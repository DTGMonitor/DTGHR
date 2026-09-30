-- ===========================================================================
-- Contracts that renew themselves.
--
-- The managing director: "For monthly auto-renewing subscriptions I shouldn't
-- have to write an end date -- just the start once. E.g. Claude and Dropbox
-- are paid monthly, TeamViewer once a year. I only enter the start date; if I
-- choose monthly it repeats monthly, annual repeats yearly."
--
--   * contracts.billing_cycle: 'one_off' | 'monthly' | 'quarterly' | 'annual'
--     (null on rows nobody has classified). billing_period stays as the text
--     the screens show; when a cycle is chosen it is kept in step with it
--     ("Monthly", "Annual", ...).
--   * contracts.auto_renew: for these, end_date means "next renewal": the
--     first start + k cycles (k >= 1) after today in Jakarta, months added the
--     way Postgres adds them (31 Jan + 1 month = 28/29 Feb). The client sends
--     a start date and no end date; one sent is ignored.
--   * contracts_roll_renewals(): once a day (00:05 WIB) moves every active
--     auto-renewing contract whose renewal date has arrived on to the next
--     one, and clears that contract's acknowledgements -- a new cycle, new
--     warnings. contracts_send_renewal_notices() runs it first.
--   * Default warnings when none are given: monthly 7 days, quarterly 14,
--     annual 30; client contracts keep 60/42/30; anything else 30.
--   * Legacy billing_period text is classified once: month -> monthly,
--     quarter -> quarterly, year/annual -> annual, one-off/once -> one_off.
--     Subscriptions that come out monthly, quarterly or annual renew
--     automatically from then on.
--
-- contracts_create, contracts_update and _contracts_serialise are re-created
-- from their newest definitions (20260926001000_contracts.sql,
-- 20260929000100_purchase_orders.sql); contracts_send_renewal_notices and
-- _contracts_coming_up from 20260929000100_purchase_orders.sql, so that
-- auto-renewals do not nag: "Coming up" shows one only within its largest
-- warning, and monthly/quarterly ones get no renewal email.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.contracts add column if not exists billing_cycle varchar(12);
alter table public.contracts add column if not exists auto_renew boolean not null default false;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'contracts_billing_cycle_check') then
        alter table public.contracts add constraint contracts_billing_cycle_check
            check (billing_cycle is null or billing_cycle in ('one_off', 'monthly', 'quarterly', 'annual'));
    end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- A cycle out of free text ("monthly", "Annual (in advance)", "one-off").
create or replace function public._contracts_cycle_from_text(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case
        when p_text is null or btrim(p_text) = '' then null
        when lower(p_text) like '%one-off%' or lower(p_text) like '%one off%'
          or lower(p_text) like '%oneoff%' or lower(p_text) like '%once%' then 'one_off'
        when lower(p_text) like '%quarter%' then 'quarterly'
        when lower(p_text) like '%month%' then 'monthly'
        when lower(p_text) like '%year%' or lower(p_text) like '%annual%' then 'annual'
        else null
    end;
$$;

-- What the screens show for a cycle.
create or replace function public._contracts_cycle_label(p_cycle text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_cycle
        when 'one_off' then 'One-off'
        when 'monthly' then 'Monthly'
        when 'quarterly' then 'Quarterly'
        when 'annual' then 'Annual'
    end;
$$;

-- The first start + k cycles (k >= 1) after p_today. Each candidate is
-- computed from the start, not from the previous one, so 31 January renews
-- on 28/29 February and then on 31 March.
create or replace function public._contracts_next_renewal(p_start date, p_cycle text, p_today date)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v_months int := case p_cycle when 'monthly' then 1 when 'quarterly' then 3 when 'annual' then 12 end;
    k int;
begin
    if p_start is null or v_months is null or p_today is null then
        return null;
    end if;
    -- Jump close to the answer, then step: k * cycle lands no later than
    -- today's month, so at most one or two steps remain.
    k := greatest(1, ((extract(year from p_today)::int - extract(year from p_start)::int) * 12
                      + extract(month from p_today)::int - extract(month from p_start)::int) / v_months);
    while (p_start + make_interval(months => k * v_months))::date <= p_today loop
        k := k + 1;
    end loop;
    return (p_start + make_interval(months => k * v_months))::date;
end;
$$;

-- The default warnings when the caller gives none.
create or replace function public._contracts_default_reminders(p_kind text, p_cycle text)
returns int[]
language sql
immutable
set search_path = public, pg_temp
as $$
    select case
        when p_kind = 'client' then array[60, 42, 30]
        when p_cycle = 'monthly' then array[7]
        when p_cycle = 'quarterly' then array[14]
        when p_cycle = 'annual' then array[30]
        else array[30]
    end;
$$;

-- billing_cycle out of a body; 422 on anything else.
create or replace function public._contracts_body_cycle(p_body jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v text := p_body ->> 'billing_cycle';
begin
    if v is null or v = '' then
        return null;
    end if;
    if v not in ('one_off', 'monthly', 'quarterly', 'annual') then
        raise exception 'billing_cycle: Input should be ''one_off'', ''monthly'', ''quarterly'' or ''annual'''
            using errcode = 'PT422';
    end if;
    return v;
end;
$$;

-- auto_renew out of a body; null when absent.
create or replace function public._contracts_body_bool(p_body jsonb, p_key text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    if p_body -> p_key is null or jsonb_typeof(p_body -> p_key) = 'null' then
        return null;
    end if;
    if jsonb_typeof(p_body -> p_key) = 'boolean' then
        return (p_body ->> p_key)::boolean;
    end if;
    raise exception '%: Input should be a valid boolean', p_key using errcode = 'PT422';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Roll renewals forward
-- ---------------------------------------------------------------------------
create or replace function public.contracts_roll_renewals(p_today date default public.local_today())
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    c record;
    v_next date;
    v_rolled int := 0;
begin
    for c in
        select id, start_date, end_date, billing_cycle
          from public.contracts
         where auto_renew
           and status = 'active'
           and billing_cycle in ('monthly', 'quarterly', 'annual')
           and end_date <= p_today
         for update
    loop
        -- Anchored on the start; a legacy row with no start renews from the
        -- date it was last due.
        v_next := public._contracts_next_renewal(coalesce(c.start_date, c.end_date), c.billing_cycle, p_today);
        update public.contracts set end_date = v_next, updated_at = now() where id = c.id;
        update public.contract_reminders
           set acknowledged_at = null, acknowledged_by = null, acknowledgement_note = null,
               updated_at = now()
         where contract_id = c.id and acknowledged_at is not null;
        v_rolled := v_rolled + 1;
    end loop;
    return v_rolled;
end;
$$;

-- Classify legacy billing_period text, once per row: only rows with no cycle
-- yet are touched, so re-running never re-enables what somebody turned off.
create or replace function public._contracts_backfill_billing_cycles()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_n int;
begin
    update public.contracts c
       set billing_cycle = x.cycle,
           auto_renew = (c.kind = 'subscription' and x.cycle in ('monthly', 'quarterly', 'annual')),
           updated_at = now()
      from (select id, public._contracts_cycle_from_text(billing_period) as cycle
              from public.contracts
             where billing_cycle is null) x
     where c.id = x.id and x.cycle is not null;
    get diagnostics v_n = row_count;
    return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Serialisation: + billing_cycle, auto_renew, next_renewal. An auto-renew
-- contract whose date has passed (the daily job not yet run) shows the next
-- renewal anyway.
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
    v_end date;
    v_reminders jsonb;
    v_documents jsonb;
    v_pos jsonb;
    v_open int;
begin
    select * into c from public.contracts where id = p_id;
    if not found then
        return null;
    end if;

    v_end := c.end_date;
    if c.auto_renew and c.status = 'active' and c.end_date <= p_today
       and c.billing_cycle in ('monthly', 'quarterly', 'annual') then
        v_end := public._contracts_next_renewal(coalesce(c.start_date, c.end_date), c.billing_cycle, p_today);
    end if;

    -- Furthest warning first.
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id,
               'days_before', r.days_before,
               'due_on', to_char(v_end - r.days_before, 'YYYY-MM-DD'),
               'is_due', (c.status = 'active'
                          and r.acknowledged_at is null
                          and (v_end - r.days_before) <= p_today),
               'acknowledged_at', to_jsonb(r.acknowledged_at),
               'acknowledgement_note', r.acknowledgement_note
           ) order by r.days_before desc, r.created_at), '[]'::jsonb),
           count(*) filter (where c.status = 'active'
                              and r.acknowledged_at is null
                              and (v_end - r.days_before) <= p_today)::int
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
        'end_date', to_char(v_end, 'YYYY-MM-DD'),
        'days_remaining', v_end - p_today,
        'amount', c.amount,
        'currency', c.currency,
        'billing_period', c.billing_period,
        'billing_cycle', c.billing_cycle,
        'auto_renew', c.auto_renew,
        'next_renewal', case when c.auto_renew then to_char(v_end, 'YYYY-MM-DD') end,
        'notes', c.notes,
        'status', c.status,
        'reminders', v_reminders,
        'open_reminders', coalesce(v_open, 0),
        'purchase_orders', v_pos
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
    v_cycle text;
    v_auto boolean;
    v_period text := p_body ->> 'billing_period';
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

    -- The cycle as chosen, or read out of the old free-text field.
    v_cycle := coalesce(public._contracts_body_cycle(p_body), public._contracts_cycle_from_text(v_period));
    v_auto := coalesce(public._contracts_body_bool(p_body, 'auto_renew'), false);
    if v_auto and coalesce(v_cycle, 'one_off') not in ('monthly', 'quarterly', 'annual') then
        raise exception 'Only a monthly, quarterly or annual contract can renew automatically.'
            using errcode = 'PT422';
    end if;
    if v_cycle is not null then
        v_period := public._contracts_cycle_label(v_cycle);
    end if;

    v_start := public._contracts_date(p_body, 'start_date');
    if v_auto then
        if v_start is null then
            raise exception 'Auto-renewing contracts need a start date.' using errcode = 'PT422';
        end if;
        -- end_date is the next renewal; whatever was sent is ignored.
        v_end := public._contracts_next_renewal(v_start, v_cycle, public.local_today());
    else
        v_end := public._contracts_date(p_body, 'end_date');
        if v_end is null then
            raise exception 'end_date: Field required' using errcode = 'PT422';
        end if;
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

    -- The defaults unless the caller said otherwise (an empty list counts as
    -- not saying).
    if v_days is null or cardinality(v_days) = 0 then
        v_days := public._contracts_default_reminders(v_kind, v_cycle);
    end if;

    insert into public.contracts (kind, title, counterparty, employee_id, start_date, end_date,
                                  amount, currency, billing_period, billing_cycle, auto_renew, notes)
    values (v_kind, v_title, p_body ->> 'counterparty',
            nullif(p_body ->> 'employee_id', '')::uuid,
            v_start, v_end, v_amount, v_currency,
            v_period, v_cycle, v_auto, p_body ->> 'notes')
    returning id into v_id;

    for d in select distinct x from unnest(v_days) x order by x desc loop
        insert into public.contract_reminders (contract_id, days_before) values (v_id, d);
    end loop;

    perform public.log_activity('CONTRACT_CREATED',
        format('Added a %s contract for %s', v_kind, v_title), v_id, null);

    return public._contracts_serialise(v_id, public.local_today());
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
    v_auto boolean;
    v_today date := public.local_today();
    v_touched boolean;
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

    -- The cycle, chosen or read out of the text; the text follows the cycle.
    if p_body ? 'billing_cycle' then
        c.billing_cycle := public._contracts_body_cycle(p_body);
        if c.billing_cycle is not null then
            c.billing_period := public._contracts_cycle_label(c.billing_cycle);
        elsif p_body ? 'billing_period' then
            c.billing_period := p_body ->> 'billing_period';
        end if;
    elsif p_body ? 'billing_period' then
        c.billing_period := p_body ->> 'billing_period';
        c.billing_cycle := public._contracts_cycle_from_text(c.billing_period);
        if c.billing_cycle is not null then
            c.billing_period := public._contracts_cycle_label(c.billing_cycle);
        end if;
    end if;
    v_auto := public._contracts_body_bool(p_body, 'auto_renew');
    if v_auto is not null then
        c.auto_renew := v_auto;
    end if;
    if coalesce(c.billing_cycle, 'one_off') not in ('monthly', 'quarterly', 'annual') then
        if v_auto then
            raise exception 'Only a monthly, quarterly or annual contract can renew automatically.'
                using errcode = 'PT422';
        end if;
        -- A contract billed once does not renew itself.
        c.auto_renew := false;
    end if;

    if p_body ? 'notes' then c.notes := p_body ->> 'notes'; end if;
    if p_body ? 'status' and p_body ->> 'status' is not null then
        if p_body ->> 'status' not in ('active', 'renewed', 'ended', 'cancelled') then
            raise exception 'status: Input should be ''active'', ''renewed'', ''ended'' or ''cancelled'''
                using errcode = 'PT422';
        end if;
        c.status := p_body ->> 'status';
    end if;
    v_days := public._contracts_reminder_days(p_body);

    -- Auto-renewing: end_date is the next renewal, worked out from the start.
    if c.auto_renew then
        v_touched := p_body ? 'auto_renew' or p_body ? 'billing_cycle'
                  or p_body ? 'billing_period' or p_body ? 'start_date';
        if c.start_date is null and v_touched then
            raise exception 'Auto-renewing contracts need a start date.' using errcode = 'PT422';
        end if;
        select end_date into c.end_date from public.contracts where id = p_id;
        if v_touched or c.end_date <= v_today then
            c.end_date := public._contracts_next_renewal(coalesce(c.start_date, c.end_date),
                                                         c.billing_cycle, v_today);
        end if;
    end if;

    update public.contracts
       set title = c.title, counterparty = c.counterparty, start_date = c.start_date,
           end_date = c.end_date, amount = c.amount, currency = c.currency,
           billing_period = c.billing_period, billing_cycle = c.billing_cycle,
           auto_renew = c.auto_renew, notes = c.notes, status = c.status,
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

    return public._contracts_serialise(p_id, v_today);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6b. Coming up: as in 20260929000100_purchase_orders.sql, except that an
-- auto-renewing contract shows only within its own largest warning (monthly
-- with [7]: the last 7 days before renewal), not the 90-day window.
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
             and not (c.auto_renew and c.billing_cycle in ('monthly', 'quarterly', 'annual'))
             and c.end_date <= p_today + 90
             and (c.end_date >= p_today
                  or not exists (select 1 from public.contract_reminders r
                                  where r.contract_id = c.id)
                  or exists (select 1 from public.contract_reminders r
                              where r.contract_id = c.id and r.acknowledged_at is null))
          union all
          select 'contract'::text,
                 c.id,
                 c.id,
                 c.title::text,
                 coalesce(nullif(btrim(c.counterparty), ''), c.title)::text,
                 c.kind::text,
                 to_char(c.end_date, 'YYYY-MM-DD'),
                 (c.end_date - p_today),
                 false
            from public.contracts c
           where c.status = 'active'
             and c.auto_renew and c.billing_cycle in ('monthly', 'quarterly', 'annual')
             and c.end_date >= p_today
             and c.end_date <= p_today + coalesce((select max(r.days_before)
                                                     from public.contract_reminders r
                                                    where r.contract_id = c.id), 0)
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

-- ---------------------------------------------------------------------------
-- 7. Renewal emails: as in 20260929000100_purchase_orders.sql, after rolling
-- auto-renewing contracts on so no email names a date already gone. Monthly
-- and quarterly auto-renewals (usually auto-debit) get no email; annual ones
-- still do.
-- ---------------------------------------------------------------------------
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
    perform public.contracts_roll_renewals(public.local_today());

    for r in
        select 'contract'::text as kind, c.id, c.title::text as label,
               coalesce(nullif(btrim(c.counterparty), ''), c.title)::text as client,
               c.kind::text as contract_kind, c.end_date, (c.end_date - p_today) as days
          from public.contracts c
         where c.status = 'active' and c.end_date between p_today and p_today + 60
           and not (c.auto_renew and c.billing_cycle in ('monthly', 'quarterly'))
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
-- 8. Grants. The roll and the backfill are for the scheduler and this
-- migration only.
-- ---------------------------------------------------------------------------
revoke all on function public._contracts_cycle_from_text(text)                from public;
revoke all on function public._contracts_cycle_label(text)                    from public;
revoke all on function public._contracts_next_renewal(date, text, date)       from public;
revoke all on function public._contracts_default_reminders(text, text)        from public;
revoke all on function public._contracts_body_cycle(jsonb)                    from public;
revoke all on function public._contracts_body_bool(jsonb, text)               from public;
revoke all on function public.contracts_roll_renewals(date)                   from public;
revoke all on function public._contracts_backfill_billing_cycles()            from public;
revoke all on function public._contracts_serialise(uuid, date)                from public;
revoke all on function public.contracts_create(jsonb)                         from public;
revoke all on function public.contracts_update(uuid, jsonb)                   from public;
revoke all on function public.contracts_send_renewal_notices(date)            from public;
revoke all on function public._contracts_coming_up(date)                      from public;

grant execute on function public.contracts_create(jsonb)                      to authenticated;
grant execute on function public.contracts_update(uuid, jsonb)                to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Backfill: classify the old text, then bring every auto-renewing
-- contract's date up to today.
-- ---------------------------------------------------------------------------
select public._contracts_backfill_billing_cycles();
select public.contracts_roll_renewals();

-- ---------------------------------------------------------------------------
-- 10. Schedule: roll renewals on at 00:05 in Jakarta (17:05 UTC), before the
--     08:00 renewal emails. Only where pg_cron exists.
-- ---------------------------------------------------------------------------
do $$
begin
    if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
        begin
            create extension if not exists pg_cron;
        exception when others then
            raise notice 'contract-auto-renew not scheduled: %', sqlerrm;
        end;
    end if;

    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.schedule(
            'contract-auto-renew',
            '5 17 * * *',
            $cron$select public.contracts_roll_renewals();$cron$);
    end if;
end
$$;

commit;
