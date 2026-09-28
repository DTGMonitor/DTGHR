-- ===========================================================================
-- The back-up engineer reads the roster only in a month she works it.
--
-- The back-up flag used to open the rotating crew's schedule for every month.
-- Nurhuda: Nessy covers the roster in October and November, and in a month
-- where she has no roster shift she is office staff like anyone else. So the
-- crew's rows of a schedule are visible to the back-up engineer only when
-- she herself has a DS or NS cell in that schedule. The roster's name list
-- (schedules_list_employees) still carries the crew, names only: the grid
-- draws rows from the schedule's own cells.
-- ===========================================================================

begin;

-- Employee ids whose rows of one schedule the caller may see. NULL means
-- unrestricted (an administrator).
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
               and a.shift_code in ('DS', 'NS')) then
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

create or replace function public.schedules_can_see_cell(p_schedule_id uuid, p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_ids uuid[] := public.schedules_visible_employee_ids_for(p_schedule_id);
begin
    return v_ids is null or p_employee_id = any(v_ids);
end;
$$;

revoke all on function public.schedules_visible_employee_ids_for(uuid) from public;
revoke all on function public.schedules_can_see_cell(uuid, uuid)        from public;
grant execute on function public.schedules_visible_employee_ids_for(uuid) to authenticated;
grant execute on function public.schedules_can_see_cell(uuid, uuid)        to authenticated;

-- A plain read of the roster table obeys the same, per-schedule rule.
drop policy if exists shift_assignments_select on public.shift_assignments;
create policy shift_assignments_select on public.shift_assignments
    for select to authenticated
    using (public.schedule_is_visible(schedule_id)
           and public.schedules_can_see_cell(schedule_id, employee_id));

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

revoke all on function public.get_schedule_detail(uuid)                       from public;
grant execute on function public.get_schedule_detail(uuid)                    to authenticated;

commit;
