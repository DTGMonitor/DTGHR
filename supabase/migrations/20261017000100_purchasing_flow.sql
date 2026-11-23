-- ===========================================================================
-- Purchasing flow (Route 2: purchases above the petty-cash limit).
-- openspec/changes/add-purchasing-flow.
--
-- The company's purchasing procedure keeps two pairs apart: approving money
-- from recording money (Peter, the executive, approves and releases; finance
-- keeps the books), and buying from receiving (a second employee, never the
-- requester and never finance, checks the goods in). Here:
--
--   request (anyone) -> finance registers PR-0001 -> quotes and evidence by
--   tier -> Peter approves vendor and price -> finance issues PO-0001 and
--   names the checker -> the checker records the GRN with a photo -> finance
--   matches PO + GRN + invoice -> a finance request for the net payable is
--   created and submitted, and the existing chain pays it.
--
--   * The tier counts the vendor's other approved purchases in the same
--     month, so splitting an order does not lower it.
--   * Urgent purchases carry Peter's WhatsApp / phone approval, skip quoting,
--     and cannot be matched until Peter confirms on the platform.
--   * Asset lines wait for IT to register them; the asset keeps the line.
--   * The requester asks in general terms (items, quantities, notes) and
--     tracks five milestones; finance turns the items into priced lines. The
--     requester never sees the lines, vendor, amounts, checker or payment.
--   * Screens and messages name the role ("the approver"), not a person.
--   * Vendors: finance adds them; only Peter changes a bank account, with the
--     callback he made to the number on file.
--
-- Outgoing orders live on `purchases`. `purchase_orders` (20260929000100)
-- holds client POs, which an inventory line may point at.
--
-- Redefined here, each from its latest definition:
--   finance_request_json   (20260930001000) + purchase
--   finance_apply_body     (20260926000800) + a linked request keeps its amount
--   finance_mark_paid      (20260926000800) + transfer proof; pays the purchase
--   assets_serialise       (20261016000100) + purchase
-- Safe to re-run.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------

create table if not exists public.vendors (
    id                  uuid primary key default gen_random_uuid(),
    name                varchar(200) not null,
    npwp                varchar(30),
    is_pkp              boolean not null default false,
    contact_name        varchar(160),
    phone               varchar(40),
    email               varchar(200),
    bank_name           varchar(100),
    bank_account_number varchar(40),
    bank_account_holder varchar(160),
    is_active           boolean not null default true,
    notes               text,
    created_by          uuid references public.users(id) on delete set null,
    updated_by          uuid references public.users(id) on delete set null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create unique index if not exists ux_vendors_name on public.vendors (lower(btrim(name)));
create unique index if not exists ux_vendors_npwp
    on public.vendors (regexp_replace(npwp, '[^0-9A-Za-z]', '', 'g')) where npwp is not null;

-- Append-only: no function updates or deletes a row.
create table if not exists public.vendor_events (
    id         uuid primary key default gen_random_uuid(),
    seq        bigint generated always as identity,
    vendor_id  uuid not null references public.vendors(id) on delete cascade,
    kind       varchar(20) not null,
    actor_id   uuid references public.users(id) on delete set null,
    actor_name varchar(160) not null,
    before     jsonb,
    after      jsonb,
    note       text,
    detail     jsonb,
    created_at timestamptz not null default clock_timestamp(),
    constraint ck_vendor_events_kind
        check (kind in ('created', 'edited', 'bank_changed', 'deactivated', 'reactivated'))
);
create index if not exists ix_vendor_events_vendor on public.vendor_events (vendor_id, seq);

-- One row: the limits, and the PR and PO counters.
create table if not exists public.purchase_settings (
    id               integer primary key default 1,
    petty_cash_limit numeric(18, 2) not null default 500000,
    simple_limit     numeric(18, 2) not null default 5000000,
    quotation_limit  numeric(18, 2) not null default 50000000,
    next_pr          integer not null default 1,
    next_po          integer not null default 1,
    updated_by       uuid references public.users(id) on delete set null,
    updated_at       timestamptz not null default now(),
    constraint ck_purchase_settings_one check (id = 1),
    constraint ck_purchase_settings_order
        check (petty_cash_limit >= 0 and petty_cash_limit < simple_limit and simple_limit < quotation_limit)
);
insert into public.purchase_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.purchases (
    id                       uuid primary key default gen_random_uuid(),
    reference                varchar(12),
    order_number             varchar(12),
    title                    varchar(200) not null,
    purpose                  text,
    needed_by                date,
    cost_code                varchar(60),
    budget_confirmed         boolean not null default false,
    budget_exception_note    text,
    status                   varchar(20) not null default 'draft',
    requester_id             uuid not null references public.users(id),
    vendor_id                uuid references public.vendors(id),
    estimated_total          numeric(18, 2) not null default 0,
    approval_amount          numeric(18, 2),
    approved_amount          numeric(18, 2),
    tier                     varchar(12),
    route_value              numeric(18, 2),
    related_party            boolean,
    related_party_note       text,
    sole_source              boolean not null default false,
    sole_source_note         text,
    shareholders_informed_on date,
    urgent                   boolean not null default false,
    urgent_channel           varchar(10),
    urgent_approved_at       timestamptz,
    urgent_vendor_name       varchar(200),
    urgent_amount            numeric(18, 2),
    urgent_note              text,
    urgent_confirmed_at      timestamptz,
    urgent_confirmed_by      uuid references public.users(id) on delete set null,
    late_entry               boolean not null default false,
    self_approved            boolean not null default false,
    submitted_at             timestamptz,
    registered_at            timestamptz,
    registered_by            uuid references public.users(id) on delete set null,
    sent_for_approval_at     timestamptz,
    approved_by              uuid references public.users(id) on delete set null,
    approved_at              timestamptz,
    checker_id               uuid references public.users(id),
    ordered_at               timestamptz,
    delivery_round_at        timestamptz,
    grn_at                   timestamptz,
    grn_by                   uuid references public.users(id) on delete set null,
    grn_note                 text,
    invoice_number           varchar(60),
    invoice_date             date,
    invoice_total            numeric(18, 2),
    ppn_amount               numeric(18, 2),
    pph_amount               numeric(18, 2),
    amount_review_amount     numeric(18, 2),
    finance_request_id       uuid references public.finance_requests(id) on delete set null,
    matched_at               timestamptz,
    paid_on                  date,
    cancel_reason            text,
    cancelled_at             timestamptz,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),
    constraint ck_purchases_status check (status in (
        'draft', 'submitted', 'sourcing', 'awaiting_approval', 'approved', 'ordered',
        'received', 'amount_review', 'matched', 'paid', 'cancelled', 'petty_cash')),
    constraint ck_purchases_tier check (tier is null or tier in ('simple', 'quotation', 'contract')),
    constraint ck_purchases_channel check (urgent_channel is null or urgent_channel in ('whatsapp', 'phone')),
    constraint ck_purchases_amounts check (
        estimated_total >= 0
        and coalesce(approval_amount, 0) >= 0 and coalesce(approved_amount, 0) >= 0
        and coalesce(urgent_amount, 0) >= 0 and coalesce(invoice_total, 0) >= 0
        and coalesce(ppn_amount, 0) >= 0 and coalesce(pph_amount, 0) >= 0
        and coalesce(amount_review_amount, 0) >= 0)
);
create unique index if not exists ux_purchases_reference on public.purchases (reference) where reference is not null;
create unique index if not exists ux_purchases_order on public.purchases (order_number) where order_number is not null;
create index if not exists ix_purchases_status    on public.purchases (status);
create index if not exists ix_purchases_vendor    on public.purchases (vendor_id);
create index if not exists ix_purchases_requester on public.purchases (requester_id);
create index if not exists ix_purchases_checker   on public.purchases (checker_id);
create index if not exists ix_purchases_approved  on public.purchases (approved_at);

create table if not exists public.purchase_lines (
    id                uuid primary key default gen_random_uuid(),
    purchase_id       uuid not null references public.purchases(id) on delete cascade,
    sort_order        integer not null default 0,
    line_type         varchar(10) not null,
    description       varchar(300) not null,
    specification     text,
    quantity          numeric(14, 3) not null,
    unit              varchar(20) not null default 'pcs',
    unit_price        numeric(18, 2) not null default 0,
    asset_category_id uuid references public.asset_categories(id),
    client_ref        varchar(120),
    client_po_id      uuid references public.purchase_orders(id) on delete set null,
    qty_received      numeric(14, 3),
    condition_note    text,
    created_at        timestamptz not null default now(),
    constraint ck_purchase_lines_type check (line_type in ('asset', 'inventory', 'expense')),
    constraint ck_purchase_lines_qty check (quantity > 0),
    constraint ck_purchase_lines_price check (unit_price >= 0),
    constraint ck_purchase_lines_category check ((line_type = 'asset') = (asset_category_id is not null)),
    constraint ck_purchase_lines_client_po check (client_po_id is null or line_type = 'inventory'),
    constraint ck_purchase_lines_received check (qty_received is null or (qty_received >= 0 and qty_received <= quantity))
);
create index if not exists ix_purchase_lines_purchase on public.purchase_lines (purchase_id, sort_order);

-- What the requester asked for, in their own words: a generic item, how many,
-- and a note for a preference or minimum need. Finance's purchase_lines are
-- seeded from these at registration; these stay as the requester wrote them.
create table if not exists public.purchase_request_items (
    id          uuid primary key default gen_random_uuid(),
    purchase_id uuid not null references public.purchases(id) on delete cascade,
    sort_order  integer not null default 0,
    description varchar(200) not null,
    quantity    numeric(14, 3) not null,
    note        varchar(1000),
    created_at  timestamptz not null default now(),
    constraint ck_purchase_request_items_qty check (quantity > 0)
);
create index if not exists ix_purchase_request_items_purchase
    on public.purchase_request_items (purchase_id, sort_order);

create table if not exists public.purchase_documents (
    id               uuid primary key default gen_random_uuid(),
    purchase_id      uuid not null references public.purchases(id) on delete cascade,
    kind             varchar(20) not null,
    filename         varchar(255) not null,
    content_type     varchar(120) not null,
    byte_size        integer not null,
    storage_path     varchar(500) not null,
    uploaded_by      uuid references public.users(id) on delete set null,
    uploaded_by_name varchar(160),
    created_at       timestamptz not null default clock_timestamp(),
    constraint ck_purchase_documents_kind check (kind in (
        'request', 'quote', 'comparison', 'contract', 'approval_evidence', 'budget_exception',
        'delivery_photo', 'delivery_note', 'invoice', 'tax_invoice', 'other'))
);
create index if not exists ix_purchase_documents_purchase on public.purchase_documents (purchase_id, kind);
create unique index if not exists ux_purchase_documents_path on public.purchase_documents (storage_path);

-- Append-only. seq keeps the written order where two events share a time.
create table if not exists public.purchase_events (
    id          uuid primary key default gen_random_uuid(),
    seq         bigint generated always as identity,
    purchase_id uuid not null references public.purchases(id) on delete cascade,
    kind        varchar(30) not null,
    actor_id    uuid references public.users(id) on delete set null,
    actor_name  varchar(160) not null,
    from_status varchar(20),
    to_status   varchar(20),
    note        text,
    detail      jsonb,
    created_at  timestamptz not null default clock_timestamp()
);
create index if not exists ix_purchase_events_purchase on public.purchase_events (purchase_id, seq);

alter table public.finance_requests
    add column if not exists purchase_id uuid references public.purchases(id) on delete set null;
create unique index if not exists ux_finance_requests_purchase
    on public.finance_requests (purchase_id) where purchase_id is not null;

alter table public.assets
    add column if not exists purchase_line_id uuid references public.purchase_lines(id) on delete set null;
create index if not exists ix_assets_purchase_line on public.assets (purchase_line_id);

alter table public.vendors            enable row level security;
alter table public.vendor_events      enable row level security;
alter table public.purchase_settings  enable row level security;
alter table public.purchases          enable row level security;
alter table public.purchase_lines     enable row level security;
alter table public.purchase_request_items enable row level security;
alter table public.purchase_documents enable row level security;
alter table public.purchase_events    enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Helpers (not callable by clients).
-- ---------------------------------------------------------------------------

create or replace function public.purchases_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.current_user_role()::text, '');
$$;

-- Finance, the director and Peter see every purchase in full.
create or replace function public.purchases_is_full_viewer()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.purchases_role() in ('finance', 'director', 'executive');
$$;

create or replace function public.purchases_require_auth()
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
end;
$$;

create or replace function public.purchases_require_role(p_role text, p_message text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if public.purchases_role() <> p_role then
        raise exception '%', p_message using errcode = 'PT403';
    end if;
end;
$$;

create or replace function public.purchases_load(p_id uuid)
returns public.purchases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
begin
    select * into r from public.purchases where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return r;
end;
$$;

create or replace function public.purchases_label(r public.purchases)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
    select coalesce(r.reference, 'The request');
$$;

create or replace function public.purchases_require_status(r public.purchases, p_states text[], p_action text)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
    if not (r.status = any (p_states)) then
        raise exception '% is %; it can''t be % now.',
            public.purchases_label(r), replace(r.status, '_', ' '), p_action
            using errcode = 'PT409';
    end if;
end;
$$;

create or replace function public.purchases_user_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (select nullif(trim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), '')
           from public.employees e where e.user_id = p_user limit 1),
        (select nullif(btrim(u.full_name), '') from public.users u where u.id = p_user));
$$;

create or replace function public.purchases_actor_name()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.purchases_user_name(auth.uid()),
                    case when auth.uid() is null then 'Automatic' else 'Someone' end);
$$;

create or replace function public.purchases_money(p numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case when p is null then null
                else 'IDR ' || to_char(round(p), 'FM999,999,999,999,999,990') end;
$$;

create or replace function public.purchases_event(
    p_purchase_id uuid,
    p_kind text,
    p_from text,
    p_to text,
    p_note text default null,
    p_detail jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.purchase_events (purchase_id, kind, actor_id, actor_name, from_status, to_status,
                                        note, detail, created_at)
    values (p_purchase_id, p_kind, auth.uid(), left(public.purchases_actor_name(), 160), p_from, p_to,
            nullif(btrim(coalesce(p_note, '')), ''), p_detail, clock_timestamp());
end;
$$;

-- A notification about one purchase. The actor is never told about their own
-- action, and a failure never undoes the change.
create or replace function public.purchases_notify(
    p_to uuid[],
    p_kind text,
    p_tone text,
    p_purchase_id uuid,
    p_headline text,
    p_intro text,
    p_note text default null,
    p_note_by text default null,
    p_link_path text default null,
    p_link_label text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
    v_vendor text;
begin
    begin
        select * into r from public.purchases where id = p_purchase_id;
        select v.name into v_vendor from public.vendors v where v.id = r.vendor_id;
        perform public.notifications_enqueue(
            p_to,
            array_remove(array[auth.uid()], null),
            p_kind,
            coalesce(r.reference || ': ', '') || p_headline,
            public.notifications_payload(
                p_tone, 'Purchase ' || coalesce(r.reference, ''),
                p_headline,
                p_intro,
                array['Purchase', r.title,
                      'Order', coalesce(r.order_number, ''),
                      'Vendor', coalesce(v_vendor, ''),
                      'Requested by', coalesce(public.purchases_user_name(r.requester_id), '')],
                p_note, p_note_by,
                coalesce(p_link_path, '/purchasing?open=' || r.id),
                coalesce(p_link_label, 'Open the purchase')),
            'purchases', r.id);
    exception when others then
        raise warning 'purchases_notify %: %', p_kind, sqlerrm;
    end;
end;
$$;

-- The requester's notification: their purchase in general terms only -- its
-- title and numbers, never the vendor, an amount, the checker or the
-- approver. Not sent when the requester is the one acting.
create or replace function public.purchases_notify_requester(
    p_purchase_id uuid,
    p_kind text,
    p_tone text,
    p_headline text,
    p_intro text,
    p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
begin
    begin
        select * into r from public.purchases where id = p_purchase_id;
        perform public.notifications_enqueue(
            array[r.requester_id],
            array_remove(array[auth.uid()], null),
            p_kind,
            coalesce(r.reference || ': ', '') || p_headline,
            public.notifications_payload(
                p_tone, 'Your purchase request',
                p_headline,
                p_intro,
                array['Request', r.title,
                      'Reference', coalesce(r.reference, ''),
                      'Order', coalesce(r.order_number, '')],
                p_note, null,
                '/purchasing?open=' || r.id, 'Track your request'),
            'purchases', r.id);
    exception when others then
        raise warning 'purchases_notify_requester %: %', p_kind, sqlerrm;
    end;
end;
$$;

-- Settle these kinds of open action item on a purchase, for one recipient or all.
create or replace function public.purchases_settle(
    p_purchase_id uuid,
    p_kinds text[],
    p_status text,
    p_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    begin
        update public.notifications
           set resolved_at = now(),
               resolved_by = auth.uid(),
               resolved_by_name = public.notifications_actor_name(),
               resolved_status = p_status
         where source_table = 'purchases'
           and source_id = p_purchase_id
           and resolved_at is null
           and needs_action
           and kind = any (coalesce(p_kinds, '{}'))
           and created_at < now()
           and (p_user_id is null or user_id = p_user_id);
    exception when others then
        raise warning 'purchases_settle: %', sqlerrm;
    end;
end;
$$;

create or replace function public.purchases_settings_row()
returns public.purchase_settings
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select * from public.purchase_settings where id = 1;
$$;

create or replace function public.purchases_field_bool(p jsonb, p_key text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    if p ->> p_key is null then
        return null;
    end if;
    return (p ->> p_key)::boolean;
exception when others then
    raise exception '%: must be true or false', p_key using errcode = 'PT422';
end;
$$;

create or replace function public.purchases_field_uuid(p jsonb, p_key text)
returns uuid
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    return nullif(btrim(coalesce(p ->> p_key, '')), '')::uuid;
exception when others then
    raise exception '%: is not a valid id', p_key using errcode = 'PT422';
end;
$$;

create or replace function public.purchases_field_time(p jsonb, p_key text)
returns timestamptz
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    return nullif(btrim(coalesce(p ->> p_key, '')), '')::timestamptz;
exception when others then
    raise exception '%: must be a date and time', p_key using errcode = 'PT422';
end;
$$;

-- The approved amounts of a vendor's other purchases in the month of p_day
-- (Asia/Jakarta), from approval onwards; cancelled ones do not count.
create or replace function public.purchases_month_total(p_vendor_id uuid, p_exclude uuid, p_day date)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(sum(p.approved_amount), 0)
      from public.purchases p
     where p.vendor_id = p_vendor_id
       and p.id <> coalesce(p_exclude, '00000000-0000-0000-0000-000000000000'::uuid)
       and p.status in ('approved', 'ordered', 'received', 'amount_review', 'matched', 'paid')
       and date_trunc('month', (coalesce(p.approved_at, p.urgent_approved_at) at time zone 'Asia/Jakarta'))
           = date_trunc('month', p_day::timestamp);
$$;

create or replace function public.purchases_tier(p_value numeric)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select case when p_value <= s.simple_limit then 'simple'
                when p_value <= s.quotation_limit then 'quotation'
                else 'contract' end
      from public.purchase_settings s where s.id = 1;
$$;

-- The live route: this purchase's amount plus the vendor's month so far.
create or replace function public.purchases_route(r public.purchases)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_amount numeric := coalesce(r.approval_amount, r.estimated_total, 0);
    v_month numeric := 0;
    v_value numeric;
begin
    if r.vendor_id is not null then
        v_month := public.purchases_month_total(r.vendor_id, r.id, public.local_today());
    end if;
    v_value := v_amount + v_month;
    return jsonb_build_object('amount', v_amount, 'vendor_month', v_month,
                              'route_value', v_value, 'tier', public.purchases_tier(v_value));
end;
$$;

create or replace function public.purchases_doc_count(p_purchase_id uuid, p_kind text)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select count(*)::int from public.purchase_documents d
     where d.purchase_id = p_purchase_id and d.kind = p_kind;
$$;

-- What is still missing before the purchase can go to Peter.
create or replace function public.purchases_missing(r public.purchases)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_out text[] := '{}';
    v_tier text := public.purchases_route(r) ->> 'tier';
    v_need int;
    v_have int := public.purchases_doc_count(r.id, 'quote');
    v_vendor public.vendors;
begin
    select * into v_vendor from public.vendors where id = r.vendor_id;
    -- Each appended literal is cast: an untyped literal after text[] || would
    -- be read as an array.
    if v_vendor.id is null then
        v_out := v_out || 'a vendor'::text;
    elsif not v_vendor.is_active then
        v_out := v_out || 'an active vendor'::text;
    end if;
    if coalesce(r.approval_amount, 0) <= 0 then
        v_out := v_out || 'the amount to approve'::text;
    end if;
    if r.related_party is null then
        v_out := v_out || 'the related-party answer'::text;
    elsif r.related_party and coalesce(btrim(r.related_party_note), '') = '' then
        v_out := v_out || 'the related-party declaration'::text;
    end if;
    if r.sole_source and coalesce(btrim(r.sole_source_note), '') = '' then
        v_out := v_out || 'the sole-source justification and price benchmark'::text;
    end if;
    v_need := case when r.sole_source then 1
                   when v_tier = 'simple' then 1
                   when v_tier = 'quotation' then 2
                   else 3 end;
    if v_have < v_need then
        v_out := v_out || (case when v_need = 1 then 'a quote'
                                else format('%s quotes (%s attached)', v_need, v_have) end)::text;
    end if;
    if v_tier in ('quotation', 'contract') and not r.sole_source
       and public.purchases_doc_count(r.id, 'comparison') = 0 then
        v_out := v_out || 'a comparison sheet'::text;
    end if;
    if v_tier = 'contract' then
        if public.purchases_doc_count(r.id, 'contract') = 0 then
            v_out := v_out || 'the draft contract'::text;
        end if;
        if r.shareholders_informed_on is null then
            v_out := v_out || 'the date the shareholders were informed'::text;
        end if;
    end if;
    return v_out;
end;
$$;

-- How the caller sees a purchase: full, requester, checker, or not at all.
create or replace function public.purchases_shape(r public.purchases)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select case
        when auth.uid() is null then null
        when public.purchases_is_full_viewer() then 'full'
        when r.requester_id = auth.uid() then 'requester'
        when r.checker_id = auth.uid()
             and r.status in ('ordered', 'received', 'amount_review', 'matched', 'paid') then 'checker'
    end;
$$;

-- What the caller may do next.
create or replace function public.purchases_can(r public.purchases)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid uuid := auth.uid();
    v_role text := public.purchases_role();
    v_out text[] := '{}';
begin
    if v_uid is null then
        return v_out;
    end if;
    if r.requester_id = v_uid then
        if r.status = 'draft' then
            v_out := v_out || array['edit', 'delete', 'submit', 'cancel', 'add_document'];
        elsif r.status = 'submitted' then
            v_out := v_out || array['cancel', 'add_document'];
        end if;
    end if;
    if v_role = 'finance' then
        if r.status = 'submitted' then
            v_out := v_out || array['register', 'return', 'close_petty_cash'];
        elsif r.status = 'sourcing' then
            v_out := v_out || array['source', 'send_for_approval'];
        elsif r.status = 'approved' then
            v_out := v_out || array['issue_order'];
        elsif r.status = 'ordered' then
            v_out := v_out || array['change_checker'];
        elsif r.status = 'received' then
            v_out := v_out || array['ask_amount'];
            if not (r.urgent and r.urgent_confirmed_at is null) then
                v_out := v_out || array['match'];
            end if;
        end if;
        if r.status in ('sourcing', 'awaiting_approval', 'approved', 'ordered') then
            v_out := v_out || array['cancel'];
        end if;
        if r.status not in ('draft', 'paid', 'cancelled', 'petty_cash') then
            v_out := v_out || array['add_document'];
        end if;
    end if;
    if v_role = 'executive' then
        if r.status = 'awaiting_approval' then
            v_out := v_out || array['approve', 'send_back', 'reject'];
        end if;
        if r.urgent and r.urgent_confirmed_at is null
           and r.status in ('approved', 'ordered', 'received', 'amount_review') then
            v_out := v_out || array['confirm_urgent'];
        end if;
        if r.status = 'amount_review' then
            v_out := v_out || array['decide_amount'];
        end if;
    end if;
    if r.checker_id = v_uid and r.status = 'ordered' then
        v_out := v_out || array['receive', 'add_document'];
    end if;
    return array(select distinct x from unnest(v_out) x order by 1);
end;
$$;

drop function if exists public.purchases_write_lines(uuid, jsonb);
drop function if exists public.purchases_fix_lines(uuid, jsonb);

-- One purchase line, as finance writes it.
create or replace function public.purchases_check_line(
    p_n int,
    p_type text,
    p_description text,
    p_quantity numeric,
    p_unit_price numeric,
    p_category uuid,
    p_client_po uuid,
    p_new_category boolean
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_cat public.asset_categories;
begin
    if p_type is null or p_type not in ('asset', 'inventory', 'expense') then
        raise exception 'lines[%].line_type: must be asset, inventory or expense', p_n using errcode = 'PT422';
    end if;
    if p_description is null or char_length(p_description) > 300 then
        raise exception 'lines[%].description: say what it is (up to 300 characters)', p_n using errcode = 'PT422';
    end if;
    if p_quantity is null or p_quantity <= 0 then
        raise exception 'lines[%].quantity: must be greater than zero', p_n using errcode = 'PT422';
    end if;
    if p_unit_price is null or p_unit_price < 0 then
        raise exception 'lines[%].unit_price: must not be negative', p_n using errcode = 'PT422';
    end if;
    if p_type = 'asset' then
        if p_category is null then
            raise exception 'lines[%].asset_category_id: an asset line needs a category', p_n using errcode = 'PT422';
        end if;
        select * into v_cat from public.asset_categories where id = p_category;
        if v_cat.id is null then
            raise exception 'lines[%].asset_category_id: unknown category', p_n using errcode = 'PT422';
        end if;
        if p_new_category and not v_cat.is_active then
            raise exception 'lines[%].asset_category_id: % is no longer in use', p_n, v_cat.name using errcode = 'PT422';
        end if;
        if p_quantity <> trunc(p_quantity) then
            raise exception 'lines[%].quantity: assets are counted in whole items', p_n using errcode = 'PT422';
        end if;
    end if;
    if p_client_po is not null then
        if p_type <> 'inventory' then
            raise exception 'lines[%].client_po_id: only an inventory line names a client PO', p_n using errcode = 'PT422';
        end if;
        if not exists (select 1 from public.purchase_orders po where po.id = p_client_po) then
            raise exception 'lines[%].client_po_id: unknown client PO', p_n using errcode = 'PT422';
        end if;
    end if;
end;
$$;

create or replace function public.purchases_recompute_total(p_purchase_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
    update public.purchases p
       set estimated_total = coalesce((select round(sum(l.quantity * l.unit_price), 2)
                                         from public.purchase_lines l where l.purchase_id = p.id), 0),
           updated_at = now()
     where p.id = p_purchase_id;
$$;

-- The requester's items, replaced wholesale: a generic description, how many,
-- and a note for a preference or minimum need. No prices, no types.
create or replace function public.purchases_write_items(p_purchase_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_item jsonb;
    v_n int := 0;
    v_desc text;
    v_qty numeric;
begin
    if p_items is null or jsonb_typeof(p_items) <> 'array' then
        raise exception 'items: must be a list' using errcode = 'PT422';
    end if;
    if jsonb_array_length(p_items) > 50 then
        raise exception 'items: at most 50 items' using errcode = 'PT422';
    end if;
    delete from public.purchase_request_items where purchase_id = p_purchase_id;
    for v_item in select * from jsonb_array_elements(p_items) loop
        v_n := v_n + 1;
        if jsonb_typeof(v_item) <> 'object' then
            raise exception 'items[%]: must be an object', v_n using errcode = 'PT422';
        end if;
        v_desc := public.assets_field_text(v_item, 'description', 200);
        if v_desc is null then
            raise exception 'items[%].description: say what is needed', v_n using errcode = 'PT422';
        end if;
        v_qty := public.assets_field_numeric(v_item, 'quantity');
        if v_qty is null or v_qty <= 0 then
            raise exception 'items[%].quantity: must be greater than zero', v_n using errcode = 'PT422';
        end if;
        insert into public.purchase_request_items (purchase_id, sort_order, description, quantity, note)
        values (p_purchase_id, v_n, v_desc, v_qty, public.assets_field_text(v_item, 'note', 1000));
    end loop;
    update public.purchases set updated_at = now() where id = p_purchase_id;
end;
$$;

-- Registration: one purchase line from each requested item, the note as its
-- starting specification. Finance details them from there.
create or replace function public.purchases_seed_lines(p_purchase_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
    delete from public.purchase_lines where purchase_id = p_purchase_id;
    insert into public.purchase_lines (purchase_id, sort_order, line_type, description, specification,
                                       quantity, unit, unit_price)
    select i.purchase_id, i.sort_order, 'expense', left(i.description, 300), i.note, i.quantity, 'pcs', 0
      from public.purchase_request_items i
     where i.purchase_id = p_purchase_id;
    update public.purchases set estimated_total = 0, updated_at = now() where id = p_purchase_id;
$$;

-- Finance's lines, replaced wholesale: add, split, rewrite and remove, with
-- the type, category, specification, unit, price and client PO of each.
create or replace function public.purchases_write_lines_finance(p_purchase_id uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_line jsonb;
    v_n int := 0;
    v_type text;
    v_desc text;
    v_qty numeric;
    v_price numeric;
    v_cat uuid;
    v_po uuid;
begin
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
        raise exception 'lines: give at least one line' using errcode = 'PT422';
    end if;
    if jsonb_array_length(p_lines) > 100 then
        raise exception 'lines: at most 100 lines' using errcode = 'PT422';
    end if;
    delete from public.purchase_lines where purchase_id = p_purchase_id;
    for v_line in select * from jsonb_array_elements(p_lines) loop
        v_n := v_n + 1;
        if jsonb_typeof(v_line) <> 'object' then
            raise exception 'lines[%]: must be an object', v_n using errcode = 'PT422';
        end if;
        v_type := coalesce(v_line ->> 'line_type', 'expense');
        v_desc := public.assets_field_text(v_line, 'description', 300);
        v_qty := public.assets_field_numeric(v_line, 'quantity');
        v_price := coalesce(public.assets_field_numeric(v_line, 'unit_price'), 0);
        v_cat := case when v_type = 'asset' then public.purchases_field_uuid(v_line, 'asset_category_id') end;
        v_po := case when v_type = 'inventory' then public.purchases_field_uuid(v_line, 'client_po_id') end;
        perform public.purchases_check_line(v_n, v_type, v_desc, v_qty, v_price, v_cat, v_po, true);
        insert into public.purchase_lines (purchase_id, sort_order, line_type, description, specification,
                                           quantity, unit, unit_price, asset_category_id, client_ref, client_po_id)
        values (p_purchase_id, v_n, v_type, v_desc,
                public.assets_field_text(v_line, 'specification', 4000), v_qty,
                coalesce(public.assets_field_text(v_line, 'unit', 20), 'pcs'),
                round(v_price, 2), v_cat,
                case when v_type = 'inventory' then public.assets_field_text(v_line, 'client_ref', 120) end,
                v_po);
    end loop;
    perform public.purchases_recompute_total(p_purchase_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Vendors.
-- ---------------------------------------------------------------------------

create or replace function public.vendors_json(p_id uuid, p_with_events boolean)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', v.id, 'name', v.name, 'npwp', v.npwp, 'is_pkp', v.is_pkp,
        'contact_name', v.contact_name, 'phone', v.phone, 'email', v.email,
        'bank_name', v.bank_name, 'bank_account_number', v.bank_account_number,
        'bank_account_holder', v.bank_account_holder,
        'is_active', v.is_active, 'notes', v.notes,
        'created_at', v.created_at, 'updated_at', v.updated_at,
        'phone_changed_recently', exists (
            select 1 from public.vendor_events e
             where e.vendor_id = v.id and e.kind = 'edited'
               and e.detail ? 'phone' and e.created_at > now() - interval '30 days'),
        'purchases', (select count(*)::int from public.purchases p where p.vendor_id = v.id),
        'events', case when not p_with_events then '[]'::jsonb else coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', e.id, 'kind', e.kind, 'actor_name', e.actor_name,
                       'before', e.before, 'after', e.after, 'note', e.note, 'detail', e.detail,
                       'created_at', e.created_at) order by e.seq)
              from public.vendor_events e where e.vendor_id = v.id), '[]'::jsonb) end)
      from public.vendors v where v.id = p_id;
$$;

create or replace function public.vendors_event(
    p_vendor_id uuid, p_kind text, p_before jsonb, p_after jsonb, p_note text, p_detail jsonb default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.vendor_events (vendor_id, kind, actor_id, actor_name, before, after, note, detail, created_at)
    values (p_vendor_id, p_kind, auth.uid(), left(public.purchases_actor_name(), 160), p_before, p_after,
            nullif(btrim(coalesce(p_note, '')), ''), p_detail, clock_timestamp());
end;
$$;

create or replace function public.vendors_require_view()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.purchases_require_auth();
    if not public.purchases_is_full_viewer() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
end;
$$;

create or replace function public.vendors_list(p_include_inactive boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.vendors_require_view();
    return jsonb_build_object(
        'items', coalesce((select jsonb_agg(public.vendors_json(v.id, false) order by lower(v.name))
                             from public.vendors v
                            where coalesce(p_include_inactive, false) or v.is_active), '[]'::jsonb),
        'can_manage', public.purchases_role() = 'finance',
        'can_change_bank', public.purchases_role() = 'executive');
end;
$$;

create or replace function public.vendors_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v jsonb;
begin
    perform public.vendors_require_view();
    v := public.vendors_json(p_id, true);
    if v is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return v;
end;
$$;

-- The editable, non-bank fields, from a payload; name required.
create or replace function public.vendors_check_identity(p_id uuid, p_name text, p_npwp text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if p_name is null then
        raise exception 'name: give the vendor''s name' using errcode = 'PT422';
    end if;
    if exists (select 1 from public.vendors v
                where lower(btrim(v.name)) = lower(p_name)
                  and v.id <> coalesce(p_id, '00000000-0000-0000-0000-000000000000'::uuid)) then
        raise exception 'name: a vendor with this name already exists' using errcode = 'PT422';
    end if;
    if p_npwp is not null and exists (
           select 1 from public.vendors v
            where v.npwp is not null
              and regexp_replace(v.npwp, '[^0-9A-Za-z]', '', 'g') = regexp_replace(p_npwp, '[^0-9A-Za-z]', '', 'g')
              and v.id <> coalesce(p_id, '00000000-0000-0000-0000-000000000000'::uuid)) then
        raise exception 'npwp: another vendor has this NPWP' using errcode = 'PT422';
    end if;
end;
$$;

create or replace function public.vendors_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_name text;
    v_npwp text;
    v_id uuid;
begin
    perform public.vendors_require_view();
    perform public.purchases_require_role('finance', 'Only finance adds vendors.');
    p := coalesce(p, '{}'::jsonb);
    v_name := public.assets_field_text(p, 'name', 200);
    v_npwp := public.assets_field_text(p, 'npwp', 30);
    perform public.vendors_check_identity(null, v_name, v_npwp);
    insert into public.vendors (name, npwp, is_pkp, contact_name, phone, email, bank_name,
                                bank_account_number, bank_account_holder, notes, created_by, updated_by)
    values (v_name, v_npwp, coalesce(public.purchases_field_bool(p, 'is_pkp'), false),
            public.assets_field_text(p, 'contact_name', 160),
            public.assets_field_text(p, 'phone', 40),
            public.assets_field_text(p, 'email', 200),
            public.assets_field_text(p, 'bank_name', 100),
            public.assets_field_text(p, 'bank_account_number', 40),
            public.assets_field_text(p, 'bank_account_holder', 160),
            public.assets_field_text(p, 'notes', 4000),
            auth.uid(), auth.uid())
    returning id into v_id;
    perform public.vendors_event(v_id, 'created', null, public.vendors_json(v_id, false) - 'events', null);
    perform public.log_activity('VENDOR_CREATED', 'Added vendor ' || v_name, v_id, null);
    return public.vendors_json(v_id, true);
end;
$$;

-- Finance edits everything but the bank account.
create or replace function public.vendors_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v public.vendors;
    v_new public.vendors;
    v_before jsonb := '{}'::jsonb;
    v_after jsonb := '{}'::jsonb;
    k text;
begin
    perform public.vendors_require_view();
    perform public.purchases_require_role('finance', 'Only finance edits vendors.');
    p := coalesce(p, '{}'::jsonb);
    select * into v from public.vendors where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if p ?| array['bank_name', 'bank_account_number', 'bank_account_holder'] then
        raise exception 'Only the approver changes a vendor''s bank account.' using errcode = 'PT403';
    end if;
    v_new := v;
    if p ? 'name' then v_new.name := public.assets_field_text(p, 'name', 200); end if;
    if p ? 'npwp' then v_new.npwp := public.assets_field_text(p, 'npwp', 30); end if;
    if p ? 'is_pkp' then v_new.is_pkp := coalesce(public.purchases_field_bool(p, 'is_pkp'), false); end if;
    if p ? 'contact_name' then v_new.contact_name := public.assets_field_text(p, 'contact_name', 160); end if;
    if p ? 'phone' then v_new.phone := public.assets_field_text(p, 'phone', 40); end if;
    if p ? 'email' then v_new.email := public.assets_field_text(p, 'email', 200); end if;
    if p ? 'notes' then v_new.notes := public.assets_field_text(p, 'notes', 4000); end if;
    perform public.vendors_check_identity(v.id, v_new.name, v_new.npwp);

    foreach k in array array['name', 'npwp', 'is_pkp', 'contact_name', 'phone', 'email', 'notes'] loop
        if (to_jsonb(v) -> k) is distinct from (to_jsonb(v_new) -> k) then
            v_before := v_before || jsonb_build_object(k, to_jsonb(v) -> k);
            v_after := v_after || jsonb_build_object(k, to_jsonb(v_new) -> k);
        end if;
    end loop;
    if v_after = '{}'::jsonb then
        raise exception 'Nothing has changed.' using errcode = 'PT422';
    end if;

    update public.vendors
       set name = v_new.name, npwp = v_new.npwp, is_pkp = v_new.is_pkp,
           contact_name = v_new.contact_name, phone = v_new.phone, email = v_new.email,
           notes = v_new.notes, updated_by = auth.uid(), updated_at = now()
     where id = v.id;
    -- detail carries the changed keys, so a recent phone change can be found.
    perform public.vendors_event(v.id, 'edited', v_before, v_after, null,
        (select jsonb_object_agg(x, true) from jsonb_object_keys(v_after) x));
    return public.vendors_json(v.id, true);
end;
$$;

create or replace function public.vendors_set_active(p_id uuid, p_active boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v public.vendors;
begin
    perform public.vendors_require_view();
    if public.purchases_role() not in ('finance', 'executive') then
        raise exception 'Only finance or the approver can do that.' using errcode = 'PT403';
    end if;
    select * into v from public.vendors where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if p_active is null or v.is_active = p_active then
        raise exception '% is already %.', v.name, case when v.is_active then 'active' else 'inactive' end
            using errcode = 'PT409';
    end if;
    update public.vendors set is_active = p_active, updated_by = auth.uid(), updated_at = now() where id = v.id;
    perform public.vendors_event(v.id, case when p_active then 'reactivated' else 'deactivated' end,
                                 null, null, p_note);
    return public.vendors_json(v.id, true);
end;
$$;

-- Peter only, after calling the vendor back on the number already on file.
create or replace function public.vendors_change_bank(p_id uuid, p jsonb, p_callback_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v public.vendors;
    v_bank text;
    v_number text;
    v_holder text;
    v_recent boolean;
begin
    perform public.vendors_require_view();
    perform public.purchases_require_role('executive', 'Only the approver changes a vendor''s bank account.');
    p := coalesce(p, '{}'::jsonb);
    select * into v from public.vendors where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if coalesce(btrim(p_callback_note), '') = '' then
        raise exception 'callback_note: record the call you made to confirm the new account' using errcode = 'PT422';
    end if;
    if v.phone is null then
        raise exception 'phone: there is no phone number on file to call back' using errcode = 'PT422';
    end if;
    v_bank := public.assets_field_text(p, 'bank_name', 100);
    v_number := public.assets_field_text(p, 'bank_account_number', 40);
    v_holder := public.assets_field_text(p, 'bank_account_holder', 160);
    if v_bank is null or v_number is null or v_holder is null then
        raise exception 'bank: give the bank, the account number and the account holder' using errcode = 'PT422';
    end if;
    if v_bank is not distinct from v.bank_name and v_number is not distinct from v.bank_account_number
       and v_holder is not distinct from v.bank_account_holder then
        raise exception 'Nothing has changed.' using errcode = 'PT422';
    end if;
    v_recent := exists (select 1 from public.vendor_events e
                         where e.vendor_id = v.id and e.kind = 'edited'
                           and e.detail ? 'phone' and e.created_at > now() - interval '30 days');
    update public.vendors
       set bank_name = v_bank, bank_account_number = v_number, bank_account_holder = v_holder,
           updated_by = auth.uid(), updated_at = now()
     where id = v.id;
    perform public.vendors_event(v.id, 'bank_changed',
        jsonb_build_object('bank_name', v.bank_name, 'bank_account_number', v.bank_account_number,
                           'bank_account_holder', v.bank_account_holder),
        jsonb_build_object('bank_name', v_bank, 'bank_account_number', v_number,
                           'bank_account_holder', v_holder),
        p_callback_note,
        jsonb_build_object('phone_called', v.phone, 'phone_changed_recently', v_recent));
    perform public.log_activity('VENDOR_BANK_CHANGED', 'Changed the bank account of ' || v.name, v.id, null);
    return public.vendors_json(v.id, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Settings.
-- ---------------------------------------------------------------------------

create or replace function public.purchases_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    s public.purchase_settings := public.purchases_settings_row();
begin
    perform public.purchases_require_auth();
    return jsonb_build_object(
        'petty_cash_limit', s.petty_cash_limit,
        'simple_limit', s.simple_limit,
        'quotation_limit', s.quotation_limit,
        'updated_by_name', public.purchases_user_name(s.updated_by),
        'updated_at', s.updated_at,
        'can_edit', public.purchases_role() = 'executive');
end;
$$;

create or replace function public.purchases_settings_update(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    s public.purchase_settings;
    v_petty numeric;
    v_simple numeric;
    v_quote numeric;
begin
    perform public.purchases_require_auth();
    perform public.purchases_require_role('executive', 'Only the approver changes the purchasing limits.');
    p := coalesce(p, '{}'::jsonb);
    select * into s from public.purchase_settings where id = 1 for update;
    v_petty := coalesce(public.assets_field_numeric(p, 'petty_cash_limit'), s.petty_cash_limit);
    v_simple := coalesce(public.assets_field_numeric(p, 'simple_limit'), s.simple_limit);
    v_quote := coalesce(public.assets_field_numeric(p, 'quotation_limit'), s.quotation_limit);
    if not (v_petty < v_simple and v_simple < v_quote) then
        raise exception 'limits: petty cash < simple < quotation' using errcode = 'PT422';
    end if;
    update public.purchase_settings
       set petty_cash_limit = v_petty, simple_limit = v_simple, quotation_limit = v_quote,
           updated_by = auth.uid(), updated_at = now()
     where id = 1;
    perform public.log_activity('PURCHASE_LIMITS_CHANGED',
        format('Purchasing limits: petty cash %s, simple %s, quotation %s',
               public.purchases_money(v_petty), public.purchases_money(v_simple), public.purchases_money(v_quote)),
        null, null);
    return public.purchases_settings();
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The purchase, as the page reads it.
--
-- full: finance, the director, the approver -- everything.
-- requester: a tracking view. Their own items as they wrote them, the
--   milestone reached and when, notes addressed to them, and the documents
--   they attached. No purchase lines, vendor, amount, checker, quotes,
--   invoice, payment or detailed history.
-- checker: the lines and quantities without prices, the vendor's name, the
--   order number, and only the delivery documents and events.
-- ---------------------------------------------------------------------------

-- Where a purchase stands for its requester: the milestone reached, the date
-- of each, and -- off the path -- the outcome with the note meant for them.
create or replace function public.purchases_milestone(r public.purchases)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_dates jsonb;
    v_current text;
    v_outcome text;
    v_note text;
    v_returned timestamptz;
    v_submitted timestamptz;
begin
    select jsonb_build_object(
               'submitted', min(e.created_at) filter (where e.kind = 'submitted'),
               'approved', coalesce(min(e.created_at) filter (where e.kind = 'approved'),
                                    case when r.urgent then min(e.created_at) filter (where e.kind = 'registered') end),
               'ordered', min(e.created_at) filter (where e.kind = 'ordered'),
               'delivered', min(e.created_at) filter (where e.kind = 'grn_accepted'),
               'done', min(e.created_at) filter (where e.kind = 'paid')),
           max(e.created_at) filter (where e.kind = 'returned'),
           max(e.created_at) filter (where e.kind = 'submitted')
      into v_dates, v_returned, v_submitted
      from public.purchase_events e
     where e.purchase_id = r.id;

    v_current := case
        when r.status in ('submitted', 'sourcing', 'awaiting_approval') then 'submitted'
        when r.status = 'approved' then 'approved'
        when r.status = 'ordered' then 'ordered'
        when r.status in ('received', 'amount_review', 'matched') then 'delivered'
        when r.status = 'paid' then 'done'
        -- Off the path: the last milestone it reached before leaving.
        when v_dates ->> 'delivered' is not null then 'delivered'
        when v_dates ->> 'ordered' is not null then 'ordered'
        when v_dates ->> 'approved' is not null then 'approved'
        when v_dates ->> 'submitted' is not null and r.status <> 'draft' then 'submitted'
    end;

    if r.status = 'draft' and v_returned is not null and v_returned >= coalesce(v_submitted, v_returned) then
        v_outcome := 'returned';
        select e.note into v_note from public.purchase_events e
         where e.purchase_id = r.id and e.kind = 'returned' order by e.seq desc limit 1;
    elsif r.status = 'cancelled' then
        if exists (select 1 from public.purchase_events e where e.purchase_id = r.id and e.kind = 'rejected') then
            v_outcome := 'not_approved';
        else
            v_outcome := 'cancelled';
        end if;
        v_note := r.cancel_reason;
    elsif r.status = 'petty_cash' then
        v_outcome := 'petty_cash';
    end if;

    return jsonb_build_object('current', v_current, 'outcome', v_outcome, 'note', v_note, 'dates', v_dates,
                              'outcome_at', case when v_outcome = 'returned' then v_returned
                                                 when v_outcome is not null then r.updated_at end);
end;
$$;

create or replace function public.purchases_serialise(p_id uuid, p_shape text, p_with_events boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
    v public.vendors;
    fr public.finance_requests;
    v_full boolean := p_shape = 'full';
    v_req boolean := p_shape = 'requester';
    v_milestone jsonb;
    v_out jsonb;
begin
    select * into r from public.purchases where id = p_id;
    if not found or p_shape is null then
        return null;
    end if;
    select * into v from public.vendors where id = r.vendor_id;
    v_milestone := public.purchases_milestone(r);

    v_out := jsonb_build_object(
        'id', r.id,
        'reference', r.reference,
        'order_number', r.order_number,
        'title', r.title,
        'status', r.status,
        'needed_by', r.needed_by,
        'urgent', r.urgent,
        'requester', jsonb_build_object('id', r.requester_id, 'name', public.purchases_user_name(r.requester_id)),
        'milestone', v_milestone,
        'created_at', r.created_at,
        'updated_at', r.updated_at,
        'shape', p_shape,
        'can', to_jsonb(public.purchases_can(r)),
        'documents', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', d.id, 'kind', d.kind, 'filename', d.filename, 'content_type', d.content_type,
                       'byte_size', d.byte_size, 'uploaded_by_name', d.uploaded_by_name,
                       'created_at', d.created_at,
                       'can_delete', d.uploaded_by = auth.uid() and r.status in ('draft', 'submitted', 'sourcing'))
                   order by d.created_at, d.id)
              from public.purchase_documents d
             where d.purchase_id = r.id
               and (v_full
                    or (v_req and d.uploaded_by = r.requester_id)
                    or (p_shape = 'checker' and d.kind in ('delivery_photo', 'delivery_note')))), '[]'::jsonb)
    );

    -- What the requester asked for: they and finance read it.
    if v_full or v_req then
        v_out := v_out || jsonb_build_object(
            'purpose', r.purpose,
            'submitted_at', r.submitted_at,
            'items', coalesce((
                select jsonb_agg(jsonb_build_object('id', i.id, 'description', i.description,
                                                    'quantity', i.quantity, 'note', i.note)
                                 order by i.sort_order, i.id)
                  from public.purchase_request_items i where i.purchase_id = r.id), '[]'::jsonb),
            'urgent_detail', case when not r.urgent then null
                                  when v_req then jsonb_build_object(
                                      'channel', r.urgent_channel, 'approved_at', r.urgent_approved_at,
                                      'note', r.urgent_note)
                                  else jsonb_build_object(
                                      'channel', r.urgent_channel, 'approved_at', r.urgent_approved_at,
                                      'note', r.urgent_note, 'amount', r.urgent_amount,
                                      'confirmed_at', r.urgent_confirmed_at,
                                      'confirmed_by_name', public.purchases_user_name(r.urgent_confirmed_by)) end);
    end if;

    -- The purchase itself: finance and the checker.
    if not v_req then
        v_out := v_out || jsonb_build_object(
            'checker', case when r.checker_id is null then null
                            else jsonb_build_object('id', r.checker_id, 'name', public.purchases_user_name(r.checker_id)) end,
            'vendor', case when v.id is null then null
                           when v_full then jsonb_build_object(
                               'id', v.id, 'name', v.name, 'npwp', v.npwp, 'is_pkp', v.is_pkp, 'phone', v.phone,
                               'bank_name', v.bank_name, 'bank_account_number', v.bank_account_number,
                               'bank_account_holder', v.bank_account_holder, 'is_active', v.is_active)
                           else jsonb_build_object('name', v.name) end,
            'ordered_at', r.ordered_at,
            'grn_at', r.grn_at,
            'grn_note', r.grn_note,
            'lines', coalesce((
                select jsonb_agg(
                           jsonb_build_object(
                               'id', l.id, 'line_type', l.line_type, 'description', l.description,
                               'specification', l.specification,
                               'quantity', l.quantity, 'unit', l.unit,
                               'asset_category', case when c.id is null then null
                                                      else jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name) end,
                               'qty_received', l.qty_received, 'condition_note', l.condition_note)
                           || case when v_full then jsonb_build_object(
                                  'unit_price', l.unit_price,
                                  'line_total', round(l.quantity * l.unit_price, 2),
                                  'client_ref', l.client_ref,
                                  'client_po', case when po.id is null then null
                                                    else jsonb_build_object('id', po.id, 'po_number', po.po_number,
                                                                            'client_name', po.client_name) end,
                                  'assets_registered', (select count(*)::int from public.assets a
                                                         where a.purchase_line_id = l.id))
                              else '{}'::jsonb end
                           order by l.sort_order, l.id)
                  from public.purchase_lines l
                  left join public.asset_categories c on c.id = l.asset_category_id
                  left join public.purchase_orders po on po.id = l.client_po_id
                 where l.purchase_id = r.id), '[]'::jsonb));
    end if;

    if v_full then
        select * into fr from public.finance_requests where id = r.finance_request_id;
        v_out := v_out || jsonb_build_object(
            'cost_code', r.cost_code,
            'budget_confirmed', r.budget_confirmed,
            'budget_exception_note', r.budget_exception_note,
            'estimated_total', r.estimated_total,
            'approval_amount', r.approval_amount,
            'approved_amount', r.approved_amount,
            'tier', r.tier,
            'route_value', r.route_value,
            'related_party', r.related_party,
            'related_party_note', r.related_party_note,
            'sole_source', r.sole_source,
            'sole_source_note', r.sole_source_note,
            'shareholders_informed_on', r.shareholders_informed_on,
            'late_entry', r.late_entry,
            'self_approved', r.self_approved,
            'registered_at', r.registered_at,
            'sent_for_approval_at', r.sent_for_approval_at,
            'approved_at', r.approved_at,
            'approved_by_name', public.purchases_user_name(r.approved_by),
            'invoice', case when r.invoice_total is null then null else jsonb_build_object(
                'number', r.invoice_number, 'date', r.invoice_date, 'total', r.invoice_total,
                'ppn', r.ppn_amount, 'pph', r.pph_amount,
                'net_payable', r.invoice_total - coalesce(r.pph_amount, 0)) end,
            'amount_review_amount', r.amount_review_amount,
            'matched_at', r.matched_at,
            'finance_request', case when fr.id is null then null
                                    else jsonb_build_object('id', fr.id, 'reference', fr.reference,
                                                            'status', fr.status) end,
            'paid_on', r.paid_on,
            'cancel_reason', r.cancel_reason,
            'cancelled_at', r.cancelled_at,
            'route', public.purchases_route(r),
            'missing', case when r.status = 'sourcing' then to_jsonb(public.purchases_missing(r))
                            else '[]'::jsonb end);
    end if;

    -- History: everything for finance; the delivery steps for the checker; for
    -- the requester, only the milestones and the outcome, with no actor.
    v_out := v_out || jsonb_build_object('events', case
        when not p_with_events then '[]'::jsonb
        when v_req then coalesce((
            select jsonb_agg(jsonb_build_object('kind', m.kind, 'created_at', m.at, 'note', m.note) order by m.at, m.ord)
              from (select k.kind, (v_milestone -> 'dates' ->> k.kind)::timestamptz as at, null::text as note, k.ord
                      from (values ('submitted', 1), ('approved', 2), ('ordered', 3), ('delivered', 4), ('done', 5))
                           as k(kind, ord)
                     where v_milestone -> 'dates' ->> k.kind is not null
                    union all
                    select v_milestone ->> 'outcome', (v_milestone ->> 'outcome_at')::timestamptz,
                           v_milestone ->> 'note', 6
                     where v_milestone ->> 'outcome' is not null) m), '[]'::jsonb)
        else coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', e.id, 'kind', e.kind, 'actor_name', e.actor_name,
                       'from_status', e.from_status, 'to_status', e.to_status,
                       'note', e.note,
                       'detail', case when v_full then e.detail end,
                       'created_at', e.created_at) order by e.seq)
              from public.purchase_events e
             where e.purchase_id = r.id
               and (v_full
                    or e.kind in ('ordered', 'checker_changed', 'grn_accepted', 'delivery_rejected')
                    or (e.kind = 'document_added' and e.detail ->> 'kind' in ('delivery_photo', 'delivery_note')))
        ), '[]'::jsonb) end);

    return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Reads.
-- ---------------------------------------------------------------------------

create or replace function public.purchases_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
    v_shape text;
begin
    perform public.purchases_require_auth();
    select * into r from public.purchases where id = p_id;
    v_shape := case when r.id is null then null else public.purchases_shape(r) end;
    if v_shape is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return public.purchases_serialise(r.id, v_shape, true);
end;
$$;

-- The register, for finance, the director and Peter. Filters (all optional):
-- status, tier, vendor_id, requester_id, urgent, late_entry, self_approved,
-- related_party, q (PR, PO or title).
create or replace function public.purchases_list(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    f jsonb := coalesce(p_filters, '{}'::jsonb);
    v_q text := nullif(btrim(coalesce(f ->> 'q', '')), '');
begin
    perform public.purchases_require_auth();
    if not public.purchases_is_full_viewer() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return jsonb_build_object(
        'items', coalesce((
            select jsonb_agg(public.purchases_serialise(p.id, 'full', false)
                             order by p.created_at desc, p.id)
              from public.purchases p
             where p.status <> 'draft'
               and (f ->> 'status' is null or p.status = f ->> 'status')
               and (f ->> 'tier' is null or p.tier = f ->> 'tier')
               and (f ->> 'vendor_id' is null or p.vendor_id::text = f ->> 'vendor_id')
               and (f ->> 'requester_id' is null or p.requester_id::text = f ->> 'requester_id')
               and (f ->> 'urgent' is null or p.urgent = (f ->> 'urgent')::boolean)
               and (f ->> 'late_entry' is null or p.late_entry = (f ->> 'late_entry')::boolean)
               and (f ->> 'self_approved' is null or p.self_approved = (f ->> 'self_approved')::boolean)
               and (f ->> 'related_party' is null or coalesce(p.related_party, false) = (f ->> 'related_party')::boolean)
               and (v_q is null or p.reference ilike '%' || v_q || '%' or p.order_number ilike '%' || v_q || '%'
                    or p.title ilike '%' || v_q || '%')), '[]'::jsonb),
        'role', public.purchases_role());
end;
$$;

create or replace function public.purchases_mine()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.purchases_require_auth();
    return jsonb_build_object(
        'items', coalesce((select jsonb_agg(public.purchases_serialise(p.id, public.purchases_shape(p), false)
                                            order by p.created_at desc, p.id)
                             from public.purchases p where p.requester_id = auth.uid()), '[]'::jsonb),
        'role', public.purchases_role(),
        'is_full_viewer', public.purchases_is_full_viewer());
end;
$$;

create or replace function public.purchases_to_check()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.purchases_require_auth();
    return jsonb_build_object(
        'items', coalesce((select jsonb_agg(public.purchases_serialise(p.id, public.purchases_shape(p), false)
                                            order by (p.status = 'ordered') desc, p.ordered_at desc, p.id)
                             from public.purchases p
                            where p.checker_id = auth.uid()
                              and p.status in ('ordered', 'received', 'amount_review', 'matched', 'paid')),
                          '[]'::jsonb));
end;
$$;

-- Who finance may name as the checker: active staff with an account, not the
-- requester, not finance.
create or replace function public.purchases_checker_candidates(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
begin
    perform public.purchases_require_auth();
    perform public.purchases_require_role('finance', 'Only finance names the checker.');
    select * into r from public.purchases where id = p_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('user_id', u.id,
                                            'name', public.purchases_user_name(u.id),
                                            'department', e.department, 'position', e.position)
                         order by public.purchases_user_name(u.id))
          from public.users u
          join public.employees e on e.user_id = u.id
         where u.is_active and e.is_active
           and u.id <> r.requester_id
           and u.role::text <> 'finance'), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The requester.
-- ---------------------------------------------------------------------------

create or replace function public.purchases_apply_request(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_title text := public.assets_field_text(p, 'title', 200);
    v_urgent boolean := coalesce(public.purchases_field_bool(p, 'urgent'), false);
    v_channel text := public.assets_field_text(p, 'urgent_channel', 10);
begin
    -- The requester describes what they need in general terms. Prices, the
    -- vendor, specifications, line types and the cost code are finance's.
    if v_title is null then
        raise exception 'title: say what is needed' using errcode = 'PT422';
    end if;
    if v_channel is not null and v_channel not in ('whatsapp', 'phone') then
        raise exception 'urgent_channel: whatsapp or phone' using errcode = 'PT422';
    end if;
    update public.purchases
       set title = v_title,
           purpose = public.assets_field_text(p, 'purpose', 4000),
           needed_by = public.assets_field_date(p, 'needed_by'),
           urgent = v_urgent,
           urgent_channel = case when v_urgent then v_channel end,
           urgent_approved_at = case when v_urgent then public.purchases_field_time(p, 'urgent_approved_at') end,
           urgent_note = case when v_urgent then public.assets_field_text(p, 'urgent_note', 4000) end,
           updated_at = now()
     where id = p_id;
    if p ? 'items' then
        perform public.purchases_write_items(p_id, p -> 'items');
    end if;
end;
$$;

create or replace function public.purchases_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
begin
    perform public.purchases_require_auth();
    if not exists (select 1 from public.users u where u.id = auth.uid() and u.is_active) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    p := coalesce(p, '{}'::jsonb);
    insert into public.purchases (title, requester_id, status)
    values ('(pending)', auth.uid(), 'draft')
    returning id into v_id;
    perform public.purchases_apply_request(v_id, p);
    perform public.purchases_event(v_id, 'created', null, 'draft');
    return public.purchases_get(v_id);
end;
$$;

-- The requester's own draft; anybody else gets "not found".
create or replace function public.purchases_load_own_draft(p_id uuid)
returns public.purchases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
begin
    perform public.purchases_require_auth();
    r := public.purchases_load(p_id);
    if r.requester_id <> auth.uid() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    perform public.purchases_require_status(r, array['draft'], 'changed');
    return r;
end;
$$;

create or replace function public.purchases_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_own_draft(p_id);
begin
    perform public.purchases_apply_request(r.id, coalesce(p, '{}'::jsonb));
    return public.purchases_get(r.id);
end;
$$;

-- A draft can go; returns its files' storage paths for the caller to remove.
create or replace function public.purchases_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_own_draft(p_id);
    v_paths jsonb;
begin
    select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_paths
      from public.purchase_documents where purchase_id = r.id;
    delete from public.purchases where id = r.id;
    return v_paths;
end;
$$;

create or replace function public.purchases_submit(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_own_draft(p_id);
    v_late boolean := false;
begin
    if not exists (select 1 from public.purchase_request_items where purchase_id = r.id) then
        raise exception 'items: add at least one item' using errcode = 'PT422';
    end if;
    if r.urgent then
        if r.urgent_channel is null then
            raise exception 'urgent_channel: say how the approver approved it' using errcode = 'PT422';
        end if;
        if r.urgent_approved_at is null then
            raise exception 'urgent_approved_at: say when the approver approved it' using errcode = 'PT422';
        end if;
        if r.urgent_approved_at > now() + interval '5 minutes' then
            raise exception 'urgent_approved_at: can''t be in the future' using errcode = 'PT422';
        end if;
        if r.urgent_channel = 'whatsapp' and public.purchases_doc_count(r.id, 'approval_evidence') = 0 then
            raise exception 'urgent: attach the WhatsApp screenshot of the approval' using errcode = 'PT422';
        end if;
        if r.urgent_channel = 'phone' and coalesce(btrim(r.urgent_note), '') = '' then
            raise exception 'urgent_note: write a note of the call' using errcode = 'PT422';
        end if;
        v_late := now() - r.urgent_approved_at > interval '24 hours';
    end if;
    update public.purchases
       set status = 'submitted', submitted_at = now(), late_entry = v_late, updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'submitted', 'draft', 'submitted', null,
        case when v_late then jsonb_build_object('late_entry', true) end);
    perform public.purchases_settle(r.id, array['purchase_returned'], 'resubmitted');
    perform public.purchases_notify(public.notifications_role_users('finance'), 'purchase_submitted', 'action', r.id,
        case when r.urgent then 'Urgent purchase request: ' else 'Purchase request: ' end || r.title,
        public.purchases_actor_name() || ' has asked for something. Register it, return it, or close it as petty cash.');
    return public.purchases_get(r.id);
end;
$$;

create or replace function public.purchases_cancel(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
    v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
    v_own boolean;
begin
    perform public.purchases_require_auth();
    r := public.purchases_load(p_id);
    if public.purchases_shape(r) is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    v_own := r.requester_id = auth.uid() and r.status in ('draft', 'submitted');
    if not v_own then
        if public.purchases_role() <> 'finance' then
            if r.requester_id = auth.uid() then
                perform public.purchases_require_status(r, array['draft', 'submitted'], 'cancelled');
            end if;
            raise exception 'Only finance cancels a purchase once it is registered.' using errcode = 'PT403';
        end if;
        perform public.purchases_require_status(r,
            array['submitted', 'sourcing', 'awaiting_approval', 'approved', 'ordered'], 'cancelled');
        if v_reason is null then
            raise exception 'reason: say why it is cancelled' using errcode = 'PT422';
        end if;
    end if;
    update public.purchases
       set status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(), updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'cancelled', r.status, 'cancelled', v_reason);
    perform public.purchases_settle(r.id, array['purchase_submitted', 'purchase_approval_needed',
        'purchase_check_needed', 'purchase_urgent_confirm', 'purchase_returned'], 'cancelled');
    perform public.purchases_notify_requester(r.id, 'purchase_closed', 'danger',
        'Cancelled: ' || r.title, 'Your purchase request has been cancelled.', v_reason);
    perform public.log_activity('PURCHASE_CANCELLED',
        'Cancelled ' || coalesce(r.reference, 'a request') || ': ' || r.title, r.id, null);
    return public.purchases_get(r.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Finance: register, return, petty cash, sourcing, sending for approval.
-- ---------------------------------------------------------------------------

create or replace function public.purchases_load_finance(p_id uuid, p_states text[], p_action text)
returns public.purchases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
begin
    perform public.purchases_require_auth();
    perform public.purchases_require_role('finance', 'Only finance can do that.');
    r := public.purchases_load(p_id);
    if r.status = 'draft' then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    perform public.purchases_require_status(r, p_states, p_action);
    return r;
end;
$$;

create or replace function public.purchases_next_number(p_kind text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    n int;
begin
    if p_kind = 'PR' then
        update public.purchase_settings set next_pr = next_pr + 1 where id = 1 returning next_pr - 1 into n;
    else
        update public.purchase_settings set next_po = next_po + 1 where id = 1 returning next_po - 1 into n;
    end if;
    return p_kind || '-' || lpad(n::text, greatest(4, char_length(n::text)), '0');
end;
$$;

-- p: budget_confirmed, budget_exception_note, cost_code, and optionally lines
-- (finance's, wholesale; otherwise seeded from the requested items). For an
-- urgent request also vendor_id and amount: what the approver approved.
create or replace function public.purchases_register(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_finance(p_id, array['submitted'], 'registered');
    v_budget boolean;
    v_exception text;
    v_ref text;
    v_vendor public.vendors;
    v_amount numeric;
    v_route jsonb;
    v_to text;
begin
    p := coalesce(p, '{}'::jsonb);
    v_budget := coalesce(public.purchases_field_bool(p, 'budget_confirmed'), false);
    v_exception := public.assets_field_text(p, 'budget_exception_note', 4000);
    if not v_budget then
        if v_exception is null or public.purchases_doc_count(r.id, 'budget_exception') = 0 then
            raise exception 'budget_confirmed: budget must be available, or record the approver''s written exception (a note and a document)'
                using errcode = 'PT422';
        end if;
    end if;
    perform public.purchases_seed_lines(r.id);
    if p ? 'lines' then
        perform public.purchases_write_lines_finance(r.id, p -> 'lines');
    end if;

    if r.urgent then
        select * into v_vendor from public.vendors where id = public.purchases_field_uuid(p, 'vendor_id');
        if v_vendor.id is null or not v_vendor.is_active then
            raise exception 'vendor_id: choose the active vendor the approver named' using errcode = 'PT422';
        end if;
        v_amount := public.assets_field_numeric(p, 'amount');
        if coalesce(v_amount, 0) <= 0 then
            raise exception 'amount: give the amount the approver approved' using errcode = 'PT422';
        end if;
    end if;

    v_ref := public.purchases_next_number('PR');
    v_to := case when r.urgent then 'approved' else 'sourcing' end;
    update public.purchases
       set reference = v_ref,
           status = v_to,
           budget_confirmed = v_budget,
           budget_exception_note = case when v_budget then null else v_exception end,
           cost_code = case when p ? 'cost_code' then public.assets_field_text(p, 'cost_code', 60) else cost_code end,
           registered_at = now(), registered_by = auth.uid(),
           vendor_id = case when r.urgent then v_vendor.id else vendor_id end,
           approval_amount = case when r.urgent then v_amount else approval_amount end,
           approved_amount = case when r.urgent then v_amount else approved_amount end,
           urgent_amount = case when r.urgent then v_amount else urgent_amount end,
           urgent_vendor_name = case when r.urgent then v_vendor.name else urgent_vendor_name end,
           updated_at = now()
     where id = r.id
    returning * into r;

    if r.urgent then
        v_route := public.purchases_route(r);
        update public.purchases
           set tier = v_route ->> 'tier', route_value = (v_route ->> 'route_value')::numeric
         where id = r.id;
    end if;

    perform public.purchases_event(r.id, 'registered', 'submitted', v_to,
        case when v_budget then null else 'Budget exception: ' || v_exception end,
        jsonb_build_object('reference', v_ref, 'cost_code', r.cost_code, 'budget_confirmed', v_budget));
    perform public.purchases_settle(r.id, array['purchase_submitted'], 'registered');
    if r.urgent then
        perform public.purchases_notify(public.notifications_role_users('executive'), 'purchase_urgent_confirm',
            'action', r.id, 'Confirm your urgent approval: ' || r.title,
            'You approved this urgent purchase outside the platform. Confirm it here; it can''t be paid until you do.',
            r.urgent_note, null);
        -- For an urgent request, registering is its approval.
        perform public.purchases_notify_requester(r.id, 'purchase_progress', 'success',
            'Approved: ' || r.title, 'Your urgent request is approved. Finance orders it next.');
    end if;
    perform public.log_activity('PURCHASE_REGISTERED', 'Registered ' || v_ref || ': ' || r.title, r.id, null);
    return public.purchases_get(r.id);
end;
$$;

create or replace function public.purchases_return(p_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_finance(p_id, array['submitted'], 'returned');
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
    if v_note is null then
        raise exception 'note: say what the requester should change' using errcode = 'PT422';
    end if;
    update public.purchases set status = 'draft', updated_at = now() where id = r.id;
    perform public.purchases_event(r.id, 'returned', 'submitted', 'draft', v_note);
    perform public.purchases_settle(r.id, array['purchase_submitted'], 'returned');
    perform public.purchases_notify_requester(r.id, 'purchase_returned', 'action',
        'Returned to you: ' || r.title,
        'Finance has returned your request. Change it and submit it again.', v_note);
    return public.purchases_get(r.id);
end;
$$;

-- The requester gives no prices, so finance says what it expects it to cost.
drop function if exists public.purchases_close_petty_cash(uuid);
create or replace function public.purchases_close_petty_cash(p_id uuid, p_estimate numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_finance(p_id, array['submitted'], 'closed as petty cash');
    s public.purchase_settings := public.purchases_settings_row();
begin
    if p_estimate is null or p_estimate <= 0 then
        raise exception 'estimate: say what it is expected to cost' using errcode = 'PT422';
    end if;
    if p_estimate > s.petty_cash_limit then
        raise exception 'This is above the petty-cash limit (%).', public.purchases_money(s.petty_cash_limit)
            using errcode = 'PT422';
    end if;
    update public.purchases
       set status = 'petty_cash', estimated_total = round(p_estimate, 2), updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'petty_cash', 'submitted', 'petty_cash', null,
        jsonb_build_object('estimate', round(p_estimate, 2)));
    perform public.purchases_settle(r.id, array['purchase_submitted'], 'petty_cash');
    perform public.purchases_notify_requester(r.id, 'purchase_closed', 'success',
        'Petty cash: ' || r.title,
        'This is small enough for petty cash. Buy it, keep the receipt, and bring it to finance the same day.');
    return public.purchases_get(r.id);
end;
$$;

-- p: vendor_id, approval_amount, related_party, related_party_note,
-- sole_source, sole_source_note, shareholders_informed_on, lines (finance's,
-- wholesale). Only the keys present change.
create or replace function public.purchases_source(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_finance(p_id, array['sourcing'], 'changed');
    v_vendor public.vendors;
    v_vendor_id uuid := r.vendor_id;
    v_before uuid := r.vendor_id;
begin
    p := coalesce(p, '{}'::jsonb);
    if p ? 'vendor_id' then
        v_vendor_id := public.purchases_field_uuid(p, 'vendor_id');
        if v_vendor_id is not null then
            select * into v_vendor from public.vendors where id = v_vendor_id;
            if v_vendor.id is null then
                raise exception 'vendor_id: unknown vendor' using errcode = 'PT422';
            end if;
            if not v_vendor.is_active and v_vendor_id is distinct from r.vendor_id then
                raise exception 'vendor_id: % is inactive', v_vendor.name using errcode = 'PT422';
            end if;
        end if;
    end if;
    if p ? 'lines' then
        perform public.purchases_write_lines_finance(r.id, p -> 'lines');
    end if;
    update public.purchases
       set vendor_id = v_vendor_id,
           approval_amount = case when p ? 'approval_amount' then public.assets_field_numeric(p, 'approval_amount')
                                  else approval_amount end,
           related_party = case when p ? 'related_party' then public.purchases_field_bool(p, 'related_party')
                                else related_party end,
           related_party_note = case when p ? 'related_party_note' then public.assets_field_text(p, 'related_party_note', 4000)
                                     else related_party_note end,
           sole_source = case when p ? 'sole_source' then coalesce(public.purchases_field_bool(p, 'sole_source'), false)
                              else sole_source end,
           sole_source_note = case when p ? 'sole_source_note' then public.assets_field_text(p, 'sole_source_note', 4000)
                                   else sole_source_note end,
           shareholders_informed_on = case when p ? 'shareholders_informed_on'
                                           then public.assets_field_date(p, 'shareholders_informed_on')
                                           else shareholders_informed_on end,
           updated_at = now()
     where id = r.id;
    if v_vendor_id is distinct from v_before and v_vendor_id is not null then
        perform public.purchases_event(r.id, 'vendor_chosen', 'sourcing', 'sourcing', null,
            jsonb_build_object('vendor', v_vendor.name));
    end if;
    return public.purchases_get(r.id);
end;
$$;

create or replace function public.purchases_send_for_approval(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_finance(p_id, array['sourcing'], 'sent for approval');
    v_missing text[] := public.purchases_missing(r);
    v_route jsonb;
begin
    if cardinality(v_missing) > 0 then
        raise exception 'Still missing: %.', array_to_string(v_missing, ', ') using errcode = 'PT422';
    end if;
    v_route := public.purchases_route(r);
    update public.purchases
       set status = 'awaiting_approval', tier = v_route ->> 'tier',
           route_value = (v_route ->> 'route_value')::numeric,
           sent_for_approval_at = now(), updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'sent_for_approval', 'sourcing', 'awaiting_approval', null, v_route);
    perform public.purchases_notify(public.notifications_role_users('executive'), 'purchase_approval_needed',
        'action', r.id, 'Approve the vendor and price: ' || r.title,
        'Finance asks you to approve ' || public.purchases_money(r.approval_amount)
            || ' (' || (v_route ->> 'tier') || ' tier, vendor month ' || public.purchases_money((v_route ->> 'route_value')::numeric) || ').');
    return public.purchases_get(r.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The approver (role executive).
-- ---------------------------------------------------------------------------

create or replace function public.purchases_load_peter(p_id uuid, p_states text[], p_action text)
returns public.purchases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
begin
    perform public.purchases_require_auth();
    perform public.purchases_require_role('executive', 'Only the approver approves purchases.');
    r := public.purchases_load(p_id);
    if r.status = 'draft' then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    perform public.purchases_require_status(r, p_states, p_action);
    return r;
end;
$$;

create or replace function public.purchases_approve(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_peter(p_id, array['awaiting_approval'], 'approved');
    v_self boolean := r.requester_id = auth.uid();
begin
    update public.purchases
       set status = 'approved', approved_by = auth.uid(), approved_at = now(),
           approved_amount = approval_amount, self_approved = v_self, updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'approved', 'awaiting_approval', 'approved', p_note,
        jsonb_build_object('amount', r.approval_amount, 'self_approved', v_self));
    perform public.purchases_settle(r.id, array['purchase_approval_needed'], 'approved');
    perform public.purchases_notify(public.notifications_role_users('finance'),
        'purchase_decided', 'success', r.id, 'Approved: ' || r.title,
        'The approver has approved the vendor and price (' || public.purchases_money(r.approval_amount) || '). Issue the order next.',
        p_note, public.purchases_actor_name());
    perform public.purchases_notify_requester(r.id, 'purchase_progress', 'success',
        'Approved: ' || r.title, 'Your request is approved. Finance orders it next.');
    perform public.log_activity('PURCHASE_APPROVED', 'Approved ' || r.reference || ': ' || r.title, r.id, null);
    return public.purchases_get(r.id);
end;
$$;

create or replace function public.purchases_send_back(p_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_peter(p_id, array['awaiting_approval'], 'sent back');
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
    if v_note is null then
        raise exception 'note: say what should change' using errcode = 'PT422';
    end if;
    update public.purchases set status = 'sourcing', updated_at = now() where id = r.id;
    perform public.purchases_event(r.id, 'sent_back', 'awaiting_approval', 'sourcing', v_note);
    perform public.purchases_settle(r.id, array['purchase_approval_needed'], 'sent_back');
    perform public.purchases_notify(public.notifications_role_users('finance'),
        'purchase_decided', 'danger', r.id, 'Sent back: ' || r.title,
        'The approver has sent the purchase back for re-quoting or a revised specification.', v_note, public.purchases_actor_name());
    return public.purchases_get(r.id);
end;
$$;

create or replace function public.purchases_reject(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_peter(p_id, array['awaiting_approval'], 'rejected');
    v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
    if v_reason is null then
        raise exception 'reason: say why it is rejected' using errcode = 'PT422';
    end if;
    update public.purchases
       set status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(), updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'rejected', 'awaiting_approval', 'cancelled', v_reason);
    perform public.purchases_settle(r.id, array['purchase_approval_needed'], 'rejected');
    perform public.purchases_notify(public.notifications_role_users('finance'),
        'purchase_decided', 'danger', r.id, 'Rejected: ' || r.title,
        'The approver has rejected the purchase.', v_reason, public.purchases_actor_name());
    perform public.purchases_notify_requester(r.id, 'purchase_closed', 'danger',
        'Not approved: ' || r.title, 'Your request was not approved.', v_reason);
    return public.purchases_get(r.id);
end;
$$;

create or replace function public.purchases_confirm_urgent(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_peter(p_id,
        array['approved', 'ordered', 'received', 'amount_review'], 'confirmed');
    v_self boolean := r.requester_id = auth.uid();
begin
    if not r.urgent then
        raise exception '% is not an urgent purchase.', r.reference using errcode = 'PT409';
    end if;
    if r.urgent_confirmed_at is not null then
        raise exception '% is already confirmed.', r.reference using errcode = 'PT409';
    end if;
    update public.purchases
       set urgent_confirmed_at = now(), urgent_confirmed_by = auth.uid(),
           approved_by = auth.uid(), approved_at = coalesce(approved_at, now()),
           self_approved = v_self, updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'urgent_confirmed', r.status, r.status, p_note,
        jsonb_build_object('amount', r.approved_amount, 'self_approved', v_self));
    perform public.purchases_settle(r.id, array['purchase_urgent_confirm'], 'confirmed');
    return public.purchases_get(r.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. The order and the goods received note.
-- ---------------------------------------------------------------------------

create or replace function public.purchases_check_checker(r public.purchases, p_checker uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    u public.users;
begin
    select * into u from public.users where id = p_checker;
    if u.id is null or not u.is_active
       or not exists (select 1 from public.employees e where e.user_id = u.id and e.is_active) then
        raise exception 'checker_id: must be an active member of staff' using errcode = 'PT422';
    end if;
    if u.id = r.requester_id then
        raise exception 'checker_id: the requester can''t check in their own purchase' using errcode = 'PT422';
    end if;
    if u.role::text = 'finance' then
        raise exception 'checker_id: finance can''t sign for goods received' using errcode = 'PT422';
    end if;
end;
$$;

create or replace function public.purchases_issue_order(p_id uuid, p_checker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_finance(p_id, array['approved'], 'ordered');
    v_po text;
begin
    perform public.purchases_check_checker(r, p_checker_id);
    v_po := public.purchases_next_number('PO');
    update public.purchases
       set status = 'ordered', order_number = v_po, checker_id = p_checker_id,
           ordered_at = now(), delivery_round_at = clock_timestamp(), updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'ordered', 'approved', 'ordered', null,
        jsonb_build_object('order_number', v_po, 'checker', public.purchases_user_name(p_checker_id)));
    perform public.purchases_notify(array[p_checker_id], 'purchase_check_needed', 'action', r.id,
        'Check in a delivery: ' || r.title,
        'You are the checker for order ' || v_po || '. When it arrives, count and inspect it against the order, '
            || 'take a photo, and record the goods received note.');
    perform public.purchases_notify_requester(r.id, 'purchase_progress', 'success',
        'Ordered: ' || r.title, 'What you asked for has been ordered (' || v_po || ').');
    perform public.log_activity('PURCHASE_ORDERED', 'Issued ' || v_po || ' for ' || r.reference, r.id, null);
    return public.purchases_get(r.id);
end;
$$;

create or replace function public.purchases_change_checker(p_id uuid, p_checker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_finance(p_id, array['ordered'], 'given another checker');
begin
    perform public.purchases_check_checker(r, p_checker_id);
    if p_checker_id = r.checker_id then
        raise exception 'checker_id: already the checker' using errcode = 'PT422';
    end if;
    update public.purchases set checker_id = p_checker_id, updated_at = now() where id = r.id;
    perform public.purchases_event(r.id, 'checker_changed', 'ordered', 'ordered', null,
        jsonb_build_object('from', public.purchases_user_name(r.checker_id),
                           'to', public.purchases_user_name(p_checker_id)));
    perform public.purchases_settle(r.id, array['purchase_check_needed'], 'reassigned', r.checker_id);
    perform public.purchases_notify(array[p_checker_id], 'purchase_check_needed', 'action', r.id,
        'Check in a delivery: ' || r.title,
        'You are now the checker for order ' || r.order_number || '. When it arrives, count and inspect it against '
            || 'the order, take a photo, and record the goods received note.');
    return public.purchases_get(r.id);
end;
$$;

-- p_lines: [{line_id, qty_received, condition}]. Lines left out count as
-- nothing received.
create or replace function public.purchases_receive(p_id uuid, p_lines jsonb, p_matches boolean, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
    v_line jsonb;
    l public.purchase_lines;
    v_qty numeric;
    v_assets int;
begin
    perform public.purchases_require_auth();
    r := public.purchases_load(p_id);
    if r.checker_id is distinct from auth.uid() or r.status not in ('ordered', 'received', 'amount_review', 'matched', 'paid') then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    perform public.purchases_require_status(r, array['ordered'], 'received');
    if p_matches is null then
        raise exception 'matches: say whether the delivery matches the order' using errcode = 'PT422';
    end if;
    if not exists (select 1 from public.purchase_documents d
                    where d.purchase_id = r.id and d.kind = 'delivery_photo'
                      and d.uploaded_by = auth.uid() and d.created_at >= r.delivery_round_at) then
        raise exception 'photo: attach at least one photo of the delivery' using errcode = 'PT422';
    end if;

    if not p_matches then
        if v_note is null then
            raise exception 'note: say what is wrong with the delivery' using errcode = 'PT422';
        end if;
        update public.purchase_lines set qty_received = null, condition_note = null where purchase_id = r.id;
        update public.purchases set delivery_round_at = clock_timestamp(), updated_at = now() where id = r.id;
        perform public.purchases_event(r.id, 'delivery_rejected', 'ordered', 'ordered', v_note);
        perform public.purchases_notify(
            array_cat(public.notifications_role_users('executive'), public.notifications_role_users('finance')),
            'purchase_delivery_rejected', 'danger', r.id, 'Delivery rejected: ' || r.title,
            public.purchases_actor_name() || ' has rejected the delivery for ' || r.order_number
                || '. It goes back to the vendor for redelivery.', v_note, public.purchases_actor_name());
        return public.purchases_get(r.id);
    end if;

    if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
        raise exception 'lines: give the quantity received for each line' using errcode = 'PT422';
    end if;
    update public.purchase_lines set qty_received = 0, condition_note = null where purchase_id = r.id;
    for v_line in select * from jsonb_array_elements(p_lines) loop
        select * into l from public.purchase_lines
         where id = public.purchases_field_uuid(v_line, 'line_id') and purchase_id = r.id;
        if l.id is null then
            raise exception 'lines: unknown line' using errcode = 'PT422';
        end if;
        v_qty := public.assets_field_numeric(v_line, 'qty_received');
        if v_qty is null or v_qty > l.quantity then
            raise exception 'lines[%].qty_received: between 0 and %', l.sort_order, l.quantity using errcode = 'PT422';
        end if;
        if l.line_type = 'asset' and v_qty <> trunc(v_qty) then
            raise exception 'lines[%].qty_received: assets are counted in whole items', l.sort_order using errcode = 'PT422';
        end if;
        update public.purchase_lines
           set qty_received = v_qty, condition_note = public.assets_field_text(v_line, 'condition', 1000)
         where id = l.id;
    end loop;
    update public.purchases
       set status = 'received', grn_at = now(), grn_by = auth.uid(), grn_note = v_note, updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'grn_accepted', 'ordered', 'received', v_note,
        (select jsonb_agg(jsonb_build_object('line', l2.description, 'ordered', l2.quantity,
                                             'received', l2.qty_received) order by l2.sort_order)
           from public.purchase_lines l2 where l2.purchase_id = r.id));
    perform public.purchases_settle(r.id, array['purchase_check_needed'], 'received');
    perform public.purchases_notify_requester(r.id, 'purchase_progress', 'success',
        'Delivered: ' || r.title, 'What you asked for has arrived and been checked in.');
    perform public.purchases_notify(public.notifications_role_users('finance'), 'purchase_match_needed', 'action', r.id,
        'Match the invoice: ' || r.title,
        'The goods for ' || r.order_number || ' have been received. Match the PO, the GRN and the invoice.');
    select count(*)::int into v_assets from public.purchase_lines
     where purchase_id = r.id and line_type = 'asset' and qty_received > 0;
    if v_assets > 0 then
        perform public.purchases_notify(public.notifications_it_support_users(), 'purchase_assets_to_register',
            'action', r.id, 'Register bought assets: ' || r.title,
            'Assets bought on ' || r.order_number || ' have arrived. Register them in the asset register.',
            null, null, '/equipment?tab=awaiting', 'Open the awaiting list');
    end if;
    return public.purchases_get(r.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Amount review, the three-way match, and the hand-off to payment.
-- ---------------------------------------------------------------------------

create or replace function public.purchases_ask_amount(p_id uuid, p_amount numeric, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_finance(p_id, array['received'], 'sent for an amount review');
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
    if p_amount is null or p_amount <= coalesce(r.approved_amount, 0) then
        raise exception 'amount: must be above the approved %', public.purchases_money(r.approved_amount)
            using errcode = 'PT422';
    end if;
    if v_note is null then
        raise exception 'note: say why the amount is higher' using errcode = 'PT422';
    end if;
    update public.purchases
       set status = 'amount_review', amount_review_amount = round(p_amount, 2), updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'amount_review_asked', 'received', 'amount_review', v_note,
        jsonb_build_object('from', r.approved_amount, 'to', round(p_amount, 2)));
    perform public.purchases_notify(public.notifications_role_users('executive'), 'purchase_amount_review', 'action',
        r.id, 'Approve a higher amount: ' || r.title,
        'The invoice is ' || public.purchases_money(p_amount) || ' against the approved '
            || public.purchases_money(r.approved_amount) || '.', v_note, public.purchases_actor_name());
    return public.purchases_get(r.id);
end;
$$;

create or replace function public.purchases_decide_amount(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_peter(p_id, array['amount_review'], 'decided');
begin
    if p_approve is null then
        raise exception 'approve: true or false' using errcode = 'PT422';
    end if;
    update public.purchases
       set status = 'received',
           approved_amount = case when p_approve then amount_review_amount else approved_amount end,
           amount_review_amount = null,
           updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, case when p_approve then 'amount_approved' else 'amount_declined' end,
        'amount_review', 'received', p_note,
        jsonb_build_object('approved_amount', case when p_approve then r.amount_review_amount else r.approved_amount end));
    perform public.purchases_settle(r.id, array['purchase_amount_review'], case when p_approve then 'approved' else 'declined' end);
    perform public.purchases_notify(public.notifications_role_users('finance'), 'purchase_decided',
        case when p_approve then 'success' else 'danger' end, r.id,
        case when p_approve then 'Higher amount approved: ' else 'Higher amount declined: ' end || r.title,
        case when p_approve then 'The approver has approved ' || public.purchases_money(r.amount_review_amount) || '.'
             else 'The approver has declined the higher amount. Ask the vendor for a corrected invoice.' end,
        p_note, public.purchases_actor_name());
    return public.purchases_get(r.id);
end;
$$;

-- p: invoice_number, invoice_date, invoice_total, ppn_amount, pph_amount.
create or replace function public.purchases_match(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_load_finance(p_id, array['received'], 'matched');
    v public.vendors;
    v_number text;
    v_date date;
    v_total numeric;
    v_ppn numeric;
    v_pph numeric;
    v_net numeric;
    v_fr public.finance_requests;
begin
    p := coalesce(p, '{}'::jsonb);
    if r.urgent and r.urgent_confirmed_at is null then
        raise exception 'The approver has not confirmed this urgent purchase yet.' using errcode = 'PT422';
    end if;
    v_number := public.assets_field_text(p, 'invoice_number', 60);
    v_date := public.assets_field_date(p, 'invoice_date');
    v_total := public.assets_field_numeric(p, 'invoice_total');
    v_ppn := coalesce(public.assets_field_numeric(p, 'ppn_amount'), 0);
    v_pph := coalesce(public.assets_field_numeric(p, 'pph_amount'), 0);
    if v_number is null or v_date is null or coalesce(v_total, 0) <= 0 then
        raise exception 'invoice: give the invoice number, date and total' using errcode = 'PT422';
    end if;
    if v_ppn > v_total or v_pph >= v_total then
        raise exception 'invoice: the tax figures don''t fit the total' using errcode = 'PT422';
    end if;
    if public.purchases_doc_count(r.id, 'invoice') = 0 then
        raise exception 'invoice: attach the invoice' using errcode = 'PT422';
    end if;
    if v_ppn > 0 and public.purchases_doc_count(r.id, 'tax_invoice') = 0 then
        raise exception 'tax_invoice: attach the faktur pajak' using errcode = 'PT422';
    end if;
    if v_total > coalesce(r.approved_amount, 0) then
        raise exception 'Invoice is above the approved amount (% against %). Get a corrected invoice, or ask the approver to approve the new amount.',
            public.purchases_money(v_total), public.purchases_money(r.approved_amount) using errcode = 'PT422';
    end if;
    v_net := v_total - v_pph;
    select * into v from public.vendors where id = r.vendor_id;

    -- The finance request: drafted, then submitted, so the existing trigger
    -- tells Peter as it does for any request.
    perform pg_advisory_xact_lock(hashtext('finance_requests.reference'));
    insert into public.finance_requests (reference, title, notes, status, requested_by_id, purchase_id)
    values (public.finance_next_reference(),
            left(r.reference || ' / ' || r.order_number || ' – ' || coalesce(v.name, 'vendor'), 200),
            format(E'Pay into the vendor''s registered account only:\n%s, %s, a/n %s\nInvoice %s of %s: total %s, PPN %s, PPh withheld %s, net %s.',
                   coalesce(v.bank_name, '(no bank on file)'), coalesce(v.bank_account_number, '-'),
                   coalesce(v.bank_account_holder, '-'), v_number, to_char(v_date, 'FMDD FMMonth YYYY'),
                   public.purchases_money(v_total), public.purchases_money(v_ppn),
                   public.purchases_money(v_pph), public.purchases_money(v_net)),
            'draft', auth.uid(), r.id)
    returning * into v_fr;
    insert into public.finance_request_items (request_id, category, description, amount, sort_order)
    values (v_fr.id, 'vendor', left(coalesce(v.name, 'Vendor') || ': ' || r.title, 300), round(v_net, 2)::double precision, 0);
    update public.finance_requests
       set status = 'submitted', submitted_at = now(), updated_at = now()
     where id = v_fr.id
    returning * into v_fr;
    perform public.log_activity('FINANCE_REQUEST_SUBMITTED',
        format('Sent %s for review', public.finance_label(v_fr)), v_fr.id, null);

    update public.purchases
       set status = 'matched', invoice_number = v_number, invoice_date = v_date, invoice_total = v_total,
           ppn_amount = v_ppn, pph_amount = v_pph, finance_request_id = v_fr.id, matched_at = now(),
           updated_at = now()
     where id = r.id;
    perform public.purchases_event(r.id, 'matched', 'received', 'matched', null,
        jsonb_build_object('invoice_total', v_total, 'net_payable', v_net, 'finance_request', v_fr.reference));
    perform public.purchases_settle(r.id, array['purchase_match_needed'], 'matched');
    return public.purchases_get(r.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Documents (the bytes live in Storage, bucket purchase-documents, at
--     <purchase_id>/<uuid>/<filename>).
-- ---------------------------------------------------------------------------

-- The kinds the caller may add to this purchase now.
create or replace function public.purchases_doc_kinds(r public.purchases)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_out text[] := '{}';
begin
    if auth.uid() is null then
        return v_out;
    end if;
    if r.requester_id = auth.uid() and r.status in ('draft', 'submitted') then
        v_out := v_out || array['request', 'approval_evidence', 'other'];
    end if;
    if public.purchases_role() = 'finance' and r.status not in ('draft', 'paid', 'cancelled', 'petty_cash') then
        v_out := v_out || array['request', 'quote', 'comparison', 'contract', 'approval_evidence', 'budget_exception',
                                'delivery_photo', 'delivery_note', 'invoice', 'tax_invoice', 'other'];
    end if;
    if r.checker_id = auth.uid() and r.status = 'ordered' then
        v_out := v_out || array['delivery_photo', 'delivery_note'];
    end if;
    return array(select distinct x from unnest(v_out) x);
end;
$$;

create or replace function public.purchases_document_add(
    p_purchase_id uuid,
    p_kind text,
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
    r public.purchases;
    v_ext text;
    v_name text;
begin
    perform public.purchases_require_auth();
    r := public.purchases_load(p_purchase_id);
    if public.purchases_shape(r) is null and not (r.checker_id = auth.uid() and r.status = 'ordered') then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if p_kind is null or not (p_kind = any (public.purchases_doc_kinds(r))) then
        raise exception 'You can''t attach a % to % now.', replace(coalesce(p_kind, 'document'), '_', ' '),
            public.purchases_label(r) using errcode = 'PT403';
    end if;
    v_ext := case p_content_type
        when 'application/pdf' then '.pdf'
        when 'image/jpeg' then '.jpg'
        when 'image/png' then '.png'
        when 'image/webp' then '.webp'
        when 'application/msword' then '.doc'
        when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then '.docx'
        when 'application/vnd.ms-excel' then '.xls'
        when 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then '.xlsx'
    end;
    if v_ext is null then
        raise exception 'Upload a PDF, an image, or a Word or Excel document.' using errcode = 'PT415';
    end if;
    if coalesce(p_byte_size, 0) <= 0 then
        raise exception 'That file is empty.' using errcode = 'PT400';
    end if;
    if p_byte_size > 10 * 1024 * 1024 then
        raise exception 'That file is % MB. The limit is 10 MB.', p_byte_size / 1024 / 1024 using errcode = 'PT413';
    end if;
    if p_storage_path is null or p_storage_path = '' or split_part(p_storage_path, '/', 1) <> r.id::text then
        raise exception 'The file was not stored.' using errcode = 'PT422';
    end if;
    v_name := left(coalesce(nullif(btrim(p_filename), ''), 'document' || v_ext), 255);
    insert into public.purchase_documents (purchase_id, kind, filename, content_type, byte_size, storage_path,
                                           uploaded_by, uploaded_by_name, created_at)
    values (r.id, p_kind, v_name, p_content_type, p_byte_size, p_storage_path, auth.uid(),
            left(public.purchases_actor_name(), 160), clock_timestamp());
    perform public.purchases_event(r.id, 'document_added', r.status, r.status, null,
        jsonb_build_object('kind', p_kind, 'filename', v_name));
    return public.purchases_get(r.id);
end;
$$;

create or replace function public.purchases_document_get(p_purchase_id uuid, p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
    d public.purchase_documents;
    v_shape text;
begin
    perform public.purchases_require_auth();
    select * into r from public.purchases where id = p_purchase_id;
    v_shape := case when r.id is null then null else public.purchases_shape(r) end;
    select * into d from public.purchase_documents where id = p_document_id and purchase_id = p_purchase_id;
    if v_shape is null or d.id is null
       or (v_shape = 'checker' and d.kind not in ('delivery_photo', 'delivery_note'))
       or (v_shape = 'requester' and d.uploaded_by is distinct from r.requester_id) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return jsonb_build_object('id', d.id, 'filename', d.filename, 'content_type', d.content_type,
                              'byte_size', d.byte_size, 'storage_path', d.storage_path);
end;
$$;

-- By whoever added it, while the purchase is still being put together.
-- Returns { purchase, storage_path }; the route removes the object.
create or replace function public.purchases_document_delete(p_purchase_id uuid, p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
    d public.purchase_documents;
begin
    perform public.purchases_require_auth();
    r := public.purchases_load(p_purchase_id);
    select * into d from public.purchase_documents where id = p_document_id and purchase_id = r.id;
    if d.id is null or public.purchases_shape(r) is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if d.uploaded_by is distinct from auth.uid() then
        raise exception 'Only the person who added a document can remove it.' using errcode = 'PT403';
    end if;
    if r.status not in ('draft', 'submitted', 'sourcing') then
        raise exception 'Documents are kept once % has gone for approval.', public.purchases_label(r)
            using errcode = 'PT409';
    end if;
    delete from public.purchase_documents where id = d.id;
    perform public.purchases_event(r.id, 'document_removed', r.status, r.status, null,
        jsonb_build_object('kind', d.kind, 'filename', d.filename));
    return jsonb_build_object('purchase', public.purchases_get(r.id), 'storage_path', d.storage_path);
end;
$$;

-- Storage policy helpers. An object belongs to the purchase named by its
-- first path segment.
create or replace function public.purchases_storage_purchase(p_name text)
returns public.purchases
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases;
begin
    begin
        select * into r from public.purchases where id = split_part(p_name, '/', 1)::uuid;
    exception when others then
        return null;
    end;
    return r;
end;
$$;

create or replace function public.purchases_storage_can_insert(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_storage_purchase(p_name);
begin
    return r.id is not null and cardinality(public.purchases_doc_kinds(r)) > 0;
end;
$$;

create or replace function public.purchases_storage_can_read(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_storage_purchase(p_name);
    v_shape text;
begin
    if r.id is null then
        return false;
    end if;
    v_shape := public.purchases_shape(r);
    return exists (select 1 from public.purchase_documents d
                    where d.storage_path = p_name
                      and (v_shape = 'full'
                           or (v_shape = 'requester' and d.uploaded_by = r.requester_id)
                           or (v_shape = 'checker' and d.kind in ('delivery_photo', 'delivery_note'))));
end;
$$;

-- Only an object no document points at: one whose row was removed, or one
-- whose row was never written.
create or replace function public.purchases_storage_can_delete(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.purchases := public.purchases_storage_purchase(p_name);
begin
    return r.id is not null
       and not exists (select 1 from public.purchase_documents d where d.storage_path = p_name)
       and (r.requester_id = auth.uid() or r.checker_id = auth.uid() or public.purchases_role() = 'finance');
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Finance requests: the link to the purchase.
-- ---------------------------------------------------------------------------

-- As in 20260930001000, plus the purchase it pays.
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
        'awaiting', case when r.status in ('submitted', 'endorsed') then 'executive' end,
        'is_editable', r.status in ('draft', 'changes_requested'),
        'created_at', r.created_at,
        'purchase', (select jsonb_build_object('id', p.id, 'reference', p.reference,
                                               'order_number', p.order_number, 'title', p.title)
                       from public.purchases p where p.id = r.purchase_id)
    );
$$;

-- As in 20260926000800, except that a request paying a purchase keeps the
-- purchase's title and lines: only its notes and due date change.
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
    v_linked public.finance_requests;
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

    select * into v_linked from public.finance_requests where id = p_id and purchase_id is not null;
    if v_linked.id is not null then
        if btrim(v_title) <> v_linked.title
           or (select coalesce(jsonb_agg(jsonb_build_array(x ->> 'category', btrim(x ->> 'description'),
                                                           round((x ->> 'amount')::numeric, 2))
                                         order by ord), '[]'::jsonb)
                 from jsonb_array_elements(v_items) with ordinality t(x, ord))
              <> (select coalesce(jsonb_agg(jsonb_build_array(i.category, i.description, round(i.amount::numeric, 2))
                                            order by i.sort_order, i.created_at, i.id), '[]'::jsonb)
                    from public.finance_request_items i where i.request_id = p_id) then
            raise exception 'This request pays a purchase: its title and amount come from the purchase.'
                using errcode = 'PT422';
        end if;
        update public.finance_requests
           set notes = nullif(btrim(coalesce(v_notes, '')), ''),
               due_date = v_due_date,
               updated_at = now()
         where id = p_id;
        return;
    end if;

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

-- As in 20260926000800, plus: a request paying a purchase needs the transfer
-- proof attached, and paying it pays the purchase.
create or replace function public.finance_mark_paid(p_id uuid, p_paid_on date, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
    v_purchase public.purchases;
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
    if r.purchase_id is not null
       and not exists (select 1 from public.finance_request_documents d where d.request_id = r.id) then
        raise exception 'Attach the transfer proof first.' using errcode = 'PT422';
    end if;
    update public.finance_requests
       set status = 'paid', paid_on = p_paid_on, paid_by_id = auth.uid(),
           payment_note = nullif(btrim(coalesce(p_note, '')), ''),
           updated_at = now()
     where id = r.id
    returning * into r;
    perform public.log_activity('FINANCE_REQUEST_PAID',
        format('Paid %s on %s', public.finance_label(r), to_char(p_paid_on, 'DD FMMonth YYYY')), r.id, null);

    if r.purchase_id is not null then
        select * into v_purchase from public.purchases where id = r.purchase_id for update;
        if v_purchase.status = 'matched' then
            update public.purchases set status = 'paid', paid_on = p_paid_on, updated_at = now()
             where id = v_purchase.id;
            perform public.purchases_event(v_purchase.id, 'paid', 'matched', 'paid', null,
                jsonb_build_object('paid_on', p_paid_on, 'finance_request', r.reference));
            perform public.purchases_notify_requester(v_purchase.id, 'purchase_closed', 'success',
                'Done: ' || v_purchase.title, 'Your request is complete.');
        end if;
    end if;
    return public.finance_request_json(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Assets from purchase lines.
-- ---------------------------------------------------------------------------

-- The asset lines received and not yet fully registered.
create or replace function public.assets_awaiting_registration()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.purchases_require_auth();
    if not public.assets_can_manage() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return coalesce((
        select jsonb_agg(x.j order by x.grn_at, x.sort_order)
          from (select jsonb_build_object(
                           'line_id', l.id,
                           'purchase_id', p.id,
                           'reference', p.reference,
                           'order_number', p.order_number,
                           'description', l.description,
                           'category', jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name),
                           'unit_price', l.unit_price,
                           'qty_received', l.qty_received,
                           'registered', (select count(*)::int from public.assets a where a.purchase_line_id = l.id),
                           'grn_at', p.grn_at,
                           'vendor_name', (select v.name from public.vendors v where v.id = p.vendor_id)) j,
                       p.grn_at, l.sort_order
                  from public.purchase_lines l
                  join public.purchases p on p.id = l.purchase_id
                  join public.asset_categories c on c.id = l.asset_category_id
                 where l.line_type = 'asset'
                   and p.status in ('received', 'amount_review', 'matched', 'paid')
                   and coalesce(l.qty_received, 0) > (select count(*) from public.assets a where a.purchase_line_id = l.id)
               ) x), '[]'::jsonb);
end;
$$;

-- Register one asset from a waiting line: the line fills the defaults, the
-- existing assets_register does the rest, and the asset keeps the line.
create or replace function public.assets_register_from_line(p_line_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    l public.purchase_lines;
    r public.purchases;
    v_done int;
    v_out jsonb;
    v_asset uuid;
begin
    perform public.purchases_require_auth();
    if not public.assets_can_manage() then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    select * into l from public.purchase_lines where id = p_line_id for update;
    if l.id is null or l.line_type <> 'asset' then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into r from public.purchases where id = l.purchase_id;
    if r.status not in ('received', 'amount_review', 'matched', 'paid') then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select count(*)::int into v_done from public.assets a where a.purchase_line_id = l.id;
    if v_done >= coalesce(l.qty_received, 0) then
        raise exception 'All % received on this line are already registered.', coalesce(l.qty_received, 0)
            using errcode = 'PT422';
    end if;

    p := jsonb_build_object('category_id', l.asset_category_id, 'name', l.description,
                            'purchase_date', (r.grn_at at time zone 'Asia/Jakarta')::date,
                            'purchase_value', l.unit_price)
         || coalesce(p, '{}'::jsonb);
    v_out := public.assets_register(p);
    v_asset := (v_out ->> 'id')::uuid;
    update public.assets set purchase_line_id = l.id where id = v_asset;
    -- Same transaction as the registration: the event is completed, not edited later.
    update public.asset_events
       set body = body || ' · Bought on ' || r.reference || coalesce(' / ' || r.order_number, '')
     where asset_id = v_asset and kind = 'registered';

    if not exists (select 1 from public.purchase_lines l2
                    where l2.purchase_id = r.id and l2.line_type = 'asset'
                      and coalesce(l2.qty_received, 0) > (select count(*) from public.assets a
                                                          where a.purchase_line_id = l2.id)) then
        perform public.purchases_settle(r.id, array['purchase_assets_to_register'], 'registered');
    end if;
    return public.assets_serialise(v_asset, true, true);
end;
$$;

-- As in 20261016000100, plus the purchase an asset was bought on, for full
-- viewers.
create or replace function public.assets_serialise(p_id uuid, p_full boolean, p_with_events boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_me uuid := public.current_employee_id();
    v_can_manage boolean := p_full and public.assets_can_manage();
    v_a public.assets;
    v_cat public.asset_categories;
    v_out jsonb;
begin
    select * into v_a from public.assets where id = p_id;
    if not found then
        return null;
    end if;
    select * into v_cat from public.asset_categories where id = v_a.category_id;

    v_out := jsonb_build_object(
        'id', v_a.id,
        'tag', v_a.tag,
        'category', jsonb_build_object('id', v_cat.id, 'code', v_cat.code, 'name', v_cat.name,
                                       'tracks_calibration', v_cat.tracks_calibration),
        'name', v_a.name,
        'brand', v_a.brand,
        'model', v_a.model,
        'serial_number', v_a.serial_number,
        'status', v_a.status,
        'holder', case when v_a.holder_employee_id is null then null
                       else jsonb_build_object('employee_id', v_a.holder_employee_id,
                                               'name', public.assets_person_name(v_a.holder_employee_id),
                                               'since', v_a.holder_since,
                                               'confirmed_at', v_a.holder_confirmed_at) end,
        'handover_pending', v_a.status = 'assigned' and v_a.holder_confirmed_at is null,
        'calibration_due', v_a.calibration_due,
        'can_respond', v_me is not null and v_a.holder_employee_id = v_me
                       and v_a.status = 'assigned' and v_a.holder_confirmed_at is null,
        'checkin', (select jsonb_build_object('item_id', i.id, 'round_id', rd.id, 'round_name', rd.name,
                                              'due_date', rd.due_date, 'state', i.state,
                                              'can_answer', i.state = 'pending' and v_me is not null
                                                            and i.holder_employee_id = v_me)
                      from public.asset_checkin_items i
                      join public.asset_checkin_rounds rd on rd.id = i.round_id
                     where i.asset_id = v_a.id
                       and rd.closed_at is null
                       and (p_full or i.holder_employee_id = v_me))
    );

    if p_full then
        v_out := v_out || jsonb_build_object(
            'location', v_a.location,
            'purchase_date', v_a.purchase_date,
            'purchase_value', v_a.purchase_value,
            'currency', v_a.currency,
            'warranty_until', v_a.warranty_until,
            'flag', case when v_a.flag_kind is null then null
                         else jsonb_build_object('kind', v_a.flag_kind, 'note', v_a.flag_note,
                                                 'at', v_a.flagged_at) end,
            'notes', v_a.notes,
            'retired_at', v_a.retired_at,
            'created_at', v_a.created_at,
            'updated_at', v_a.updated_at,
            'can_manage', v_can_manage,
            'moves', to_jsonb(case when v_can_manage then public.assets_moves(v_a.status) else '{}'::text[] end),
            'tickets', coalesce((
                select jsonb_agg(jsonb_build_object('id', t.id, 'reference', t.reference,
                                                    'subject', t.subject, 'status', t.status,
                                                    'created_at', t.created_at)
                                 order by t.created_at, t.reference)
                  from public.support_tickets t
                 where t.asset_id = v_a.id), '[]'::jsonb),
            'purchase', (select jsonb_build_object('id', p.id, 'reference', p.reference,
                                                   'order_number', p.order_number, 'line_id', l.id)
                           from public.purchase_lines l
                           join public.purchases p on p.id = l.purchase_id
                          where l.id = v_a.purchase_line_id)
        );
    end if;

    v_out := v_out || jsonb_build_object('events', case when not p_with_events then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object(
                   'id', ev.id,
                   'kind', ev.kind,
                   'actor_name', ev.actor_name,
                   'from_status', ev.from_status,
                   'to_status', ev.to_status,
                   'from_holder_name', case when p_full or ev.from_holder_id = v_me then ev.from_holder_name end,
                   'to_holder_name', case when p_full or ev.to_holder_id = v_me then ev.to_holder_name end,
                   'ticket_reference', t.reference,
                   'body', ev.body,
                   'created_at', ev.created_at
               ) order by ev.created_at, ev.seq)
          from public.asset_events ev
          left join public.support_tickets t on t.id = ev.ticket_id
         where ev.asset_id = v_a.id
           and (p_full or ev.created_at >= v_a.holder_since)
    ), '[]'::jsonb) end);

    return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. Grants.
-- ---------------------------------------------------------------------------

do $$
declare
    f text;
begin
    -- Helpers: no client calls them.
    foreach f in array array[
        'public.purchases_role()',
        'public.purchases_is_full_viewer()',
        'public.purchases_require_auth()',
        'public.purchases_require_role(text, text)',
        'public.purchases_load(uuid)',
        'public.purchases_label(public.purchases)',
        'public.purchases_require_status(public.purchases, text[], text)',
        'public.purchases_user_name(uuid)',
        'public.purchases_actor_name()',
        'public.purchases_money(numeric)',
        'public.purchases_event(uuid, text, text, text, text, jsonb)',
        'public.purchases_notify(uuid[], text, text, uuid, text, text, text, text, text, text)',
        'public.purchases_settle(uuid, text[], text, uuid)',
        'public.purchases_settings_row()',
        'public.purchases_field_bool(jsonb, text)',
        'public.purchases_field_uuid(jsonb, text)',
        'public.purchases_field_time(jsonb, text)',
        'public.purchases_month_total(uuid, uuid, date)',
        'public.purchases_tier(numeric)',
        'public.purchases_route(public.purchases)',
        'public.purchases_doc_count(uuid, text)',
        'public.purchases_missing(public.purchases)',
        'public.purchases_shape(public.purchases)',
        'public.purchases_can(public.purchases)',
        'public.purchases_check_line(int, text, text, numeric, numeric, uuid, uuid, boolean)',
        'public.purchases_recompute_total(uuid)',
        'public.purchases_write_items(uuid, jsonb)',
        'public.purchases_seed_lines(uuid)',
        'public.purchases_write_lines_finance(uuid, jsonb)',
        'public.purchases_milestone(public.purchases)',
        'public.purchases_notify_requester(uuid, text, text, text, text, text)',
        'public.vendors_json(uuid, boolean)',
        'public.vendors_event(uuid, text, jsonb, jsonb, text, jsonb)',
        'public.vendors_require_view()',
        'public.vendors_check_identity(uuid, text, text)',
        'public.purchases_serialise(uuid, text, boolean)',
        'public.purchases_apply_request(uuid, jsonb)',
        'public.purchases_load_own_draft(uuid)',
        'public.purchases_load_finance(uuid, text[], text)',
        'public.purchases_next_number(text)',
        'public.purchases_load_peter(uuid, text[], text)',
        'public.purchases_check_checker(public.purchases, uuid)',
        'public.purchases_doc_kinds(public.purchases)',
        'public.purchases_storage_purchase(text)'
    ] loop
        execute 'revoke all on function ' || f || ' from public';
        execute 'revoke all on function ' || f || ' from anon, authenticated';
    end loop;

    -- Storage policies call these as the signed-in user.
    foreach f in array array[
        'public.purchases_storage_can_insert(text)',
        'public.purchases_storage_can_read(text)',
        'public.purchases_storage_can_delete(text)'
    ] loop
        execute 'revoke all on function ' || f || ' from public';
        execute 'revoke all on function ' || f || ' from anon';
        execute 'grant execute on function ' || f || ' to authenticated';
    end loop;

    -- What the page calls.
    foreach f in array array[
        'public.vendors_list(boolean)',
        'public.vendors_get(uuid)',
        'public.vendors_create(jsonb)',
        'public.vendors_update(uuid, jsonb)',
        'public.vendors_set_active(uuid, boolean, text)',
        'public.vendors_change_bank(uuid, jsonb, text)',
        'public.purchases_settings()',
        'public.purchases_settings_update(jsonb)',
        'public.purchases_get(uuid)',
        'public.purchases_list(jsonb)',
        'public.purchases_mine()',
        'public.purchases_to_check()',
        'public.purchases_checker_candidates(uuid)',
        'public.purchases_create(jsonb)',
        'public.purchases_update(uuid, jsonb)',
        'public.purchases_delete(uuid)',
        'public.purchases_submit(uuid)',
        'public.purchases_cancel(uuid, text)',
        'public.purchases_register(uuid, jsonb)',
        'public.purchases_return(uuid, text)',
        'public.purchases_close_petty_cash(uuid, numeric)',
        'public.purchases_source(uuid, jsonb)',
        'public.purchases_send_for_approval(uuid)',
        'public.purchases_approve(uuid, text)',
        'public.purchases_send_back(uuid, text)',
        'public.purchases_reject(uuid, text)',
        'public.purchases_confirm_urgent(uuid, text)',
        'public.purchases_issue_order(uuid, uuid)',
        'public.purchases_change_checker(uuid, uuid)',
        'public.purchases_receive(uuid, jsonb, boolean, text)',
        'public.purchases_ask_amount(uuid, numeric, text)',
        'public.purchases_decide_amount(uuid, boolean, text)',
        'public.purchases_match(uuid, jsonb)',
        'public.purchases_document_add(uuid, text, text, text, integer, text)',
        'public.purchases_document_get(uuid, uuid)',
        'public.purchases_document_delete(uuid, uuid)',
        'public.assets_awaiting_registration()',
        'public.assets_register_from_line(uuid, jsonb)'
    ] loop
        execute 'revoke all on function ' || f || ' from public';
        execute 'revoke all on function ' || f || ' from anon';
        execute 'grant execute on function ' || f || ' to authenticated';
    end loop;

    -- Redefined: as before.
    execute 'revoke all on function public.finance_request_json(public.finance_requests) from public, anon, authenticated';
    execute 'revoke all on function public.finance_apply_body(uuid, jsonb) from public, anon, authenticated';
    execute 'revoke all on function public.assets_serialise(uuid, boolean, boolean) from public';
    execute 'revoke all on function public.assets_serialise(uuid, boolean, boolean) from anon, authenticated';
    execute 'revoke all on function public.finance_mark_paid(uuid, date, text) from public';
    execute 'grant execute on function public.finance_mark_paid(uuid, date, text) to authenticated';
end
$$;

-- ---------------------------------------------------------------------------
-- 16. Storage: private bucket. Guarded: the test database has no storage
--     schema.
-- ---------------------------------------------------------------------------

do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('purchase-documents', 'purchase-documents', false)
    on conflict (id) do nothing;

    drop policy if exists purchase_documents_select on storage.objects;
    create policy purchase_documents_select on storage.objects
        for select to authenticated
        using (bucket_id = 'purchase-documents' and public.purchases_storage_can_read(name));

    drop policy if exists purchase_documents_insert on storage.objects;
    create policy purchase_documents_insert on storage.objects
        for insert to authenticated
        with check (bucket_id = 'purchase-documents' and public.purchases_storage_can_insert(name));

    drop policy if exists purchase_documents_delete on storage.objects;
    create policy purchase_documents_delete on storage.objects
        for delete to authenticated
        using (bucket_id = 'purchase-documents' and public.purchases_storage_can_delete(name));
  end if;
end $$;

commit;
