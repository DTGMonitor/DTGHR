-- ===========================================================================
-- Schedules (the roster), ported from the FastAPI line.
--
-- Spec: app/api/routes/schedules.py, app/services/schedule_service.py,
-- app/services/visibility.py, app/services/annual_leave.py (the AL dates).
--
-- Lintang's 20260916000600 / 20260919000100 already answer most of the roster.
-- Where the FastAPI line has since changed the rule, the function is replaced
-- here under the same name and signature, so there is still one rule:
--
--   * get_schedule_detail   -- rows scoped by work pattern (office-day staff vs
--                              the rotating crew; the back-up engineer and
--                              finance see both; former staff only to an
--                              administrator); totals carry work_pattern; the
--                              annual-leave figure counts approved annual
--                              requests as well as AL cells, each date once.
--   * visible_change_request_ids / list_change_requests
--                           -- "yours" means a cell on your row, not authorship;
--                              an unlinked account is told so (403).
--   * propose_shift_changes -- the FastAPI order of checks and its messages;
--                              the AL cap reads the same union as the totals;
--                              an unclaimed roster row is adopted by email.
--   * review_shift_change   -- messages word for word; approve+reject clash 422.
--   * create_schedule, set_schedule_cell, save_schedule_assignments
--                           -- request validation (422) the pydantic models did.
--   * apply_roster_pattern  -- now a thin wrapper over
--                              schedules_apply_roster_pattern, which carries the
--                              FastAPI generator: PH only in office-day
--                              (weekdays_only) mode, weekends B, and each person
--                              resumed on the leg the published roster left
--                              them on.
--
-- New: schedules_list, schedules_list_employees (names for the grid, founders
-- excluded), the holiday-calendar CRUD, and the visibility helpers. RLS on
-- shift_assignments now applies the same visibility rule.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Small helpers
-- ---------------------------------------------------------------------------

-- The shift codes of the workbook legend (app.models.enums.ShiftCode).
create or replace function public.schedules_valid_code(p_code text)
returns boolean
language sql
immutable
as $$
    select p_code in ('DS','NS','C','B','D','O','AL','SL','DL','PH','TW','ST','T');
$$;

-- Python's repr() of a sorted list of strings: ['2026-09-02', '2026-09-03'].
-- The FastAPI details interpolate lists that way, and the screens show them.
create or replace function public.schedules_pylist(p_items text[])
returns text
language sql
immutable
as $$
    select '[' || coalesce(
        (select string_agg('''' || x || '''', ', ' order by x) from unnest(p_items) x), ''
    ) || ']';
$$;

-- Python's f"{x:g}": six significant digits, trailing zeros dropped.
create or replace function public.schedules_fmt_g(p_value numeric)
returns text
language plpgsql
immutable
as $$
declare
    v numeric := coalesce(p_value, 0);
    v_txt text;
begin
    if v = 0 then
        return '0';
    end if;
    v := round(v, greatest(0, 5 - floor(log(abs(v)))::int));
    v_txt := v::text;
    if position('.' in v_txt) > 0 then
        v_txt := rtrim(rtrim(v_txt, '0'), '.');
    end if;
    return v_txt;
end;
$$;

-- '07 September 2026' -- Python's %d %B %Y.
create or replace function public.schedules_long_date(p_day date)
returns text
language sql
immutable
as $$
    select to_char(p_day, 'DD FMMonth YYYY');
$$;

-- ---------------------------------------------------------------------------
-- 1. Visibility (app/services/visibility.py)
-- ---------------------------------------------------------------------------

-- Employee ids whose schedule rows the caller may see. NULL means
-- unrestricted (an administrator); an empty array means nothing at all, which
-- is what a signed-in user with no employee record gets.
create or replace function public.schedules_visible_employee_ids()
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
    if v_viewer.is_backup_engineer then
        -- Covering the roster means needing to read it.
        v_patterns := v_patterns || 'roster'::text;
    end if;
    if public.current_user_role()::text = 'finance' then
        -- Both schedules: payroll is priced off shift days. Read-only still.
        v_patterns := array['office_day', 'roster'];
    end if;

    select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids
      from public.employees e
     where e.work_pattern::text = any(v_patterns)
       -- Former staff are an administrator's concern only.
       and e.is_active;

    -- A deactivated employee still sees their own row if they keep a login.
    if not (v_viewer.id = any(v_ids)) then
        v_ids := v_ids || v_viewer.id;
    end if;
    return v_ids;
end;
$$;

create or replace function public.schedules_can_see_employee(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_ids uuid[] := public.schedules_visible_employee_ids();
begin
    return v_ids is null or p_employee_id = any(v_ids);
end;
$$;

-- Whether this person belongs on the schedule at all. The founders -- the
-- management role *and* exempt from review -- work no shifts.
create or replace function public.schedules_carries_a_roster(p_employee public.employees)
returns boolean
language sql
stable
as $$
    select not (coalesce(p_employee.is_management_role, false)
                and not coalesce(p_employee.kpi_review_required, true));
$$;

-- The caller's roster row. Rows imported from the workbook start with no
-- user_id; the first time their owner turns up, an unclaimed row whose email
-- matches is linked to the account (routes/schedules.py _employee_for_user).
create or replace function public.schedules_employee_for_user(p_required boolean default true)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
    v_email text;
begin
    select id into v_id from public.employees where user_id = auth.uid() limit 1;

    if v_id is null and auth.uid() is not null then
        select email into v_email from public.users where id = auth.uid();
        select e.id into v_id
          from public.employees e
         where e.user_id is null
           and lower(e.email) = lower(v_email)
         order by e.created_at
         limit 1;
        if v_id is not null then
            update public.employees set user_id = auth.uid(), updated_at = now() where id = v_id;
        end if;
    end if;

    if v_id is null and p_required then
        raise exception 'No employee profile linked to this user account' using errcode = 'PT403';
    end if;
    return v_id;
end;
$$;

-- RLS: a plain read of the roster table obeys the same rule as the RPCs.
drop policy if exists shift_assignments_select on public.shift_assignments;
create policy shift_assignments_select on public.shift_assignments
    for select to authenticated
    using (public.schedule_is_visible(schedule_id)
           and public.schedules_can_see_employee(employee_id));

-- ---------------------------------------------------------------------------
-- 2. GET /schedules/employees -- names for the grid, nothing more.
-- ---------------------------------------------------------------------------
create or replace function public.schedules_list_employees()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_ids uuid[] := public.schedules_visible_employee_ids();
begin
    return coalesce((
        select jsonb_agg(
                   jsonb_build_object(
                       'id', e.id,
                       'employee_id', e.employee_id,
                       'first_name', e.first_name,
                       'last_name', e.last_name,
                       'position', e.position,
                       'work_pattern', e.work_pattern::text,
                       'is_backup_engineer', coalesce(e.is_backup_engineer, false)
                   ) order by e.employee_id)
          from public.employees e
         where e.is_active
           and (v_ids is null or e.id = any(v_ids))
           and public.schedules_carries_a_roster(e)
    ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. GET /schedules -- paginated periods; employees see only published.
-- ---------------------------------------------------------------------------
create or replace function public.schedules_list(p_page int default 1, p_page_size int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_admin boolean := public.is_admin();
    v_total int;
    v_items jsonb;
begin
    if p_page is null or p_page < 1 then
        raise exception 'page: Input should be greater than or equal to 1' using errcode = 'PT422';
    end if;
    if p_page_size is null or p_page_size < 1 or p_page_size > 100 then
        raise exception 'page_size: Input should be between 1 and 100' using errcode = 'PT422';
    end if;

    select count(*)::int into v_total
      from public.work_schedules s
     where v_admin or s.status = 'published';

    select coalesce(jsonb_agg(public.schedule_json(x.id) order by x.start_date desc, x.id), '[]'::jsonb)
      into v_items
      from (
        select s.id, s.start_date
          from public.work_schedules s
         where v_admin or s.status = 'published'
         order by s.start_date desc, s.id
        offset (p_page - 1) * p_page_size
         limit p_page_size
      ) x;

    return jsonb_build_object(
        'items', v_items, 'total', v_total, 'page', p_page, 'page_size', p_page_size
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Annual leave and holiday loading, as leave_and_loading() computes them.
--
-- A day of annual leave is a *date*: an AL cell on the roster and an approved
-- annual request covering the same day are one day (annual_leave.py).
-- ---------------------------------------------------------------------------
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
-- 5. Proposals: who sees which
-- ---------------------------------------------------------------------------

-- Superusers see everyone's; everyone else the proposals with a cell on their
-- own row. Authorship alone does not make a proposal yours.
create or replace function public.visible_change_request_ids(
    p_status text default null,
    p_schedule_id uuid default null
)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(array_agg(r.id), '{}'::uuid[])
      from public.shift_change_requests r
     where (p_status is null or r.status = p_status)
       and (p_schedule_id is null or r.schedule_id = p_schedule_id)
       and (
           public.is_admin()
           or exists (
               select 1 from public.shift_change_items i
                where i.request_id = r.id
                  and i.employee_id = public.current_employee_id()
           )
       );
$$;

-- Items in date order, as the relationship's order_by has them.
create or replace function public.change_requests_json(p_ids uuid[])
returns jsonb
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'id', r.id,
                'schedule_id', r.schedule_id,
                'status', r.status,
                'reason', r.reason,
                'review_note', r.review_note,
                'requested_by_id', r.requested_by_id,
                'requested_by_name', ru.full_name,
                'reviewed_by_id', r.reviewed_by_id,
                'reviewed_by_name', vu.full_name,
                'reviewed_at', r.reviewed_at,
                'created_at', r.created_at,
                'items', coalesce(items.arr, '[]'::jsonb)
            )
            order by r.created_at desc
        ),
        '[]'::jsonb
    )
    from public.shift_change_requests r
    left join public.users ru on ru.id = r.requested_by_id
    left join public.users vu on vu.id = r.reviewed_by_id
    left join lateral (
        select jsonb_agg(
                   jsonb_build_object(
                       'id', i.id,
                       'employee_id', i.employee_id,
                       'employee_name', e.first_name || ' ' || e.last_name,
                       'date', i.date,
                       'current_code', i.current_code,
                       'requested_code', i.requested_code,
                       'status', i.status
                   )
                   order by i.date, e.first_name, e.last_name
               ) as arr
          from public.shift_change_items i
          left join public.employees e on e.id = i.employee_id
         where i.request_id = r.id
    ) items on true
    where r.id = any(p_ids);
$$;

-- GET /schedules/change-requests
create or replace function public.list_change_requests(
    p_status text default null,
    p_schedule_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
    if p_status is not null
       and p_status not in ('pending','approved','rejected','partially_approved','cancelled') then
        raise exception 'status: Input should be ''pending'', ''approved'', ''rejected'', ''partially_approved'' or ''cancelled'''
            using errcode = 'PT422';
    end if;
    if not public.is_admin() then
        perform public.schedules_employee_for_user(true);
    end if;
    return public.change_requests_json(public.visible_change_request_ids(p_status, p_schedule_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. GET /schedules/{id}
-- ---------------------------------------------------------------------------
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
    -- and the back-up engineer see both.
    v_allowed := public.schedules_visible_employee_ids();

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
               coalesce(sum(c.n) filter (where c.code in ('DS', 'NS', 'C', 'D')), 0)::int as working_days,
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

-- ---------------------------------------------------------------------------
-- 7. Writes by an administrator: create, one cell, bulk save
-- ---------------------------------------------------------------------------
create or replace function public.create_schedule(
    p_name text,
    p_start_date date,
    p_end_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid := gen_random_uuid();
begin
    -- The request model validated before the handler ran.
    if p_name is null or p_start_date is null or p_end_date is null then
        raise exception 'name, start_date and end_date are required' using errcode = 'PT422';
    end if;
    if p_end_date < p_start_date then
        raise exception 'end_date must be on or after start_date' using errcode = 'PT422';
    end if;
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;

    insert into public.work_schedules (id, name, start_date, end_date, status)
    values (v_id, p_name, p_start_date, p_end_date, 'draft');

    perform public.log_activity(
        'SCHEDULE_CREATED',
        format('Created schedule ''%s'' (%s to %s)', p_name, p_start_date, p_end_date),
        v_id
    );
    return public.schedule_json(v_id);
end;
$$;

create or replace function public.set_schedule_cell(
    p_schedule_id uuid,
    p_employee_id uuid,
    p_date date,
    p_shift_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_schedule public.work_schedules%rowtype;
    v_code text := nullif(p_shift_code, '');
    v_assignment_id uuid;
begin
    if v_code is not null and not public.schedules_valid_code(v_code) then
        raise exception 'shift_code: ''%'' is not a shift code', v_code using errcode = 'PT422';
    end if;
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;

    select * into v_schedule from public.work_schedules where id = p_schedule_id;
    if not found then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;
    if p_date < v_schedule.start_date or p_date > v_schedule.end_date then
        raise exception 'Date falls outside this schedule period' using errcode = 'P0001';
    end if;

    v_assignment_id := public.write_schedule_cell(p_schedule_id, p_employee_id, p_date, v_code);

    perform public.log_activity(
        'SCHEDULE_CELL_UPDATED',
        format('Set %s to %s in ''%s''', p_date, coalesce(v_code, '(empty)'), v_schedule.name),
        p_schedule_id
    );

    if v_assignment_id is null then
        return null;
    end if;
    return (
        select jsonb_build_object(
            'id', a.id, 'schedule_id', a.schedule_id, 'employee_id', a.employee_id,
            'employee_name', e.first_name || ' ' || e.last_name,
            'date', a.date, 'shift_code', a.shift_code,
            'start_time', a.start_time, 'end_time', a.end_time
        )
        from public.shift_assignments a
        left join public.employees e on e.id = a.employee_id
        where a.id = v_assignment_id
    );
end;
$$;

create or replace function public.save_schedule_assignments(
    p_schedule_id uuid,
    p_assignments jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_schedule public.work_schedules%rowtype;
    v_count int;
    v_bad text;
begin
    select string_agg(distinct coalesce(item->>'shift_code', 'null'), ', ') into v_bad
      from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) item
     where not coalesce(public.schedules_valid_code(item->>'shift_code'), false);
    if v_bad is not null then
        raise exception 'shift_code: not a shift code: %', v_bad using errcode = 'PT422';
    end if;
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;

    select * into v_schedule from public.work_schedules where id = p_schedule_id;
    if not found then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;
    if v_schedule.status <> 'draft' then
        raise exception 'Cannot edit assignments on a published schedule' using errcode = 'P0001';
    end if;

    delete from public.shift_assignments where schedule_id = p_schedule_id;

    insert into public.shift_assignments
        (id, schedule_id, employee_id, date, shift_code, start_time, end_time)
    select gen_random_uuid(), p_schedule_id,
           (item->>'employee_id')::uuid, (item->>'date')::date, item->>'shift_code',
           nullif(item->>'start_time', '')::time, nullif(item->>'end_time', '')::time
      from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) as item;
    get diagnostics v_count = row_count;

    perform public.log_activity(
        'SCHEDULE_UPDATED',
        format('Updated %s shift assignments for ''%s''', v_count, v_schedule.name),
        p_schedule_id
    );
    return public.get_schedule_detail(p_schedule_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. POST /schedules/{id}/change-requests
-- ---------------------------------------------------------------------------
create or replace function public.propose_shift_changes(
    p_schedule_id uuid,
    p_items jsonb,
    p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_schedule public.work_schedules%rowtype;
    v_is_admin boolean := public.is_admin();
    v_employee_id uuid;
    v_request_id uuid := gen_random_uuid();
    v_item_count int;
    v_no_ops int;
    v_bad text;
    v_list text[];
    v_short record;
    v_summary text;
begin
    -- The request model (ShiftChangeCreate) first: 1..200 items, each code a
    -- real one, no day twice, a reason of at most 500 characters.
    drop table if exists _proposed;
    create temporary table _proposed (
        employee_id uuid, day date, requested_code text, current_code text
    ) on commit drop;

    insert into _proposed (employee_id, day, requested_code)
    select (item->>'employee_id')::uuid, (item->>'date')::date, nullif(item->>'requested_code', '')
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item;

    select count(*) into v_item_count from _proposed;
    if v_item_count = 0 then
        raise exception 'items: List should have at least 1 item after validation, not 0' using errcode = 'PT422';
    end if;
    if v_item_count > 200 then
        raise exception 'items: List should have at most 200 items after validation, not %', v_item_count
            using errcode = 'PT422';
    end if;
    select string_agg(distinct requested_code, ', ') into v_bad
      from _proposed where requested_code is not null and not public.schedules_valid_code(requested_code);
    if v_bad is not null then
        raise exception 'requested_code: not a shift code: %', v_bad using errcode = 'PT422';
    end if;
    if v_item_count <> (select count(distinct (employee_id, day)) from _proposed) then
        raise exception 'the same day appears more than once in this proposal' using errcode = 'PT422';
    end if;
    if length(p_reason) > 500 then
        raise exception 'reason: String should have at most 500 characters' using errcode = 'PT422';
    end if;

    select * into v_schedule from public.work_schedules where id = p_schedule_id;
    if not found then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;

    select array_agg(distinct day::text) into v_list
      from _proposed where day < v_schedule.start_date or day > v_schedule.end_date;
    if v_list is not null then
        raise exception 'These dates fall outside the period: %', public.schedules_pylist(v_list)
            using errcode = 'P0001';
    end if;

    -- Regular users may only propose against their own row, on a published period.
    if not v_is_admin then
        if v_schedule.status <> 'published' then
            raise exception 'Schedule not found' using errcode = 'PT404';
        end if;
        v_employee_id := public.schedules_employee_for_user(true);
        if exists (select 1 from _proposed where employee_id <> v_employee_id) then
            raise exception 'You can only propose changes to your own schedule' using errcode = 'PT403';
        end if;
    end if;

    -- A cell may sit in only one open proposal.
    select array_agg(i.date::text) into v_list
      from public.shift_change_items i
      join public.shift_change_requests r on r.id = i.request_id
      join _proposed p on p.employee_id = i.employee_id and p.day = i.date
     where r.schedule_id = p_schedule_id
       and i.status = 'pending';
    if v_list is not null then
        raise exception 'These days are already awaiting approval: %', public.schedules_pylist(v_list)
            using errcode = 'PT409';
    end if;

    update _proposed p
       set current_code = a.shift_code
      from public.shift_assignments a
     where a.schedule_id = p_schedule_id
       and a.employee_id = p.employee_id
       and a.date = p.day;

    delete from _proposed where current_code is not distinct from requested_code;
    get diagnostics v_no_ops = row_count;

    select count(*) into v_item_count from _proposed;
    if v_item_count = 0 then
        raise exception 'Nothing to change -- every day already has the code you asked for'
            using errcode = 'P0001';
    end if;

    -- Annual leave is capped by the balance; only the net extra counts.
    if not v_is_admin then
        with net as (
            select p.employee_id,
                   count(*) filter (where p.requested_code = 'AL')
                   - count(*) filter (where p.current_code = 'AL') as extra
              from _proposed p
             group by p.employee_id
        ),
        wanted as (select * from net where extra > 0)
        select w.extra, coalesce(s.balance, 0) as balance
          into v_short
          from wanted w
          left join public.schedules_leave_and_loading(
                    (select array_agg(employee_id) from wanted),
                    v_schedule.start_date, v_schedule.end_date) s
            on s.employee_id = w.employee_id
         where w.extra > coalesce(s.balance, 0)
         limit 1;

        if found then
            raise exception
                'Not enough annual leave: % day(s) requested but only % left. Ask a superuser if this is urgent.',
                v_short.extra, public.schedules_fmt_g(v_short.balance)
                using errcode = 'P0001';
        end if;
    end if;

    insert into public.shift_change_requests (id, schedule_id, status, reason, requested_by_id)
    values (v_request_id, p_schedule_id, 'pending', p_reason, auth.uid());

    insert into public.shift_change_items
        (id, request_id, employee_id, date, current_code, requested_code, status)
    select gen_random_uuid(), v_request_id, p.employee_id, p.day,
           p.current_code, p.requested_code, 'pending'
      from _proposed p;

    v_summary := format('Proposed %s roster change(s) on ''%s''', v_item_count, v_schedule.name);
    if v_no_ops > 0 then
        v_summary := v_summary || format(' (%s day(s) already matched and were dropped)', v_no_ops);
    end if;
    perform public.log_activity('SHIFT_CHANGE_REQUESTED', v_summary, v_request_id);

    return coalesce(public.change_requests_json(array[v_request_id]) -> 0, 'null'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. PUT /schedules/change-requests/{id}/review
-- ---------------------------------------------------------------------------
create or replace function public.review_shift_change(
    p_request_id uuid,
    p_approved_item_ids uuid[] default null,
    p_rejected_item_ids uuid[] default null,
    p_review_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_request public.shift_change_requests%rowtype;
    v_pending uuid[];
    v_approved uuid[];
    v_rejected uuid[] := coalesce(p_rejected_item_ids, '{}'::uuid[]);
    v_clash text[];
    v_unknown text[];
    v_applied int := 0;
    v_status text;
    v_item record;
begin
    -- ShiftChangeReview's own validation.
    select array_agg(distinct x::text) into v_clash
      from unnest(coalesce(p_approved_item_ids, '{}'::uuid[])) x
     where x = any(v_rejected);
    if v_clash is not null then
        raise exception 'item(s) both approved and rejected: %', public.schedules_pylist(v_clash)
            using errcode = 'PT422';
    end if;
    if length(p_review_note) > 500 then
        raise exception 'review_note: String should have at most 500 characters' using errcode = 'PT422';
    end if;

    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;

    select * into v_request from public.shift_change_requests where id = p_request_id;
    if not found then
        raise exception 'Change request not found' using errcode = 'PT404';
    end if;
    if v_request.status = 'cancelled' then
        raise exception 'This proposal was withdrawn' using errcode = 'P0001';
    end if;

    select coalesce(array_agg(id), '{}'::uuid[]) into v_pending
      from public.shift_change_items
     where request_id = p_request_id and status = 'pending';
    if cardinality(v_pending) = 0 then
        raise exception 'Every day in this proposal has already been reviewed' using errcode = 'P0001';
    end if;

    -- No selection at all: accept the proposal wholesale.
    if p_approved_item_ids is null and cardinality(v_rejected) = 0 then
        v_approved := v_pending;
    else
        v_approved := coalesce(p_approved_item_ids, '{}'::uuid[]);
    end if;

    select array_agg(distinct x::text) into v_unknown
      from unnest(v_approved || v_rejected) as x
     where not (x = any(v_pending));
    if v_unknown is not null then
        raise exception 'These days are not pending in this proposal: %', public.schedules_pylist(v_unknown)
            using errcode = 'P0001';
    end if;

    for v_item in
        select i.id, i.employee_id, i.date, i.requested_code
          from public.shift_change_items i
         where i.id = any(v_approved)
    loop
        perform public.write_schedule_cell(
            v_request.schedule_id, v_item.employee_id, v_item.date, v_item.requested_code);
        update public.shift_change_items set status = 'approved', updated_at = now()
         where id = v_item.id;
        v_applied := v_applied + 1;
    end loop;

    update public.shift_change_items set status = 'rejected', updated_at = now()
     where id = any(v_rejected);

    update public.shift_change_requests
       set review_note = coalesce(nullif(p_review_note, ''), review_note),
           reviewed_by_id = auth.uid(),
           reviewed_at = (now() at time zone 'utc'),
           updated_at = now()
     where id = p_request_id;

    v_status := public.recompute_change_status(p_request_id);

    perform public.log_activity(
        'SHIFT_CHANGE_REVIEWED',
        format('Reviewed roster proposal: %s day(s) approved, %s rejected (%s)',
               v_applied, (select count(distinct x) from unnest(v_rejected) x), v_status),
        p_request_id
    );

    return coalesce(public.change_requests_json(array[p_request_id]) -> 0, 'null'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. POST /schedules/roster-pattern
-- ---------------------------------------------------------------------------

-- Where one person stands in the rotation the day before p_anchor, read off
-- the published roster (schedule_service.continuation_offsets). NULL when
-- there is no usable history.
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
       and a.shift_code not in ('AL','SL','DL','PH','ST','T','TW','O');
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

-- Lintang's signature, kept so nothing that calls it breaks: the same
-- generator, with an explicit stagger and no read-back of the previous month
-- (it has no flag to ask for one), laying a rotating cycle every day.
create or replace function public.apply_roster_pattern(
    p_employee_ids uuid[],
    p_pattern jsonb,
    p_start_date date,
    p_end_date date,
    p_offset_days int default 0,
    p_overwrite boolean default true,
    p_apply_public_holidays boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
    return public.schedules_apply_roster_pattern(
        p_employee_ids, p_pattern, p_start_date, p_end_date,
        p_offset_days, p_overwrite, p_apply_public_holidays, false, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Public holidays (the Settings calendar)
-- ---------------------------------------------------------------------------
create or replace function public.schedules_holiday_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object('id', h.id, 'date', h.date, 'name', h.name, 'is_national', h.is_national)
      from public.public_holidays h where h.id = p_id;
$$;

create or replace function public.schedules_list_public_holidays(p_year int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if p_year is not null and (p_year < 1970 or p_year > 2200) then
        raise exception 'year: Input should be between 1970 and 2200' using errcode = 'PT422';
    end if;
    return coalesce((
        select jsonb_agg(
                   jsonb_build_object('id', h.id, 'date', h.date, 'name', h.name,
                                      'is_national', h.is_national)
                   order by h.date)
          from public.public_holidays h
         where p_year is null
            or h.date between make_date(p_year, 1, 1) and make_date(p_year, 12, 31)
    ), '[]'::jsonb);
end;
$$;

create or replace function public.schedules_create_public_holiday(
    p_date date,
    p_name text,
    p_is_national boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_clash text;
    v_id uuid := gen_random_uuid();
begin
    if p_date is null or p_name is null then
        raise exception 'date and name are required' using errcode = 'PT422';
    end if;
    if length(p_name) > 200 then
        raise exception 'name: String should have at most 200 characters' using errcode = 'PT422';
    end if;
    if not public.is_admin() then
        raise exception 'Only an administrator can change the holiday calendar.' using errcode = 'PT403';
    end if;

    select name into v_clash from public.public_holidays where date = p_date;
    if found then
        raise exception '% is already on %.', v_clash, public.schedules_long_date(p_date)
            using errcode = 'PT409';
    end if;

    insert into public.public_holidays (id, date, name, is_national)
    values (v_id, p_date, p_name, coalesce(p_is_national, true));

    perform public.log_activity(
        'PUBLIC_HOLIDAY_ADDED',
        format('Added %s on %s', p_name, public.schedules_long_date(p_date)),
        v_id
    );
    return public.schedules_holiday_json(v_id);
end;
$$;

-- Partial update: only the keys present in p_patch are changed.
create or replace function public.schedules_update_public_holiday(p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_holiday public.public_holidays%rowtype;
    v_date date;
    v_name text;
    v_national boolean;
    v_clash text;
    v_was text;
begin
    p_patch := coalesce(p_patch, '{}'::jsonb);
    if length(p_patch->>'name') > 200 then
        raise exception 'name: String should have at most 200 characters' using errcode = 'PT422';
    end if;
    if not public.is_admin() then
        raise exception 'Only an administrator can change the holiday calendar.' using errcode = 'PT403';
    end if;

    select * into v_holiday from public.public_holidays where id = p_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    v_date := coalesce((p_patch->>'date')::date, v_holiday.date);
    v_name := coalesce(p_patch->>'name', v_holiday.name);
    v_national := coalesce((p_patch->>'is_national')::boolean, v_holiday.is_national);

    if v_date <> v_holiday.date then
        select name into v_clash from public.public_holidays where date = v_date and id <> p_id;
        if found then
            raise exception '% is already on %.', v_clash, public.schedules_long_date(v_date)
                using errcode = 'PT409';
        end if;
    end if;

    v_was := format('%s on %s', v_holiday.name, public.schedules_long_date(v_holiday.date));
    update public.public_holidays
       set date = v_date, name = v_name, is_national = v_national, updated_at = now()
     where id = p_id;

    perform public.log_activity(
        'PUBLIC_HOLIDAY_UPDATED',
        format('Changed %s to %s on %s', v_was, v_name, public.schedules_long_date(v_date)),
        p_id
    );
    return public.schedules_holiday_json(p_id);
end;
$$;

create or replace function public.schedules_delete_public_holiday(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_holiday public.public_holidays%rowtype;
begin
    if not public.is_admin() then
        raise exception 'Only an administrator can change the holiday calendar.' using errcode = 'PT403';
    end if;
    select * into v_holiday from public.public_holidays where id = p_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    perform public.log_activity(
        'PUBLIC_HOLIDAY_REMOVED',
        format('Removed %s on %s', v_holiday.name, public.schedules_long_date(v_holiday.date)),
        p_id
    );
    delete from public.public_holidays where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.schedules_valid_code(text)                      from public;
revoke all on function public.schedules_pylist(text[])                        from public;
revoke all on function public.schedules_fmt_g(numeric)                        from public;
revoke all on function public.schedules_long_date(date)                       from public;
revoke all on function public.schedules_visible_employee_ids()                from public;
revoke all on function public.schedules_can_see_employee(uuid)                from public;
revoke all on function public.schedules_carries_a_roster(public.employees)    from public;
revoke all on function public.schedules_employee_for_user(boolean)            from public;
revoke all on function public.schedules_list_employees()                      from public;
revoke all on function public.schedules_list(int, int)                        from public;
revoke all on function public.schedules_leave_and_loading(uuid[], date, date) from public;
revoke all on function public.visible_change_request_ids(text, uuid)          from public;
revoke all on function public.change_requests_json(uuid[])                    from public;
revoke all on function public.list_change_requests(text, uuid)                from public;
revoke all on function public.get_schedule_detail(uuid)                       from public;
revoke all on function public.create_schedule(text, date, date)               from public;
revoke all on function public.set_schedule_cell(uuid, uuid, date, text)       from public;
revoke all on function public.save_schedule_assignments(uuid, jsonb)          from public;
revoke all on function public.propose_shift_changes(uuid, jsonb, text)        from public;
revoke all on function public.review_shift_change(uuid, uuid[], uuid[], text) from public;
revoke all on function public.schedules_continuation_offset(uuid, text[], date) from public;
revoke all on function public.schedules_apply_roster_pattern(uuid[], jsonb, date, date, int, boolean, boolean, boolean, boolean) from public;
revoke all on function public.apply_roster_pattern(uuid[], jsonb, date, date, int, boolean, boolean) from public;
revoke all on function public.schedules_holiday_json(uuid)                    from public;
revoke all on function public.schedules_list_public_holidays(int)             from public;
revoke all on function public.schedules_create_public_holiday(date, text, boolean) from public;
revoke all on function public.schedules_update_public_holiday(uuid, jsonb)    from public;
revoke all on function public.schedules_delete_public_holiday(uuid)           from public;

-- The policy on shift_assignments calls this as the signed-in user.
grant execute on function public.schedules_can_see_employee(uuid)             to authenticated;
grant execute on function public.schedules_list_employees()                   to authenticated;
grant execute on function public.schedules_list(int, int)                     to authenticated;
grant execute on function public.list_change_requests(text, uuid)             to authenticated;
grant execute on function public.get_schedule_detail(uuid)                    to authenticated;
grant execute on function public.create_schedule(text, date, date)            to authenticated;
grant execute on function public.set_schedule_cell(uuid, uuid, date, text)    to authenticated;
grant execute on function public.save_schedule_assignments(uuid, jsonb)       to authenticated;
grant execute on function public.propose_shift_changes(uuid, jsonb, text)     to authenticated;
grant execute on function public.review_shift_change(uuid, uuid[], uuid[], text) to authenticated;
grant execute on function public.schedules_apply_roster_pattern(uuid[], jsonb, date, date, int, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.apply_roster_pattern(uuid[], jsonb, date, date, int, boolean, boolean) to authenticated;
grant execute on function public.schedules_list_public_holidays(int)          to authenticated;
grant execute on function public.schedules_create_public_holiday(date, text, boolean) to authenticated;
grant execute on function public.schedules_update_public_holiday(uuid, jsonb) to authenticated;
grant execute on function public.schedules_delete_public_holiday(uuid)        to authenticated;

commit;
