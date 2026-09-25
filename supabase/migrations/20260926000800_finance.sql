-- Finance requests: petty cash, tax, BPJS and the rest, approved before they
-- are paid. Port of the FastAPI line's app/api/routes/finance_requests.py
-- (alembic 0023).
--
--     finance prepares -> the director reviews -> the executive approves -> finance pays
--
-- * Only finance raises and edits a request, and only while it is a draft or
--   has been sent back.
-- * The director's review passes it to the executive -- or, when the final say
--   has been handed to the director in Settings, approves it outright.
-- * Either signatory can send it back to finance with a reason; the executive
--   can instead send it back to the director.
-- * Once approved, finance marks it paid, with the date the money went out.
--
-- Finance, the director and the executives see every request. Everybody else
-- gets 404 ("Not found").
--
-- One departure from the model: finance_request_documents keeps the file in
-- Storage (bucket finance-documents) and records its storage_path, where the
-- FastAPI table held the bytes in a `data` column. Listing requests therefore
-- never touches file contents.

begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.finance_requests (
    id uuid primary key default gen_random_uuid(),
    reference varchar(20) not null,
    title varchar(200) not null,
    notes text,
    due_date date,
    status varchar(20) not null default 'draft',
    requested_by_id uuid references public.users(id) on delete set null,
    submitted_at timestamptz,
    reviewed_at timestamptz,
    reviewed_by_id uuid references public.users(id) on delete set null,
    approved_at timestamptz,
    approved_by_id uuid references public.users(id) on delete set null,
    revision_note text,
    revision_at timestamptz,
    revision_by_id uuid references public.users(id) on delete set null,
    paid_on date,
    paid_by_id uuid references public.users(id) on delete set null,
    payment_note text,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    constraint uq_finance_requests_reference unique (reference)
);
create index if not exists ix_finance_requests_reference on public.finance_requests (reference);
create index if not exists ix_finance_requests_status on public.finance_requests (status);

create table if not exists public.finance_request_items (
    id uuid primary key default gen_random_uuid(),
    request_id uuid not null references public.finance_requests(id) on delete cascade,
    category varchar(20) not null,
    description varchar(300) not null,
    amount double precision not null,
    sort_order integer not null default 0,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now()
);
create index if not exists ix_finance_request_items_request_id on public.finance_request_items (request_id);

create table if not exists public.finance_request_documents (
    id uuid primary key default gen_random_uuid(),
    request_id uuid not null references public.finance_requests(id) on delete cascade,
    filename varchar(255) not null,
    content_type varchar(100) not null,
    byte_size integer not null,
    -- Object path in the finance-documents bucket (replaces the model's `data`).
    storage_path varchar(500) not null,
    uploaded_by uuid references public.users(id) on delete set null,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now()
);
create index if not exists ix_finance_request_documents_request_id on public.finance_request_documents (request_id);

create table if not exists public.finance_settings (
    id uuid primary key default gen_random_uuid(),
    director_final_approval boolean not null default false,
    updated_by uuid references public.users(id) on delete set null,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now()
);

-- A single row, off by default: the chain as it runs now.
insert into public.finance_settings (director_final_approval)
select false
 where not exists (select 1 from public.finance_settings);

alter table public.finance_requests          enable row level security;
alter table public.finance_request_items     enable row level security;
alter table public.finance_request_documents enable row level security;
alter table public.finance_settings          enable row level security;
-- No policies: every read and write goes through the finance_* functions.

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------

-- Finance, the director and the executives see requests; everybody else 404.
create or replace function public.finance_require_see()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if coalesce(public.current_user_role()::text in ('finance', 'director', 'executive'), false) is not true then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
end;
$$;

create or replace function public.finance_require_role(p_role text, p_action text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if coalesce(public.current_user_role()::text = p_role, false) is not true then
        raise exception 'Only %.', p_action using errcode = 'PT403';
    end if;
end;
$$;

create or replace function public.finance_load(p_id uuid)
returns public.finance_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
begin
    select * into r from public.finance_requests where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return r;
end;
$$;

create or replace function public.finance_require_state(r public.finance_requests, p_states text[], p_action text)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
    if not (r.status = any (p_states)) then
        raise exception '% is %; it cannot be % now.',
            r.reference, replace(r.status, '_', ' '), p_action
            using errcode = 'PT409';
    end if;
end;
$$;

create or replace function public.finance_total(p_id uuid)
returns double precision
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select round(coalesce(sum(amount), 0)::numeric, 2)::double precision
      from public.finance_request_items where request_id = p_id;
$$;

-- "FR-0001 (October petty cash, IDR 30,574,124)"
create or replace function public.finance_label(r public.finance_requests)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select format('%s (%s, IDR %s)', r.reference, r.title,
                  to_char(round(public.finance_total(r.id)::numeric), 'FM999,999,999,999,999,990'));
$$;

create or replace function public.finance_director_final_approval()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce((select director_final_approval from public.finance_settings
                      order by created_at limit 1), false);
$$;

-- The RequestOut shape.
create or replace function public.finance_request_json(r public.finance_requests)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', r.id,
        'reference', r.reference,
        'title', r.title,
        'notes', r.notes,
        'due_date', r.due_date,
        'status', r.status,
        'total', public.finance_total(r.id),
        'items', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', i.id, 'category', i.category,
                       'description', i.description, 'amount', i.amount)
                   order by i.sort_order, i.created_at, i.id)
              from public.finance_request_items i where i.request_id = r.id), '[]'::jsonb),
        'documents', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', d.id, 'filename', d.filename, 'content_type', d.content_type,
                       'byte_size', d.byte_size, 'created_at', d.created_at)
                   order by d.created_at, d.id)
              from public.finance_request_documents d where d.request_id = r.id), '[]'::jsonb),
        'requested_by_name', (select full_name from public.users where id = r.requested_by_id),
        'submitted_at', r.submitted_at,
        'reviewed_by_name', (select full_name from public.users where id = r.reviewed_by_id),
        'reviewed_at', r.reviewed_at,
        'approved_by_name', (select full_name from public.users where id = r.approved_by_id),
        'approved_at', r.approved_at,
        'revision_note', r.revision_note,
        'revision_by_name', (select full_name from public.users where id = r.revision_by_id),
        'paid_on', r.paid_on,
        'paid_by_name', (select full_name from public.users where id = r.paid_by_id),
        'payment_note', r.payment_note,
        'awaiting', case r.status when 'submitted' then 'director'
                                  when 'endorsed' then 'executive' end,
        'is_editable', r.status in ('draft', 'changes_requested'),
        'created_at', r.created_at
    );
$$;

create or replace function public.finance_request_json_by_id(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.finance_request_json(r) from public.finance_requests r where r.id = p_id;
$$;

-- RequestIn: validates, then replaces the header fields and the lines wholesale.
create or replace function public.finance_apply_body(p_id uuid, p_body jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_title text := p_body ->> 'title';
    v_notes text := p_body ->> 'notes';
    v_due text := p_body ->> 'due_date';
    v_due_date date;
    v_items jsonb := p_body -> 'items';
    v_item jsonb;
    v_amount double precision;
    v_n integer := 0;
    k text;
begin
    if p_body is null or jsonb_typeof(p_body) <> 'object' then
        raise exception 'The request body is invalid.' using errcode = 'PT422';
    end if;
    for k in select jsonb_object_keys(p_body) loop
        if k not in ('title', 'notes', 'due_date', 'items') then
            raise exception 'Unexpected field: %.', k using errcode = 'PT422';
        end if;
    end loop;
    if v_title is null or char_length(v_title) < 3 or char_length(v_title) > 200 then
        raise exception 'The title must be between 3 and 200 characters.' using errcode = 'PT422';
    end if;
    if v_due is not null then
        begin
            v_due_date := v_due::date;
        exception when others then
            raise exception 'The due date is not a valid date.' using errcode = 'PT422';
        end;
    end if;
    if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) < 1 then
        raise exception 'A request needs at least one line.' using errcode = 'PT422';
    end if;
    for v_item in select * from jsonb_array_elements(v_items) loop
        if jsonb_typeof(v_item) <> 'object' then
            raise exception 'Each line needs a category, a description and an amount.' using errcode = 'PT422';
        end if;
        for k in select jsonb_object_keys(v_item) loop
            if k not in ('category', 'description', 'amount') then
                raise exception 'Unexpected field on a line: %.', k using errcode = 'PT422';
            end if;
        end loop;
        if coalesce(v_item ->> 'category', '') not in
               ('petty_cash', 'tax', 'bpjs', 'vendor', 'reimbursement', 'other') then
            raise exception 'Unknown category: %.', coalesce(v_item ->> 'category', 'none') using errcode = 'PT422';
        end if;
        if v_item ->> 'description' is null or char_length(v_item ->> 'description') < 1
           or char_length(v_item ->> 'description') > 300 then
            raise exception 'Each line needs a description of up to 300 characters.' using errcode = 'PT422';
        end if;
        begin
            v_amount := (v_item ->> 'amount')::double precision;
        exception when others then
            v_amount := null;
        end;
        if v_amount is null or not (v_amount > 0) then
            raise exception 'Each amount must be greater than zero.' using errcode = 'PT422';
        end if;
    end loop;

    update public.finance_requests
       set title = btrim(v_title),
           notes = nullif(btrim(coalesce(v_notes, '')), ''),
           due_date = v_due_date,
           updated_at = now()
     where id = p_id;

    delete from public.finance_request_items where request_id = p_id;
    for v_item in select * from jsonb_array_elements(v_items) loop
        insert into public.finance_request_items (request_id, category, description, amount, sort_order)
        values (p_id, v_item ->> 'category', btrim(v_item ->> 'description'),
                round((v_item ->> 'amount')::numeric, 2)::double precision, v_n);
        v_n := v_n + 1;
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- GET /finance-requests: every request, newest first.
create or replace function public.finance_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.finance_require_see();
    return jsonb_build_object(
        'items', coalesce((select jsonb_agg(public.finance_request_json(r) order by r.created_at desc, r.reference desc)
                             from public.finance_requests r), '[]'::jsonb),
        'can_create', public.is_finance(),
        'director_final_approval', public.finance_director_final_approval()
    );
end;
$$;

-- GET /finance-requests/:id
create or replace function public.finance_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
begin
    perform public.finance_require_see();
    select * into r from public.finance_requests where id = p_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return public.finance_request_json(r);
end;
$$;

-- GET /finance-requests/settings
create or replace function public.finance_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.finance_require_see();
    return jsonb_build_object('director_final_approval', public.finance_director_final_approval());
end;
$$;

-- PUT /finance-requests/settings: the platform admin's.
create or replace function public.finance_settings_update(p_director_final_approval boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.is_platform_admin() then
        raise exception 'Only the platform administrator can change this.' using errcode = 'PT403';
    end if;
    if p_director_final_approval is null then
        raise exception 'director_final_approval is required.' using errcode = 'PT422';
    end if;
    if exists (select 1 from public.finance_settings) then
        update public.finance_settings
           set director_final_approval = p_director_final_approval,
               updated_by = auth.uid(),
               updated_at = now()
         where id = (select id from public.finance_settings order by created_at limit 1);
    else
        insert into public.finance_settings (director_final_approval, updated_by)
        values (p_director_final_approval, auth.uid());
    end if;
    perform public.log_activity(
        'FINANCE_SETTINGS_CHANGED',
        case when p_director_final_approval
             then 'The director''s review is now the final approval on finance requests'
             else 'Finance requests go to the executive for final approval again' end,
        null, null);
    return jsonb_build_object('director_final_approval', p_director_final_approval);
end;
$$;

-- ---------------------------------------------------------------------------
-- Preparing
-- ---------------------------------------------------------------------------

-- FR-0001, FR-0002 -- from the highest so far, compared as numbers (as text
-- "FR-10000" sorts below "FR-9999"), so a deleted draft frees no number.
create or replace function public.finance_next_reference()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    n bigint;
begin
    select coalesce(max(split_part(reference, '-', 2)::numeric), 0) + 1 into n
      from public.finance_requests
     where split_part(reference, '-', 2) ~ '^[0-9]+$';
    return 'FR-' || case when length(n::text) >= 4 then n::text else lpad(n::text, 4, '0') end;
end;
$$;

-- POST /finance-requests
create or replace function public.finance_create(p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
begin
    perform public.finance_require_see();
    perform public.finance_require_role('finance', 'finance raises a request');
    -- One reference at a time.
    perform pg_advisory_xact_lock(hashtext('finance_requests.reference'));
    insert into public.finance_requests (reference, title, status, requested_by_id)
    values (public.finance_next_reference(), '(pending)', 'draft', auth.uid())
    returning * into r;
    perform public.finance_apply_body(r.id, p_body);
    select * into r from public.finance_requests where id = r.id;
    perform public.log_activity('FINANCE_REQUEST_DRAFTED',
        format('Drafted %s: %s', r.reference, r.title), r.id, null);
    return public.finance_request_json(r);
end;
$$;

-- PUT /finance-requests/:id
create or replace function public.finance_update(p_id uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
begin
    perform public.finance_require_see();
    perform public.finance_require_role('finance', 'finance edits a request');
    r := public.finance_load(p_id);
    perform public.finance_require_state(r, array['draft', 'changes_requested'], 'edited');
    perform public.finance_apply_body(r.id, p_body);
    return public.finance_request_json_by_id(r.id);
end;
$$;

-- DELETE /finance-requests/:id: a draft nobody has seen can go.
-- Returns the storage paths of its documents, for the caller to remove.
create or replace function public.finance_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
    v_paths jsonb;
begin
    perform public.finance_require_see();
    perform public.finance_require_role('finance', 'finance discards a request');
    r := public.finance_load(p_id);
    perform public.finance_require_state(r, array['draft'], 'discarded');
    select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_paths
      from public.finance_request_documents where request_id = r.id;
    delete from public.finance_requests where id = r.id;
    return v_paths;
end;
$$;

-- ---------------------------------------------------------------------------
-- The chain
-- ---------------------------------------------------------------------------

-- POST /finance-requests/:id/submit: finance sends it to the director.
create or replace function public.finance_submit(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
begin
    perform public.finance_require_see();
    perform public.finance_require_role('finance', 'finance sends a request');
    r := public.finance_load(p_id);
    perform public.finance_require_state(r, array['draft', 'changes_requested'], 'sent');
    update public.finance_requests
       set status = 'submitted', submitted_at = now(),
           -- The reason it came back is answered.
           revision_note = null, revision_at = null, revision_by_id = null,
           updated_at = now()
     where id = r.id
    returning * into r;
    perform public.log_activity('FINANCE_REQUEST_SUBMITTED',
        format('Sent %s for review', public.finance_label(r)), r.id, null);
    return public.finance_request_json(r);
end;
$$;

-- POST /finance-requests/:id/review: on to the executive, or approved outright
-- when the director has the final say.
create or replace function public.finance_review(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
    v_final boolean;
begin
    perform public.finance_require_see();
    perform public.finance_require_role('director', 'the director reviews a request');
    r := public.finance_load(p_id);
    perform public.finance_require_state(r, array['submitted'], 'reviewed');
    v_final := public.finance_director_final_approval();
    update public.finance_requests
       set reviewed_at = now(), reviewed_by_id = auth.uid(),
           revision_note = null, revision_at = null, revision_by_id = null,
           status = case when v_final then 'approved' else 'endorsed' end,
           approved_at = case when v_final then now() else approved_at end,
           approved_by_id = case when v_final then auth.uid() else approved_by_id end,
           updated_at = now()
     where id = r.id
    returning * into r;
    perform public.log_activity(
        case when v_final then 'FINANCE_REQUEST_APPROVED' else 'FINANCE_REQUEST_REVIEWED' end,
        case when v_final
             then format('Reviewed and approved %s', public.finance_label(r))
             else format('Reviewed %s and passed it to the executive', public.finance_label(r)) end,
        r.id, null);
    return public.finance_request_json(r);
end;
$$;

-- POST /finance-requests/:id/approve: the executive approves it.
create or replace function public.finance_approve(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
begin
    perform public.finance_require_see();
    perform public.finance_require_role('executive', 'the executive approves a request');
    r := public.finance_load(p_id);
    perform public.finance_require_state(r, array['endorsed'], 'approved');
    update public.finance_requests
       set status = 'approved', approved_at = now(), approved_by_id = auth.uid(),
           updated_at = now()
     where id = r.id
    returning * into r;
    perform public.log_activity('FINANCE_REQUEST_APPROVED',
        format('Approved %s', public.finance_label(r)), r.id, null);
    return public.finance_request_json(r);
end;
$$;

-- POST /finance-requests/:id/send-back: back to finance, or -- the executive's
-- choice only -- back to the director. A reason is required.
create or replace function public.finance_send_back(p_id uuid, p_note text, p_send_to text default 'finance')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
    v_role text := coalesce(public.current_user_role()::text, '');
    v_to text := coalesce(p_send_to, 'finance');
    v_status text;
    v_where text;
begin
    perform public.finance_require_see();
    if p_note is null or char_length(p_note) < 3 or char_length(p_note) > 2000 then
        raise exception 'Say why it is going back (3 to 2000 characters).' using errcode = 'PT422';
    end if;
    if v_to not in ('finance', 'director') then
        raise exception 'send_to must be "finance" or "director".' using errcode = 'PT422';
    end if;
    r := public.finance_load(p_id);

    if v_to = 'director' then
        if v_role <> 'executive' or r.status not in ('endorsed', 'approved') then
            raise exception 'Only the executive sends a request back to the director, once reviewed.'
                using errcode = 'PT403';
        end if;
        v_status := 'submitted';
        v_where := 'the director';
    else
        if not ((v_role = 'director' and r.status in ('submitted', 'approved'))
             or (v_role = 'executive' and r.status in ('endorsed', 'approved'))) then
            raise exception 'Only whoever it is waiting on can send it back.' using errcode = 'PT403';
        end if;
        v_status := 'changes_requested';
        v_where := 'finance';
    end if;

    update public.finance_requests
       set status = v_status,
           revision_note = btrim(p_note), revision_at = now(), revision_by_id = auth.uid(),
           -- Signatures no longer stand for what comes back.
           reviewed_at = null, reviewed_by_id = null,
           approved_at = null, approved_by_id = null,
           updated_at = now()
     where id = r.id
    returning * into r;
    perform public.log_activity('FINANCE_REQUEST_SENT_BACK',
        format('Sent %s back to %s: %s', public.finance_label(r), v_where, r.revision_note), r.id, null);
    return public.finance_request_json(r);
end;
$$;

-- POST /finance-requests/:id/paid: finance records that the money went out.
create or replace function public.finance_mark_paid(p_id uuid, p_paid_on date, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
begin
    perform public.finance_require_see();
    if p_paid_on is null then
        raise exception 'paid_on is required.' using errcode = 'PT422';
    end if;
    if p_note is not null and char_length(p_note) > 2000 then
        raise exception 'The note can be at most 2000 characters.' using errcode = 'PT422';
    end if;
    perform public.finance_require_role('finance', 'finance marks a request paid');
    r := public.finance_load(p_id);
    perform public.finance_require_state(r, array['approved'], 'marked paid');
    update public.finance_requests
       set status = 'paid', paid_on = p_paid_on, paid_by_id = auth.uid(),
           payment_note = nullif(btrim(coalesce(p_note, '')), ''),
           updated_at = now()
     where id = r.id
    returning * into r;
    perform public.log_activity('FINANCE_REQUEST_PAID',
        format('Paid %s on %s', public.finance_label(r), to_char(p_paid_on, 'DD FMMonth YYYY')), r.id, null);
    return public.finance_request_json(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- Documents (the bytes live in Storage, bucket finance-documents)
-- ---------------------------------------------------------------------------

-- POST /finance-requests/:id/documents, after the route has put the file in
-- Storage. Finance's, at any stage -- a receipt often only exists after the
-- money has gone out.
create or replace function public.finance_document_add(
    p_request_id uuid,
    p_filename text,
    p_content_type text,
    p_byte_size integer,
    p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
    v_ext text;
    v_name text;
begin
    perform public.finance_require_see();
    perform public.finance_require_role('finance', 'finance attaches documents');
    r := public.finance_load(p_request_id);
    v_ext := case p_content_type
        when 'application/pdf' then '.pdf'
        when 'image/jpeg' then '.jpg'
        when 'image/png' then '.png'
        when 'application/msword' then '.doc'
        when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then '.docx'
    end;
    if v_ext is null then
        raise exception 'Upload a PDF, an image, or a Word document.' using errcode = 'PT415';
    end if;
    if coalesce(p_byte_size, 0) <= 0 then
        raise exception 'That file is empty.' using errcode = 'PT400';
    end if;
    if p_byte_size > 10 * 1024 * 1024 then
        raise exception 'That file is % MB. The limit is 10 MB.', p_byte_size / 1024 / 1024
            using errcode = 'PT413';
    end if;
    if p_storage_path is null or p_storage_path = '' then
        raise exception 'The file was not stored.' using errcode = 'PT422';
    end if;
    v_name := coalesce(nullif(p_filename, ''), 'document' || v_ext);
    insert into public.finance_request_documents
        (request_id, filename, content_type, byte_size, storage_path, uploaded_by, created_at, updated_at)
    values (r.id, left(v_name, 255), p_content_type, p_byte_size, p_storage_path, auth.uid(),
            clock_timestamp(), clock_timestamp());
    perform public.log_activity('FINANCE_REQUEST_DOCUMENT_ADDED',
        format('Attached %s to %s', coalesce(p_filename, 'None'), r.reference), r.id, null);
    return public.finance_request_json_by_id(r.id);
end;
$$;

-- GET /finance-requests/:id/documents/:docId: where the bytes are.
create or replace function public.finance_document_get(p_request_id uuid, p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v jsonb;
begin
    perform public.finance_require_see();
    select jsonb_build_object('id', d.id, 'filename', d.filename, 'content_type', d.content_type,
                              'byte_size', d.byte_size, 'storage_path', d.storage_path)
      into v
      from public.finance_request_documents d
     where d.id = p_document_id and d.request_id = p_request_id;
    if v is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return v;
end;
$$;

-- DELETE /finance-requests/:id/documents/:docId: only while the request can
-- still be changed. Returns { request, storage_path } -- the route removes
-- the object and answers with the request.
create or replace function public.finance_document_delete(p_request_id uuid, p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
    v_path text;
begin
    perform public.finance_require_see();
    perform public.finance_require_role('finance', 'finance removes documents');
    r := public.finance_load(p_request_id);
    perform public.finance_require_state(r, array['draft', 'changes_requested'], 'changed');
    delete from public.finance_request_documents
     where id = p_document_id and request_id = r.id
    returning storage_path into v_path;
    if v_path is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    update public.finance_requests set updated_at = now() where id = r.id;
    return jsonb_build_object('request', public.finance_request_json_by_id(r.id),
                              'storage_path', v_path);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function public.finance_require_see() from public, anon, authenticated;
revoke all on function public.finance_require_role(text, text) from public, anon, authenticated;
revoke all on function public.finance_load(uuid) from public, anon, authenticated;
revoke all on function public.finance_require_state(public.finance_requests, text[], text) from public, anon, authenticated;
revoke all on function public.finance_total(uuid) from public, anon, authenticated;
revoke all on function public.finance_label(public.finance_requests) from public, anon, authenticated;
revoke all on function public.finance_director_final_approval() from public, anon, authenticated;
revoke all on function public.finance_request_json(public.finance_requests) from public, anon, authenticated;
revoke all on function public.finance_request_json_by_id(uuid) from public, anon, authenticated;
revoke all on function public.finance_apply_body(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.finance_next_reference() from public, anon, authenticated;

revoke all on function public.finance_list() from public;
revoke all on function public.finance_get(uuid) from public;
revoke all on function public.finance_settings_get() from public;
revoke all on function public.finance_settings_update(boolean) from public;
revoke all on function public.finance_create(jsonb) from public;
revoke all on function public.finance_update(uuid, jsonb) from public;
revoke all on function public.finance_delete(uuid) from public;
revoke all on function public.finance_submit(uuid) from public;
revoke all on function public.finance_review(uuid) from public;
revoke all on function public.finance_approve(uuid) from public;
revoke all on function public.finance_send_back(uuid, text, text) from public;
revoke all on function public.finance_mark_paid(uuid, date, text) from public;
revoke all on function public.finance_document_add(uuid, text, text, integer, text) from public;
revoke all on function public.finance_document_get(uuid, uuid) from public;
revoke all on function public.finance_document_delete(uuid, uuid) from public;

grant execute on function public.finance_list() to authenticated;
grant execute on function public.finance_get(uuid) to authenticated;
grant execute on function public.finance_settings_get() to authenticated;
grant execute on function public.finance_settings_update(boolean) to authenticated;
grant execute on function public.finance_create(jsonb) to authenticated;
grant execute on function public.finance_update(uuid, jsonb) to authenticated;
grant execute on function public.finance_delete(uuid) to authenticated;
grant execute on function public.finance_submit(uuid) to authenticated;
grant execute on function public.finance_review(uuid) to authenticated;
grant execute on function public.finance_approve(uuid) to authenticated;
grant execute on function public.finance_send_back(uuid, text, text) to authenticated;
grant execute on function public.finance_mark_paid(uuid, date, text) to authenticated;
grant execute on function public.finance_document_add(uuid, text, text, integer, text) to authenticated;
grant execute on function public.finance_document_get(uuid, uuid) to authenticated;
grant execute on function public.finance_document_delete(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, finance uploads and removes, the three roles read.
-- Objects live at <request_id>/<uuid>/<filename>.
-- ---------------------------------------------------------------------------

do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('finance-documents', 'finance-documents', false)
    on conflict (id) do nothing;

    drop policy if exists finance_documents_select on storage.objects;
    create policy finance_documents_select on storage.objects
        for select to authenticated
        using (bucket_id = 'finance-documents'
               and coalesce(public.current_user_role()::text in ('finance', 'director', 'executive'), false));

    drop policy if exists finance_documents_insert on storage.objects;
    create policy finance_documents_insert on storage.objects
        for insert to authenticated
        with check (bucket_id = 'finance-documents' and public.is_finance());

    drop policy if exists finance_documents_delete on storage.objects;
    create policy finance_documents_delete on storage.objects
        for delete to authenticated
        using (bucket_id = 'finance-documents' and public.is_finance());
  end if;
end $$;

commit;
