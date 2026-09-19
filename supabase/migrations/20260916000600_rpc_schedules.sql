-- ===========================================================================
-- Roster RPCs.
--
-- Ports app/api/routes/schedules.py and app/services/schedule_service.py.
--
-- The one worth calling out is get_schedule_detail: the old endpoint fanned
-- out into six queries plus two Python passes to build a single response, and
-- every one of those round trips crossed the network twice (browser to lambda,
-- lambda to Postgres). It is now one call that returns one document.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Annual leave accrual
--
-- One day a month, with the joining month pro-rated by the share of it the
-- employee was present for -- the workbook opens with 29/30 for someone who
-- started on the 2nd of a 30-day month. Four decimal places, not two: those
-- thirtieths and thirty-firsts have to survive the round trip.
-- ---------------------------------------------------------------------------

create or replace function public.days_in_month(p_day date)
returns int
language sql
immutable
as $$
    select extract(day from (date_trunc('month', p_day::timestamp) + interval '1 month - 1 day'))::int;
$$;

create or replace function public.accrued_annual_leave(p_joined date, p_through date)
returns numeric
language sql
immutable
as $$
    select case
        when p_joined is null or p_through is null or p_joined > p_through then 0::numeric
        else
            -- ANNUAL_LEAVE_PER_MONTH = 12 days / 12 months
            (12.0 / 12.0)::numeric * (
                ((public.days_in_month(p_joined) - extract(day from p_joined)::int + 1)::numeric
                 / public.days_in_month(p_joined)::numeric)
                + ((extract(year from p_through)::int - extract(year from p_joined)::int) * 12
                   + (extract(month from p_through)::int - extract(month from p_joined)::int))::numeric
            )
    end;
$$;

-- Per employee: the running annual-leave balance at p_end, the AL days falling
-- inside the period, and the national public holidays they were rostered to
-- work. Cuti bersama is excluded from the loading -- it is a government day
-- off, not a worked holiday, and that reading is what reproduces every
-- hard-coded figure in the workbook.
create or replace function public.annual_leave_state(
    p_employee_ids uuid[],
    p_start date,
    p_end date
)
returns table (employee_id uuid, balance numeric, taken_in_period int, ph_loading int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with emp as (
        select e.id,
               e.date_of_joining,
               coalesce(e.annual_leave_opening_balance, 0)::numeric as opening
          from public.employees e
         where e.id = any(p_employee_ids)
    ),
    al as (
        -- Everything booked up to the end of this period, including months
        -- after it, so an approved future booking is already reflected.
        select a.employee_id,
               count(*)::int as taken_to_date,
               count(*) filter (where a.date between p_start and p_end)::int as taken_in_period
          from public.shift_assignments a
         where a.employee_id = any(p_employee_ids)
           and a.shift_code = 'AL'
           and a.date <= p_end
         group by a.employee_id
    ),
    loading as (
        select a.employee_id, count(*)::int as n
          from public.shift_assignments a
          join public.public_holidays h
            on h.date = a.date and h.is_national
         where a.employee_id = any(p_employee_ids)
           and a.date between p_start and p_end
           and a.shift_code in ('DS', 'NS', 'C', 'D')
         group by a.employee_id
    )
    select emp.id,
           round(emp.opening
                 + public.accrued_annual_leave(emp.date_of_joining, p_end)
                 - coalesce(al.taken_to_date, 0), 4),
           coalesce(al.taken_in_period, 0),
           coalesce(loading.n, 0)
      from emp
      left join al on al.employee_id = emp.id
      left join loading on loading.employee_id = emp.id;
$$;

-- ---------------------------------------------------------------------------
-- Proposal serialisation, in the shape the grid already expects.
-- ---------------------------------------------------------------------------
-- VOLATILE, not STABLE: propose_shift_changes and review_shift_change call
-- this to serialise rows they have just written in the same transaction, and
-- volatility is what guarantees it reads a fresh snapshot rather than the one
-- the calling statement started with.
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
                   order by i.date
               ) as arr
          from public.shift_change_items i
          left join public.employees e on e.id = i.employee_id
         where i.request_id = r.id
    ) items on true
    where r.id = any(p_ids);
$$;

-- Ids of the proposals the caller is allowed to see: theirs by authorship,
-- theirs by roster row, or everything when they are a superuser.
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
           or r.requested_by_id = auth.uid()
           or exists (
               select 1 from public.shift_change_items i
                where i.request_id = r.id
                  and i.employee_id = public.current_employee_id()
           )
       );
$$;

create or replace function public.list_change_requests(
    p_status text default null,
    p_schedule_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.change_requests_json(
        public.visible_change_request_ids(p_status, p_schedule_id)
    );
$$;

-- ---------------------------------------------------------------------------
-- Schedule detail
-- ---------------------------------------------------------------------------
-- VOLATILE for the same reason as change_requests_json: save_schedule_assignments
-- returns this immediately after replacing every row it describes.
create or replace function public.get_schedule_detail(p_schedule_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_schedule public.work_schedules%rowtype;
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

    -- Employees only ever see a published period; a draft is a 404 to them,
    -- not a 403, so its existence is not disclosed.
    if not public.is_admin() and v_schedule.status <> 'published' then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;

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
      from public.shift_assignments a
      left join public.employees e on e.id = a.employee_id
     where a.schedule_id = p_schedule_id;

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
       and lr.end_date >= v_schedule.start_date;

    -- Only still-open proposals split a cell in two. PARTIALLY_APPROVED is
    -- deliberately excluded: everything in such a proposal has been decided.
    v_pending := public.change_requests_json(
        public.visible_change_request_ids('pending', p_schedule_id)
    );

    select coalesce(jsonb_agg(
               jsonb_build_object(
                   'id', h.id,
                   'date', h.date,
                   'name', h.name,
                   'is_national', h.is_national
               ) order by h.date
           ), '[]'::jsonb)
      into v_holidays
      from public.public_holidays h
     where h.date between v_schedule.start_date and v_schedule.end_date;

    -- Right-hand totals, as the workbook presents them.
    with codes as (
        select a.employee_id, a.shift_code as code, count(*)::int as n
          from public.shift_assignments a
         where a.schedule_id = p_schedule_id
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
        select * from public.annual_leave_state(
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
                   'public_holiday_loading', coalesce(x.ph_loading, 0)
               ) order by e.first_name, e.last_name
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
-- Schedule lifecycle (admin)
-- ---------------------------------------------------------------------------
create or replace function public.schedule_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', s.id, 'name', s.name, 'start_date', s.start_date, 'end_date', s.end_date,
        'status', s.status, 'created_at', s.created_at, 'updated_at', s.updated_at
    )
    from public.work_schedules s where s.id = p_id;
$$;

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
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;
    if p_end_date < p_start_date then
        raise exception 'end_date must be on or after start_date' using errcode = 'P0001';
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

create or replace function public.publish_schedule(p_schedule_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_schedule public.work_schedules%rowtype;
begin
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;

    select * into v_schedule from public.work_schedules where id = p_schedule_id;
    if not found then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;
    if v_schedule.status = 'published' then
        raise exception 'Schedule is already published' using errcode = 'P0001';
    end if;

    update public.work_schedules set status = 'published', updated_at = now() where id = p_schedule_id;

    perform public.log_activity(
        'SCHEDULE_PUBLISHED',
        format('Published schedule ''%s''', v_schedule.name),
        p_schedule_id
    );

    return public.schedule_json(p_schedule_id);
end;
$$;

create or replace function public.unpublish_schedule(p_schedule_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_schedule public.work_schedules%rowtype;
begin
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;

    select * into v_schedule from public.work_schedules where id = p_schedule_id;
    if not found then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;
    if v_schedule.status = 'draft' then
        raise exception 'Schedule is already in draft' using errcode = 'P0001';
    end if;

    update public.work_schedules set status = 'draft', updated_at = now() where id = p_schedule_id;

    perform public.log_activity(
        'SCHEDULE_UNPUBLISHED',
        format('Reverted schedule ''%s'' to draft', v_schedule.name),
        p_schedule_id
    );

    return public.schedule_json(p_schedule_id);
end;
$$;

create or replace function public.delete_schedule(p_schedule_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_schedule public.work_schedules%rowtype;
begin
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;

    select * into v_schedule from public.work_schedules where id = p_schedule_id;
    if not found then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;

    perform public.log_activity(
        'SCHEDULE_DELETED',
        format('Deleted schedule ''%s''', v_schedule.name),
        p_schedule_id
    );

    delete from public.work_schedules where id = p_schedule_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cells
-- ---------------------------------------------------------------------------

-- Upsert -- or delete, when the code is null -- one roster cell.
create or replace function public.write_schedule_cell(
    p_schedule_id uuid,
    p_employee_id uuid,
    p_date date,
    p_code text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
begin
    select id into v_id
      from public.shift_assignments
     where schedule_id = p_schedule_id
       and employee_id = p_employee_id
       and date = p_date
     limit 1;

    if p_code is null then
        if v_id is not null then
            delete from public.shift_assignments where id = v_id;
        end if;
        return null;
    end if;

    if v_id is not null then
        update public.shift_assignments
           set shift_code = p_code, updated_at = now()
         where id = v_id;
        return v_id;
    end if;

    v_id := gen_random_uuid();
    insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
    values (v_id, p_schedule_id, p_employee_id, p_date, p_code);
    return v_id;
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
    v_assignment_id uuid;
begin
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

    v_assignment_id := public.write_schedule_cell(
        p_schedule_id, p_employee_id, p_date, nullif(p_shift_code, '')
    );

    perform public.log_activity(
        'SCHEDULE_CELL_UPDATED',
        format('Set %s to %s in ''%s''',
               p_date, coalesce(nullif(p_shift_code, ''), '(empty)'), v_schedule.name),
        p_schedule_id
    );

    if v_assignment_id is null then
        return null;
    end if;

    return (
        select jsonb_build_object(
            'id', a.id,
            'schedule_id', a.schedule_id,
            'employee_id', a.employee_id,
            'employee_name', e.first_name || ' ' || e.last_name,
            'date', a.date,
            'shift_code', a.shift_code,
            'start_time', a.start_time,
            'end_time', a.end_time
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
begin
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
    select gen_random_uuid(),
           p_schedule_id,
           (item->>'employee_id')::uuid,
           (item->>'date')::date,
           item->>'shift_code',
           nullif(item->>'start_time', '')::time,
           nullif(item->>'end_time', '')::time
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
-- Proposals
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
    v_employee_id uuid := public.current_employee_id();
    v_is_admin boolean := public.is_admin();
    v_request_id uuid := gen_random_uuid();
    v_item_count int;
    v_no_ops int;
    v_outside text;
    v_clashes text;
    v_short record;
    v_summary text;
begin
    select * into v_schedule from public.work_schedules where id = p_schedule_id;
    if not found then
        raise exception 'Schedule not found' using errcode = 'PT404';
    end if;

    drop table if exists _proposed;
    create temporary table _proposed (
        employee_id uuid,
        day date,
        requested_code text,
        current_code text
    ) on commit drop;

    insert into _proposed (employee_id, day, requested_code)
    select (item->>'employee_id')::uuid,
           (item->>'date')::date,
           nullif(item->>'requested_code', '')
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item;

    select count(*) into v_item_count from _proposed;
    if v_item_count = 0 then
        raise exception 'A proposal must contain at least one day' using errcode = 'P0001';
    end if;
    if v_item_count > 200 then
        raise exception 'A proposal cannot cover more than 200 days' using errcode = 'P0001';
    end if;
    if v_item_count <> (select count(distinct (employee_id, day)) from _proposed) then
        raise exception 'the same day appears more than once in this proposal' using errcode = 'P0001';
    end if;

    select string_agg(distinct day::text, ', ' order by day::text) into v_outside
      from _proposed
     where day < v_schedule.start_date or day > v_schedule.end_date;
    if v_outside is not null then
        raise exception 'These dates fall outside the period: %', v_outside using errcode = 'P0001';
    end if;

    -- A regular user may only ever propose against their own row, and only on
    -- a period that has actually been published to them.
    if not v_is_admin then
        if v_schedule.status <> 'published' then
            raise exception 'Schedule not found' using errcode = 'PT404';
        end if;
        if v_employee_id is null then
            raise exception 'No employee profile linked to this user account' using errcode = 'PT403';
        end if;
        if exists (select 1 from _proposed where employee_id <> v_employee_id) then
            raise exception 'You can only propose changes to your own schedule' using errcode = 'PT403';
        end if;
    end if;

    -- A cell may sit in only one open proposal, so the split-cell rendering
    -- stays unambiguous and two reviewers cannot race on the same day.
    select string_agg(distinct i.date::text, ', ' order by i.date::text) into v_clashes
      from public.shift_change_items i
      join public.shift_change_requests r on r.id = i.request_id
      join _proposed p on p.employee_id = i.employee_id and p.day = i.date
     where r.schedule_id = p_schedule_id
       and i.status = 'pending';
    if v_clashes is not null then
        raise exception 'These days are already awaiting approval: %', v_clashes using errcode = 'PT409';
    end if;

    -- What each cell is changing *from*, so the reviewer can see it.
    update _proposed p
       set current_code = a.shift_code
      from public.shift_assignments a
     where a.schedule_id = p_schedule_id
       and a.employee_id = p.employee_id
       and a.date = p.day;

    -- Days that already hold the requested code are silently dropped.
    delete from _proposed
     where current_code is not distinct from requested_code;
    get diagnostics v_no_ops = row_count;

    select count(*) into v_item_count from _proposed;
    if v_item_count = 0 then
        raise exception 'Nothing to change -- every day already has the code you asked for'
            using errcode = 'P0001';
    end if;

    -- Annual leave is capped by the balance. Only the *net* extra matters:
    -- turning one AL day into another code inside the same proposal gives a
    -- day back. A superuser can still book past the cap for an urgent case,
    -- which is why the employee is told to go and ask.
    if not v_is_admin then
        with net as (
            select p.employee_id,
                   count(*) filter (where p.requested_code = 'AL')
                   - count(*) filter (where p.current_code = 'AL') as extra
              from _proposed p
             group by p.employee_id
        ),
        wanted as (select * from net where extra > 0)
        select w.extra, s.balance
          into v_short
          from wanted w
          left join public.annual_leave_state(
                    (select array_agg(employee_id) from wanted),
                    v_schedule.start_date, v_schedule.end_date) s
            on s.employee_id = w.employee_id
         where w.extra > coalesce(s.balance, 0)
         limit 1;

        if found then
            raise exception
                'Not enough annual leave: % day(s) requested but only % left. Ask a superuser if this is urgent.',
                v_short.extra,
                trim(to_char(coalesce(v_short.balance, 0), 'FM999999990.####'))
                using errcode = 'P0001';
        end if;
    end if;

    insert into public.shift_change_requests
        (id, schedule_id, status, reason, requested_by_id)
    values (v_request_id, p_schedule_id, 'pending', nullif(p_reason, ''), auth.uid());

    insert into public.shift_change_items
        (id, request_id, employee_id, date, current_code, requested_code, status)
    select gen_random_uuid(), v_request_id, p.employee_id, p.day,
           p.current_code, p.requested_code, 'pending'
      from _proposed p;

    v_summary := format('Proposed %s roster change(s) on ''%s''', v_item_count, v_schedule.name);
    if v_no_ops > 0 then
        v_summary := v_summary
            || format(' (%s day(s) already matched and were dropped)', v_no_ops);
    end if;
    perform public.log_activity('SHIFT_CHANGE_REQUESTED', v_summary, v_request_id);

    return coalesce(public.change_requests_json(array[v_request_id]) -> 0, 'null'::jsonb);
end;
$$;

-- Roll the items' verdicts up into the proposal's own status. Still pending
-- while any cell is undecided, so a reviewer can work through a large
-- proposal across several sittings.
create or replace function public.recompute_change_status(p_request_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_current text;
    v_verdicts text[];
    v_next text;
begin
    select status into v_current from public.shift_change_requests where id = p_request_id;
    if v_current = 'cancelled' then
        return v_current;
    end if;

    select array_agg(distinct status) into v_verdicts
      from public.shift_change_items where request_id = p_request_id;

    if 'pending' = any(v_verdicts) then
        v_next := 'pending';
    elsif v_verdicts = array['approved'] then
        v_next := 'approved';
    elsif v_verdicts = array['rejected'] then
        v_next := 'rejected';
    else
        v_next := 'partially_approved';
    end if;

    update public.shift_change_requests set status = v_next, updated_at = now()
     where id = p_request_id;
    return v_next;
end;
$$;

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
    v_unknown text;
    v_applied int := 0;
    v_status text;
    v_item record;
begin
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

    -- No selection at all: accept the proposal wholesale, which is the common
    -- "looks fine, apply it" case.
    if p_approved_item_ids is null and cardinality(v_rejected) = 0 then
        v_approved := v_pending;
    else
        v_approved := coalesce(p_approved_item_ids, '{}'::uuid[]);
    end if;

    select string_agg(x::text, ', ' order by x::text) into v_unknown
      from unnest(v_approved || v_rejected) as x
     where not (x = any(v_pending));
    if v_unknown is not null then
        raise exception 'These days are not pending in this proposal: %', v_unknown
            using errcode = 'P0001';
    end if;

    if exists (
        select 1 from unnest(v_approved) a where a = any(v_rejected)
    ) then
        raise exception 'An item cannot be both approved and rejected' using errcode = 'P0001';
    end if;

    -- Approving a cell is what writes its code onto the roster; rejecting
    -- leaves the roster untouched.
    for v_item in
        select i.id, i.employee_id, i.date, i.requested_code
          from public.shift_change_items i
         where i.id = any(v_approved)
    loop
        perform public.write_schedule_cell(
            v_request.schedule_id, v_item.employee_id, v_item.date, v_item.requested_code
        );
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
               v_applied, cardinality(v_rejected), v_status),
        p_request_id
    );

    return coalesce(public.change_requests_json(array[p_request_id]) -> 0, 'null'::jsonb);
end;
$$;

create or replace function public.cancel_shift_change(p_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_request public.shift_change_requests%rowtype;
begin
    select * into v_request from public.shift_change_requests where id = p_request_id;
    if not found then
        raise exception 'Change request not found' using errcode = 'PT404';
    end if;

    if not public.is_admin() and v_request.requested_by_id <> auth.uid() then
        raise exception 'You can only withdraw your own proposals' using errcode = 'PT403';
    end if;
    if v_request.status <> 'pending' then
        raise exception 'Only a proposal that is still pending can be withdrawn' using errcode = 'P0001';
    end if;

    update public.shift_change_items set status = 'cancelled', updated_at = now()
     where request_id = p_request_id and status = 'pending';

    update public.shift_change_requests set status = 'cancelled', updated_at = now()
     where id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Default rotation generator
-- ---------------------------------------------------------------------------

-- Fetch -- creating where missing -- one DRAFT schedule per month in range.
-- Generating a rotation for "the next 12 months" has to land in twelve
-- separate monthly periods, so the generator creates any that do not exist.
create or replace function public.ensure_month_schedules(p_start date, p_end date)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_month date;
begin
    for v_month in
        select generate_series(
            date_trunc('month', p_start)::date,
            date_trunc('month', p_end)::date,
            interval '1 month'
        )::date
    loop
        if not exists (
            select 1 from public.work_schedules s
             where date_trunc('month', s.start_date)::date = v_month
        ) then
            insert into public.work_schedules (id, name, start_date, end_date, status)
            values (
                gen_random_uuid(),
                to_char(v_month, 'FMMonth YYYY'),
                v_month,
                (v_month + interval '1 month - 1 day')::date,
                'draft'
            );
        end if;
    end loop;
end;
$$;

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
declare
    v_cycle text[];
    v_len int;
    v_written int := 0;
    v_skipped int := 0;
    v_touched int := 0;
    v_label text;
begin
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;
    if p_employee_ids is null or cardinality(p_employee_ids) = 0 then
        raise exception 'Select at least one employee' using errcode = 'P0001';
    end if;
    if p_end_date < p_start_date then
        raise exception 'end_date must be on or after start_date' using errcode = 'P0001';
    end if;

    -- Flatten [{DS,4},{NS,4},{B,4}] into a 12-entry cycle.
    select array_agg(block.code order by block.ord, g)
      into v_cycle
      from jsonb_array_elements(coalesce(p_pattern, '[]'::jsonb)) with ordinality as e(elem, ord)
      cross join lateral (select e.elem->>'shift_code' as code,
                                 (e.elem->>'days')::int as days,
                                 e.ord as ord) block
      cross join lateral generate_series(1, block.days) g;

    v_len := coalesce(array_length(v_cycle, 1), 0);
    if v_len = 0 then
        raise exception 'The rotation is empty' using errcode = 'P0001';
    end if;

    perform public.ensure_month_schedules(p_start_date, p_end_date);

    -- Every cell the rotation wants to land on, with a flag for whether one is
    -- already there. The flag has to be captured *before* any write, because
    -- after the insert every target row exists and "was it already set?" can
    -- no longer be answered.
    drop table if exists _target;
    create temporary table _target on commit drop as
    with emp as (
        select t.id, (t.ord - 1)::int as position
          from unnest(p_employee_ids) with ordinality as t(id, ord)
    ),
    days as (
        select generate_series(p_start_date, p_end_date, interval '1 day')::date as day
    ),
    sched as (
        select distinct on (date_trunc('month', s.start_date))
               date_trunc('month', s.start_date)::date as month,
               s.id
          from public.work_schedules s
         where s.start_date <= p_end_date and s.end_date >= p_start_date
         order by date_trunc('month', s.start_date), s.start_date, s.created_at
    )
    select emp.id as employee_id,
           days.day,
           sched.id as schedule_id,
           case
               when p_apply_public_holidays and h.date is not null then 'PH'
               else v_cycle[
                   (((days.day - p_start_date) + emp.position * p_offset_days) % v_len + v_len) % v_len + 1
               ]
           end as code,
           exists (
               select 1 from public.shift_assignments a
                where a.employee_id = emp.id and a.date = days.day
           ) as pre_existing
      from emp
     cross join days
      left join sched on sched.month = date_trunc('month', days.day)::date
      left join public.public_holidays h on h.date = days.day and h.is_national
     where sched.id is not null;

    -- With overwrite off, a cell that already holds a code is left alone.
    select count(*) filter (where t.pre_existing and not p_overwrite),
           count(*) filter (where not (t.pre_existing and not p_overwrite)),
           count(distinct t.schedule_id) filter (where not (t.pre_existing and not p_overwrite))
      into v_skipped, v_written, v_touched
      from _target t;

    if p_overwrite then
        update public.shift_assignments a
           set shift_code = t.code,
               schedule_id = t.schedule_id,
               updated_at = now()
          from _target t
         where t.pre_existing
           and a.employee_id = t.employee_id
           and a.date = t.day;
    end if;

    insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
    select gen_random_uuid(), t.schedule_id, t.employee_id, t.day, t.code
      from _target t
     where not t.pre_existing;

    select string_agg(format('%sx %s', elem->>'days', elem->>'shift_code'), ' / ')
      into v_label
      from jsonb_array_elements(p_pattern) as elem;

    perform public.log_activity(
        'SCHEDULE_PATTERN_APPLIED',
        format('Applied rotation [%s] to %s employee(s) from %s to %s (%s cells)',
               v_label, cardinality(p_employee_ids), p_start_date, p_end_date, v_written)
    );

    return jsonb_build_object(
        'schedules_touched', v_touched,
        'cells_written', v_written,
        'cells_skipped', v_skipped
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.days_in_month(date)                              from public;
revoke all on function public.accrued_annual_leave(date, date)                 from public;
revoke all on function public.annual_leave_state(uuid[], date, date)           from public;
revoke all on function public.change_requests_json(uuid[])                     from public;
revoke all on function public.visible_change_request_ids(text, uuid)           from public;
revoke all on function public.list_change_requests(text, uuid)                 from public;
revoke all on function public.get_schedule_detail(uuid)                        from public;
revoke all on function public.schedule_json(uuid)                              from public;
revoke all on function public.create_schedule(text, date, date)                from public;
revoke all on function public.publish_schedule(uuid)                           from public;
revoke all on function public.unpublish_schedule(uuid)                         from public;
revoke all on function public.delete_schedule(uuid)                            from public;
revoke all on function public.write_schedule_cell(uuid, uuid, date, text)      from public;
revoke all on function public.set_schedule_cell(uuid, uuid, date, text)        from public;
revoke all on function public.save_schedule_assignments(uuid, jsonb)           from public;
revoke all on function public.propose_shift_changes(uuid, jsonb, text)         from public;
revoke all on function public.recompute_change_status(uuid)                    from public;
revoke all on function public.review_shift_change(uuid, uuid[], uuid[], text)  from public;
revoke all on function public.cancel_shift_change(uuid)                        from public;
revoke all on function public.ensure_month_schedules(date, date)               from public;
revoke all on function public.apply_roster_pattern(uuid[], jsonb, date, date, int, boolean, boolean) from public;

grant execute on function public.list_change_requests(text, uuid)                to authenticated;
grant execute on function public.get_schedule_detail(uuid)                       to authenticated;
grant execute on function public.create_schedule(text, date, date)               to authenticated;
grant execute on function public.publish_schedule(uuid)                          to authenticated;
grant execute on function public.unpublish_schedule(uuid)                        to authenticated;
grant execute on function public.delete_schedule(uuid)                           to authenticated;
grant execute on function public.set_schedule_cell(uuid, uuid, date, text)       to authenticated;
grant execute on function public.save_schedule_assignments(uuid, jsonb)          to authenticated;
grant execute on function public.propose_shift_changes(uuid, jsonb, text)        to authenticated;
grant execute on function public.review_shift_change(uuid, uuid[], uuid[], text) to authenticated;
grant execute on function public.cancel_shift_change(uuid)                       to authenticated;
grant execute on function public.apply_roster_pattern(uuid[], jsonb, date, date, int, boolean, boolean) to authenticated;

commit;
