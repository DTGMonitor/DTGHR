-- ===========================================================================
-- Salary: reviews, the KPI summary, the increase-by-band table, and the year
-- of CPI and AUD->IDR shown beside it.
--
-- Ported from the FastAPI line: app/api/routes/salary.py,
-- app/api/routes/salary_guidance.py, app/services/salary_guidance.py.
--
-- Audience: the director and the executives, nobody else -- finance
-- included -- and everybody else is answered 404, not 403, so a refusal does
-- not reveal that a salary review exists. The director writes a proposal, the
-- executive approves or declines it, nobody signs their own.
--
-- The outside fetches (BPS for CPI y/y, the ECB via frankfurter.app for
-- AUD->IDR) live in the Edge Function `economic-readings`. The route asks
-- `salary_guidance_missing()` which months are not stored yet, has the Edge
-- Function fetch and store them through `salary_store_readings()` (service
-- role only, never overwriting a stored row), then reads the averages from
-- `salary_annual_average()`, which works from stored rows alone.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
create table if not exists public.salary_reviews (
    id               uuid primary key default gen_random_uuid(),
    employee_id      uuid not null references public.employees(id) on delete cascade,
    effective_date   date not null,
    current_amount   double precision not null,
    proposed_amount  double precision not null,
    currency         varchar(3) not null default 'IDR',
    rationale        text,
    status           varchar(20) not null default 'draft',
    prepared_by      uuid references public.users(id) on delete set null,
    submitted_at     timestamp,
    endorsed_by      uuid references public.users(id) on delete set null,
    endorsed_at      timestamp,
    endorsement_note text,
    approved_by      uuid references public.users(id) on delete set null,
    approved_at      timestamp,
    decline_reason   text,
    created_at       timestamp not null default now(),
    updated_at       timestamp not null default now()
);
create index if not exists ix_salary_reviews_employee_id on public.salary_reviews (employee_id);
create index if not exists ix_salary_reviews_status      on public.salary_reviews (status);

create table if not exists public.economic_indicators (
    id         uuid primary key default gen_random_uuid(),
    kind       varchar(20) not null,
    month      date not null,
    value      double precision not null,
    source     varchar(160),
    entered_by uuid references public.users(id) on delete set null,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    constraint uq_economic_indicator_kind_month unique (kind, month)
);
create index if not exists ix_economic_indicators_kind on public.economic_indicators (kind);

create table if not exists public.salary_increase_settings (
    id             uuid primary key default gen_random_uuid(),
    band_increases jsonb not null
        default '{"1": 3.0, "2L": 3.0, "2M": 3.0, "2H": 5.0, "3": 7.0}'::jsonb,
    updated_by     uuid references public.users(id) on delete set null,
    created_at     timestamp not null default now(),
    updated_at     timestamp not null default now()
);
-- A single row, enforced: two first reads racing cannot create two tables.
create unique index if not exists uq_salary_increase_settings_single
    on public.salary_increase_settings ((true));

alter table public.salary_reviews           enable row level security;
alter table public.economic_indicators      enable row level security;
alter table public.salary_increase_settings enable row level security;
-- No policies: every read and write goes through the functions below.

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (not granted to anybody; called from the functions).
-- ---------------------------------------------------------------------------

-- The two founders. Nobody else, ever -- finance included.
create or replace function public.salary_can_view()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.is_director() or public.is_executive();
$$;

create or replace function public.salary_require_access()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.salary_can_view() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
end;
$$;

-- Python's "{:g}" closely enough for a log line: 3.0 -> 3, 4.25 -> 4.25.
create or replace function public.salary_fmt_g(p double precision)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select trim_scale(round(p::numeric, 6))::text;
$$;

-- SalaryReviewResponse.
create or replace function public.salary_review_out(r public.salary_reviews, e public.employees)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', r.id,
        'employee_id', r.employee_id,
        'employee_name', trim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')),
        'employee_position', e.position,
        'effective_date', r.effective_date,
        'current_amount', r.current_amount,
        'proposed_amount', r.proposed_amount,
        'currency', r.currency,
        'rationale', r.rationale,
        'status', r.status,
        -- SALARY_AWAITS: only a submitted review waits on anybody.
        'awaiting_role', case when r.status = 'submitted' then 'executive' end,
        'endorsement_note', r.endorsement_note,
        'decline_reason', r.decline_reason,
        'submitted_at', r.submitted_at,
        'endorsed_at', r.endorsed_at,
        'approved_at', r.approved_at
    );
$$;

-- The single row of band percentages, created with the defaults on first read.
create or replace function public.salary_band_increases()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v jsonb;
begin
    select band_increases into v from public.salary_increase_settings limit 1;
    if v is null then
        insert into public.salary_increase_settings default values
        on conflict do nothing;
        select band_increases into v from public.salary_increase_settings limit 1;
    end if;
    return v;
end;
$$;

-- A scorecard's total and band, from the KPI area's own scoring
-- (public.kpi_score), so the Salary page and the scorecard can never disagree.
create or replace function public.salary_kpi_score(p_review_id uuid)
returns table (total_score double precision, is_complete boolean,
               band_code text, band_label text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v jsonb;
begin
    select public.kpi_score(coalesce(jsonb_agg(jsonb_build_object(
               'weight', i.weight,
               'rating', i.rating,
               'is_not_applicable', i.is_not_applicable)
             order by i.sort_order, i.number), '[]'::jsonb))
      into v
      from public.kpi_review_items i
     where i.review_id = p_review_id;

    return query select (v->>'total')::double precision,
                        coalesce((v->>'is_complete')::boolean, false),
                        v->>'band_code',
                        v->>'band_label';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Salary reviews.
-- ---------------------------------------------------------------------------

-- GET /salary-reviews
create or replace function public.salary_list_reviews()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_author boolean := public.is_director();
    v_exec   boolean := public.is_executive();
    v_items  jsonb;
    v_await  int;
begin
    perform public.salary_require_access();

    select coalesce(jsonb_agg(public.salary_review_out(r, e)
                              order by r.effective_date desc, r.created_at desc), '[]'::jsonb),
           count(*) filter (where v_exec and r.status = 'submitted'
                              and e.user_id is distinct from auth.uid())::int
      into v_items, v_await
      from public.salary_reviews r
      join public.employees e on e.id = r.employee_id
     -- Drafts are the author's working papers.
     where v_author or r.status <> 'draft';

    return jsonb_build_object(
        'items', v_items,
        'can_prepare', v_author,
        'can_endorse', false,
        'can_approve', v_exec,
        'awaiting_me', v_await
    );
end;
$$;

-- GET /salary-reviews/kpi-summary
create or replace function public.salary_kpi_summary()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_author boolean := public.is_director();
    v_bands  jsonb;
    v_items  jsonb;
begin
    perform public.salary_require_access();
    v_bands := public.salary_band_increases();

    with staff as (
        select e.*
          from public.employees e
         where e.is_active
           -- Founders are neither assessed nor salary-reviewed.
           and not (e.is_management_role and not e.kpi_review_required)
    ),
    kpi as (
        select distinct on (k.employee_id) k.*
          from public.kpi_reviews k
         where k.employee_id in (select id from staff)
         order by k.employee_id, k.period_end desc, k.created_at desc
    ),
    approved as (
        select distinct on (s.employee_id) s.employee_id, s.proposed_amount
          from public.salary_reviews s
         where s.status = 'approved' and s.employee_id in (select id from staff)
         order by s.employee_id, s.effective_date desc, s.created_at desc
    ),
    latest as (
        select distinct on (s.employee_id) s.*
          from public.salary_reviews s
         where s.employee_id in (select id from staff)
           and (v_author or s.status <> 'draft')
         order by s.employee_id, s.effective_date desc, s.created_at desc
    ),
    out_rows as (
        select st.first_name, st.last_name, st.id as employee_id,
               jsonb_build_object(
                   'employee_id', st.id,
                   'employee_name', trim(coalesce(st.first_name, '') || ' ' || coalesce(st.last_name, '')),
                   'employee_position', st.position,
                   'kpi_exemption_reason', case when st.kpi_review_required then null
                                                else st.kpi_exemption_reason end,
                   'kpi_review_id', k.id,
                   'period_label', k.period_label,
                   'kpi_status', k.status::text,
                   'total_score', case when k.id is not null then sc.total_score end,
                   'max_score', 130.0,
                   'is_complete', coalesce(sc.is_complete, false),
                   'band_code', sc.band_code,
                   'band_label', sc.band_label,
                   'critical_gate_cleared', coalesce(k.critical_gate_cleared, true),
                   'hard_gate_triggered', coalesce(k.hard_gate_triggered, false),
                   -- The scorecard's assessor or approver, never on their own card.
                   'can_edit_gate', coalesce(k.id is not null
                        and st.user_id is distinct from auth.uid()
                        and auth.uid() in (k.assessor_id, k.approver_id), false),
                   'recommended_increase_pct',
                        case when k.id is not null
                              and k.status::text in ('approved', 'published')
                              and sc.is_complete
                              and k.critical_gate_cleared
                              and not k.hard_gate_triggered
                             then (v_bands ->> sc.band_code)::double precision end,
                   'recommendation_note',
                        case when k.id is null then null
                             when k.status::text not in ('approved', 'published')
                                 then 'Waiting for the scorecard to be approved.'
                             when not sc.is_complete then 'Scorecard not fully rated.'
                             when not k.critical_gate_cleared
                                 then 'Serious violation recorded — no KPI-linked increase.'
                             when k.hard_gate_triggered
                                 then 'Hard gate raised — no increase until it is reviewed.'
                             else 'Band ' || sc.band_code || ' (' || sc.band_label || ')' end,
                   'current_salary', case when a.employee_id is not null then a.proposed_amount
                                          when k.id is not null then k.current_basic_salary::double precision end,
                   'salary_review_id', l.id,
                   'salary_review_status', l.status,
                   'salary_review_effective_date', l.effective_date,
                   'salary_review_proposed_amount', l.proposed_amount
               ) as j
          from staff st
          left join kpi k on k.employee_id = st.id
          left join lateral public.salary_kpi_score(k.id) sc on k.id is not null
          left join approved a on a.employee_id = st.id
          left join latest l on l.employee_id = st.id
    )
    select coalesce(jsonb_agg(j order by first_name, last_name), '[]'::jsonb)
      into v_items
      from out_rows;

    return jsonb_build_object('items', v_items);
end;
$$;

-- POST /salary-reviews
create or replace function public.salary_create_review(p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_emp      public.employees;
    v_row      public.salary_reviews;
    v_current  double precision;
    v_proposed double precision;
    v_currency text := coalesce(p_body ->> 'currency', 'IDR');
    v_reason   text := p_body ->> 'rationale';
begin
    if not public.is_director() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    if p_body ->> 'employee_id' is null or p_body ->> 'effective_date' is null
       or p_body ->> 'current_amount' is null or p_body ->> 'proposed_amount' is null then
        raise exception 'employee_id, effective_date, current_amount and proposed_amount are required.'
            using errcode = 'PT422';
    end if;
    v_current  := (p_body ->> 'current_amount')::double precision;
    v_proposed := (p_body ->> 'proposed_amount')::double precision;
    if v_current < 0 or v_proposed < 0 then
        raise exception 'An amount cannot be negative.' using errcode = 'PT422';
    end if;
    if length(v_currency) <> 3 then
        raise exception 'A currency is three letters.' using errcode = 'PT422';
    end if;
    if v_proposed <> v_current and coalesce(trim(v_reason), '') = '' then
        raise exception 'Give a rationale when the proposed figure differs from the current one.'
            using errcode = 'PT422';
    end if;

    select * into v_emp from public.employees where id = (p_body ->> 'employee_id')::uuid;
    if v_emp.id is null or not v_emp.is_active then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    insert into public.salary_reviews (employee_id, effective_date, current_amount, proposed_amount,
                                       currency, rationale, status, prepared_by)
    values (v_emp.id, (p_body ->> 'effective_date')::date, v_current, v_proposed,
            v_currency, v_reason, 'draft', auth.uid())
    returning * into v_row;

    perform public.log_activity('SALARY_REVIEW_DRAFTED',
        'Drafted a salary review for ' || v_emp.first_name || ' ' || v_emp.last_name, v_row.id, null);
    return public.salary_review_out(v_row, v_emp);
end;
$$;

-- PATCH /salary-reviews/:id -- the author, on a draft, only the keys sent.
create or replace function public.salary_update_review(p_id uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.salary_reviews;
    v_emp public.employees;
begin
    perform public.salary_require_access();
    select * into v_row from public.salary_reviews where id = p_id;
    select * into v_emp from public.employees where id = v_row.employee_id;
    if v_row.id is null or v_emp.id is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if not (public.is_director() and v_row.status = 'draft') then
        raise exception 'This review cannot be edited at its current step.' using errcode = 'PT409';
    end if;
    if coalesce((p_body ->> 'current_amount')::double precision, 0) < 0
       or coalesce((p_body ->> 'proposed_amount')::double precision, 0) < 0 then
        raise exception 'An amount cannot be negative.' using errcode = 'PT422';
    end if;

    update public.salary_reviews set
        effective_date  = coalesce((p_body ->> 'effective_date')::date, effective_date),
        current_amount  = coalesce((p_body ->> 'current_amount')::double precision, current_amount),
        proposed_amount = coalesce((p_body ->> 'proposed_amount')::double precision, proposed_amount),
        rationale       = case when p_body ? 'rationale' then p_body ->> 'rationale' else rationale end,
        updated_at      = now()
     where id = p_id
    returning * into v_row;
    return public.salary_review_out(v_row, v_emp);
end;
$$;

-- POST /salary-reviews/:id/submit
create or replace function public.salary_submit_review(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.salary_reviews;
    v_emp public.employees;
begin
    if not public.is_director() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into v_row from public.salary_reviews where id = p_id for update;
    select * into v_emp from public.employees where id = v_row.employee_id;
    if v_row.id is null or v_emp.id is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_row.status <> 'draft' then
        raise exception 'This review has already been submitted.' using errcode = 'PT409';
    end if;

    -- A resubmission clears the previous refusal.
    update public.salary_reviews
       set status = 'submitted', submitted_at = (now() at time zone 'utc'),
           decline_reason = null, updated_at = now()
     where id = p_id
    returning * into v_row;

    perform public.log_activity('SALARY_REVIEW_SUBMITTED',
        'Submitted a salary review for ' || v_emp.first_name || ' ' || v_emp.last_name, v_row.id, null);
    return public.salary_review_out(v_row, v_emp);
end;
$$;

-- POST /salary-reviews/:id/approve -- the executive; the end of the chain.
create or replace function public.salary_approve_review(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.salary_reviews;
    v_emp public.employees;
begin
    if not public.is_executive() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into v_row from public.salary_reviews where id = p_id for update;
    select * into v_emp from public.employees where id = v_row.employee_id;
    if v_row.id is null or v_emp.id is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_emp.user_id = auth.uid() then
        raise exception 'You cannot sign off your own salary review.' using errcode = 'PT403';
    end if;
    if v_row.status <> 'submitted' then
        raise exception 'This review has not been endorsed yet.' using errcode = 'PT409';
    end if;

    update public.salary_reviews
       set status = 'approved', approved_by = auth.uid(),
           approved_at = (now() at time zone 'utc'), updated_at = now()
     where id = p_id
    returning * into v_row;

    perform public.log_activity('SALARY_REVIEW_APPROVED',
        'Approved the salary review for ' || v_emp.first_name || ' ' || v_emp.last_name, v_row.id, null);
    return public.salary_review_out(v_row, v_emp);
end;
$$;

-- POST /salary-reviews/:id/decline -- back to the author as a draft, with why.
create or replace function public.salary_decline_review(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.salary_reviews;
    v_emp public.employees;
begin
    select * into v_row from public.salary_reviews where id = p_id for update;
    select * into v_emp from public.employees where id = v_row.employee_id;
    if v_row.id is null or v_emp.id is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if not (public.is_executive() and v_row.status = 'submitted') then
        if public.salary_can_view() then
            raise exception 'This review is not waiting on you.' using errcode = 'PT409';
        end if;
        raise exception 'This review is not waiting on you.' using errcode = 'PT404';
    end if;
    if v_emp.user_id = auth.uid() then
        raise exception 'You cannot sign off your own salary review.' using errcode = 'PT403';
    end if;
    if coalesce(trim(p_note), '') = '' then
        raise exception 'Say why, so finance knows what to change.' using errcode = 'PT422';
    end if;

    update public.salary_reviews
       set status = 'draft', decline_reason = p_note, submitted_at = null,
           endorsed_by = null, endorsed_at = null, endorsement_note = null, updated_at = now()
     where id = p_id
    returning * into v_row;

    perform public.log_activity('SALARY_REVIEW_DECLINED',
        'Sent back the salary review for ' || v_emp.first_name || ' ' || v_emp.last_name, v_row.id, null);
    return public.salary_review_out(v_row, v_emp);
end;
$$;

-- DELETE /salary-reviews/:id -- the author discards a draft.
create or replace function public.salary_delete_review(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.salary_reviews;
begin
    if not public.is_director() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into v_row from public.salary_reviews where id = p_id;
    if v_row.id is null or not exists (select 1 from public.employees where id = v_row.employee_id) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_row.status <> 'draft' then
        raise exception 'Only a draft can be discarded.' using errcode = 'PT409';
    end if;
    delete from public.salary_reviews where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Guidance: the band table and the indicators.
-- ---------------------------------------------------------------------------

create or replace function public.salary_indicator_out(i public.economic_indicators)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
    select jsonb_build_object('id', i.id, 'kind', i.kind, 'month', i.month,
                              'value', i.value, 'source', i.source, 'entered_by', i.entered_by);
$$;

-- GET /salary-guidance
create or replace function public.salary_guidance_data()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_ind jsonb;
begin
    perform public.salary_require_access();
    -- Only kinds still in use: a leftover row of a retired kind must not
    -- take the page down.
    select coalesce(jsonb_agg(public.salary_indicator_out(i) order by i.kind, i.month desc), '[]'::jsonb)
      into v_ind
      from public.economic_indicators i
     where i.kind in ('cpi_yoy', 'aud_idr');
    return jsonb_build_object('band_increases', public.salary_band_increases(),
                              'indicators', v_ind);
end;
$$;

-- PUT /salary-guidance/bands
create or replace function public.salary_set_band_increases(p_band_increases jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_codes   text[] := array['1', '2L', '2M', '2H', '3'];
    v_unknown text;
    v_out     jsonb := '{}'::jsonb;
    v_desc    text;
    v_code    text;
    v_pct     double precision;
begin
    perform public.salary_require_access();
    if p_band_increases is null or jsonb_typeof(p_band_increases) <> 'object' then
        raise exception 'band_increases must be an object of band code to percent.' using errcode = 'PT422';
    end if;
    select string_agg(k, ', ' order by k) into v_unknown
      from jsonb_object_keys(p_band_increases) k
     where k <> all (v_codes);
    if v_unknown is not null then
        raise exception 'Unknown band codes: %', v_unknown using errcode = 'PT422';
    end if;
    if exists (select 1 from jsonb_each(p_band_increases) x
                where jsonb_typeof(x.value) <> 'number'
                   or (x.value)::text::double precision < 0
                   or (x.value)::text::double precision > 50) then
        raise exception 'An increase must be between 0 and 50 percent.' using errcode = 'PT422';
    end if;

    -- Every band present, so the table never has a hole in it.
    foreach v_code in array v_codes loop
        v_pct := coalesce((p_band_increases ->> v_code)::double precision, 0.0);
        v_out := v_out || jsonb_build_object(v_code, v_pct);
        v_desc := coalesce(v_desc || ', ', '') || v_code || ' ' || public.salary_fmt_g(v_pct) || '%';
    end loop;

    perform public.salary_band_increases();  -- make sure the row exists
    update public.salary_increase_settings
       set band_increases = v_out, updated_by = auth.uid(), updated_at = now();

    perform public.log_activity('SALARY_INCREASE_BANDS', 'Set the increase by KPI band: ' || v_desc, null, null);
    return jsonb_build_object('band_increases', v_out);
end;
$$;

-- PUT /salary-guidance/indicators -- enter or correct a month's reading.
create or replace function public.salary_upsert_indicator(
    p_kind text, p_month date, p_value double precision, p_source text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_month date := date_trunc('month', p_month)::date;
    v_row   public.economic_indicators;
begin
    perform public.salary_require_access();
    if p_kind is null or p_kind not in ('cpi_yoy', 'aud_idr') then
        raise exception 'kind must be cpi_yoy or aud_idr.' using errcode = 'PT422';
    end if;
    if p_month is null or p_value is null then
        raise exception 'month and value are required.' using errcode = 'PT422';
    end if;
    if p_kind = 'aud_idr' and p_value <= 0 then
        raise exception 'An exchange rate must be above zero.' using errcode = 'PT422';
    end if;
    if length(p_source) > 160 then
        raise exception 'A source is at most 160 characters.' using errcode = 'PT422';
    end if;

    insert into public.economic_indicators (kind, month, value, source, entered_by)
    values (p_kind, v_month, p_value, coalesce(nullif(trim(p_source), ''), 'Entered by hand'), auth.uid())
    on conflict (kind, month) do update
        set value = excluded.value, source = excluded.source,
            entered_by = excluded.entered_by, updated_at = now()
    returning * into v_row;

    perform public.log_activity('SALARY_GUIDANCE_INDICATOR',
        'Set ' || upper(p_kind) || ' for ' || to_char(v_month, 'FMMonth YYYY') || ' to '
            || public.salary_fmt_g(p_value), v_row.id, null);
    return public.salary_indicator_out(v_row);
end;
$$;

-- DELETE /salary-guidance/indicators/:id
create or replace function public.salary_delete_indicator(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.economic_indicators;
begin
    perform public.salary_require_access();
    select * into v_row from public.economic_indicators where id = p_id;
    if v_row.id is null then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    perform public.log_activity('SALARY_GUIDANCE_INDICATOR',
        'Removed ' || upper(v_row.kind) || ' for ' || to_char(v_row.month, 'FMMonth YYYY')
            || ' (' || public.salary_fmt_g(v_row.value) || ')', null, null);
    delete from public.economic_indicators where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The twelve-month average, from stored readings.
-- ---------------------------------------------------------------------------

-- The latest month BPS has published, looking back from last month over four
-- months of stored CPI readings; last month when none is stored (it then
-- shows up as missing rather than failing).
create or replace function public.salary_latest_published_month()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (select max(i.month) from public.economic_indicators i
          where i.kind = 'cpi_yoy'
            and i.month between (date_trunc('month', public.local_today()) - interval '4 months')::date
                            and (date_trunc('month', public.local_today()) - interval '1 month')::date),
        (date_trunc('month', public.local_today()) - interval '1 month')::date);
$$;

-- What the Edge Function should fetch before the average is read: every
-- month in the window not stored yet and already started. With no end,
-- `candidates` lists the months the default end is looked for in; fetch those
-- first and call again, and `end` is then the one to use.
create or replace function public.salary_guidance_missing(p_end date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_now  date := date_trunc('month', public.local_today())::date;
    v_end  date;
    v_cand jsonb := '[]'::jsonb;
begin
    perform public.salary_require_access();
    if p_end is null then
        select coalesce(jsonb_agg(m order by m), '[]'::jsonb) into v_cand
          from (select (v_now - make_interval(months => n))::date m
                  from generate_series(1, 4) n) c
         where not exists (select 1 from public.economic_indicators i
                            where i.kind = 'cpi_yoy' and i.month = c.m);
        v_end := public.salary_latest_published_month();
    else
        v_end := date_trunc('month', p_end)::date;
    end if;

    return jsonb_build_object(
        'end', v_end,
        'candidates', v_cand,
        'cpi_yoy', (
            select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
              from (select (v_end - make_interval(months => n))::date m
                      from generate_series(0, 11) n) w
             where w.m <= v_now
               and not exists (select 1 from public.economic_indicators i
                                where i.kind = 'cpi_yoy' and i.month = w.m)),
        'aud_idr', (
            select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
              from (select (v_end - make_interval(months => n))::date m
                      from generate_series(0, 23) n) w
             where w.m <= v_now
               and not exists (select 1 from public.economic_indicators i
                                where i.kind = 'aud_idr' and i.month = w.m))
    );
end;
$$;

-- GET /salary-guidance/annual-average, once the readings are in.
create or replace function public.salary_annual_average(p_end date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_end   date;
    v_start date;
    v_out   jsonb;
begin
    perform public.salary_require_access();
    v_end := coalesce(date_trunc('month', p_end)::date, public.salary_latest_published_month());
    v_start := (v_end - interval '11 months')::date;

    with months as (
        select (v_start + make_interval(months => n))::date as month
          from generate_series(0, 11) n
    ),
    joined as (
        select m.month,
               c.value as cpi_yoy,
               a.value as aud_idr,
               b.value as aud_before
          from months m
          left join public.economic_indicators c on c.kind = 'cpi_yoy' and c.month = m.month
          left join public.economic_indicators a on a.kind = 'aud_idr' and a.month = m.month
          left join public.economic_indicators b
                 on b.kind = 'aud_idr' and b.month = (m.month - interval '12 months')::date
    ),
    changes as (
        select j.*,
               case when j.aud_idr is not null and coalesce(j.aud_before, 0) <> 0
                    then round(((j.aud_idr / j.aud_before - 1) * 100)::numeric, 2)::double precision
               end as aud_idr_yoy
          from joined j
    )
    select jsonb_build_object(
        'start', v_start,
        'end', v_end,
        'months', coalesce(jsonb_agg(jsonb_build_object(
                      'month', c.month, 'cpi_yoy', c.cpi_yoy, 'aud_idr', c.aud_idr,
                      'aud_idr_year_before', c.aud_before, 'aud_idr_yoy', c.aud_idr_yoy)
                      order by c.month), '[]'::jsonb),
        'cpi_average', round(avg(c.cpi_yoy)::numeric, 2)::double precision,
        'aud_idr_average', round(avg(c.aud_idr_yoy)::numeric, 2)::double precision,
        'missing',
            coalesce((select jsonb_agg('CPI for ' || to_char(x.month, 'FMMonth YYYY') order by x.month)
                        from changes x where x.cpi_yoy is null), '[]'::jsonb)
            || coalesce((select jsonb_agg('AUD→IDR for ' || to_char(x.month, 'FMMonth YYYY') order by x.month)
                           from changes x where x.aud_idr_yoy is null), '[]'::jsonb)
    )
      into v_out
      from changes c;
    return v_out;
end;
$$;

-- Where the Edge Function stores what it fetched: service role only. A month
-- already stored -- entered by hand, or by a request that got there first --
-- is kept, never overwritten. Returns how many rows were added.
create or replace function public.salary_store_readings(p_kind text, p_readings jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_n int;
begin
    if p_kind not in ('cpi_yoy', 'aud_idr') then
        raise exception 'kind must be cpi_yoy or aud_idr.' using errcode = 'PT422';
    end if;
    with ins as (
        insert into public.economic_indicators (kind, month, value, source)
        select p_kind, date_trunc('month', (r ->> 'month')::date)::date,
               (r ->> 'value')::double precision, left(r ->> 'source', 160)
          from jsonb_array_elements(coalesce(p_readings, '[]'::jsonb)) r
         where r ->> 'month' is not null and r ->> 'value' is not null
        on conflict (kind, month) do nothing
        returning 1
    )
    select count(*)::int into v_n from ins;
    return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants.
-- ---------------------------------------------------------------------------
revoke all on function public.salary_require_access()                        from public, anon, authenticated;
revoke all on function public.salary_fmt_g(double precision)                 from public, anon, authenticated;
revoke all on function public.salary_review_out(public.salary_reviews, public.employees) from public, anon, authenticated;
revoke all on function public.salary_indicator_out(public.economic_indicators) from public, anon, authenticated;
revoke all on function public.salary_band_increases()                        from public, anon, authenticated;
revoke all on function public.salary_kpi_score(uuid)                         from public, anon, authenticated;
revoke all on function public.salary_latest_published_month()                from public, anon, authenticated;
revoke all on function public.salary_store_readings(text, jsonb)             from public, anon, authenticated;
grant execute on function public.salary_store_readings(text, jsonb)          to service_role;

revoke all on function public.salary_can_view()                              from public;
revoke all on function public.salary_list_reviews()                          from public;
revoke all on function public.salary_kpi_summary()                           from public;
revoke all on function public.salary_create_review(jsonb)                    from public;
revoke all on function public.salary_update_review(uuid, jsonb)              from public;
revoke all on function public.salary_submit_review(uuid)                     from public;
revoke all on function public.salary_approve_review(uuid, text)              from public;
revoke all on function public.salary_decline_review(uuid, text)              from public;
revoke all on function public.salary_delete_review(uuid)                     from public;
revoke all on function public.salary_guidance_data()                         from public;
revoke all on function public.salary_set_band_increases(jsonb)               from public;
revoke all on function public.salary_upsert_indicator(text, date, double precision, text) from public;
revoke all on function public.salary_delete_indicator(uuid)                  from public;
revoke all on function public.salary_guidance_missing(date)                  from public;
revoke all on function public.salary_annual_average(date)                    from public;

grant execute on function public.salary_can_view()                           to authenticated;
grant execute on function public.salary_list_reviews()                       to authenticated;
grant execute on function public.salary_kpi_summary()                        to authenticated;
grant execute on function public.salary_create_review(jsonb)                 to authenticated;
grant execute on function public.salary_update_review(uuid, jsonb)           to authenticated;
grant execute on function public.salary_submit_review(uuid)                  to authenticated;
grant execute on function public.salary_approve_review(uuid, text)           to authenticated;
grant execute on function public.salary_decline_review(uuid, text)           to authenticated;
grant execute on function public.salary_delete_review(uuid)                  to authenticated;
grant execute on function public.salary_guidance_data()                      to authenticated;
grant execute on function public.salary_set_band_increases(jsonb)            to authenticated;
grant execute on function public.salary_upsert_indicator(text, date, double precision, text) to authenticated;
grant execute on function public.salary_delete_indicator(uuid)               to authenticated;
grant execute on function public.salary_guidance_missing(date)               to authenticated;
grant execute on function public.salary_annual_average(date)                 to authenticated;

commit;
