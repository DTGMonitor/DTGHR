-- ===========================================================================
-- Approved leave shows on the roster.
--
-- Approving a leave request used to change only the request. The roster kept
-- DS, NS or D on those days, so everything that reads the roster -- payroll's
-- field days, the dashboard's on-shift and away lists, the roster totals --
-- counted the person as working.
--
--   * leaves_roster_code(): each leave type has one code. annual AL, sick SL,
--     study ST, every family and special type SP.
--   * leaves_is_leave_day(): the one rule for which days a leave takes --
--     what leaves_count_days counted, now per day, and used by approval, the
--     generator and the annual balance too.
--   * Approval marks the request on_roster and writes its code over each
--     working cell (DS, NS, C, D, TW, T) on its leave days, remembering the
--     code it replaced in leave_roster_cells. B, O, PH and leave cells stay.
--   * The generator writes an on_roster leave's code instead of a working
--     pattern code, so a month built later has the leave and a rebuilt one
--     keeps it.
--   * Cancelling restores the remembered code wherever the leave's code is
--     still there; a cell edited since is left as it was edited.
--   * Only leave approved from now on: every existing request is on_roster =
--     false and is never written. No cell changes here.
--   * The annual balance counts AL cells and the leave days of approved
--     annual requests -- no longer every calendar day of them. Weekends,
--     Break days and national holidays stop being charged.
--
-- Otherwise the functions are as in 20260926000300_leaves.sql,
-- 20260926000400_schedules.sql and 20261008000200_roster_special_leave.sql.
--
-- Safe to re-run.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The mapping and the rule.
-- ---------------------------------------------------------------------------

create or replace function public.leaves_roster_code(p_leave_type text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_leave_type
               when 'annual' then 'AL'
               when 'sick'   then 'SL'
               when 'study'  then 'ST'
               else 'SP'
           end;
$$;

-- A day a leave takes: for the rotating crew on a rostered day, a working or
-- leave code (a published schedule's cell first); otherwise Monday to Friday
-- and not a national holiday.
create or replace function public.leaves_is_leave_day(p_employee_id uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select case
             when c.shift_code is not null then
                  c.shift_code in ('DS', 'NS', 'C', 'D', 'TW', 'T', 'AL', 'SL', 'DL', 'SP')
             else extract(isodow from p_day) < 6
                  and not exists (select 1 from public.public_holidays h
                                   where h.date = p_day and h.is_national)
           end
      from (select 1) one
      left join public.employees e on e.id = p_employee_id and e.work_pattern = 'roster'
      left join lateral (
            select a.shift_code
              from public.shift_assignments a
              join public.work_schedules s on s.id = a.schedule_id
             where e.id is not null
               and a.employee_id = e.id
               and a.date = p_day
             order by (s.status = 'published') desc, a.updated_at desc
             limit 1
      ) c on true;
$$;

create or replace function public.leaves_count_days(p_employee_id uuid, p_start date, p_end date)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select count(*)::int
      from generate_series(p_start, p_end, interval '1 day') g(d)
     where public.leaves_is_leave_day(p_employee_id, g.d::date);
$$;

-- ---------------------------------------------------------------------------
-- 2. The flag and what a leave replaced.
-- ---------------------------------------------------------------------------

alter table public.leave_requests
    add column if not exists on_roster boolean not null default false;

create table if not exists public.leave_roster_cells (
    leave_request_id uuid not null references public.leave_requests (id) on delete cascade,
    employee_id      uuid not null,
    date             date not null,
    leave_code       text not null references public.shift_codes (code),
    previous_code    text not null references public.shift_codes (code),
    primary key (leave_request_id, date)
);

alter table public.leave_roster_cells enable row level security;
revoke all on public.leave_roster_cells from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Writing a leave onto the roster, and taking it off.
-- ---------------------------------------------------------------------------

create or replace function public.leaves_apply_to_roster(p_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_request public.leave_requests%rowtype;
    v_code text;
    v_day date;
    v_previous text;
begin
    select * into v_request from public.leave_requests where id = p_request_id;
    if not found or v_request.status <> 'approved' or not v_request.on_roster then
        return;
    end if;
    v_code := public.leaves_roster_code(v_request.leave_type);

    for v_day in
        select g::date from generate_series(v_request.start_date, v_request.end_date, interval '1 day') g
    loop
        continue when not public.leaves_is_leave_day(v_request.employee_id, v_day);

        select a.shift_code into v_previous
          from public.shift_assignments a
          join public.work_schedules s on s.id = a.schedule_id
         where a.employee_id = v_request.employee_id
           and a.date = v_day
           and a.shift_code in ('DS', 'NS', 'C', 'D', 'TW', 'T')
         order by (s.status = 'published') desc, a.updated_at desc
         limit 1;
        continue when v_previous is null;

        insert into public.leave_roster_cells (leave_request_id, employee_id, date, leave_code, previous_code)
        values (p_request_id, v_request.employee_id, v_day, v_code, v_previous)
        on conflict (leave_request_id, date) do nothing;

        update public.shift_assignments
           set shift_code = v_code, updated_at = now()
         where employee_id = v_request.employee_id
           and date = v_day
           and shift_code in ('DS', 'NS', 'C', 'D', 'TW', 'T');
    end loop;
end;
$$;

create or replace function public.leaves_remove_from_roster(p_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
    update public.shift_assignments a
       set shift_code = r.previous_code, updated_at = now()
      from public.leave_roster_cells r
     where r.leave_request_id = p_request_id
       and a.employee_id = r.employee_id
       and a.date = r.date
       and a.shift_code = r.leave_code;

    delete from public.leave_roster_cells where leave_request_id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Approve and cancel. As in 20260926000300, plus the roster.
-- ---------------------------------------------------------------------------

create or replace function public.approve_leave_request(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_reviewer_id uuid := public.assert_can_review_leave(p_id);
    v_request public.leave_requests%rowtype;
    v_name text;
    v_target_user uuid;
begin
    select * into v_request from public.leave_requests where id = p_id;

    update public.leave_requests
       set status = 'approved',
           reviewed_by = v_reviewer_id,
           reviewed_at = (now() at time zone 'utc'),
           reviewer_note = p_note,
           on_roster = true,
           updated_at = now()
     where id = p_id;

    -- Annual deducts itself: it is computed from the dates away. The other
    -- types keep a stored counter where one exists and move it.
    if v_request.leave_type <> 'annual' then
        update public.leave_balances
           set used_days = used_days + v_request.days_requested,
               updated_at = now()
         where employee_id = v_request.employee_id
           and leave_type = v_request.leave_type
           and year = extract(year from v_request.start_date)::int;
    end if;

    -- The roster's working days in the range become the leave's code.
    perform public.leaves_apply_to_roster(p_id);

    select e.first_name || ' ' || e.last_name, e.user_id
      into v_name, v_target_user
      from public.employees e where e.id = v_request.employee_id;

    perform public.log_activity(
        'LEAVE_APPROVED',
        format('Approved %s''s %s leave request', coalesce(v_name, 'Employee'), v_request.leave_type),
        p_id,
        v_target_user
    );

    return public.leave_request_json(p_id);
end;
$$;

create or replace function public.cancel_leave_request(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype := public.leaves_require_employee();
    v_request public.leave_requests%rowtype;
begin
    select * into v_request from public.leave_requests where id = p_id;
    if not found then
        raise exception 'Leave request not found' using errcode = 'PT404';
    end if;

    if v_request.employee_id <> v_employee.id then
        raise exception 'You can only cancel your own leave requests' using errcode = 'PT403';
    end if;

    if v_request.status not in ('pending', 'approved') then
        raise exception 'Cannot cancel a leave request with status ''%''', v_request.status
            using errcode = 'PT400';
    end if;

    -- Annual restores itself: the request leaves the set of dates away.
    if v_request.status = 'approved' and v_request.leave_type <> 'annual' then
        update public.leave_balances
           set used_days = greatest(0, used_days - v_request.days_requested),
               updated_at = now()
         where employee_id = v_request.employee_id
           and leave_type = v_request.leave_type
           and year = extract(year from v_request.start_date)::int;
    end if;

    -- The roster gets back what the leave replaced.
    if v_request.status = 'approved' and v_request.on_roster then
        perform public.leaves_remove_from_roster(p_id);
    end if;

    update public.leave_requests
       set status = 'cancelled', updated_at = now()
     where id = p_id;

    perform public.log_activity(
        'LEAVE_CANCELLED',
        format('%s %s cancelled their %s leave request',
               v_employee.first_name, v_employee.last_name, v_request.leave_type),
        p_id,
        auth.uid()
    );

    return public.leave_request_json(p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The generator gives way to approved leave. As in 20260926000400, plus
--    the leave step after the day's code is decided.
-- ---------------------------------------------------------------------------

create or replace function public.schedules_apply_roster_pattern(
    p_employee_ids uuid[],
    p_pattern jsonb,
    p_start_date date,
    p_end_date date,
    p_offset_days int default 0,
    p_overwrite boolean default true,
    p_apply_public_holidays boolean default true,
    p_continue_rotation boolean default true,
    p_weekdays_only boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_cycle text[];
    v_n int;
    v_holidays date[] := '{}'::date[];
    v_emp uuid;
    v_pos int;
    v_offset int;
    v_resumed int;
    v_weekday_index int;
    v_day date;
    v_weekend boolean;
    v_code text;
    v_leave_id uuid;
    v_leave_code text;
    v_month date;
    v_sched uuid;
    v_existing uuid;
    v_written int := 0;
    v_skipped int := 0;
    v_touched uuid[] := '{}'::uuid[];
    v_label text;
begin
    -- RosterPatternRequest's validation.
    if p_employee_ids is null or cardinality(p_employee_ids) = 0 then
        raise exception 'employee_ids: List should have at least 1 item after validation, not 0'
            using errcode = 'PT422';
    end if;
    if p_pattern is null or jsonb_typeof(p_pattern) <> 'array' or jsonb_array_length(p_pattern) = 0 then
        raise exception 'pattern: List should have at least 1 item after validation, not 0'
            using errcode = 'PT422';
    end if;
    if exists (
        select 1 from jsonb_array_elements(p_pattern) b
         where not coalesce(public.schedules_valid_code(b->>'shift_code'), false)
            or coalesce((b->>'days')::int, 0) not between 1 and 60
    ) then
        raise exception 'pattern: each block needs a shift code and 1 to 60 days' using errcode = 'PT422';
    end if;
    if p_start_date is null or p_end_date is null then
        raise exception 'start_date and end_date are required' using errcode = 'PT422';
    end if;
    if p_end_date < p_start_date then
        raise exception 'end_date must be on or after start_date' using errcode = 'PT422';
    end if;

    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;

    -- Flatten [{DS,4},{NS,4},{B,4}] into a 12-entry cycle.
    select array_agg(e.elem->>'shift_code' order by e.ord, g)
      into v_cycle
      from jsonb_array_elements(p_pattern) with ordinality as e(elem, ord)
     cross join lateral generate_series(1, (e.elem->>'days')::int) g;
    v_n := array_length(v_cycle, 1);

    perform public.ensure_month_schedules(p_start_date, p_end_date);

    -- A holiday replaces a code only for people who do not work them: the
    -- office-day staff. The rotating crew works through.
    if p_apply_public_holidays and p_weekdays_only then
        select coalesce(array_agg(h.date), '{}'::date[]) into v_holidays
          from public.public_holidays h
         where h.date between p_start_date and p_end_date and h.is_national;
    end if;

    for v_emp, v_pos in
        select t.id, (t.ord - 1)::int
          from unnest(p_employee_ids) with ordinality as t(id, ord)
         order by t.ord
    loop
        v_offset := v_pos * coalesce(p_offset_days, 0);
        -- Pick each person up where the roster left them, unless told otherwise.
        if p_continue_rotation and not p_weekdays_only then
            v_resumed := public.schedules_continuation_offset(v_emp, v_cycle, p_start_date);
            if v_resumed is not null then
                v_offset := v_resumed;
            end if;
        end if;

        v_weekday_index := 0;
        v_month := null;
        v_day := p_start_date;
        while v_day <= p_end_date loop
            if v_month is distinct from date_trunc('month', v_day)::date then
                v_month := date_trunc('month', v_day)::date;
                select s.id into v_sched
                  from public.work_schedules s
                 where date_trunc('month', s.start_date)::date = v_month
                 order by s.start_date, s.created_at
                 limit 1;
            end if;

            -- Saturday and Sunday are Break for office staff, not blank.
            v_weekend := extract(isodow from v_day) >= 6;
            if v_day = any(v_holidays) then
                v_code := 'PH';
            elsif p_weekdays_only then
                if v_weekend then
                    v_code := 'B';
                else
                    v_code := v_cycle[(v_weekday_index % v_n) + 1];
                    v_weekday_index := v_weekday_index + 1;
                end if;
            else
                v_code := v_cycle[((((v_day - p_start_date) + v_offset) % v_n) + v_n) % v_n + 1];
            end if;

            select a.id into v_existing
              from public.shift_assignments a
             where a.employee_id = v_emp and a.date = v_day
             order by (a.schedule_id = v_sched) desc
             limit 1;

            if v_existing is not null and not p_overwrite then
                v_skipped := v_skipped + 1;
            else
                -- Approved leave on the roster wins over a working day; the
                -- pattern's code is what cancelling it gives back.
                v_leave_id := null;
                if v_code in ('DS', 'NS', 'C', 'D', 'TW', 'T') then
                    select lr.id, public.leaves_roster_code(lr.leave_type)
                      into v_leave_id, v_leave_code
                      from public.leave_requests lr
                     where lr.employee_id = v_emp
                       and lr.status = 'approved'
                       and lr.on_roster
                       and v_day between lr.start_date and lr.end_date
                     order by lr.reviewed_at desc
                     limit 1;
                end if;
                if v_leave_id is not null then
                    insert into public.leave_roster_cells
                        (leave_request_id, employee_id, date, leave_code, previous_code)
                    values (v_leave_id, v_emp, v_day, v_leave_code, v_code)
                    on conflict (leave_request_id, date)
                        do update set previous_code = excluded.previous_code,
                                      leave_code = excluded.leave_code;
                    v_code := v_leave_code;
                end if;

                if v_existing is not null then
                    update public.shift_assignments
                       set shift_code = v_code, schedule_id = v_sched, updated_at = now()
                     where id = v_existing;
                else
                    insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
                    values (gen_random_uuid(), v_sched, v_emp, v_day, v_code);
                end if;
                v_written := v_written + 1;
                if not (v_sched = any(v_touched)) then
                    v_touched := v_touched || v_sched;
                end if;
            end if;

            v_day := v_day + 1;
        end loop;
    end loop;

    select string_agg(format('%sx %s', elem->>'days', elem->>'shift_code'), ' / ' order by ord)
      into v_label
      from jsonb_array_elements(p_pattern) with ordinality as x(elem, ord);

    perform public.log_activity(
        'SCHEDULE_PATTERN_APPLIED',
        format('Applied rotation [%s] to %s employee(s) from %s to %s (%s cells)',
               v_label, cardinality(p_employee_ids), p_start_date, p_end_date, v_written)
    );

    return jsonb_build_object(
        'schedules_touched', cardinality(v_touched),
        'cells_written', v_written,
        'cells_skipped', v_skipped
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The annual balance counts leave days, not calendar days.
-- ---------------------------------------------------------------------------

create or replace function public.leaves_annual_position(
    p_employee_id uuid,
    p_through date,
    p_period_start date default null
)
returns table (
    entitlement numeric,
    taken int,
    taken_in_period int,
    remaining numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with emp as (
        select coalesce(e.annual_leave_opening_balance, 0)::numeric
               + case when e.date_of_joining is null then 0
                      else public.accrued_annual_leave(e.date_of_joining, p_through) end as ent
          from public.employees e
         where e.id = p_employee_id
    ),
    days as (
        select a.date as d
          from public.shift_assignments a
         where a.employee_id = p_employee_id
           and a.shift_code = 'AL'
           and a.date <= p_through
        union
        select g::date
          from public.leave_requests lr,
               generate_series(lr.start_date, least(lr.end_date, p_through), interval '1 day') g
         where lr.employee_id = p_employee_id
           and lr.leave_type = 'annual'
           and lr.status = 'approved'
           and lr.start_date <= p_through
           and public.leaves_is_leave_day(p_employee_id, g::date)
    ),
    counted as (
        select count(*)::int as n,
               count(*) filter (where p_period_start is null
                                   or d between p_period_start and p_through)::int as n_period
          from days
    )
    select coalesce((select ent from emp), 0),
           counted.n,
           counted.n_period,
           round(coalesce((select ent from emp), 0) - counted.n, 4)
      from counted;
$$;

create or replace function public.schedules_leave_and_loading(
    p_employee_ids uuid[],
    p_start date,
    p_end date
)
returns table (
    employee_id uuid,
    balance numeric,
    taken_in_period int,
    ph_loading int,
    ph_loading_ytd int,
    ph_dates date[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with emp as (
        select e.id, e.date_of_joining,
               coalesce(e.annual_leave_opening_balance, 0)::numeric as opening
          from public.employees e
         where e.id = any(p_employee_ids)
    ),
    al_dates as (
        select a.employee_id, a.date as day
          from public.shift_assignments a
         where a.employee_id = any(p_employee_ids)
           and a.shift_code = 'AL'
           and a.date <= p_end
        union
        select lr.employee_id, d::date
          from public.leave_requests lr
         cross join lateral generate_series(lr.start_date, least(lr.end_date, p_end), interval '1 day') d
         where lr.employee_id = any(p_employee_ids)
           and lr.leave_type = 'annual'
           and lr.status = 'approved'
           and lr.start_date <= p_end
           and public.leaves_is_leave_day(lr.employee_id, d::date)
    ),
    al as (
        select d.employee_id,
               count(*)::int as taken_to_date,
               count(*) filter (where d.day between p_start and p_end)::int as taken_in_period
          from al_dates d
         group by d.employee_id
    ),
    loading as (
        select a.employee_id,
               count(*) filter (where a.date >= p_start)::int as n,
               count(*)::int as ytd,
               array_agg(a.date order by a.date) filter (where a.date >= p_start) as dates
          from public.shift_assignments a
          join public.public_holidays h on h.date = a.date and h.is_national
         where a.employee_id = any(p_employee_ids)
           and a.date between make_date(extract(year from p_end)::int, 1, 1) and p_end
           and a.shift_code in ('DS', 'NS', 'C', 'D')
         group by a.employee_id
    )
    select emp.id,
           round(emp.opening
                 + public.accrued_annual_leave(emp.date_of_joining, p_end)
                 - coalesce(al.taken_to_date, 0), 4),
           coalesce(al.taken_in_period, 0),
           coalesce(loading.n, 0),
           coalesce(loading.ytd, 0),
           coalesce(loading.dates, '{}'::date[])
      from emp
      left join al on al.employee_id = emp.id
      left join loading on loading.employee_id = emp.id;
$$;

-- ---------------------------------------------------------------------------
-- Grants. The new functions run only inside the security-definer ones.
-- ---------------------------------------------------------------------------
revoke all on function public.leaves_roster_code(text)               from public, anon, authenticated;
revoke all on function public.leaves_is_leave_day(uuid, date)        from public, anon, authenticated;
revoke all on function public.leaves_count_days(uuid, date, date)    from public, anon, authenticated;
revoke all on function public.leaves_apply_to_roster(uuid)           from public, anon, authenticated;
revoke all on function public.leaves_remove_from_roster(uuid)        from public, anon, authenticated;

commit;
