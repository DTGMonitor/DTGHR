-- ===========================================================================
-- Shift codes: what each code means, in the table.
--
-- 20261010000100 put each code's name and look in public.shift_codes; what a
-- code meant stayed in about a dozen lists inside the functions, and they had
-- drifted: TW and T were working days to leave but not to the roster's Total
-- days; ST counted as nothing; the week strip's labels were a third copy that
-- had no SP.
--
--   * shift_codes gains one column per rule:
--       is_working    DS NS C D TW T   worked; leave replaces it and is charged
--       is_leave      AL SL DL SP      leave; a request over it is charged
--       is_away       AL SL DL SP ST   away on the dashboard
--       is_field_day  DS NS            payroll shift days; back-up engineers
--       in_rotation   DS NS C D B      what the generator continues from
--       is_off        O B              an off day on the week strip
--     A code with none set counts as none of them.
--   * leave_type_codes maps each leave type to its code; every mapped code is
--     an away code. leaves_roster_code() reads it.
--   * The functions that kept lists read the columns instead. Each is copied
--     from its latest migration with only that change.
--   * overview_shift_label() reads shift_codes.label. NS is "Night shift"
--     everywhere -- the legend said "Night", the dashboard "Night shift".
--   * annual_leave_state(), called only by superseded definitions, is dropped.
--
-- Decided changes: TW and T count in Total days and PH loading; ST is away on
-- the dashboard; SP has its label. Everything else gives the same results.
-- AL (the annual balance), DS/NS (the dashboard's crews) and D/PH/B (the
-- holiday trigger and the generator) stay named on purpose.
--
-- Safe to re-run.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. What each code means.
-- ---------------------------------------------------------------------------

alter table public.shift_codes
    add column if not exists is_working   boolean not null default false,
    add column if not exists is_leave     boolean not null default false,
    add column if not exists is_away      boolean not null default false,
    add column if not exists is_field_day boolean not null default false,
    add column if not exists in_rotation  boolean not null default false,
    add column if not exists is_off       boolean not null default false;

update public.shift_codes c
   set is_working   = c.code in ('DS', 'NS', 'C', 'D', 'TW', 'T'),
       is_leave     = c.code in ('AL', 'SL', 'DL', 'SP'),
       is_away      = c.code in ('AL', 'SL', 'DL', 'SP', 'ST'),
       is_field_day = c.code in ('DS', 'NS'),
       in_rotation  = c.code in ('DS', 'NS', 'C', 'D', 'B'),
       is_off       = c.code in ('O', 'B'),
       updated_at   = now();

-- One label for NS, the dashboard's, now that the legend and the week strip
-- read the same row. Left alone if a later migration has renamed it.
update public.shift_codes set label = 'Night shift', updated_at = now()
 where code = 'NS' and label = 'Night';

-- ---------------------------------------------------------------------------
-- 2. Each leave type's code.
-- ---------------------------------------------------------------------------

create table if not exists public.leave_type_codes (
    leave_type text primary key,
    shift_code text not null references public.shift_codes (code)
);

insert into public.leave_type_codes (leave_type, shift_code) values
    ('annual', 'AL'),
    ('sick', 'SL'),
    ('study', 'ST'),
    ('maternity', 'SP'),
    ('paternity', 'SP'),
    ('miscarriage', 'SP'),
    ('menstrual', 'SP'),
    ('marriage', 'SP'),
    ('child_marriage', 'SP'),
    ('child_ceremony', 'SP'),
    ('bereavement', 'SP'),
    ('bereavement_household', 'SP')
on conflict (leave_type) do nothing;

alter table public.leave_type_codes enable row level security;
revoke all on public.leave_type_codes from anon, authenticated;
grant select on public.leave_type_codes to authenticated;
drop policy if exists leave_type_codes_select on public.leave_type_codes;
create policy leave_type_codes_select on public.leave_type_codes
    for select to authenticated using (true);

-- A leave goes on the roster as an away code, never as a working one.
do $$
declare
    v_bad text;
begin
    select string_agg(format('%s -> %s', m.leave_type, m.shift_code), ', ' order by m.leave_type)
      into v_bad
      from public.leave_type_codes m
      join public.shift_codes c on c.code = m.shift_code
     where not c.is_away;
    if v_bad is not null then
        raise exception 'leave_type_codes maps leave to codes that are not away codes: %', v_bad;
    end if;
end;
$$;

create or replace function public.leaves_roster_code(p_leave_type text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
    select coalesce((select m.shift_code from public.leave_type_codes m
                      where m.leave_type = p_leave_type), 'SP');
$$;

-- ---------------------------------------------------------------------------
-- 3. Labels, from the table.
-- ---------------------------------------------------------------------------

create or replace function public.overview_shift_label(p_code text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
    select c.label from public.shift_codes c where c.code = p_code;
$$;

-- ---------------------------------------------------------------------------
-- 4. The functions that kept lists, each as in its latest migration with the
--    list replaced by its column.
-- ---------------------------------------------------------------------------

-- leaves_is_leave_day
create or replace function public.leaves_is_leave_day(p_employee_id uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select case
             when c.shift_code is not null then
                  c.shift_code in (select code from public.shift_codes where is_working or is_leave)
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

-- leaves_apply_to_roster
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
           and a.shift_code in (select code from public.shift_codes where is_working)
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
           and shift_code in (select code from public.shift_codes where is_working);
    end loop;
end;
$$;

-- schedules_apply_roster_pattern
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
                if v_code in (select code from public.shift_codes where is_working) then
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

-- schedules_continuation_offset
create or replace function public.schedules_continuation_offset(
    p_employee_id uuid,
    p_cycle text[],
    p_anchor date
)
returns int
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_recent text[];
    v_last text;
    v_run int := 0;
    v_n int := coalesce(array_length(p_cycle, 1), 0);
    v_code text;
    v_behind int;
    i int;
    j int;
begin
    if v_n = 0 then
        return null;
    end if;

    -- Leave and holidays are stepped over, not counted.
    select array_agg(a.shift_code order by a.date desc) into v_recent
      from public.shift_assignments a
      join public.work_schedules s on s.id = a.schedule_id
     where a.employee_id = p_employee_id
       and a.date < p_anchor
       and a.date >= p_anchor - 60
       and s.status = 'published'
       and a.shift_code in (select code from public.shift_codes where in_rotation);
    if v_recent is null then
        return null;
    end if;

    v_last := v_recent[1];
    if not (v_last = any(p_cycle)) then
        return null;
    end if;
    foreach v_code in array v_recent loop
        exit when v_code <> v_last;
        v_run := v_run + 1;
    end loop;

    -- A place in the cycle where this code has exactly v_run days behind it.
    for i in 0 .. v_n - 1 loop
        continue when p_cycle[i + 1] <> v_last;
        v_behind := 0;
        j := i;
        while p_cycle[((j % v_n) + v_n) % v_n + 1] = v_last and v_behind < v_n loop
            v_behind := v_behind + 1;
            j := j - 1;
        end loop;
        if v_behind = v_run then
            return (i + 1) % v_n;
        end if;
    end loop;

    -- A part-finished block that cannot be placed: the start of its block.
    return array_position(p_cycle, v_last) - 1;
end;
$$;

-- get_schedule_detail
create or replace function public.get_schedule_detail(p_schedule_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_schedule public.work_schedules%rowtype;
    v_allowed uuid[];
    v_admin boolean := public.is_admin();
    v_me uuid;
    v_assignments jsonb;
    v_leaves jsonb;
    v_pending jsonb;
    v_holidays jsonb;
    v_working jsonb;
begin
    select * into v_schedule from public.work_schedules where id = p_schedule_id;
    if not found then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;
    -- A draft is a 404 to an employee, so its existence is not disclosed.
    if not v_admin and v_schedule.status <> 'published' then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;

    -- Office staff see the office-day rows, the crew the roster; administrators
    -- see both, and the back-up engineer too -- in a month she works the roster.
    v_allowed := public.schedules_visible_employee_ids_for(p_schedule_id);

    drop table if exists _visible_cells;
    create temporary table _visible_cells on commit drop as
    select a.*
      from public.shift_assignments a
     where a.schedule_id = p_schedule_id
       and (v_allowed is null or a.employee_id = any(v_allowed));

    select coalesce(jsonb_agg(
               jsonb_build_object(
                   'id', a.id,
                   'schedule_id', a.schedule_id,
                   'employee_id', a.employee_id,
                   'employee_name', e.first_name || ' ' || e.last_name,
                   'date', a.date,
                   'shift_code', a.shift_code,
                   'start_time', a.start_time,
                   'end_time', a.end_time
               ) order by e.first_name, e.last_name, a.date
           ), '[]'::jsonb)
      into v_assignments
      from _visible_cells a
      left join public.employees e on e.id = a.employee_id;

    select coalesce(jsonb_agg(
               jsonb_build_object(
                   'employee_id', lr.employee_id,
                   'leave_type', lr.leave_type,
                   'start_date', lr.start_date,
                   'end_date', lr.end_date
               ) order by lr.start_date
           ), '[]'::jsonb)
      into v_leaves
      from public.leave_requests lr
     where lr.status = 'approved'
       and lr.start_date <= v_schedule.end_date
       and lr.end_date >= v_schedule.start_date
       and (v_allowed is null or lr.employee_id = any(v_allowed));

    -- Open proposals only; PARTIALLY_APPROVED has nothing left waiting.
    if v_admin then
        v_pending := public.change_requests_json(
            public.visible_change_request_ids('pending', p_schedule_id));
    else
        v_me := public.schedules_employee_for_user(false);
        if v_me is null then
            v_pending := '[]'::jsonb;
        else
            v_pending := public.change_requests_json(array(
                select r.id
                  from public.shift_change_requests r
                 where r.schedule_id = p_schedule_id
                   and r.status = 'pending'
                   and exists (select 1 from public.shift_change_items i
                                where i.request_id = r.id and i.employee_id = v_me)
            ));
        end if;
    end if;

    select coalesce(jsonb_agg(
               jsonb_build_object('id', h.id, 'date', h.date, 'name', h.name,
                                  'is_national', h.is_national)
               order by h.date
           ), '[]'::jsonb)
      into v_holidays
      from public.public_holidays h
     where h.date between v_schedule.start_date and v_schedule.end_date;

    with codes as (
        select a.employee_id, a.shift_code as code, count(*)::int as n
          from _visible_cells a
         group by a.employee_id, a.shift_code
    ),
    per_employee as (
        select c.employee_id,
               coalesce(sum(c.n) filter (where c.code in (select code from public.shift_codes where is_working)), 0)::int as working_days,
               jsonb_object_agg(c.code, c.n order by c.code) as by_code
          from codes c
         group by c.employee_id
    ),
    extras as (
        select * from public.schedules_leave_and_loading(
            (select array_agg(employee_id) from per_employee),
            v_schedule.start_date,
            v_schedule.end_date
        )
    )
    select coalesce(jsonb_agg(
               jsonb_build_object(
                   'employee_id', p.employee_id,
                   'employee_name', e.first_name || ' ' || e.last_name,
                   'working_days', p.working_days,
                   'by_code', p.by_code,
                   'annual_leave_days', coalesce(x.balance, 0),
                   'annual_leave_taken', coalesce(x.taken_in_period, 0),
                   'public_holiday_loading', coalesce(x.ph_loading, 0),
                   'public_holiday_loading_ytd', coalesce(x.ph_loading_ytd, 0),
                   'public_holiday_dates', to_jsonb(coalesce(x.ph_dates, '{}'::date[])),
                   'work_pattern', e.work_pattern::text
               ) order by coalesce(e.first_name || ' ' || e.last_name, '')
           ), '[]'::jsonb)
      into v_working
      from per_employee p
      left join public.employees e on e.id = p.employee_id
      left join extras x on x.employee_id = p.employee_id;

    return jsonb_build_object(
        'id', v_schedule.id,
        'name', v_schedule.name,
        'start_date', v_schedule.start_date,
        'end_date', v_schedule.end_date,
        'status', v_schedule.status,
        'created_at', v_schedule.created_at,
        'updated_at', v_schedule.updated_at,
        'assignments', v_assignments,
        'leaves', v_leaves,
        'pending_changes', v_pending,
        'holidays', v_holidays,
        'working_days', v_working
    );
end;
$$;

-- schedules_leave_and_loading
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
           and a.shift_code in (select code from public.shift_codes where is_working)
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

-- payroll_roster_shift_days
create or replace function public.payroll_roster_shift_days(p_employee_id uuid, p_year int, p_month int)
returns int
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    first_day date := make_date(p_year, p_month, 1);
    last_day date := make_date(p_year, p_month, public.payroll_days_in_month(p_year, p_month));
begin
    if not exists (
        select 1 from public.shift_assignments sa
          join public.work_schedules ws on ws.id = sa.schedule_id
         where ws.status::text = 'published' and sa.date between first_day and last_day
    ) then
        return null;
    end if;
    return (
        select count(*)::int from public.shift_assignments sa
          join public.work_schedules ws on ws.id = sa.schedule_id
         where ws.status::text = 'published'
           and sa.employee_id = p_employee_id
           and sa.date between first_day and last_day
           and sa.shift_code in (select code from public.shift_codes where is_field_day));
end;
$$;

-- schedules_visible_employee_ids_for
create or replace function public.schedules_visible_employee_ids_for(p_schedule_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_viewer public.employees%rowtype;
    v_patterns text[];
    v_ids uuid[];
begin
    if public.is_admin() then
        return null;
    end if;

    select * into v_viewer from public.employees where user_id = auth.uid() limit 1;
    if not found then
        return '{}'::uuid[];
    end if;

    v_patterns := array[v_viewer.work_pattern::text];
    if v_viewer.is_backup_engineer and exists (
            select 1 from public.shift_assignments a
             where a.schedule_id = p_schedule_id
               and a.employee_id = v_viewer.id
               and a.shift_code in (select code from public.shift_codes where is_field_day)) then
        -- Covering the roster this month means needing to read it.
        v_patterns := v_patterns || 'roster'::text;
    end if;
    if public.current_user_role()::text = 'finance' then
        -- Both schedules: payroll is priced off shift days. Read-only still.
        v_patterns := array['office_day', 'roster'];
    end if;

    select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids
      from public.employees e
     where e.work_pattern::text = any(v_patterns)
       and e.is_active;

    if not (v_viewer.id = any(v_ids)) then
        v_ids := v_ids || v_viewer.id;
    end if;
    return v_ids;
end;
$$;

-- overview_at
create or replace function public.overview_at(p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid uuid := auth.uid();
    v_user public.users%rowtype;
    v_role text;
    v_emp public.employees%rowtype;
    v_has_emp boolean;
    v_is_management boolean;
    v_week_end date := p_today + 6;
    v_month_end date := (date_trunc('month', p_today) + interval '1 month - 1 day')::date;
    v_week jsonb := '[]'::jsonb;
    v_holidays jsonb;
    v_next_holiday jsonb;
    v_leave jsonb := null;
    v_pos record;
    v_booked record;
    v_pending_mine int := 0;
    v_tickets_open int := null;
    v_my_tickets_open int := 0;
    v_finance_sent_back jsonb := null;
    v_payroll_desk jsonb := null;
    v_this_run text;
    v_days_left int;
    v_pending_approvals int := null;
    v_approvals jsonb := null;
    v_on_leave_today int := null;
    v_headcount int := null;
    v_salary_awaiting int := null;
    v_payroll_awaiting jsonb := null;
    v_kpi_awaiting int := null;
    v_on_duty jsonb := null;
    v_salary_states text[];
    v_payroll_states text[];
    v_away text[];
    v_finance_state text;
begin
    perform public.people_require_user();

    select * into v_user from public.users where id = v_uid;
    v_role := v_user.role::text;
    select * into v_emp from public.employees where user_id = v_uid limit 1;
    v_has_emp := found;

    v_is_management := coalesce(v_user.is_superuser, false)
        or v_role in ('director', 'executive')
        or (v_has_emp and coalesce(v_emp.is_management_role, false));

    -- ── The next seven days: published schedules only ──────────────────
    if v_has_emp then
        select jsonb_agg(jsonb_build_object(
                   'date', d::date,
                   'code', sa.code,
                   'label', public.overview_shift_label(sa.code),
                   'holiday', (select h.name from public.public_holidays h
                                where h.date = d::date and h.is_national limit 1),
                   'is_today', d::date = p_today)
               order by d)
          into v_week
          from generate_series(p_today, v_week_end, interval '1 day') d
          left join lateral (
              select max(a.shift_code)::text as code
                from public.shift_assignments a
                join public.work_schedules ws on ws.id = a.schedule_id
               where a.employee_id = v_emp.id
                 and a.date = d::date
                 and ws.status = 'published'
          ) sa on true;
    end if;

    -- ── Public holidays left this month, and the next of any month ─────
    select coalesce(jsonb_agg(jsonb_build_object(
               'date', h.date, 'name', h.name, 'is_national', coalesce(h.is_national, false))
             order by h.date), '[]'::jsonb)
      into v_holidays
      from public.public_holidays h
     where h.date between p_today and v_month_end
       and h.is_national;

    select jsonb_build_object('date', h.date, 'name', h.name)
      into v_next_holiday
      from public.public_holidays h
     where h.date >= p_today
       and h.is_national
     order by h.date
     limit 1;

    -- ── Leave balance: the Leave page's computed position ──────────────
    if v_has_emp then
        -- Founders (management, exempt from review) carry no balance.
        if not public.leaves_is_founder(v_emp.id) then
            select * into v_pos
              from public.leaves_annual_position(v_emp.id, make_date(extract(year from p_today)::int, 12, 31));
            if found then
                v_leave := jsonb_build_object(
                    'total', round(v_pos.entitlement, 2),
                    'used', v_pos.taken::double precision,
                    'remaining', round(v_pos.remaining, 2));
            end if;
        end if;

        select count(*)::int into v_pending_mine
          from public.leave_requests
         where employee_id = v_emp.id and status = 'pending';

        select lr.start_date, lr.end_date into v_booked
          from public.leave_requests lr
         where lr.employee_id = v_emp.id
           and lr.status = 'approved'
           and lr.end_date >= p_today
         order by lr.start_date
         limit 1;
        if found and v_leave is not null then
            v_leave := v_leave || jsonb_build_object(
                'next_from', v_booked.start_date, 'next_to', v_booked.end_date);
        end if;
    end if;

    -- ── IT support's queue, and everybody's own open tickets ───────────
    if v_has_emp and public.tickets_works_queue(v_emp.id) then
        select count(*)::int into v_tickets_open
          from public.support_tickets
         where status in ('open', 'in_progress', 'waiting');
    end if;
    if v_has_emp then
        select count(*)::int into v_my_tickets_open
          from public.support_tickets
         where reporter_id = v_emp.id
           and status in ('open', 'in_progress', 'waiting');
    end if;

    -- ── Finance's desk ─────────────────────────────────────────────────
    if v_role = 'finance' then
        select coalesce(jsonb_agg(jsonb_build_object(
                   'reference', r.reference, 'title', r.title, 'note', r.revision_note)
                 order by r.created_at), '[]'::jsonb)
          into v_finance_sent_back
          from public.finance_requests r
         where r.status = 'changes_requested';

        select pm.status into v_this_run
          from public.payroll_months pm
         where pm.year = extract(year from p_today)::int
           and pm.month = extract(month from p_today)::int;

        v_days_left := extract(day from v_month_end)::int - extract(day from p_today)::int;

        v_payroll_desk := jsonb_build_object(
            'sent_back', coalesce((
                select jsonb_agg(jsonb_build_object(
                           'label', public.payroll_label(pm.year, pm.month),
                           'note', pm.revision_note)
                       order by pm.year, pm.month)
                  from public.payroll_months pm
                 where pm.status = 'changes_requested'), '[]'::jsonb),
            'this_month', public.payroll_label(extract(year from p_today)::int,
                                               extract(month from p_today)::int),
            'this_month_status', v_this_run,
            'days_left', v_days_left,
            -- A week's warning, and only while the run can still be typed into.
            'due_soon', v_days_left <= 7 and v_this_run is not null
                        and v_this_run in ('draft', 'changes_requested'),
            'not_started', v_this_run is null and v_days_left <= 7,
            -- Approved months whose payslips still carry an estimated PPh 21.
            'tax_actuals_due', public.payroll_tax_reminders(p_today));
    end if;

    -- ── Waiting on management ──────────────────────────────────────────
    if v_is_management then
        -- Not their own: nobody approves their own leave.
        select count(*)::int into v_pending_approvals
          from public.leave_requests lr
         where lr.status = 'pending'
           and (not v_has_emp or lr.employee_id <> v_emp.id);

        -- Staff, not people: the founders are not headcount.
        select count(*)::int into v_headcount
          from public.employees e
         where e.is_active
           and not (e.is_management_role and not e.kpi_review_required);

        -- Who is covering the site today, and who is away -- from approved
        -- requests and from away cells (shift_codes.is_away) on the published roster.
        select coalesce(array_agg(name order by name collate "C"), '{}'::text[])
          into v_away
          from (
              select e.first_name as name
                from public.leave_requests lr
                join public.employees e on e.id = lr.employee_id
               where lr.status = 'approved'
                 and lr.start_date <= p_today
                 and lr.end_date >= p_today
              union
              select e.first_name
                from public.shift_assignments a
                join public.employees e on e.id = a.employee_id
                join public.work_schedules ws on ws.id = a.schedule_id
               where a.date = p_today
                 and ws.status = 'published'
                 and a.shift_code in (select code from public.shift_codes where is_away)
          ) away;

        v_on_duty := jsonb_build_object(
            'dayshift', coalesce((
                select jsonb_agg(e.first_name order by e.first_name collate "C")
                  from public.shift_assignments a
                  join public.employees e on e.id = a.employee_id
                  join public.work_schedules ws on ws.id = a.schedule_id
                 where a.date = p_today and ws.status = 'published' and a.shift_code = 'DS'),
                '[]'::jsonb),
            'nightshift', coalesce((
                select jsonb_agg(e.first_name order by e.first_name collate "C")
                  from public.shift_assignments a
                  join public.employees e on e.id = a.employee_id
                  join public.work_schedules ws on ws.id = a.schedule_id
                 where a.date = p_today and ws.status = 'published' and a.shift_code = 'NS'),
                '[]'::jsonb),
            'on_leave', to_jsonb(v_away));
        v_on_leave_today := coalesce(array_length(v_away, 1), 0);

        -- Salary reviews on this person's signature; null when the role is
        -- not in the chain at all.
        v_salary_states := public.overview_salary_states(v_role);
        if cardinality(v_salary_states) > 0 then
            select count(*)::int into v_salary_awaiting
              from public.salary_reviews sr
             where sr.status = any (v_salary_states)
               and (not v_has_emp or sr.employee_id <> v_emp.id);
        end if;

        -- The payroll run on this person's signature.
        v_payroll_states := public.overview_payroll_states(v_role);
        if cardinality(v_payroll_states) > 0 then
            select jsonb_build_object(
                       'count', count(*)::int,
                       'label', (array_agg(public.payroll_label(pm.year, pm.month)
                                           order by pm.year, pm.month))[1])
              into v_payroll_awaiting
              from public.payroll_months pm
             where pm.status = any (v_payroll_states);
        end if;

        -- Scorecards waiting on this person's signature.
        if v_has_emp then
            select count(*)::int into v_kpi_awaiting
              from public.kpi_reviews k
             where k.approver_id = v_emp.user_id and k.status = 'submitted';
        else
            v_kpi_awaiting := 0;
        end if;

        -- The same queues by name, for the sentence at the top.
        v_finance_state := case when v_role = 'executive' then 'submitted'
                                when v_role = 'director' and public.finance_director_final_approval()
                                     then 'submitted' end;
        v_approvals := jsonb_build_object(
            'leave', coalesce((
                select jsonb_agg(jsonb_build_object(
                           'name', e.first_name,
                           'leave_type', lr.leave_type,
                           'start', lr.start_date,
                           'end', lr.end_date,
                           'days', lr.days_requested)
                       order by lr.start_date)
                  from public.leave_requests lr
                  join public.employees e on e.id = lr.employee_id
                 where lr.status = 'pending'
                   and (not v_has_emp or lr.employee_id <> v_emp.id)), '[]'::jsonb),
            'payroll', coalesce((
                select jsonb_agg(jsonb_build_object(
                           'label', public.payroll_label(pm.year, pm.month),
                           'submitted_by', sub.full_name,
                           -- Set when the executive sent it back to the director's review.
                           'sent_back_note', pm.revision_note,
                           'sent_back_by', case when pm.revision_note is not null then ret.full_name end)
                       order by pm.year, pm.month)
                  from public.payroll_months pm
                  left join public.users sub on sub.id = pm.submitted_by_id
                  left join public.users ret on ret.id = pm.revision_by_id
                 where pm.status = any (v_payroll_states)), '[]'::jsonb),
            'salary', coalesce((
                select jsonb_agg(jsonb_build_object('name', e.first_name))
                  from public.salary_reviews sr
                  join public.employees e on e.id = sr.employee_id
                 where sr.status = any (v_salary_states)
                   and (not v_has_emp or sr.employee_id <> v_emp.id)), '[]'::jsonb),
            'kpi', case when v_has_emp then coalesce((
                select jsonb_agg(jsonb_build_object('name', e.first_name, 'period', k.period_label))
                  from public.kpi_reviews k
                  join public.employees e on e.id = k.employee_id
                 where k.approver_id = v_emp.user_id and k.status = 'submitted'), '[]'::jsonb)
                else '[]'::jsonb end,
            'finance', coalesce((
                select jsonb_agg(jsonb_build_object(
                           'reference', r.reference,
                           'title', r.title,
                           'total', public.finance_total(r.id),
                           'requested_by', req.full_name,
                           'sent_back_note', r.revision_note,
                           'sent_back_by', case when r.revision_note is not null then ret.full_name end)
                       order by r.created_at)
                  from public.finance_requests r
                  left join public.users req on req.id = r.requested_by_id
                  left join public.users ret on ret.id = r.revision_by_id
                 where v_finance_state is not null and r.status in (v_finance_state, case when v_finance_state = 'submitted' then 'endorsed' end)), '[]'::jsonb));
    end if;

    return jsonb_build_object(
        'is_management', v_is_management,
        'has_employee_record', v_has_emp,
        'week', coalesce(v_week, '[]'::jsonb),
        'holidays', v_holidays,
        'leave', v_leave,
        'pending_mine', v_pending_mine,
        'pending_approvals', v_pending_approvals,
        'on_leave_today', v_on_leave_today,
        'headcount', v_headcount,
        'salary_awaiting', v_salary_awaiting,
        'payroll_awaiting', v_payroll_awaiting,
        'payroll_desk', v_payroll_desk,
        'finance_sent_back', v_finance_sent_back,
        'tickets_open', v_tickets_open,
        'my_tickets_open', v_my_tickets_open,
        'kpi_awaiting', v_kpi_awaiting,
        'approvals', v_approvals,
        'on_duty', v_on_duty,
        'next_holiday', v_next_holiday);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Unused: only definitions since replaced ever called it.
-- ---------------------------------------------------------------------------
drop function if exists public.annual_leave_state(uuid[], date, date);

commit;
