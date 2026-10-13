-- ===========================================================================
-- Office asset register.
-- openspec/changes/office-asset-register.
--
-- Office assets were tracked in an Excel file IT kept, which went stale
-- because every change relied on somebody remembering to open it. The
-- register starts fresh here, and keeping it true is part of the handover:
--
--   * every item gets a tag the platform generates, DTG-<category>-<number>,
--     which never changes and is never reused;
--   * an item is in store, assigned, in repair, retired or lost, and moves
--     between them only by IT's explicit moves, each kept on an append-only
--     history;
--   * the person an item is assigned to confirms they have it, or says they
--     did not receive it, which flags it to IT;
--   * IT links a ticket to the asset it concerns, so repairs show on the
--     asset;
--   * IT runs check-in rounds: every holder answers for each item, and IT
--     marks what is on the shelf; the closed round is kept for audit;
--   * a daily run reminds holders a week into a round, reminds IT when six
--     months have passed since the last round, and tells IT about leavers who
--     still hold items.
--
-- IT is whoever works the IT queue (tickets_works_queue: the IT support flag,
-- and the manager of IT support). Finance and management read the whole
-- register, values included; everyone else sees what they hold, without
-- values, location or earlier holders.
--
-- The holder is a nullable employee rather than a required one, so the
-- sensor work can add a site as holder and a `deployed` status later.
--
-- tickets_serialise() is as in 20261015000100, plus the linked asset.
-- Safe to re-run.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------

create table if not exists public.asset_categories (
    id                 uuid primary key default gen_random_uuid(),
    code               varchar(4)  not null,
    name               varchar(80) not null,
    tracks_calibration boolean not null default false,
    next_number        integer not null default 1,
    is_active          boolean not null default true,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    constraint uq_asset_categories_code unique (code),
    constraint ck_asset_categories_code check (code ~ '^[A-Z]{2,4}$'),
    constraint ck_asset_categories_next check (next_number >= 1)
);

insert into public.asset_categories (code, name, tracks_calibration) values
    ('LAP', 'Laptop', false),
    ('DSK', 'Desktop', false),
    ('MON', 'Monitor', false),
    ('PHN', 'Phone / tablet', false),
    ('PRN', 'Printer / scanner', false),
    ('NET', 'Network', false),
    ('ACC', 'Accessory', false),
    ('FUR', 'Furniture', false),
    ('SEN', 'Sensor', true),
    ('OTH', 'Other', false)
on conflict (code) do nothing;

-- The holder must exist while it holds something: deleting an employee who
-- still holds an asset is refused (no action), rather than leaving an
-- assigned item with nobody.
create table if not exists public.assets (
    id                  uuid primary key default gen_random_uuid(),
    tag                 varchar(20)  not null,
    category_id         uuid not null references public.asset_categories(id),
    name                varchar(200) not null,
    brand               varchar(100),
    model               varchar(100),
    serial_number       varchar(100),
    status              varchar(20) not null default 'in_store',
    holder_employee_id  uuid references public.employees(id),
    holder_since        timestamptz,
    holder_confirmed_at timestamptz,
    location            varchar(160),
    purchase_date       date,
    purchase_value      numeric(16, 2),
    currency            varchar(3) not null default 'IDR',
    warranty_until      date,
    calibration_due     date,
    flag_kind           varchar(30),
    flag_note           text,
    flagged_at          timestamptz,
    notes               text,
    retired_at          timestamptz,
    created_by          uuid references public.users(id) on delete set null,
    updated_by          uuid references public.users(id) on delete set null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint uq_assets_tag unique (tag),
    constraint ck_assets_status
        check (status in ('in_store', 'assigned', 'in_repair', 'retired', 'lost')),
    -- Assigned has a holder; in store and retired have none; an item in
    -- repair or lost keeps whoever it was with, if anybody.
    constraint ck_assets_holder
        check ((status = 'assigned' and holder_employee_id is not null)
            or (status in ('in_store', 'retired') and holder_employee_id is null)
            or status in ('in_repair', 'lost')),
    constraint ck_assets_confirmed
        check (holder_employee_id is not null or (holder_confirmed_at is null and holder_since is null)),
    constraint ck_assets_flag
        check (flag_kind is null or flag_kind in ('handover_declined', 'checkin_missing')),
    constraint ck_assets_value check (purchase_value is null or purchase_value >= 0),
    constraint ck_assets_currency check (currency ~ '^[A-Z]{3}$')
);

-- One serial per item, however it was typed.
create unique index if not exists ux_assets_serial
    on public.assets (lower(btrim(serial_number))) where serial_number is not null;
create index if not exists ix_assets_status      on public.assets (status);
create index if not exists ix_assets_holder      on public.assets (holder_employee_id);
create index if not exists ix_assets_category_id on public.assets (category_id);

-- Append-only: no client grants, and no function updates or deletes a row.
-- seq keeps the order events were written where two share a timestamp (see
-- 20261015000100). The holders' names are kept as they were at the time.
create table if not exists public.asset_events (
    id               uuid primary key default gen_random_uuid(),
    seq              bigint generated always as identity,
    asset_id         uuid not null references public.assets(id) on delete cascade,
    kind             varchar(30) not null,
    actor_id         uuid references public.users(id) on delete set null,
    actor_name       varchar(160) not null,
    from_status      varchar(20),
    to_status        varchar(20),
    from_holder_id   uuid references public.employees(id) on delete set null,
    to_holder_id     uuid references public.employees(id) on delete set null,
    from_holder_name varchar(160),
    to_holder_name   varchar(160),
    ticket_id        uuid references public.support_tickets(id) on delete set null,
    body             text,
    created_at       timestamptz not null default clock_timestamp()
);
create index if not exists ix_asset_events_asset
    on public.asset_events (asset_id, created_at, seq);

alter table public.support_tickets
    add column if not exists asset_id uuid references public.assets(id) on delete set null;
create index if not exists ix_support_tickets_asset_id on public.support_tickets (asset_id);

create table if not exists public.asset_checkin_rounds (
    id              uuid primary key default gen_random_uuid(),
    name            varchar(120) not null,
    started_at      timestamptz not null default now(),
    started_by      uuid references public.users(id) on delete set null,
    started_by_name varchar(160),
    due_date        date not null,
    reminded_at     timestamptz,
    closed_at       timestamptz,
    closed_by       uuid references public.users(id) on delete set null,
    closed_by_name  varchar(160),
    summary         jsonb
);
-- One round open at a time.
create unique index if not exists ux_asset_checkin_rounds_open
    on public.asset_checkin_rounds ((closed_at is null)) where closed_at is null;

create table if not exists public.asset_checkin_items (
    id                 uuid primary key default gen_random_uuid(),
    round_id           uuid not null references public.asset_checkin_rounds(id) on delete cascade,
    asset_id           uuid not null references public.assets(id) on delete cascade,
    holder_employee_id uuid references public.employees(id) on delete set null,
    holder_name        varchar(160),
    state              varchar(20) not null default 'pending',
    responded_at       timestamptz,
    responded_by       uuid references public.users(id) on delete set null,
    responded_by_name  varchar(160),
    note               text,
    constraint uq_asset_checkin_items unique (round_id, asset_id),
    constraint ck_asset_checkin_items_state
        check (state in ('pending', 'confirmed', 'missing', 'seen', 'no_reply'))
);
create index if not exists ix_asset_checkin_items_holder
    on public.asset_checkin_items (holder_employee_id, state);

-- A leaver notice goes once per employee, reason and end date: a moved end
-- date warns afresh.
create table if not exists public.asset_leaver_notices (
    id          uuid primary key default gen_random_uuid(),
    employee_id uuid not null references public.employees(id) on delete cascade,
    reason      varchar(20) not null,
    end_date    date,
    sent_at     timestamptz not null default now(),
    constraint ck_asset_leaver_notices_reason check (reason in ('inactive', 'contract_end'))
);
create unique index if not exists ux_asset_leaver_notices
    on public.asset_leaver_notices (employee_id, reason, coalesce(end_date, date '1970-01-01'));

-- Every read and write goes through the functions below.
alter table public.asset_categories     enable row level security;
alter table public.assets               enable row level security;
alter table public.asset_events         enable row level security;
alter table public.asset_checkin_rounds enable row level security;
alter table public.asset_checkin_items  enable row level security;
alter table public.asset_leaver_notices enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Helpers (not callable by clients).
-- ---------------------------------------------------------------------------

-- IT: whoever works the IT queue.
create or replace function public.assets_can_manage()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.tickets_works_queue(public.current_employee_id());
$$;

-- The whole register, values included: IT, finance and management.
create or replace function public.assets_can_view_all()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.assets_can_manage()
        or public.is_finance()
        or public.is_admin()
        or coalesce((public.current_employee()).is_management_role, false);
$$;

create or replace function public.assets_person_name(p_employee_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select nullif(trim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), '')
      from public.employees e
     where e.id = p_employee_id;
$$;

create or replace function public.assets_actor_name()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (select nullif(trim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), '')
           from public.employees e where e.user_id = auth.uid() limit 1),
        public.notifications_actor_name(),
        case when auth.uid() is null then 'Automatic' else 'Someone' end);
$$;

create or replace function public.assets_user_of(p_employee_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select e.user_id from public.employees e where e.id = p_employee_id;
$$;

create or replace function public.assets_status_label(p_status text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_status
        when 'in_store'  then 'in store'
        when 'assigned'  then 'assigned'
        when 'in_repair' then 'in repair'
        when 'retired'   then 'retired'
        when 'lost'      then 'lost'
        else coalesce(p_status, '')
    end;
$$;

-- The moves IT may make from a status.
create or replace function public.assets_moves(p_status text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_status
        when 'in_store'  then array['assign', 'repair_out', 'lost', 'retire']
        when 'assigned'  then array['transfer', 'return', 'repair_out', 'lost']
        when 'in_repair' then array['repair_back', 'lost', 'retire']
        when 'lost'      then array['found', 'retire']
        else '{}'::text[]
    end;
$$;

-- Whether somebody still holds anything: assigned to them, or away for
-- repair in their name. A lost item is no longer held.
create or replace function public.assets_holds_anything(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (select 1 from public.assets a
                    where a.holder_employee_id = p_employee_id
                      and a.status in ('assigned', 'in_repair'));
$$;

-- One history row, with the actor and the holders' names as they are now.
create or replace function public.assets_event(
    p_asset_id uuid,
    p_kind text,
    p_from_status text,
    p_to_status text,
    p_from_holder uuid,
    p_to_holder uuid,
    p_body text,
    p_ticket_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.asset_events (asset_id, kind, actor_id, actor_name, from_status, to_status,
                                     from_holder_id, to_holder_id, from_holder_name, to_holder_name,
                                     ticket_id, body, created_at)
    values (p_asset_id, p_kind, auth.uid(), left(public.assets_actor_name(), 160),
            p_from_status, p_to_status, p_from_holder, p_to_holder,
            left(public.assets_person_name(p_from_holder), 160),
            left(public.assets_person_name(p_to_holder), 160),
            p_ticket_id, nullif(btrim(coalesce(p_body, '')), ''), clock_timestamp());
end;
$$;

-- A notification about one asset. The actor is never told about their own
-- action, and a failure never undoes the change.
create or replace function public.assets_notify(
    p_to uuid[],
    p_kind text,
    p_tone text,
    p_asset_id uuid,
    p_intro text,
    p_note text default null,
    p_note_by text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_asset public.assets;
    v_category text;
begin
    begin
        select * into v_asset from public.assets where id = p_asset_id;
        select c.name into v_category from public.asset_categories c where c.id = v_asset.category_id;
        perform public.notifications_enqueue(
            p_to,
            array_remove(array[auth.uid()], null),
            p_kind,
            v_asset.tag || ': ' || public.notifications_one_line(v_asset.name, 100),
            public.notifications_payload(
                p_tone, 'Asset ' || v_asset.tag,
                public.notifications_one_line(v_asset.name, 200),
                p_intro,
                array['Tag', v_asset.tag,
                      'Category', coalesce(v_category, ''),
                      'Serial number', coalesce(v_asset.serial_number, '')],
                p_note, p_note_by,
                '/equipment?open=' || v_asset.id, 'Open the asset'),
            'assets', v_asset.id);
    exception when others then
        raise warning 'assets_notify %: %', p_kind, sqlerrm;
    end;
end;
$$;

-- A notification about something other than one asset: a check-in round, a
-- leaver.
create or replace function public.assets_notify_about(
    p_to uuid[],
    p_kind text,
    p_tone text,
    p_eyebrow text,
    p_headline text,
    p_intro text,
    p_details text[],
    p_link_path text,
    p_link_label text,
    p_source_table text,
    p_source_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    begin
        perform public.notifications_enqueue(
            p_to,
            array_remove(array[auth.uid()], null),
            p_kind,
            p_headline,
            public.notifications_payload(p_tone, p_eyebrow, p_headline, p_intro, p_details,
                                         null, null, p_link_path, p_link_label),
            p_source_table, p_source_id);
    exception when others then
        raise warning 'assets_notify_about %: %', p_kind, sqlerrm;
    end;
end;
$$;

-- Settle these kinds of open action item on a source, for one recipient or
-- for all. notifications_resolve_kinds() settles for everybody; a check-in
-- round asks each holder separately, and each is done when they are.
create or replace function public.assets_settle(
    p_source_table text,
    p_source_id uuid,
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
         where source_table = p_source_table
           and source_id is not distinct from p_source_id
           and resolved_at is null
           and needs_action
           and kind = any (coalesce(p_kinds, '{}'))
           and created_at < now()
           and (p_user_id is null or user_id = p_user_id);
    exception when others then
        raise warning 'assets_settle: %', sqlerrm;
    end;
end;
$$;

-- A holder who has answered everything in a round is done with its request.
create or replace function public.assets_round_settle_holder(p_round_id uuid, p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user uuid := public.assets_user_of(p_employee_id);
begin
    if p_employee_id is null or v_user is null then
        return;
    end if;
    if not exists (select 1 from public.asset_checkin_items i
                    where i.round_id = p_round_id
                      and i.holder_employee_id = p_employee_id
                      and i.state = 'pending') then
        perform public.assets_settle('asset_checkin_rounds', p_round_id,
                                     array['asset_checkin_requested'], 'answered', v_user);
    end if;
end;
$$;

-- What every IT move on an asset settles: IT's flag items on it, its pending
-- item in the open round (IT handled it, so it is seen), and a leaver's item
-- once they hold nothing.
create or replace function public.assets_after_it_move(p_asset_id uuid, p_old_holder uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r record;
begin
    perform public.assets_settle('assets', p_asset_id,
                                 array['asset_handover_declined', 'asset_checkin_missing'], p_status);

    for r in update public.asset_checkin_items i
                set state = 'seen',
                    responded_at = now(),
                    responded_by = auth.uid(),
                    responded_by_name = left(public.assets_actor_name(), 160),
                    note = 'Handled by IT during the round'
               from public.asset_checkin_rounds rd
              where rd.id = i.round_id
                and rd.closed_at is null
                and i.asset_id = p_asset_id
                and i.state = 'pending'
          returning i.round_id, i.holder_employee_id loop
        perform public.assets_round_settle_holder(r.round_id, r.holder_employee_id);
    end loop;

    if p_old_holder is not null and not public.assets_holds_anything(p_old_holder) then
        perform public.assets_settle('employees', p_old_holder, array['asset_holder_leaving'], 'cleared');
    end if;
end;
$$;

-- Payload fields, with the field named when they will not parse.
create or replace function public.assets_field_date(p jsonb, p_key text)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    return nullif(btrim(coalesce(p ->> p_key, '')), '')::date;
exception when others then
    raise exception '%: must be a date', p_key using errcode = 'PT422';
end;
$$;

create or replace function public.assets_field_numeric(p jsonb, p_key text)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v numeric;
begin
    begin
        v := nullif(btrim(coalesce(p ->> p_key, '')), '')::numeric;
    exception when others then
        raise exception '%: must be a number', p_key using errcode = 'PT422';
    end;
    if v is not null and v < 0 then
        raise exception '%: must not be negative', p_key using errcode = 'PT422';
    end if;
    return v;
end;
$$;

create or replace function public.assets_field_text(p jsonb, p_key text, p_max int)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v text := nullif(btrim(coalesce(p ->> p_key, '')), '');
begin
    if char_length(coalesce(v, '')) > p_max then
        raise exception '%: must be at most % characters', p_key, p_max using errcode = 'PT422';
    end if;
    return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The asset, as the page reads it.
--
-- Full (IT, finance, management): everything, the whole history, the linked
-- tickets, and the moves IT may make. Holder (everybody else, for what they
-- hold): no value, no location, and only the history since they became the
-- holder, with nobody else's name in it.
-- ---------------------------------------------------------------------------

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
                 where t.asset_id = v_a.id), '[]'::jsonb)
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
-- 4. Reads.
-- ---------------------------------------------------------------------------

create or replace function public.assets_list(p_include_retired boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_view_all() then
        raise exception 'The asset register is for IT, finance and management.' using errcode = 'PT403';
    end if;
    return jsonb_build_object(
        'items', coalesce((select jsonb_agg(public.assets_serialise(a.id, true, false) order by a.tag)
                             from public.assets a
                            where coalesce(p_include_retired, false) or a.status <> 'retired'), '[]'::jsonb),
        'can_manage', public.assets_can_manage()
    );
end;
$$;

create or replace function public.assets_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_a public.assets;
    v_me uuid := public.current_employee_id();
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    select * into v_a from public.assets where id = p_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if public.assets_can_view_all() then
        return public.assets_serialise(v_a.id, true, true);
    end if;
    if v_me is not null and v_a.holder_employee_id = v_me and v_a.status in ('assigned', 'in_repair') then
        return public.assets_serialise(v_a.id, false, true);
    end if;
    raise exception 'Not found' using errcode = 'PT404';
end;
$$;

-- My equipment: what the caller holds, and the round waiting on them.
create or replace function public.assets_mine()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_me uuid := public.current_employee_id();
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    return jsonb_build_object(
        'items', coalesce((select jsonb_agg(public.assets_serialise(a.id, false, true) order by a.tag)
                             from public.assets a
                            where v_me is not null
                              and a.holder_employee_id = v_me
                              and a.status in ('assigned', 'in_repair')), '[]'::jsonb),
        'round', (select jsonb_build_object(
                             'id', rd.id, 'name', rd.name, 'due_date', rd.due_date,
                             'pending', (select count(*)::int from public.asset_checkin_items i
                                          where i.round_id = rd.id and i.holder_employee_id = v_me
                                            and i.state = 'pending'),
                             'total', (select count(*)::int from public.asset_checkin_items i
                                        where i.round_id = rd.id and i.holder_employee_id = v_me))
                    from public.asset_checkin_rounds rd
                   where rd.closed_at is null
                     and v_me is not null
                     and exists (select 1 from public.asset_checkin_items i
                                  where i.round_id = rd.id and i.holder_employee_id = v_me)),
        'can_view_all', public.assets_can_view_all(),
        'can_manage', public.assets_can_manage()
    );
end;
$$;

create or replace function public.assets_categories()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'id', c.id, 'code', c.code, 'name', c.name,
                   'tracks_calibration', c.tracks_calibration, 'is_active', c.is_active,
                   'assets', (select count(*)::int from public.assets a where a.category_id = c.id),
                   'next_tag', 'DTG-' || c.code || '-' || lpad(c.next_number::text,
                                                               greatest(4, char_length(c.next_number::text)), '0'))
               order by c.is_active desc, c.name)
          from public.asset_categories c), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Registering and editing.
-- ---------------------------------------------------------------------------

-- Hand an asset to somebody (from store, or from its current holder). The
-- caller has checked who may and from which status.
create or replace function public.assets_do_assign(p_id uuid, p_employee_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_a public.assets;
    v_holder public.employees;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
    v_name text;
    v_actor text := public.assets_actor_name();
    v_transfer boolean;
begin
    select * into v_a from public.assets where id = p_id for update;
    select * into v_holder from public.employees where id = p_employee_id;
    if not found or not v_holder.is_active then
        raise exception 'employee: must be an active member of staff' using errcode = 'PT422';
    end if;
    if v_a.status = 'assigned' and v_a.holder_employee_id = v_holder.id then
        raise exception '% is already with %.', v_a.tag, public.assets_person_name(v_holder.id)
            using errcode = 'PT409';
    end if;
    v_transfer := v_a.status = 'assigned';
    v_name := public.assets_person_name(v_holder.id);

    update public.assets
       set status = 'assigned',
           holder_employee_id = v_holder.id,
           holder_since = now(),
           holder_confirmed_at = null,
           location = null,
           flag_kind = null, flag_note = null, flagged_at = null,
           updated_by = auth.uid(),
           updated_at = now()
     where id = v_a.id;

    -- The body names only the new holder: the history a holder reads starts
    -- here, and the person before them is not theirs to see.
    perform public.assets_event(v_a.id, case when v_transfer then 'transferred' else 'assigned' end,
        v_a.status, 'assigned', v_a.holder_employee_id, v_holder.id,
        case when v_transfer then 'Transferred to ' else 'Assigned to ' end || coalesce(v_name, 'a member of staff')
        || coalesce(': ' || v_note, '')
        || case when v_a.flag_kind is not null then ' · Flag cleared' else '' end);

    if v_transfer then
        perform public.assets_settle('assets', v_a.id, array['asset_assigned'], 'transferred',
                                     public.assets_user_of(v_a.holder_employee_id));
        perform public.assets_notify(array_remove(array[public.assets_user_of(v_a.holder_employee_id)], null),
            'asset_released', 'reminder', v_a.id,
            v_a.tag || ' has been transferred to someone else by ' || v_actor
            || '. It is no longer recorded against you.');
    end if;
    perform public.assets_notify(array_remove(array[v_holder.user_id], null),
        'asset_assigned', 'action', v_a.id,
        v_actor || ' has recorded ' || v_a.tag || ' as handed to you. Confirm you have it, '
        || 'or say if you did not receive it. Until you confirm, the handover shows as pending.',
        v_note, v_actor);

    perform public.log_activity('ASSET_ASSIGNED',
        v_a.tag || ' assigned to ' || coalesce(v_name, 'a member of staff'), v_a.id, v_holder.user_id);
    perform public.assets_after_it_move(v_a.id, case when v_transfer then v_a.holder_employee_id end, 'assigned');
end;
$$;

create or replace function public.assets_register(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_cat public.asset_categories;
    v_name text;
    v_serial text;
    v_currency text;
    v_assign uuid;
    v_holder public.employees;
    v_number int;
    v_tag text;
    v_existing text;
    v_id uuid;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_manage() then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    p := coalesce(p, '{}'::jsonb);

    v_name := public.assets_field_text(p, 'name', 200);
    if v_name is null then
        raise exception 'name: say what the item is' using errcode = 'PT422';
    end if;
    begin
        select * into v_cat from public.asset_categories
         where id = nullif(btrim(coalesce(p ->> 'category_id', '')), '')::uuid;
    exception when others then
        v_cat := null;
    end;
    if v_cat.id is null then
        raise exception 'category: choose a category' using errcode = 'PT422';
    end if;
    if not v_cat.is_active then
        raise exception 'category: % is no longer in use', v_cat.name using errcode = 'PT422';
    end if;

    v_serial := public.assets_field_text(p, 'serial_number', 100);
    if v_serial is not null then
        select a.tag into v_existing from public.assets a
         where lower(btrim(a.serial_number)) = lower(v_serial);
        if v_existing is not null then
            raise exception 'serial_number: already registered as %', v_existing using errcode = 'PT422';
        end if;
    end if;
    v_currency := upper(coalesce(public.assets_field_text(p, 'currency', 3), 'IDR'));
    if v_currency !~ '^[A-Z]{3}$' then
        raise exception 'currency: must be a three-letter code' using errcode = 'PT422';
    end if;

    if nullif(btrim(coalesce(p ->> 'assign_to', '')), '') is not null then
        begin
            v_assign := (p ->> 'assign_to')::uuid;
        exception when others then
            raise exception 'assign_to: must be an active member of staff' using errcode = 'PT422';
        end;
        select * into v_holder from public.employees where id = v_assign;
        if not found or not v_holder.is_active then
            raise exception 'assign_to: must be an active member of staff' using errcode = 'PT422';
        end if;
    end if;

    -- The category row is locked while its number is taken, so two people
    -- registering at once never get the same tag.
    update public.asset_categories
       set next_number = next_number + 1,
           updated_at = now()
     where id = v_cat.id
    returning next_number - 1 into v_number;
    v_tag := 'DTG-' || v_cat.code || '-' || lpad(v_number::text, greatest(4, char_length(v_number::text)), '0');

    insert into public.assets (tag, category_id, name, brand, model, serial_number, status,
                               location, purchase_date, purchase_value, currency, warranty_until,
                               calibration_due, notes, created_by, updated_by)
    values (v_tag, v_cat.id, v_name,
            public.assets_field_text(p, 'brand', 100),
            public.assets_field_text(p, 'model', 100),
            v_serial, 'in_store',
            public.assets_field_text(p, 'location', 160),
            public.assets_field_date(p, 'purchase_date'),
            public.assets_field_numeric(p, 'purchase_value'),
            v_currency,
            public.assets_field_date(p, 'warranty_until'),
            public.assets_field_date(p, 'calibration_due'),
            public.assets_field_text(p, 'notes', 4000),
            auth.uid(), auth.uid())
    returning id into v_id;

    perform public.assets_event(v_id, 'registered', null, 'in_store', null, null,
        'Registered as ' || v_tag);
    perform public.log_activity('ASSET_REGISTERED', 'Registered ' || v_tag || ': ' || v_name, v_id, null);

    if v_holder.id is not null then
        perform public.assets_do_assign(v_id, v_holder.id, public.assets_field_text(p, 'note', 4000));
    end if;

    return public.assets_serialise(v_id, true, true);
end;
$$;

-- Edit the details. Never the tag, status or holder: those move only by the
-- moves. Value changes show without their figures, since the history text is
-- the same for every reader.
create or replace function public.assets_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_a public.assets;
    v_cat public.asset_categories;
    v_new_cat public.asset_categories;
    v_parts text[] := '{}';
    v_name text;
    v_brand text;
    v_model text;
    v_serial text;
    v_location text;
    v_purchase_date date;
    v_value numeric;
    v_currency text;
    v_warranty date;
    v_calibration date;
    v_notes text;
    v_existing text;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_manage() then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    p := coalesce(p, '{}'::jsonb);
    select * into v_a from public.assets where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_a.status = 'retired' then
        raise exception '% is retired.', v_a.tag using errcode = 'PT409';
    end if;
    select * into v_cat from public.asset_categories where id = v_a.category_id;

    v_new_cat := v_cat;
    if p ? 'category_id' then
        begin
            select * into v_new_cat from public.asset_categories
             where id = nullif(btrim(coalesce(p ->> 'category_id', '')), '')::uuid;
        exception when others then
            v_new_cat := null;
        end;
        if v_new_cat.id is null then
            raise exception 'category: choose a category' using errcode = 'PT422';
        end if;
        if v_new_cat.id <> v_cat.id and not v_new_cat.is_active then
            raise exception 'category: % is no longer in use', v_new_cat.name using errcode = 'PT422';
        end if;
    end if;

    v_name := case when p ? 'name' then public.assets_field_text(p, 'name', 200) else v_a.name end;
    if v_name is null then
        raise exception 'name: say what the item is' using errcode = 'PT422';
    end if;
    v_brand := case when p ? 'brand' then public.assets_field_text(p, 'brand', 100) else v_a.brand end;
    v_model := case when p ? 'model' then public.assets_field_text(p, 'model', 100) else v_a.model end;
    v_serial := case when p ? 'serial_number' then public.assets_field_text(p, 'serial_number', 100)
                     else v_a.serial_number end;
    v_location := case when p ? 'location' then public.assets_field_text(p, 'location', 160) else v_a.location end;
    v_purchase_date := case when p ? 'purchase_date' then public.assets_field_date(p, 'purchase_date')
                            else v_a.purchase_date end;
    v_value := case when p ? 'purchase_value' then public.assets_field_numeric(p, 'purchase_value')
                    else v_a.purchase_value end;
    v_currency := case when p ? 'currency' then upper(coalesce(public.assets_field_text(p, 'currency', 3), 'IDR'))
                       else v_a.currency end;
    if v_currency !~ '^[A-Z]{3}$' then
        raise exception 'currency: must be a three-letter code' using errcode = 'PT422';
    end if;
    v_warranty := case when p ? 'warranty_until' then public.assets_field_date(p, 'warranty_until')
                       else v_a.warranty_until end;
    v_calibration := case when p ? 'calibration_due' then public.assets_field_date(p, 'calibration_due')
                          else v_a.calibration_due end;
    v_notes := case when p ? 'notes' then public.assets_field_text(p, 'notes', 4000) else v_a.notes end;

    if v_serial is not null and lower(v_serial) is distinct from lower(btrim(coalesce(v_a.serial_number, ''))) then
        select a.tag into v_existing from public.assets a
         where lower(btrim(a.serial_number)) = lower(v_serial) and a.id <> v_a.id;
        if v_existing is not null then
            raise exception 'serial_number: already registered as %', v_existing using errcode = 'PT422';
        end if;
    end if;

    if v_new_cat.id <> v_cat.id then
        v_parts := v_parts || ('Category: ' || v_cat.name || ' → ' || v_new_cat.name);
    end if;
    if v_name is distinct from v_a.name then
        v_parts := v_parts || ('Name: ' || v_a.name || ' → ' || v_name);
    end if;
    if v_brand is distinct from v_a.brand then
        v_parts := v_parts || ('Brand: ' || coalesce(v_a.brand, '—') || ' → ' || coalesce(v_brand, '—'));
    end if;
    if v_model is distinct from v_a.model then
        v_parts := v_parts || ('Model: ' || coalesce(v_a.model, '—') || ' → ' || coalesce(v_model, '—'));
    end if;
    if v_serial is distinct from v_a.serial_number then
        v_parts := v_parts || ('Serial: ' || coalesce(v_a.serial_number, '—') || ' → ' || coalesce(v_serial, '—'));
    end if;
    if v_location is distinct from v_a.location then
        v_parts := v_parts || ('Location: ' || coalesce(v_a.location, '—') || ' → ' || coalesce(v_location, '—'));
    end if;
    if v_purchase_date is distinct from v_a.purchase_date then
        v_parts := v_parts || ('Purchase date: ' || coalesce(public.notifications_date(v_a.purchase_date), '—')
                               || ' → ' || coalesce(public.notifications_date(v_purchase_date), '—'));
    end if;
    if v_value is distinct from v_a.purchase_value or v_currency is distinct from v_a.currency then
        v_parts := v_parts || 'Purchase value changed'::text;
    end if;
    if v_warranty is distinct from v_a.warranty_until then
        v_parts := v_parts || ('Warranty: ' || coalesce(public.notifications_date(v_a.warranty_until), '—')
                               || ' → ' || coalesce(public.notifications_date(v_warranty), '—'));
    end if;
    if v_calibration is distinct from v_a.calibration_due then
        v_parts := v_parts || ('Calibration due: ' || coalesce(public.notifications_date(v_a.calibration_due), '—')
                               || ' → ' || coalesce(public.notifications_date(v_calibration), '—'));
    end if;
    if v_notes is distinct from v_a.notes then
        v_parts := v_parts || 'Notes updated'::text;
    end if;

    if coalesce(array_length(v_parts, 1), 0) = 0 then
        raise exception 'Nothing to change.' using errcode = 'PT422';
    end if;

    update public.assets
       set category_id = v_new_cat.id,
           name = v_name,
           brand = v_brand,
           model = v_model,
           serial_number = v_serial,
           location = v_location,
           purchase_date = v_purchase_date,
           purchase_value = v_value,
           currency = v_currency,
           warranty_until = v_warranty,
           calibration_due = v_calibration,
           notes = v_notes,
           updated_by = auth.uid(),
           updated_at = now()
     where id = v_a.id;

    perform public.assets_event(v_a.id, 'edited', v_a.status, v_a.status,
        v_a.holder_employee_id, v_a.holder_employee_id, array_to_string(v_parts, ' · '));

    return public.assets_serialise(v_a.id, true, true);
end;
$$;

create or replace function public.assets_category_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_cat public.asset_categories;
    v_code text := upper(btrim(coalesce(p ->> 'code', '')));
    v_name text := btrim(coalesce(p ->> 'name', ''));
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_manage() then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    p := coalesce(p, '{}'::jsonb);
    if v_name = '' or char_length(v_name) > 80 then
        raise exception 'name: must be between 1 and 80 characters' using errcode = 'PT422';
    end if;
    if v_code !~ '^[A-Z]{2,4}$' then
        raise exception 'code: two to four capital letters, such as LAP' using errcode = 'PT422';
    end if;

    if nullif(btrim(coalesce(p ->> 'id', '')), '') is null then
        if exists (select 1 from public.asset_categories where code = v_code) then
            raise exception 'code: % is already used', v_code using errcode = 'PT422';
        end if;
        insert into public.asset_categories (code, name, tracks_calibration, is_active)
        values (v_code, v_name, coalesce((p ->> 'tracks_calibration')::boolean, false),
                coalesce((p ->> 'is_active')::boolean, true));
    else
        select * into v_cat from public.asset_categories where id = (p ->> 'id')::uuid for update;
        if not found then
            raise exception 'Not found' using errcode = 'PT404';
        end if;
        if v_code <> v_cat.code then
            if exists (select 1 from public.assets a where a.category_id = v_cat.id) then
                raise exception 'code: % is on registered items and cannot change', v_cat.code
                    using errcode = 'PT422';
            end if;
            if exists (select 1 from public.asset_categories where code = v_code) then
                raise exception 'code: % is already used', v_code using errcode = 'PT422';
            end if;
        end if;
        update public.asset_categories
           set code = v_code,
               name = v_name,
               tracks_calibration = coalesce((p ->> 'tracks_calibration')::boolean, tracks_calibration),
               is_active = coalesce((p ->> 'is_active')::boolean, is_active),
               updated_at = now()
         where id = v_cat.id;
    end if;
    return public.assets_categories();
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Moves.
--
--   assign       in_store            → assigned (holder, pending)
--   transfer     assigned            → assigned (new holder, pending)
--   return       assigned            → in_store
--   repair_out   in_store, assigned  → in_repair (holder kept)
--   repair_back  in_repair           → assigned with its holder, else in_store
--   lost         any but retired     → lost (holder kept; note required)
--   found        lost                → in_store
--   retire       in_store, in_repair, lost → retired (reason required; final)
--
-- Every move writes one event and clears any flag.
-- ---------------------------------------------------------------------------

create or replace function public.assets_move(
    p_id uuid,
    p_move text,
    p_employee_id uuid default null,
    p_location text default null,
    p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_a public.assets;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
    v_location text := nullif(btrim(coalesce(p_location, '')), '');
    v_to text;
    v_holder uuid;
    v_kind text;
    v_body text;
    v_cleared text;
    v_actor text := public.assets_actor_name();
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_manage() then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    if char_length(coalesce(v_note, '')) > 4000 then
        raise exception 'note: must be at most 4000 characters' using errcode = 'PT422';
    end if;
    if char_length(coalesce(v_location, '')) > 160 then
        raise exception 'location: must be at most 160 characters' using errcode = 'PT422';
    end if;
    select * into v_a from public.assets where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    if p_move = 'assign' then
        if v_a.status not in ('in_store', 'assigned') then
            raise exception '% is %; it cannot be assigned.', v_a.tag, public.assets_status_label(v_a.status)
                using errcode = 'PT409';
        end if;
        if p_employee_id is null then
            raise exception 'employee: choose who has it' using errcode = 'PT422';
        end if;
        perform public.assets_do_assign(v_a.id, p_employee_id, v_note);
        return public.assets_serialise(v_a.id, true, true);
    end if;

    if not (p_move = any (public.assets_moves(v_a.status))) then
        raise exception '% is %; that move does not apply.', v_a.tag, public.assets_status_label(v_a.status)
            using errcode = 'PT409';
    end if;
    v_cleared := case when v_a.flag_kind is not null then ' · Flag cleared' else '' end;

    if p_move = 'return' then
        v_to := 'in_store'; v_holder := null; v_kind := 'returned';
        v_body := 'Returned' || coalesce(' to ' || v_location, '') || coalesce(': ' || v_note, '');
    elsif p_move = 'repair_out' then
        v_to := 'in_repair'; v_holder := v_a.holder_employee_id; v_kind := 'repair_out';
        v_body := 'Sent for repair' || coalesce(': ' || v_note, '');
    elsif p_move = 'repair_back' then
        v_to := case when v_a.holder_employee_id is not null then 'assigned' else 'in_store' end;
        v_holder := v_a.holder_employee_id; v_kind := 'repair_back';
        v_body := 'Back from repair' || coalesce(': ' || v_note, '');
    elsif p_move = 'lost' then
        if v_note is null then
            raise exception 'note: say what happened' using errcode = 'PT422';
        end if;
        v_to := 'lost'; v_holder := v_a.holder_employee_id; v_kind := 'lost';
        v_body := 'Marked lost: ' || v_note;
    elsif p_move = 'found' then
        v_to := 'in_store'; v_holder := null; v_kind := 'found';
        v_body := 'Found' || coalesce(', now at ' || v_location, '') || coalesce(': ' || v_note, '');
    elsif p_move = 'retire' then
        if v_note is null then
            raise exception 'reason: say why it is retired' using errcode = 'PT422';
        end if;
        v_to := 'retired'; v_holder := null; v_kind := 'retired';
        v_body := 'Retired: ' || v_note;
    else
        raise exception 'move: unknown' using errcode = 'PT422';
    end if;

    update public.assets
       set status = v_to,
           holder_employee_id = v_holder,
           holder_since = case when v_holder is null then null else holder_since end,
           holder_confirmed_at = case when v_holder is null then null else holder_confirmed_at end,
           location = coalesce(v_location, location),
           retired_at = case when v_to = 'retired' then now() else retired_at end,
           flag_kind = null, flag_note = null, flagged_at = null,
           updated_by = auth.uid(),
           updated_at = now()
     where id = v_a.id;

    perform public.assets_event(v_a.id, v_kind, v_a.status, v_to, v_a.holder_employee_id, v_holder,
                                v_body || v_cleared);
    perform public.log_activity('ASSET_' || upper(v_kind), v_a.tag || ': ' || v_body, v_a.id, null);

    -- The person it left. A pending handover they can no longer answer is
    -- settled; a lost item's handover too, since it is no longer theirs to
    -- confirm.
    if v_a.holder_employee_id is not null
       and (v_holder is null or v_to = 'lost') then
        perform public.assets_settle('assets', v_a.id, array['asset_assigned'], v_to,
                                     public.assets_user_of(v_a.holder_employee_id));
    end if;
    if v_a.holder_employee_id is not null and v_holder is null and v_to in ('in_store', 'retired') then
        perform public.assets_notify(array_remove(array[public.assets_user_of(v_a.holder_employee_id)], null),
            'asset_released', 'reminder', v_a.id,
            case v_kind
                when 'returned' then v_actor || ' has recorded ' || v_a.tag || ' as returned. It is no longer recorded against you.'
                when 'found' then v_a.tag || ' has been found and is back in store. It is no longer recorded against you.'
                else v_a.tag || ' has been retired by ' || v_actor || '. It is no longer recorded against you.'
            end);
    end if;

    perform public.assets_after_it_move(v_a.id,
        case when v_holder is distinct from v_a.holder_employee_id or v_to = 'lost'
             then v_a.holder_employee_id end,
        v_to);

    return public.assets_serialise(v_a.id, true, true);
end;
$$;

create or replace function public.assets_assign(p_id uuid, p_employee_id uuid, p_note text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$ select public.assets_move(p_id, 'assign', p_employee_id, null, p_note); $$;

create or replace function public.assets_return(p_id uuid, p_location text default null, p_note text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$ select public.assets_move(p_id, 'return', null, p_location, p_note); $$;

create or replace function public.assets_send_to_repair(p_id uuid, p_note text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$ select public.assets_move(p_id, 'repair_out', null, null, p_note); $$;

create or replace function public.assets_back_from_repair(p_id uuid, p_note text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$ select public.assets_move(p_id, 'repair_back', null, null, p_note); $$;

create or replace function public.assets_mark_lost(p_id uuid, p_note text)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$ select public.assets_move(p_id, 'lost', null, null, p_note); $$;

create or replace function public.assets_mark_found(p_id uuid, p_location text default null, p_note text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$ select public.assets_move(p_id, 'found', null, p_location, p_note); $$;

create or replace function public.assets_retire(p_id uuid, p_reason text)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$ select public.assets_move(p_id, 'retire', null, null, p_reason); $$;

-- ---------------------------------------------------------------------------
-- 7. The holder's answer, and IT clearing a flag.
-- ---------------------------------------------------------------------------

create or replace function public.assets_respond_handover(p_id uuid, p_accept boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me uuid := public.current_employee_id();
    v_a public.assets;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
    v_actor text := public.assets_actor_name();
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if char_length(coalesce(v_note, '')) > 4000 then
        raise exception 'note: must be at most 4000 characters' using errcode = 'PT422';
    end if;
    select * into v_a from public.assets where id = p_id for update;
    if not found or v_me is null or v_a.holder_employee_id is distinct from v_me or v_a.status <> 'assigned' then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_a.holder_confirmed_at is not null then
        raise exception 'You have already confirmed %.', v_a.tag using errcode = 'PT409';
    end if;

    if coalesce(p_accept, false) then
        update public.assets
           set holder_confirmed_at = now(),
               flag_kind = case when flag_kind = 'handover_declined' then null else flag_kind end,
               flag_note = case when flag_kind = 'handover_declined' then null else flag_note end,
               flagged_at = case when flag_kind = 'handover_declined' then null else flagged_at end,
               updated_at = now()
         where id = v_a.id;
        perform public.assets_event(v_a.id, 'confirmed', 'assigned', 'assigned', v_me, v_me,
            'Confirmed receipt' || coalesce(': ' || v_note, ''));
        if v_a.flag_kind = 'handover_declined' then
            perform public.assets_settle('assets', v_a.id, array['asset_handover_declined'], 'confirmed');
        end if;
    else
        if v_note is null then
            raise exception 'note: say what happened, for example who still has it' using errcode = 'PT422';
        end if;
        if v_a.flag_kind = 'handover_declined' then
            raise exception 'You have already told IT about %.', v_a.tag using errcode = 'PT409';
        end if;
        update public.assets
           set flag_kind = 'handover_declined',
               flag_note = v_note,
               flagged_at = now(),
               updated_at = now()
         where id = v_a.id;
        perform public.assets_event(v_a.id, 'declined', 'assigned', 'assigned', v_me, v_me,
            'Says they did not receive it: ' || v_note);
        perform public.assets_notify(public.notifications_it_support_users(),
            'asset_handover_declined', 'action', v_a.id,
            coalesce(v_actor, 'The holder') || ' says they did not receive ' || v_a.tag
            || '. It is still recorded against them until IT returns, reassigns or marks it lost.',
            v_note, v_actor);
    end if;

    perform public.assets_settle('assets', v_a.id, array['asset_assigned'],
                                 case when coalesce(p_accept, false) then 'confirmed' else 'declined' end,
                                 auth.uid());

    return public.assets_serialise(v_a.id, public.assets_can_view_all(), true);
end;
$$;

create or replace function public.assets_clear_flag(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_a public.assets;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_manage() then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    select * into v_a from public.assets where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_a.flag_kind is null then
        raise exception '% is not flagged.', v_a.tag using errcode = 'PT409';
    end if;
    update public.assets
       set flag_kind = null, flag_note = null, flagged_at = null,
           updated_by = auth.uid(), updated_at = now()
     where id = v_a.id;
    perform public.assets_event(v_a.id, 'flag_cleared', v_a.status, v_a.status,
        v_a.holder_employee_id, v_a.holder_employee_id, 'Flag cleared' || coalesce(': ' || v_note, ''));
    perform public.assets_settle('assets', v_a.id,
                                 array['asset_handover_declined', 'asset_checkin_missing'], 'cleared');
    return public.assets_serialise(v_a.id, true, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Tickets: which asset a ticket concerns.
-- ---------------------------------------------------------------------------

create or replace function public.tickets_link_asset(p_ticket_id uuid, p_asset_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_ticket public.support_tickets;
    v_asset public.assets;
    v_old public.assets;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.tickets_works_queue(v_me.id) then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    select * into v_ticket from public.support_tickets where id = p_ticket_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if p_asset_id is not distinct from v_ticket.asset_id then
        raise exception 'Nothing to change.' using errcode = 'PT422';
    end if;
    if p_asset_id is not null then
        select * into v_asset from public.assets where id = p_asset_id;
        if not found then
            raise exception 'asset: no such asset' using errcode = 'PT422';
        end if;
    end if;
    select * into v_old from public.assets where id = v_ticket.asset_id;

    update public.support_tickets set asset_id = v_asset.id where id = v_ticket.id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, created_at)
    values (v_ticket.id, auth.uid(), trim(v_me.first_name || ' ' || v_me.last_name), 'asset_linked',
            case when v_asset.id is null then 'No longer linked to ' || coalesce(v_old.tag, 'an asset')
                 when v_old.id is null then 'Linked to ' || v_asset.tag
                 else 'Linked to ' || v_asset.tag || ' instead of ' || v_old.tag end,
            clock_timestamp());

    if v_old.id is not null then
        perform public.assets_event(v_old.id, 'ticket_unlinked', null, null, null, null,
            'No longer linked to ' || v_ticket.reference, v_ticket.id);
    end if;
    if v_asset.id is not null then
        perform public.assets_event(v_asset.id, 'ticket_linked', null, null, null, null,
            'Linked to ' || v_ticket.reference || ': ' || public.notifications_one_line(v_ticket.subject, 120),
            v_ticket.id);
    end if;

    perform public.tickets_touch(v_ticket.id);

    return public.tickets_serialise(v_ticket.id, true, true, true);
end;
$$;

-- As in 20261015000100, plus the asset the ticket concerns.
create or replace function public.tickets_serialise(
    p_ticket_id uuid,
    p_can_work boolean,
    p_with_events boolean,
    p_show_internal boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_me uuid := public.current_employee_id();
    v_out jsonb;
begin
    select jsonb_build_object(
        'id', t.id,
        'reference', t.reference,
        'subject', t.subject,
        'description', t.description,
        'category', t.category,
        'priority', t.priority,
        'status', t.status,
        'location', t.location,
        'channel', t.channel,
        'reporter_id', t.reporter_id,
        'reporter_name', case when r.id is null then null
                              else trim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')) end,
        'assignee_id', t.assignee_id,
        'assignee_name', case when a.id is null then null
                              else trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')) end,
        'resolution', t.resolution,
        'resolved_at', t.resolved_at,
        'resolved_by', public.tickets_resolver(t.id),
        'closed_at', t.closed_at,
        'auto_close_at', t.auto_close_at,
        'created_at', t.created_at,
        'updated_at', t.updated_at,
        'can_work', coalesce(p_can_work, false),
        'asset', (select jsonb_build_object('id', x.id, 'tag', x.tag, 'name', x.name)
                    from public.assets x where x.id = t.asset_id),
        'related', (
            select case when coalesce(p_can_work, false) or rt.reporter_id = v_me
                        then jsonb_build_object('id', rt.id, 'reference', rt.reference, 'subject', rt.subject,
                                                'status', rt.status, 'resolution', rt.resolution,
                                                'resolved_at', rt.resolved_at)
                        else jsonb_build_object('id', null, 'reference', rt.reference, 'subject', null,
                                                'status', rt.status, 'resolution', null, 'resolved_at', null)
                   end
              from public.support_tickets rt
             where rt.id = t.related_ticket_id),
        'recurrences', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', case when coalesce(p_can_work, false) or rc.reporter_id = v_me then rc.id end,
                       'reference', rc.reference,
                       'status', rc.status,
                       'created_at', rc.created_at
                   ) order by rc.created_at, rc.reference)
              from public.support_tickets rc
             where rc.related_ticket_id = t.id), '[]'::jsonb),
        'last_public_actor', lp.actor,
        'last_public_kind', lp.kind,
        'last_public_at', lp.created_at,
        'events', case when not p_with_events then '[]'::jsonb else coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', ev.id,
                       'actor_name', ev.actor_name,
                       'kind', ev.kind,
                       'body', ev.body,
                       'from_status', ev.from_status,
                       'to_status', ev.to_status,
                       'is_internal', ev.is_internal,
                       'created_at', ev.created_at
                   ) order by ev.created_at, ev.seq)
              from public.ticket_events ev
             where ev.ticket_id = t.id
               and (p_show_internal or not ev.is_internal)
        ), '[]'::jsonb) end
    )
      into v_out
      from public.support_tickets t
      left join public.employees r on r.id = t.reporter_id
      left join public.employees a on a.id = t.assignee_id
      left join lateral (
          select case when ev.actor_id is null then 'system'
                      when ev.actor_id = r.user_id then 'reporter'
                      else 'support' end as actor,
                 ev.kind, ev.created_at
            from public.ticket_events ev
           where ev.ticket_id = t.id and not ev.is_internal
           order by ev.created_at desc, ev.seq desc
           limit 1
      ) lp on true
     where t.id = p_ticket_id;
    return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Check-in rounds.
-- ---------------------------------------------------------------------------

create or replace function public.assets_round_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_out jsonb;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_view_all() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select jsonb_build_object(
        'id', rd.id,
        'name', rd.name,
        'started_at', rd.started_at,
        'started_by_name', rd.started_by_name,
        'due_date', rd.due_date,
        'reminded_at', rd.reminded_at,
        'closed_at', rd.closed_at,
        'closed_by_name', rd.closed_by_name,
        'is_open', rd.closed_at is null,
        'can_manage', public.assets_can_manage(),
        'counts', (select jsonb_build_object(
                              'total', count(*)::int,
                              'pending', count(*) filter (where i.state = 'pending')::int,
                              'confirmed', count(*) filter (where i.state = 'confirmed')::int,
                              'missing', count(*) filter (where i.state = 'missing')::int,
                              'seen', count(*) filter (where i.state = 'seen')::int,
                              'no_reply', count(*) filter (where i.state = 'no_reply')::int)
                     from public.asset_checkin_items i where i.round_id = rd.id),
        'summary', rd.summary,
        'items', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', i.id,
                       'asset_id', a.id,
                       'tag', a.tag,
                       'name', a.name,
                       'category', c.name,
                       'asset_status', a.status,
                       'holder_employee_id', i.holder_employee_id,
                       'holder_name', i.holder_name,
                       'state', i.state,
                       'responded_at', i.responded_at,
                       'responded_by_name', i.responded_by_name,
                       'note', i.note
                   ) order by (i.state = 'pending') desc, i.holder_name nulls last, a.tag)
              from public.asset_checkin_items i
              join public.assets a on a.id = i.asset_id
              join public.asset_categories c on c.id = a.category_id
             where i.round_id = rd.id), '[]'::jsonb)
    )
      into v_out
      from public.asset_checkin_rounds rd
     where rd.id = p_id;
    if v_out is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return v_out;
end;
$$;

create or replace function public.assets_rounds()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_view_all() then
        raise exception 'The asset register is for IT, finance and management.' using errcode = 'PT403';
    end if;
    return jsonb_build_object(
        'items', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', rd.id,
                       'name', rd.name,
                       'started_at', rd.started_at,
                       'due_date', rd.due_date,
                       'closed_at', rd.closed_at,
                       'is_open', rd.closed_at is null,
                       'counts', (select jsonb_build_object(
                                             'total', count(*)::int,
                                             'pending', count(*) filter (where i.state = 'pending')::int,
                                             'confirmed', count(*) filter (where i.state = 'confirmed')::int,
                                             'missing', count(*) filter (where i.state = 'missing')::int,
                                             'seen', count(*) filter (where i.state = 'seen')::int,
                                             'no_reply', count(*) filter (where i.state = 'no_reply')::int)
                                    from public.asset_checkin_items i where i.round_id = rd.id)
                   ) order by rd.started_at desc)
              from public.asset_checkin_rounds rd), '[]'::jsonb),
        'can_manage', public.assets_can_manage(),
        'last_started_at', (select max(started_at) from public.asset_checkin_rounds)
    );
end;
$$;

create or replace function public.assets_round_start(p_name text default null, p_due_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_name text := nullif(btrim(coalesce(p_name, '')), '');
    v_due date := coalesce(p_due_date, public.local_today() + 14);
    v_id uuid;
    r record;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_manage() then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    if exists (select 1 from public.asset_checkin_rounds where closed_at is null) then
        raise exception 'A check-in round is already open. Close it before starting another.'
            using errcode = 'PT422';
    end if;
    if char_length(coalesce(v_name, '')) > 120 then
        raise exception 'name: must be at most 120 characters' using errcode = 'PT422';
    end if;
    if v_due < public.local_today() then
        raise exception 'due_date: must be today or later' using errcode = 'PT422';
    end if;
    v_name := coalesce(v_name, 'Check-in ' || to_char(public.local_today(), 'FMMonth YYYY'));

    insert into public.asset_checkin_rounds (name, started_by, started_by_name, due_date)
    values (v_name, auth.uid(), left(public.assets_actor_name(), 160), v_due)
    returning id into v_id;

    -- Everything that should be somewhere: assigned items to their holder,
    -- the rest (in store, away for repair) to IT.
    insert into public.asset_checkin_items (round_id, asset_id, holder_employee_id, holder_name)
    select v_id, a.id,
           case when a.status = 'assigned' then a.holder_employee_id end,
           case when a.status = 'assigned' then left(public.assets_person_name(a.holder_employee_id), 160) end
      from public.assets a
     where a.status in ('assigned', 'in_store', 'in_repair');

    for r in select i.holder_employee_id, count(*)::int n
               from public.asset_checkin_items i
              where i.round_id = v_id and i.holder_employee_id is not null
              group by i.holder_employee_id loop
        perform public.assets_notify_about(
            array_remove(array[public.assets_user_of(r.holder_employee_id)], null),
            'asset_checkin_requested', 'action',
            'Equipment check-in', v_name,
            'IT is checking that the register is right. Confirm each item you hold, or say if one is not with you.',
            array['Items', case when r.n = 1 then '1 item' else r.n || ' items' end,
                  'Answer by', public.notifications_date(v_due)],
            '/equipment?round=' || v_id, 'Answer the check-in',
            'asset_checkin_rounds', v_id);
    end loop;

    perform public.assets_settle('asset_checkin_rounds', null, array['asset_checkin_due'], 'started');
    perform public.log_activity('ASSET_CHECKIN_STARTED', 'Started ' || v_name, v_id, null);

    return public.assets_round_get(v_id);
end;
$$;

create or replace function public.assets_round_answer(p_item_id uuid, p_have_it boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me uuid := public.current_employee_id();
    v_item public.asset_checkin_items;
    v_round public.asset_checkin_rounds;
    v_a public.assets;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
    v_actor text := public.assets_actor_name();
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if char_length(coalesce(v_note, '')) > 4000 then
        raise exception 'note: must be at most 4000 characters' using errcode = 'PT422';
    end if;
    select * into v_item from public.asset_checkin_items where id = p_item_id for update;
    if not found or v_me is null or v_item.holder_employee_id is distinct from v_me then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into v_round from public.asset_checkin_rounds where id = v_item.round_id;
    if v_round.closed_at is not null then
        raise exception 'This check-in round has closed.' using errcode = 'PT422';
    end if;
    select * into v_a from public.assets where id = v_item.asset_id for update;
    if v_item.state <> 'pending' then
        raise exception 'You have already answered for %.', v_a.tag using errcode = 'PT409';
    end if;

    if coalesce(p_have_it, false) then
        update public.asset_checkin_items
           set state = 'confirmed', responded_at = now(), responded_by = auth.uid(),
               responded_by_name = left(v_actor, 160), note = v_note
         where id = v_item.id;
        perform public.assets_event(v_a.id, 'checkin_confirmed', v_a.status, v_a.status,
            v_a.holder_employee_id, v_a.holder_employee_id,
            'Check-in: I have it' || coalesce(': ' || v_note, ''));
        -- "I have it" is the same statement as confirming the handover.
        if v_a.status = 'assigned' and v_a.holder_employee_id = v_me and v_a.holder_confirmed_at is null then
            update public.assets set holder_confirmed_at = now(), updated_at = now() where id = v_a.id;
            perform public.assets_event(v_a.id, 'confirmed', 'assigned', 'assigned', v_me, v_me,
                'Confirmed receipt through the check-in');
            perform public.assets_settle('assets', v_a.id, array['asset_assigned'], 'confirmed', auth.uid());
        end if;
    else
        if v_note is null then
            raise exception 'note: say where it is, or what happened to it' using errcode = 'PT422';
        end if;
        update public.asset_checkin_items
           set state = 'missing', responded_at = now(), responded_by = auth.uid(),
               responded_by_name = left(v_actor, 160), note = v_note
         where id = v_item.id;
        update public.assets
           set flag_kind = 'checkin_missing', flag_note = v_note, flagged_at = now(), updated_at = now()
         where id = v_a.id;
        perform public.assets_event(v_a.id, 'checkin_missing', v_a.status, v_a.status,
            v_a.holder_employee_id, v_a.holder_employee_id, 'Check-in: not with me: ' || v_note);
        perform public.assets_notify(public.notifications_it_support_users(),
            'asset_checkin_missing', 'action', v_a.id,
            coalesce(v_actor, 'The holder') || ' says ' || v_a.tag || ' is not with them ('
            || v_round.name || '). It is still recorded against them until IT acts.',
            v_note, v_actor);
    end if;

    perform public.assets_round_settle_holder(v_round.id, v_me);

    return public.assets_mine();
end;
$$;

create or replace function public.assets_round_mark_seen(p_item_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_item public.asset_checkin_items;
    v_round public.asset_checkin_rounds;
    v_a public.assets;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_manage() then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    select * into v_item from public.asset_checkin_items where id = p_item_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into v_round from public.asset_checkin_rounds where id = v_item.round_id;
    if v_round.closed_at is not null then
        raise exception 'This check-in round has closed.' using errcode = 'PT422';
    end if;
    if v_item.state <> 'pending' then
        raise exception 'That item has already been answered.' using errcode = 'PT409';
    end if;
    select * into v_a from public.assets where id = v_item.asset_id;

    update public.asset_checkin_items
       set state = 'seen', responded_at = now(), responded_by = auth.uid(),
           responded_by_name = left(public.assets_actor_name(), 160), note = v_note
     where id = v_item.id;
    perform public.assets_event(v_a.id, 'checkin_seen', v_a.status, v_a.status,
        v_a.holder_employee_id, v_a.holder_employee_id,
        'Check-in: seen by IT' || coalesce(': ' || v_note, ''));
    perform public.assets_round_settle_holder(v_round.id, v_item.holder_employee_id);

    return public.assets_round_get(v_round.id);
end;
$$;

create or replace function public.assets_round_close(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_round public.asset_checkin_rounds;
    v_summary jsonb;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_manage() then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    select * into v_round from public.asset_checkin_rounds where id = p_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_round.closed_at is not null then
        raise exception 'This check-in round has already closed.' using errcode = 'PT409';
    end if;

    update public.asset_checkin_items set state = 'no_reply' where round_id = v_round.id and state = 'pending';

    select jsonb_build_object(
               'total', count(*)::int,
               'confirmed', count(*) filter (where state = 'confirmed')::int,
               'missing', count(*) filter (where state = 'missing')::int,
               'seen', count(*) filter (where state = 'seen')::int,
               'no_reply', count(*) filter (where state = 'no_reply')::int)
      into v_summary
      from public.asset_checkin_items where round_id = v_round.id;

    update public.asset_checkin_rounds
       set closed_at = now(),
           closed_by = auth.uid(),
           closed_by_name = left(public.assets_actor_name(), 160),
           summary = v_summary
     where id = v_round.id;

    perform public.assets_settle('asset_checkin_rounds', v_round.id, array['asset_checkin_requested'], 'closed');
    perform public.log_activity('ASSET_CHECKIN_CLOSED', 'Closed ' || v_round.name, v_round.id, null);

    return public.assets_round_get(v_round.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Leavers with items, and the daily run.
-- ---------------------------------------------------------------------------

-- Everyone holding something who is inactive, or whose contract ends within
-- 14 days: the employee record's contract end date, or an active manpower
-- contract's, whichever comes first.
create or replace function public.assets_leaver_rows()
returns table (employee_id uuid, name text, reason text, end_date date, items jsonb)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with today as (select public.local_today() as d),
    held as (
        select a.holder_employee_id as e_id,
               jsonb_agg(jsonb_build_object('id', a.id, 'tag', a.tag, 'name', a.name, 'status', a.status)
                         order by a.tag) as items
          from public.assets a
         where a.status in ('assigned', 'in_repair') and a.holder_employee_id is not null
         group by a.holder_employee_id
    ),
    ends as (
        select e.id, e.is_active, h.items,
               least(
                   case when e.contract_end_date between t.d and t.d + 14 then e.contract_end_date end,
                   (select min(c.end_date) from public.contracts c
                     where c.employee_id = e.id and c.kind = 'manpower' and c.status = 'active'
                       and c.end_date between t.d and t.d + 14)) as contract_end
          from held h
          join public.employees e on e.id = h.e_id
          cross join today t
    )
    select x.id,
           public.assets_person_name(x.id),
           case when not x.is_active then 'inactive' else 'contract_end' end,
           case when not x.is_active then null else x.contract_end end,
           x.items
      from ends x
     where not x.is_active or x.contract_end is not null
     order by 2;
$$;

create or replace function public.assets_leavers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.assets_can_view_all() then
        raise exception 'The asset register is for IT, finance and management.' using errcode = 'PT403';
    end if;
    return coalesce((select jsonb_agg(jsonb_build_object(
                                'employee_id', l.employee_id, 'name', l.name, 'reason', l.reason,
                                'end_date', l.end_date, 'items', l.items))
                       from public.assets_leaver_rows() l), '[]'::jsonb);
end;
$$;

create or replace function public.assets_daily_run()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r record;
    h record;
    v_reminded int := 0;
    v_due int := 0;
    v_leavers int := 0;
    v_notice uuid;
    v_last timestamptz;
    v_first timestamptz;
begin
    -- 1. A week into an open round, a reminder to each holder still pending.
    for r in select rd.id, rd.name, rd.due_date
               from public.asset_checkin_rounds rd
              where rd.closed_at is null
                and rd.reminded_at is null
                and rd.started_at <= now() - interval '7 days' loop
        begin
            update public.asset_checkin_rounds set reminded_at = now() where id = r.id;
            for h in select i.holder_employee_id, count(*)::int n
                       from public.asset_checkin_items i
                      where i.round_id = r.id and i.state = 'pending' and i.holder_employee_id is not null
                      group by i.holder_employee_id loop
                perform public.assets_notify_about(
                    array_remove(array[public.assets_user_of(h.holder_employee_id)], null),
                    'asset_checkin_reminder', 'reminder',
                    'Equipment check-in', r.name,
                    'You still have items to answer for in the check-in.',
                    array['Still to answer', case when h.n = 1 then '1 item' else h.n || ' items' end,
                          'Answer by', public.notifications_date(r.due_date)],
                    '/equipment?round=' || r.id, 'Answer the check-in',
                    'asset_checkin_rounds', r.id);
                v_reminded := v_reminded + 1;
            end loop;
        exception when others then
            raise warning 'assets_daily_run reminder %: %', r.id, sqlerrm;
        end;
    end loop;

    -- 2. Six months since the last round (or since the register began), and
    --    no round open: remind IT, at most once a month.
    begin
        select max(started_at) into v_last from public.asset_checkin_rounds;
        select min(created_at) into v_first from public.assets;
        if not exists (select 1 from public.asset_checkin_rounds where closed_at is null)
           and coalesce(v_last, v_first) < now() - interval '182 days'
           and not exists (select 1 from public.notifications n
                            where n.kind = 'asset_checkin_due'
                              and n.created_at > now() - interval '30 days') then
            perform public.assets_notify_about(
                public.notifications_it_support_users(),
                'asset_checkin_due', 'action',
                'Equipment check-in', 'An equipment check-in is due',
                case when v_last is null
                     then 'The register has run for six months without a check-in. Start one so every holder confirms what they have.'
                     else 'It is six months since the last check-in started. Start the next one so every holder confirms what they have.' end,
                array['Last check-in', coalesce(public.notifications_date((v_last at time zone 'Asia/Jakarta')::date), 'None yet')],
                '/equipment?tab=checkins', 'Start a check-in',
                'asset_checkin_rounds', null);
            v_due := 1;
        end if;
    exception when others then
        raise warning 'assets_daily_run due: %', sqlerrm;
    end;

    -- 3. Leavers who still hold items: once per person, reason and end date.
    for r in select * from public.assets_leaver_rows() loop
        begin
            v_notice := null;
            insert into public.asset_leaver_notices (employee_id, reason, end_date)
            values (r.employee_id, r.reason, r.end_date)
            on conflict do nothing
            returning id into v_notice;
            if v_notice is not null then
                perform public.assets_notify_about(
                    public.notifications_it_support_users(),
                    'asset_holder_leaving', 'action',
                    'Equipment', coalesce(r.name, 'A leaver') || ' still holds '
                        || case when jsonb_array_length(r.items) = 1 then '1 item'
                                else jsonb_array_length(r.items) || ' items' end,
                    case when r.reason = 'inactive'
                         then coalesce(r.name, 'They') || ' is no longer active and still has equipment recorded against them.'
                         else coalesce(r.name, 'Their') || '''s contract ends on ' || public.notifications_date(r.end_date)
                              || '. Collect the equipment before their last day.' end,
                    array['Reason', case when r.reason = 'inactive' then 'No longer active'
                                         else 'Contract ends ' || public.notifications_date(r.end_date) end,
                          'Items', (select string_agg(x ->> 'tag', ', ' order by x ->> 'tag')
                                      from jsonb_array_elements(r.items) x)],
                    '/equipment?holder=' || r.employee_id, 'See their items',
                    'employees', r.employee_id);
                v_leavers := v_leavers + 1;
            end if;
        exception when others then
            raise warning 'assets_daily_run leaver %: %', r.employee_id, sqlerrm;
        end;
    end loop;

    return jsonb_build_object('reminded', v_reminded, 'due', v_due, 'leavers', v_leavers);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Grants.
-- ---------------------------------------------------------------------------

do $$
declare
    f text;
begin
    -- Helpers and the job: no client calls them. Supabase grants new
    -- functions to anon and authenticated by default, so revoke from both.
    foreach f in array array[
        'public.assets_can_manage()',
        'public.assets_can_view_all()',
        'public.assets_person_name(uuid)',
        'public.assets_actor_name()',
        'public.assets_user_of(uuid)',
        'public.assets_status_label(text)',
        'public.assets_moves(text)',
        'public.assets_holds_anything(uuid)',
        'public.assets_event(uuid, text, text, text, uuid, uuid, text, uuid)',
        'public.assets_notify(uuid[], text, text, uuid, text, text, text)',
        'public.assets_notify_about(uuid[], text, text, text, text, text, text[], text, text, text, uuid)',
        'public.assets_settle(text, uuid, text[], text, uuid)',
        'public.assets_round_settle_holder(uuid, uuid)',
        'public.assets_after_it_move(uuid, uuid, text)',
        'public.assets_field_date(jsonb, text)',
        'public.assets_field_numeric(jsonb, text)',
        'public.assets_field_text(jsonb, text, int)',
        'public.assets_serialise(uuid, boolean, boolean)',
        'public.assets_do_assign(uuid, uuid, text)',
        'public.assets_move(uuid, text, uuid, text, text)',
        'public.assets_leaver_rows()',
        'public.assets_daily_run()'
    ] loop
        execute 'revoke all on function ' || f || ' from public';
        execute 'revoke all on function ' || f || ' from anon, authenticated';
    end loop;

    -- What the page calls.
    foreach f in array array[
        'public.assets_list(boolean)',
        'public.assets_get(uuid)',
        'public.assets_mine()',
        'public.assets_categories()',
        'public.assets_register(jsonb)',
        'public.assets_update(uuid, jsonb)',
        'public.assets_category_save(jsonb)',
        'public.assets_assign(uuid, uuid, text)',
        'public.assets_return(uuid, text, text)',
        'public.assets_send_to_repair(uuid, text)',
        'public.assets_back_from_repair(uuid, text)',
        'public.assets_mark_lost(uuid, text)',
        'public.assets_mark_found(uuid, text, text)',
        'public.assets_retire(uuid, text)',
        'public.assets_respond_handover(uuid, boolean, text)',
        'public.assets_clear_flag(uuid, text)',
        'public.tickets_link_asset(uuid, uuid)',
        'public.assets_rounds()',
        'public.assets_round_get(uuid)',
        'public.assets_round_start(text, date)',
        'public.assets_round_answer(uuid, boolean, text)',
        'public.assets_round_mark_seen(uuid, text)',
        'public.assets_round_close(uuid)',
        'public.assets_leavers()'
    ] loop
        execute 'revoke all on function ' || f || ' from public';
        execute 'revoke all on function ' || f || ' from anon';
        execute 'grant execute on function ' || f || ' to authenticated';
    end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 12. The daily run at 07:00 WIB, where the hosted database has pg_cron (not
--     the PGlite test database, whose tests call the run directly).
-- ---------------------------------------------------------------------------
do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.schedule(
            'assets-daily',
            '0 0 * * *',
            $cron$ select public.assets_daily_run(); $cron$);
    end if;
end
$$;

commit;
