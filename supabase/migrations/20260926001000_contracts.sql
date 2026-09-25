-- ===========================================================================
-- Contracts: manpower, subscriptions and clients, with reminders that stick.
--
-- Ported from the FastAPI line: app/api/routes/contracts.py,
-- app/models/contract.py, app/schemas/contract.py, alembic 0014 and 0015.
--
-- Who may do what (unchanged):
--   * management and administrators read them;
--   * contract administrators -- administrators, or anybody given the
--     can_manage_contracts flag -- add, edit and acknowledge;
--   * everybody else gets 404 ("Not found"): a refusal still says a contract
--     exists.
--
-- A reminder is due when its date has arrived, the contract is active and
-- nobody has acknowledged it. It stays due until somebody does.
--
-- The signed document lives in the private Storage bucket
-- `contract-documents` under `<contract_id>/<document_id>`; the table keeps
-- the metadata and the storage path. The route uploads after
-- contracts_check_document() has passed, then records it with
-- contracts_add_document().
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.contracts (
    id              uuid primary key default gen_random_uuid(),
    kind            varchar(20)  not null,
    title           varchar(200) not null,
    counterparty    varchar(200),
    employee_id     uuid references public.employees(id) on delete cascade,
    start_date      date,
    end_date        date not null,
    amount          double precision,
    currency        varchar(3)  not null default 'IDR',
    billing_period  varchar(40),
    notes           text,
    status          varchar(20) not null default 'active',
    created_at      timestamp not null default now(),
    updated_at      timestamp not null default now()
);
create index if not exists ix_contracts_kind        on public.contracts (kind);
create index if not exists ix_contracts_end_date    on public.contracts (end_date);
create index if not exists ix_contracts_status      on public.contracts (status);
create index if not exists ix_contracts_employee_id on public.contracts (employee_id);

create table if not exists public.contract_reminders (
    id                    uuid primary key default gen_random_uuid(),
    contract_id           uuid not null references public.contracts(id) on delete cascade,
    days_before           integer not null,
    acknowledged_at       timestamp,
    acknowledged_by       uuid references public.users(id) on delete set null,
    acknowledgement_note  text,
    created_at            timestamp not null default now(),
    updated_at            timestamp not null default now()
);
create index if not exists ix_contract_reminders_contract_id
    on public.contract_reminders (contract_id);

-- The bytes live in Storage rather than in a `data` column: `storage_path`
-- replaces the FastAPI line's LargeBinary.
create table if not exists public.contract_documents (
    id            uuid primary key default gen_random_uuid(),
    contract_id   uuid not null references public.contracts(id) on delete cascade,
    filename      varchar(255) not null,
    content_type  varchar(100) not null,
    byte_size     integer not null,
    storage_path  varchar(500) not null,
    uploaded_by   uuid references public.users(id) on delete set null,
    created_at    timestamp not null default now(),
    updated_at    timestamp not null default now()
);
create index if not exists ix_contract_documents_contract_id
    on public.contract_documents (contract_id);

alter table public.contracts          enable row level security;
alter table public.contract_reminders enable row level security;
alter table public.contract_documents enable row level security;
-- No policies: every read and write goes through the functions below.

-- ---------------------------------------------------------------------------
-- 2. Permission helpers (contracts.py _can_manage / _can_read)
-- ---------------------------------------------------------------------------

-- Add, edit and acknowledge. Administrators, or whoever is given the flag.
create or replace function public.contracts_can_manage()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    return coalesce(public.is_admin(), false) or coalesce(public.can_manage_contracts(), false);
end;
$$;

-- Read: administrators, director/executive, management, or the flag.
create or replace function public.contracts_can_read()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    e public.employees;
begin
    if coalesce(public.is_admin(), false)
       or coalesce(public.current_user_role()::text in ('director', 'executive'), false) then
        return true;
    end if;
    e := public.current_employee();
    return coalesce(e.is_management_role, false) or coalesce(e.can_manage_contracts, false);
end;
$$;

create or replace function public._contracts_require_read()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.contracts_can_read() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
end;
$$;

create or replace function public._contracts_require_manage()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.contracts_can_manage() then
        raise exception 'You are not set up to manage contracts.' using errcode = 'PT403';
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Serialisation (contracts.py _serialise) -- ContractResponse
-- ---------------------------------------------------------------------------
create or replace function public._contracts_serialise(p_id uuid, p_today date default current_date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    c public.contracts;
    v_reminders jsonb;
    v_documents jsonb;
    v_open int;
begin
    select * into c from public.contracts where id = p_id;
    if not found then
        return null;
    end if;

    -- Furthest warning first.
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id,
               'days_before', r.days_before,
               'due_on', to_char(c.end_date - r.days_before, 'YYYY-MM-DD'),
               'is_due', (c.status = 'active'
                          and r.acknowledged_at is null
                          and (c.end_date - r.days_before) <= p_today),
               'acknowledged_at', to_jsonb(r.acknowledged_at),
               'acknowledgement_note', r.acknowledgement_note
           ) order by r.days_before desc, r.created_at), '[]'::jsonb),
           count(*) filter (where c.status = 'active'
                              and r.acknowledged_at is null
                              and (c.end_date - r.days_before) <= p_today)::int
      into v_reminders, v_open
      from public.contract_reminders r
     where r.contract_id = c.id;

    select coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id,
               'filename', d.filename,
               'content_type', d.content_type,
               'byte_size', d.byte_size,
               'uploaded_at', to_jsonb(d.created_at)
           ) order by d.created_at), '[]'::jsonb)
      into v_documents
      from public.contract_documents d
     where d.contract_id = c.id;

    return jsonb_build_object(
        'documents', v_documents,
        'id', c.id,
        'kind', c.kind,
        'title', c.title,
        'counterparty', c.counterparty,
        'employee_id', c.employee_id,
        'start_date', to_char(c.start_date, 'YYYY-MM-DD'),
        'end_date', to_char(c.end_date, 'YYYY-MM-DD'),
        'days_remaining', c.end_date - p_today,
        'amount', c.amount,
        'currency', c.currency,
        'billing_period', c.billing_period,
        'notes', c.notes,
        'status', c.status,
        'reminders', v_reminders,
        'open_reminders', coalesce(v_open, 0)
    );
end;
$$;

-- Parse an optional ISO date out of a body, answering 422 the way the
-- schema validation did.
create or replace function public._contracts_date(p_body jsonb, p_key text)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v text := p_body ->> p_key;
begin
    if v is null then
        return null;
    end if;
    begin
        return v::date;
    exception when others then
        raise exception '%: Input should be a valid date', p_key using errcode = 'PT422';
    end;
end;
$$;

-- reminder_days as an int[]; null when absent or null.
create or replace function public._contracts_reminder_days(p_body jsonb)
returns int[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v int[];
begin
    if p_body -> 'reminder_days' is null or jsonb_typeof(p_body -> 'reminder_days') = 'null' then
        return null;
    end if;
    if jsonb_typeof(p_body -> 'reminder_days') <> 'array' then
        raise exception 'reminder_days: Input should be a valid list' using errcode = 'PT422';
    end if;
    begin
        select coalesce(array_agg(x::int), '{}') into v
          from jsonb_array_elements_text(p_body -> 'reminder_days') x;
    exception when others then
        raise exception 'reminder_days: Input should be a valid integer' using errcode = 'PT422';
    end;
    return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. GET /contracts?kind=
-- ---------------------------------------------------------------------------
create or replace function public.contracts_list(p_kind text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_items jsonb;
begin
    perform public._contracts_require_read();

    if p_kind is not null and p_kind not in ('manpower', 'subscription', 'client') then
        raise exception 'kind: Input should be ''manpower'', ''subscription'' or ''client'''
            using errcode = 'PT422';
    end if;

    -- Soonest to end first.
    select coalesce(jsonb_agg(public._contracts_serialise(c.id, current_date)
                              order by c.end_date, c.created_at), '[]'::jsonb)
      into v_items
      from public.contracts c
     where p_kind is null or c.kind = p_kind;

    return jsonb_build_object(
        'items', v_items,
        'can_manage', public.contracts_can_manage(),
        'due_count', (select coalesce(sum((i ->> 'open_reminders')::int), 0)::int
                        from jsonb_array_elements(v_items) i)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. POST /contracts
-- ---------------------------------------------------------------------------
create or replace function public.contracts_create(p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_kind text := p_body ->> 'kind';
    v_title text := p_body ->> 'title';
    v_start date;
    v_end date;
    v_amount double precision;
    v_currency text := coalesce(p_body ->> 'currency', 'IDR');
    v_days int[];
    v_id uuid;
    d int;
begin
    perform public._contracts_require_manage();

    if v_kind is null or v_kind not in ('manpower', 'subscription', 'client') then
        raise exception 'kind: Input should be ''manpower'', ''subscription'' or ''client'''
            using errcode = 'PT422';
    end if;
    if v_title is null or length(v_title) < 1 then
        raise exception 'title: String should have at least 1 character' using errcode = 'PT422';
    end if;
    if length(v_title) > 200 then
        raise exception 'title: String should have at most 200 characters' using errcode = 'PT422';
    end if;
    v_start := public._contracts_date(p_body, 'start_date');
    v_end := public._contracts_date(p_body, 'end_date');
    if v_end is null then
        raise exception 'end_date: Field required' using errcode = 'PT422';
    end if;
    if p_body ->> 'amount' is not null then
        begin
            v_amount := (p_body ->> 'amount')::double precision;
        exception when others then
            raise exception 'amount: Input should be a valid number' using errcode = 'PT422';
        end;
        if v_amount < 0 then
            raise exception 'amount: Input should be greater than or equal to 0' using errcode = 'PT422';
        end if;
    end if;
    if length(v_currency) <> 3 then
        raise exception 'currency: String should have 3 characters' using errcode = 'PT422';
    end if;
    v_days := public._contracts_reminder_days(p_body);

    if v_start is not null and v_start > v_end then
        raise exception 'A contract cannot end before it starts.' using errcode = 'PT422';
    end if;
    if v_days is not null then
        if exists (select 1 from unnest(v_days) x where x < 0) then
            raise exception 'A reminder cannot be a negative number of days.' using errcode = 'PT422';
        end if;
        if cardinality(v_days) > 8 then
            raise exception 'Eight reminders is plenty for one contract.' using errcode = 'PT422';
        end if;
    end if;

    -- The kind's defaults unless the caller said otherwise (an empty list
    -- counts as not saying).
    if v_days is null or cardinality(v_days) = 0 then
        v_days := case v_kind when 'client' then array[60, 42, 30] else array[30] end;
    end if;

    insert into public.contracts (kind, title, counterparty, employee_id, start_date, end_date,
                                  amount, currency, billing_period, notes)
    values (v_kind, v_title, p_body ->> 'counterparty',
            nullif(p_body ->> 'employee_id', '')::uuid,
            v_start, v_end, v_amount, v_currency,
            p_body ->> 'billing_period', p_body ->> 'notes')
    returning id into v_id;

    for d in select distinct x from unnest(v_days) x order by x desc loop
        insert into public.contract_reminders (contract_id, days_before) values (v_id, d);
    end loop;

    perform public.log_activity('CONTRACT_CREATED',
        format('Added a %s contract for %s', v_kind, v_title), v_id, null);

    return public._contracts_serialise(v_id, current_date);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. PATCH /contracts/:id  (exclude_unset: only keys present are applied)
-- ---------------------------------------------------------------------------
create or replace function public.contracts_update(p_id uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    c public.contracts;
    v_days int[];
    v_amount double precision;
begin
    perform public._contracts_require_manage();
    select * into c from public.contracts where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    p_body := coalesce(p_body, '{}'::jsonb);

    if p_body ? 'title' and p_body ->> 'title' is not null then
        if length(p_body ->> 'title') < 1 then
            raise exception 'title: String should have at least 1 character' using errcode = 'PT422';
        end if;
        if length(p_body ->> 'title') > 200 then
            raise exception 'title: String should have at most 200 characters' using errcode = 'PT422';
        end if;
        c.title := p_body ->> 'title';
    end if;
    if p_body ? 'counterparty' then c.counterparty := p_body ->> 'counterparty'; end if;
    if p_body ? 'start_date' then c.start_date := public._contracts_date(p_body, 'start_date'); end if;
    if p_body ? 'end_date' and p_body ->> 'end_date' is not null then
        c.end_date := public._contracts_date(p_body, 'end_date');
    end if;
    if p_body ? 'amount' then
        if p_body ->> 'amount' is null then
            c.amount := null;
        else
            begin
                v_amount := (p_body ->> 'amount')::double precision;
            exception when others then
                raise exception 'amount: Input should be a valid number' using errcode = 'PT422';
            end;
            if v_amount < 0 then
                raise exception 'amount: Input should be greater than or equal to 0' using errcode = 'PT422';
            end if;
            c.amount := v_amount;
        end if;
    end if;
    if p_body ? 'currency' and p_body ->> 'currency' is not null then
        if length(p_body ->> 'currency') <> 3 then
            raise exception 'currency: String should have 3 characters' using errcode = 'PT422';
        end if;
        c.currency := p_body ->> 'currency';
    end if;
    if p_body ? 'billing_period' then c.billing_period := p_body ->> 'billing_period'; end if;
    if p_body ? 'notes' then c.notes := p_body ->> 'notes'; end if;
    if p_body ? 'status' and p_body ->> 'status' is not null then
        if p_body ->> 'status' not in ('active', 'renewed', 'ended', 'cancelled') then
            raise exception 'status: Input should be ''active'', ''renewed'', ''ended'' or ''cancelled'''
                using errcode = 'PT422';
        end if;
        c.status := p_body ->> 'status';
    end if;
    v_days := public._contracts_reminder_days(p_body);

    update public.contracts
       set title = c.title, counterparty = c.counterparty, start_date = c.start_date,
           end_date = c.end_date, amount = c.amount, currency = c.currency,
           billing_period = c.billing_period, notes = c.notes, status = c.status,
           updated_at = now()
     where id = p_id;

    if v_days is not null then
        -- Keep the acknowledgements for warnings that survive the edit.
        delete from public.contract_reminders
         where contract_id = p_id and not (days_before = any (v_days));
        insert into public.contract_reminders (contract_id, days_before)
        select p_id, x
          from (select distinct x from unnest(v_days) x) w
         where not exists (select 1 from public.contract_reminders r
                            where r.contract_id = p_id and r.days_before = w.x);
    end if;

    return public._contracts_serialise(p_id, current_date);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. POST /contracts/:id/reminders/:reminder_id/acknowledge
-- ---------------------------------------------------------------------------
create or replace function public.contracts_acknowledge(p_id uuid, p_reminder_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    c public.contracts;
    r public.contract_reminders;
begin
    perform public._contracts_require_manage();
    select * into c from public.contracts where id = p_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into r from public.contract_reminders
     where id = p_reminder_id and contract_id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if r.acknowledged_at is not null then
        raise exception 'That reminder has already been acknowledged.' using errcode = 'PT409';
    end if;

    update public.contract_reminders
       set acknowledged_at = (now() at time zone 'utc'),
           acknowledged_by = auth.uid(),
           acknowledgement_note = p_note,
           updated_at = now()
     where id = r.id;

    perform public.log_activity('CONTRACT_REMINDER_ACKNOWLEDGED',
        format('Acknowledged the %s-day warning for %s', r.days_before, c.title), c.id, null);

    return public._contracts_serialise(p_id, current_date);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. DELETE /contracts/:id
-- Returns the storage paths of the documents that went with it, so the
-- route can remove the objects from the bucket.
-- ---------------------------------------------------------------------------
create or replace function public.contracts_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_paths jsonb;
begin
    perform public._contracts_require_manage();
    if not exists (select 1 from public.contracts where id = p_id) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_paths
      from public.contract_documents where contract_id = p_id;
    delete from public.contracts where id = p_id;
    return jsonb_build_object('storage_paths', v_paths);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Documents: client contracts only; PDF, images, Word; 10 MB.
-- ---------------------------------------------------------------------------

-- Every check the upload makes, in the backend's order, without writing.
-- The route calls this before putting the bytes in Storage.
create or replace function public.contracts_check_document(
    p_id uuid, p_content_type text, p_byte_size bigint
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    c public.contracts;
begin
    perform public._contracts_require_manage();
    select * into c from public.contracts where id = p_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if c.kind <> 'client' then
        raise exception 'Documents are kept on client contracts only.' using errcode = 'PT409';
    end if;
    if p_content_type is null or p_content_type not in (
        'application/pdf', 'image/jpeg', 'image/png', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document') then
        raise exception 'Upload a PDF, an image, or a Word document.' using errcode = 'PT415';
    end if;
    if p_byte_size > 10 * 1024 * 1024 then
        raise exception 'That file is % MB. The limit is 10 MB.', p_byte_size / 1024 / 1024
            using errcode = 'PT413';
    end if;
    if coalesce(p_byte_size, 0) <= 0 then
        raise exception 'That file is empty.' using errcode = 'PT400';
    end if;
end;
$$;

-- Record a document already put in Storage at p_storage_path.
create or replace function public.contracts_add_document(
    p_id uuid,
    p_document_id uuid,
    p_filename text,
    p_content_type text,
    p_byte_size bigint,
    p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_title text;
    v_filename text;
begin
    perform public.contracts_check_document(p_id, p_content_type, p_byte_size);
    select title into v_title from public.contracts where id = p_id;

    v_filename := coalesce(nullif(p_filename, ''), 'contract' || case p_content_type
        when 'application/pdf' then '.pdf'
        when 'image/jpeg' then '.jpg'
        when 'image/png' then '.png'
        when 'application/msword' then '.doc'
        else '.docx' end);

    insert into public.contract_documents
        (id, contract_id, filename, content_type, byte_size, storage_path, uploaded_by)
    values (coalesce(p_document_id, gen_random_uuid()), p_id, v_filename, p_content_type,
            p_byte_size, p_storage_path, auth.uid());

    perform public.log_activity('CONTRACT_DOCUMENT_ADDED',
        format('Attached %s to %s', p_filename, v_title), p_id, null);

    return public._contracts_serialise(p_id, current_date);
end;
$$;

-- GET /contracts/:id/documents/:doc_id -- the metadata the route needs to
-- fetch the bytes from Storage.
create or replace function public.contracts_get_document(p_id uuid, p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    d public.contract_documents;
begin
    perform public._contracts_require_read();
    select * into d from public.contract_documents
     where id = p_document_id and contract_id = p_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return jsonb_build_object(
        'id', d.id,
        'filename', d.filename,
        'content_type', d.content_type,
        'byte_size', d.byte_size,
        'storage_path', d.storage_path
    );
end;
$$;

-- DELETE /contracts/:id/documents/:doc_id. Returns {contract, storage_path}:
-- the route answers with `contract` and removes the object.
create or replace function public.contracts_delete_document(p_id uuid, p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_path text;
begin
    perform public._contracts_require_manage();
    if not exists (select 1 from public.contracts where id = p_id) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    delete from public.contract_documents
     where id = p_document_id and contract_id = p_id
    returning storage_path into v_path;
    if v_path is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return jsonb_build_object(
        'contract', public._contracts_serialise(p_id, current_date),
        'storage_path', v_path
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.contracts_can_manage()                          from public;
revoke all on function public.contracts_can_read()                            from public;
revoke all on function public._contracts_require_read()                       from public;
revoke all on function public._contracts_require_manage()                     from public;
revoke all on function public._contracts_serialise(uuid, date)                from public;
revoke all on function public._contracts_date(jsonb, text)                    from public;
revoke all on function public._contracts_reminder_days(jsonb)                 from public;
revoke all on function public.contracts_list(text)                            from public;
revoke all on function public.contracts_create(jsonb)                         from public;
revoke all on function public.contracts_update(uuid, jsonb)                   from public;
revoke all on function public.contracts_acknowledge(uuid, uuid, text)         from public;
revoke all on function public.contracts_delete(uuid)                          from public;
revoke all on function public.contracts_check_document(uuid, text, bigint)    from public;
revoke all on function public.contracts_add_document(uuid, uuid, text, text, bigint, text) from public;
revoke all on function public.contracts_get_document(uuid, uuid)              from public;
revoke all on function public.contracts_delete_document(uuid, uuid)           from public;

grant execute on function public.contracts_can_manage()                       to authenticated;
grant execute on function public.contracts_can_read()                         to authenticated;
grant execute on function public.contracts_list(text)                         to authenticated;
grant execute on function public.contracts_create(jsonb)                      to authenticated;
grant execute on function public.contracts_update(uuid, jsonb)                to authenticated;
grant execute on function public.contracts_acknowledge(uuid, uuid, text)      to authenticated;
grant execute on function public.contracts_delete(uuid)                       to authenticated;
grant execute on function public.contracts_check_document(uuid, text, bigint) to authenticated;
grant execute on function public.contracts_add_document(uuid, uuid, text, text, bigint, text) to authenticated;
grant execute on function public.contracts_get_document(uuid, uuid)           to authenticated;
grant execute on function public.contracts_delete_document(uuid, uuid)        to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Storage: private bucket, readable by contract readers, writable by
-- contract managers. Guarded: the test database has no storage schema.
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('contract-documents', 'contract-documents', false)
    on conflict (id) do nothing;

    drop policy if exists "contract documents: readers read"     on storage.objects;
    drop policy if exists "contract documents: managers upload"  on storage.objects;
    drop policy if exists "contract documents: managers delete"  on storage.objects;

    create policy "contract documents: readers read" on storage.objects
        for select to authenticated
        using (bucket_id = 'contract-documents' and public.contracts_can_read());
    create policy "contract documents: managers upload" on storage.objects
        for insert to authenticated
        with check (bucket_id = 'contract-documents' and public.contracts_can_manage());
    create policy "contract documents: managers delete" on storage.objects
        for delete to authenticated
        using (bucket_id = 'contract-documents' and public.contracts_can_manage());
  end if;
end $$;

commit;
