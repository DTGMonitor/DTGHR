-- ===========================================================================
-- Contracts & POs, under Finance.
--
-- The managing director: "contracts could sit under finance with a place to
-- store POs as well. When we have a few accounts it will be important to
-- track PO dates and when contracts are coming up for renewal."
--
--   * Finance (role 'finance') now reads and manages contracts, and purchase
--     orders, alongside the administrators and the can_manage_contracts flag.
--     Management still reads without managing.
--   * purchase_orders: a client's PO, usually under a client contract (the
--     account) but allowed to stand alone. Unique per client, case-insensitive.
--     Documents in the private bucket `purchase-order-documents` under
--     `<po_id>/<document_id>`, same types and limit as contract documents.
--   * contracts_coming_up(): active contracts ending within 90 days (and
--     overdue ones nobody has acknowledged), active POs ending within 60 days,
--     soonest first. The dashboard route shows it to contract readers.
--   * contracts_send_renewal_notices(): once a day, an email to contract
--     managers and finance when a contract or PO crosses 60, 30 or 7 days
--     before its end -- once per item per threshold.
--
-- _contracts_serialise() is otherwise as in 20260926001000_contracts.sql; it
-- now carries the contract's purchase orders.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_orders (
    id           uuid primary key default gen_random_uuid(),
    contract_id  uuid references public.contracts(id) on delete set null,
    po_number    varchar(100) not null,
    client_name  varchar(200) not null,
    description  text,
    po_date      date not null,
    start_date   date,
    end_date     date,
    value        numeric,
    currency     varchar(3)  not null default 'IDR',
    status       varchar(20) not null default 'active'
                 check (status in ('active', 'completed', 'cancelled')),
    notes        text,
    created_by   uuid references public.users(id) on delete set null,
    updated_by   uuid references public.users(id) on delete set null,
    created_at   timestamp not null default now(),
    updated_at   timestamp not null default now(),
    constraint purchase_orders_dates check (start_date is null or end_date is null or end_date >= start_date),
    constraint purchase_orders_value check (value is null or value >= 0)
);
create unique index if not exists ux_purchase_orders_client_number
    on public.purchase_orders (lower(client_name), lower(po_number));
create index if not exists ix_purchase_orders_contract_id on public.purchase_orders (contract_id);
create index if not exists ix_purchase_orders_end_date    on public.purchase_orders (end_date);
create index if not exists ix_purchase_orders_po_date     on public.purchase_orders (po_date);

create table if not exists public.purchase_order_documents (
    id                 uuid primary key default gen_random_uuid(),
    purchase_order_id  uuid not null references public.purchase_orders(id) on delete cascade,
    filename           varchar(255) not null,
    content_type       varchar(100) not null,
    byte_size          integer not null,
    storage_path       varchar(500) not null,
    uploaded_by        uuid references public.users(id) on delete set null,
    created_at         timestamp not null default now(),
    updated_at         timestamp not null default now()
);
create index if not exists ix_purchase_order_documents_po_id
    on public.purchase_order_documents (purchase_order_id);

-- Which renewal emails have gone: one row per item, end date and threshold,
-- so an extended end date is warned about afresh.
create table if not exists public.renewal_notices (
    id         uuid primary key default gen_random_uuid(),
    item_kind  varchar(20) not null,
    item_id    uuid not null,
    end_date   date not null,
    threshold  integer not null,
    sent_at    timestamp not null default now(),
    unique (item_kind, item_id, end_date, threshold)
);

alter table public.purchase_orders          enable row level security;
alter table public.purchase_order_documents enable row level security;
alter table public.renewal_notices          enable row level security;
-- No policies: every read and write goes through the functions below.

-- ---------------------------------------------------------------------------
-- 2. Permission: finance joins the readers and the managers.
-- ---------------------------------------------------------------------------
create or replace function public.contracts_can_manage()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    return coalesce(public.is_admin(), false)
        or coalesce(public.can_manage_contracts(), false)
        or coalesce(public.current_user_role()::text = 'finance', false);
end;
$$;

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
       or coalesce(public.current_user_role()::text in ('director', 'executive', 'finance'), false) then
        return true;
    end if;
    e := public.current_employee();
    return coalesce(e.is_management_role, false) or coalesce(e.can_manage_contracts, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Contract serialisation, now with its purchase orders.
-- ---------------------------------------------------------------------------
create or replace function public._contracts_serialise(p_id uuid, p_today date default public.local_today())
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
    v_pos jsonb;
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

    -- Newest PO first.
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', po.id,
               'po_number', po.po_number,
               'po_date', to_char(po.po_date, 'YYYY-MM-DD'),
               'end_date', to_char(po.end_date, 'YYYY-MM-DD'),
               'value', po.value,
               'currency', po.currency,
               'status', po.status
           ) order by po.po_date desc, po.created_at desc), '[]'::jsonb)
      into v_pos
      from public.purchase_orders po
     where po.contract_id = c.id;

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
        'open_reminders', coalesce(v_open, 0),
        'purchase_orders', v_pos
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Purchase orders
-- ---------------------------------------------------------------------------
create or replace function public._po_serialise(p_id uuid, p_today date default public.local_today())
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    po public.purchase_orders;
    v_contract public.contracts;
    v_documents jsonb;
begin
    select * into po from public.purchase_orders where id = p_id;
    if not found then
        return null;
    end if;
    if po.contract_id is not null then
        select * into v_contract from public.contracts where id = po.contract_id;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id,
               'filename', d.filename,
               'content_type', d.content_type,
               'byte_size', d.byte_size,
               'uploaded_at', to_jsonb(d.created_at)
           ) order by d.created_at), '[]'::jsonb)
      into v_documents
      from public.purchase_order_documents d
     where d.purchase_order_id = po.id;

    return jsonb_build_object(
        'id', po.id,
        'contract_id', po.contract_id,
        'contract_title', v_contract.title,
        'po_number', po.po_number,
        'client_name', po.client_name,
        'description', po.description,
        'po_date', to_char(po.po_date, 'YYYY-MM-DD'),
        'start_date', to_char(po.start_date, 'YYYY-MM-DD'),
        'end_date', to_char(po.end_date, 'YYYY-MM-DD'),
        'days_remaining', po.end_date - p_today,
        'value', po.value,
        'currency', po.currency,
        'status', po.status,
        'notes', po.notes,
        'documents', v_documents,
        'created_at', to_jsonb(po.created_at),
        'updated_at', to_jsonb(po.updated_at)
    );
end;
$$;

-- Validate and apply a body onto a PO row (create when p_new). Shared by
-- create and update; update applies only the keys present.
create or replace function public._po_apply(po public.purchase_orders, p_body jsonb, p_new boolean)
returns public.purchase_orders
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_contract public.contracts;
    v_value numeric;
    v_text text;
begin
    if p_new or p_body ? 'contract_id' then
        v_text := nullif(btrim(coalesce(p_body ->> 'contract_id', '')), '');
        if v_text is null then
            po.contract_id := null;
        else
            begin
                po.contract_id := v_text::uuid;
            exception when others then
                raise exception 'contract_id: Input should be a valid UUID' using errcode = 'PT422';
            end;
            select * into v_contract from public.contracts where id = po.contract_id;
            if not found then
                raise exception 'That contract does not exist.' using errcode = 'PT422';
            end if;
            if v_contract.kind <> 'client' then
                raise exception 'A PO sits under a client contract.' using errcode = 'PT422';
            end if;
        end if;
    end if;

    if p_new or p_body ? 'po_number' then
        v_text := btrim(coalesce(p_body ->> 'po_number', ''));
        if v_text = '' then
            raise exception 'po_number: Field required' using errcode = 'PT422';
        end if;
        if length(v_text) > 100 then
            raise exception 'po_number: String should have at most 100 characters' using errcode = 'PT422';
        end if;
        po.po_number := v_text;
    end if;

    if p_new or p_body ? 'client_name' then
        v_text := nullif(btrim(coalesce(p_body ->> 'client_name', '')), '');
        -- The account's client when the PO sits under one.
        if v_text is null and po.contract_id is not null then
            select coalesce(nullif(btrim(counterparty), ''), title) into v_text
              from public.contracts where id = po.contract_id;
        end if;
        if v_text is null then
            raise exception 'client_name: Field required' using errcode = 'PT422';
        end if;
        if length(v_text) > 200 then
            raise exception 'client_name: String should have at most 200 characters' using errcode = 'PT422';
        end if;
        po.client_name := v_text;
    end if;

    if p_body ? 'description' then po.description := nullif(p_body ->> 'description', ''); end if;
    if p_body ? 'notes' then po.notes := nullif(p_body ->> 'notes', ''); end if;

    if p_new or p_body ? 'po_date' then
        po.po_date := public._contracts_date(p_body, 'po_date');
        if po.po_date is null then
            raise exception 'po_date: Field required' using errcode = 'PT422';
        end if;
    end if;
    if p_body ? 'start_date' then po.start_date := public._contracts_date(p_body, 'start_date'); end if;
    if p_body ? 'end_date' then po.end_date := public._contracts_date(p_body, 'end_date'); end if;
    if po.start_date is not null and po.end_date is not null and po.end_date < po.start_date then
        raise exception 'A PO cannot end before it starts.' using errcode = 'PT422';
    end if;

    if p_body ? 'value' then
        if p_body ->> 'value' is null or p_body ->> 'value' = '' then
            po.value := null;
        else
            begin
                v_value := (p_body ->> 'value')::numeric;
            exception when others then
                raise exception 'value: Input should be a valid number' using errcode = 'PT422';
            end;
            if v_value < 0 then
                raise exception 'value: Input should be greater than or equal to 0' using errcode = 'PT422';
            end if;
            po.value := v_value;
        end if;
    end if;

    if p_body ? 'currency' and p_body ->> 'currency' is not null then
        po.currency := p_body ->> 'currency';
    elsif p_new then
        po.currency := coalesce(v_contract.currency, 'IDR');
    end if;
    if length(po.currency) <> 3 then
        raise exception 'currency: String should have 3 characters' using errcode = 'PT422';
    end if;

    if p_body ? 'status' and p_body ->> 'status' is not null then
        if p_body ->> 'status' not in ('active', 'completed', 'cancelled') then
            raise exception 'status: Input should be ''active'', ''completed'' or ''cancelled'''
                using errcode = 'PT422';
        end if;
        po.status := p_body ->> 'status';
    elsif p_new then
        po.status := 'active';
    end if;

    if exists (select 1 from public.purchase_orders x
                where lower(x.client_name) = lower(po.client_name)
                  and lower(x.po_number) = lower(po.po_number)
                  and x.id is distinct from po.id) then
        raise exception 'PO % is already recorded for %.', po.po_number, po.client_name
            using errcode = 'PT409';
    end if;

    return po;
end;
$$;

-- GET /purchase-orders?client=&contract_id=&status=&from=&to=&sort=
create or replace function public.purchase_orders_list(
    p_client text default null,
    p_contract_id uuid default null,
    p_status text default null,
    p_from date default null,
    p_to date default null,
    p_sort text default 'po_date'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_sort text := coalesce(nullif(p_sort, ''), 'po_date');
    v_today date := public.local_today();
    v_items jsonb;
begin
    perform public._contracts_require_read();
    if p_status is not null and p_status not in ('active', 'completed', 'cancelled') then
        raise exception 'status: Input should be ''active'', ''completed'' or ''cancelled'''
            using errcode = 'PT422';
    end if;
    if v_sort not in ('po_date', 'end_date') then
        raise exception 'sort: Input should be ''po_date'' or ''end_date''' using errcode = 'PT422';
    end if;

    -- PO date: newest first. End date: soonest first, open-ended last.
    select coalesce(jsonb_agg(public._po_serialise(po.id, v_today)
               order by case when v_sort = 'po_date' then po.po_date end desc,
                        case when v_sort = 'end_date' then po.end_date end asc nulls last,
                        po.po_date desc, po.created_at desc), '[]'::jsonb)
      into v_items
      from public.purchase_orders po
     where (p_client is null or btrim(p_client) = ''
            or po.client_name ilike '%' || btrim(p_client) || '%')
       and (p_contract_id is null or po.contract_id = p_contract_id)
       and (p_status is null or po.status = p_status)
       and (p_from is null or po.po_date >= p_from)
       and (p_to is null or po.po_date <= p_to);

    return jsonb_build_object('items', v_items, 'can_manage', public.contracts_can_manage());
end;
$$;

-- GET /purchase-orders/:id
create or replace function public.purchase_orders_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v jsonb;
begin
    perform public._contracts_require_read();
    v := public._po_serialise(p_id, public.local_today());
    if v is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return v;
end;
$$;

-- POST /purchase-orders
create or replace function public.purchase_orders_create(p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    po public.purchase_orders;
begin
    perform public._contracts_require_manage();
    po.id := gen_random_uuid();
    po := public._po_apply(po, coalesce(p_body, '{}'::jsonb), true);

    insert into public.purchase_orders
        (id, contract_id, po_number, client_name, description, po_date, start_date, end_date,
         value, currency, status, notes, created_by, updated_by)
    values (po.id, po.contract_id, po.po_number, po.client_name, po.description, po.po_date,
            po.start_date, po.end_date, po.value, po.currency, po.status, po.notes,
            auth.uid(), auth.uid());

    perform public.log_activity('PO_CREATED',
        format('Recorded PO %s for %s', po.po_number, po.client_name), po.id, null);

    return public._po_serialise(po.id, public.local_today());
end;
$$;

-- PATCH /purchase-orders/:id (only keys present are applied)
create or replace function public.purchase_orders_update(p_id uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    po public.purchase_orders;
begin
    perform public._contracts_require_manage();
    select * into po from public.purchase_orders where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    po := public._po_apply(po, coalesce(p_body, '{}'::jsonb), false);

    update public.purchase_orders
       set contract_id = po.contract_id, po_number = po.po_number, client_name = po.client_name,
           description = po.description, po_date = po.po_date, start_date = po.start_date,
           end_date = po.end_date, value = po.value, currency = po.currency,
           status = po.status, notes = po.notes, updated_by = auth.uid(), updated_at = now()
     where id = p_id;

    return public._po_serialise(p_id, public.local_today());
end;
$$;

-- DELETE /purchase-orders/:id -- answers the storage paths to remove.
create or replace function public.purchase_orders_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    po public.purchase_orders;
    v_paths jsonb;
begin
    perform public._contracts_require_manage();
    select * into po from public.purchase_orders where id = p_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_paths
      from public.purchase_order_documents where purchase_order_id = p_id;
    delete from public.purchase_orders where id = p_id;
    perform public.log_activity('PO_DELETED',
        format('Deleted PO %s for %s', po.po_number, po.client_name), p_id, null);
    return jsonb_build_object('storage_paths', v_paths);
end;
$$;

-- Documents: PDF, images, Word; 10 MB -- as on contracts.
create or replace function public.purchase_orders_check_document(
    p_id uuid, p_content_type text, p_byte_size bigint
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public._contracts_require_manage();
    if not exists (select 1 from public.purchase_orders where id = p_id) then
        raise exception 'Not found' using errcode = 'PT404';
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

create or replace function public.purchase_orders_add_document(
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
    v_number text;
    v_filename text;
begin
    perform public.purchase_orders_check_document(p_id, p_content_type, p_byte_size);
    select po_number into v_number from public.purchase_orders where id = p_id;

    v_filename := coalesce(nullif(p_filename, ''), 'po' || case p_content_type
        when 'application/pdf' then '.pdf'
        when 'image/jpeg' then '.jpg'
        when 'image/png' then '.png'
        when 'application/msword' then '.doc'
        else '.docx' end);

    insert into public.purchase_order_documents
        (id, purchase_order_id, filename, content_type, byte_size, storage_path, uploaded_by)
    values (coalesce(p_document_id, gen_random_uuid()), p_id, v_filename, p_content_type,
            p_byte_size, p_storage_path, auth.uid());

    perform public.log_activity('PO_DOCUMENT_ADDED',
        format('Attached %s to PO %s', v_filename, v_number), p_id, null);

    return public._po_serialise(p_id, public.local_today());
end;
$$;

create or replace function public.purchase_orders_get_document(p_id uuid, p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    d public.purchase_order_documents;
begin
    perform public._contracts_require_read();
    select * into d from public.purchase_order_documents
     where id = p_document_id and purchase_order_id = p_id;
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

create or replace function public.purchase_orders_delete_document(p_id uuid, p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_path text;
begin
    perform public._contracts_require_manage();
    if not exists (select 1 from public.purchase_orders where id = p_id) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    delete from public.purchase_order_documents
     where id = p_document_id and purchase_order_id = p_id
    returning storage_path into v_path;
    if v_path is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return jsonb_build_object(
        'purchase_order', public._po_serialise(p_id, public.local_today()),
        'storage_path', v_path
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Coming up: renewals and PO ends, soonest first.
--
-- Contracts: active, ending within 90 days; or already ended while still
-- active and not every warning acknowledged (a contract with no warnings at
-- all counts as unacknowledged). POs: active, ending within 60 days.
-- ---------------------------------------------------------------------------
create or replace function public._contracts_coming_up(p_today date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(jsonb_agg(to_jsonb(x) order by x.days_remaining, x.label), '[]'::jsonb)
      from (
          select 'contract'::text as kind,
                 c.id,
                 c.id as contract_id,
                 c.title::text as label,
                 coalesce(nullif(btrim(c.counterparty), ''), c.title)::text as client,
                 c.kind::text as contract_kind,
                 to_char(c.end_date, 'YYYY-MM-DD') as end_date,
                 (c.end_date - p_today) as days_remaining,
                 (c.end_date < p_today) as overdue
            from public.contracts c
           where c.status = 'active'
             and c.end_date <= p_today + 90
             and (c.end_date >= p_today
                  or not exists (select 1 from public.contract_reminders r
                                  where r.contract_id = c.id)
                  or exists (select 1 from public.contract_reminders r
                              where r.contract_id = c.id and r.acknowledged_at is null))
          union all
          select 'purchase_order',
                 po.id,
                 po.contract_id,
                 po.po_number::text,
                 po.client_name::text,
                 null,
                 to_char(po.end_date, 'YYYY-MM-DD'),
                 (po.end_date - p_today),
                 false
            from public.purchase_orders po
           where po.status = 'active'
             and po.end_date between p_today and p_today + 60
      ) x;
$$;

-- GET /contracts/coming-up
create or replace function public.contracts_coming_up()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public._contracts_require_read();
    return jsonb_build_object('items', public._contracts_coming_up(public.local_today()));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Renewal emails: to contract managers and finance, when a contract or PO
-- first comes within 60, 30 or 7 days of its end. Once per item per
-- threshold (and per end date). Nothing for what has already ended.
-- ---------------------------------------------------------------------------
create or replace function public.contracts_renewal_recipients()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(array_agg(u.id order by u.created_at, u.id), '{}')
      from public.users u
     where u.is_active
       and (u.role::text in ('director', 'executive', 'finance')
            or exists (select 1 from public.employees e
                        where e.user_id = u.id and e.is_active and e.can_manage_contracts));
$$;

create or replace function public.contracts_send_renewal_notices(p_today date default public.local_today())
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r record;
    v_threshold int;
    v_when text;
    v_sent int := 0;
    v_recipients uuid[] := public.contracts_renewal_recipients();
begin
    for r in
        select 'contract'::text as kind, c.id, c.title::text as label,
               coalesce(nullif(btrim(c.counterparty), ''), c.title)::text as client,
               c.kind::text as contract_kind, c.end_date, (c.end_date - p_today) as days
          from public.contracts c
         where c.status = 'active' and c.end_date between p_today and p_today + 60
        union all
        select 'purchase_order', po.id, po.po_number::text, po.client_name::text,
               null, po.end_date, (po.end_date - p_today)
          from public.purchase_orders po
         where po.status = 'active' and po.end_date between p_today and p_today + 60
        order by 7, 3
    loop
        v_threshold := case when r.days <= 7 then 7 when r.days <= 30 then 30 else 60 end;
        -- Already told at this threshold or a tighter one.
        if exists (select 1 from public.renewal_notices n
                    where n.item_kind = r.kind and n.item_id = r.id
                      and n.end_date = r.end_date and n.threshold <= v_threshold) then
            continue;
        end if;
        insert into public.renewal_notices (item_kind, item_id, end_date, threshold)
        values (r.kind, r.id, r.end_date, v_threshold);

        v_when := case when r.days = 0 then 'today'
                       when r.days = 1 then 'tomorrow'
                       else 'in ' || r.days || ' days' end;
        if r.kind = 'contract' then
            perform public.notifications_enqueue(
                v_recipients, '{}',
                'contract_renewal',
                format('Contract with %s ends %s', r.client, v_when),
                array[
                    format('The %s contract %s%s ends on %s, %s.',
                           r.contract_kind, r.label,
                           case when r.client <> r.label then ' with ' || r.client else '' end,
                           public.notifications_date(r.end_date), v_when),
                    'If it is being renewed, record the new end date or mark it renewed on Contracts & POs.'
                ],
                '/contracts', 'Open Contracts & POs', 'contracts', r.id);
        else
            perform public.notifications_enqueue(
                v_recipients, '{}',
                'po_ending',
                format('PO %s (%s) ends %s', r.label, r.client, v_when),
                array[
                    format('Purchase order %s from %s ends on %s, %s.',
                           r.label, r.client, public.notifications_date(r.end_date), v_when),
                    'If the work continues, a new PO or an extension will be needed.'
                ],
                '/contracts?tab=po', 'Open Contracts & POs', 'purchase_orders', r.id);
        end if;
        v_sent := v_sent + 1;
    end loop;
    return v_sent;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.contracts_can_manage()                                   from public;
revoke all on function public.contracts_can_read()                                     from public;
revoke all on function public._contracts_serialise(uuid, date)                         from public;
revoke all on function public._po_serialise(uuid, date)                                from public;
revoke all on function public._po_apply(public.purchase_orders, jsonb, boolean)        from public;
revoke all on function public.purchase_orders_list(text, uuid, text, date, date, text) from public;
revoke all on function public.purchase_orders_get(uuid)                                from public;
revoke all on function public.purchase_orders_create(jsonb)                            from public;
revoke all on function public.purchase_orders_update(uuid, jsonb)                      from public;
revoke all on function public.purchase_orders_delete(uuid)                             from public;
revoke all on function public.purchase_orders_check_document(uuid, text, bigint)       from public;
revoke all on function public.purchase_orders_add_document(uuid, uuid, text, text, bigint, text) from public;
revoke all on function public.purchase_orders_get_document(uuid, uuid)                 from public;
revoke all on function public.purchase_orders_delete_document(uuid, uuid)              from public;
revoke all on function public._contracts_coming_up(date)                               from public;
revoke all on function public.contracts_coming_up()                                    from public;
revoke all on function public.contracts_renewal_recipients()                           from public;
revoke all on function public.contracts_send_renewal_notices(date)                     from public;

grant execute on function public.contracts_can_manage()                                   to authenticated;
grant execute on function public.contracts_can_read()                                     to authenticated;
grant execute on function public.purchase_orders_list(text, uuid, text, date, date, text) to authenticated;
grant execute on function public.purchase_orders_get(uuid)                                to authenticated;
grant execute on function public.purchase_orders_create(jsonb)                            to authenticated;
grant execute on function public.purchase_orders_update(uuid, jsonb)                      to authenticated;
grant execute on function public.purchase_orders_delete(uuid)                             to authenticated;
grant execute on function public.purchase_orders_check_document(uuid, text, bigint)       to authenticated;
grant execute on function public.purchase_orders_add_document(uuid, uuid, text, text, bigint, text) to authenticated;
grant execute on function public.purchase_orders_get_document(uuid, uuid)                 to authenticated;
grant execute on function public.purchase_orders_delete_document(uuid, uuid)              to authenticated;
grant execute on function public.contracts_coming_up()                                    to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Storage: private bucket, readable by contract readers, writable by
-- contract managers. Guarded: the test database has no storage schema.
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('purchase-order-documents', 'purchase-order-documents', false)
    on conflict (id) do nothing;

    drop policy if exists "purchase order documents: readers read"    on storage.objects;
    drop policy if exists "purchase order documents: managers upload" on storage.objects;
    drop policy if exists "purchase order documents: managers delete" on storage.objects;

    create policy "purchase order documents: readers read" on storage.objects
        for select to authenticated
        using (bucket_id = 'purchase-order-documents' and public.contracts_can_read());
    create policy "purchase order documents: managers upload" on storage.objects
        for insert to authenticated
        with check (bucket_id = 'purchase-order-documents' and public.contracts_can_manage());
    create policy "purchase order documents: managers delete" on storage.objects
        for delete to authenticated
        using (bucket_id = 'purchase-order-documents' and public.contracts_can_manage());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Schedule: renewal emails once a day, 08:00 in Jakarta (01:00 UTC).
--    Only where pg_cron exists (the hosted database, not the test one).
-- ---------------------------------------------------------------------------
do $$
begin
    if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
        begin
            create extension if not exists pg_cron;
        exception when others then
            raise notice 'contract-renewal-notices not scheduled: %', sqlerrm;
        end;
    end if;

    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.schedule(
            'contract-renewal-notices',
            '0 1 * * *',
            $cron$select public.contracts_send_renewal_notices();$cron$);
    end if;
end
$$;

commit;
