-- ===========================================================================
-- The roster: hiding a row, and office days that fill themselves.
--
-- Nurhuda, October 2026: "saya pengen hide jadwal mas Agus" -- some staff
-- (the building's cleaner) carry no roster, but every active employee who is
-- not a founder got an empty row. And a new office-day starter (Aurelio)
-- appeared with no days at all: office days were only ever written by the
-- pattern generator, run by hand, so anyone added after the month was drawn
-- stayed blank. "office day harusnya langsung ngikutin ... selain back up
-- engineer".
--
--   * employees.on_roster: false keeps a person off the roster grid
--     (schedules_carries_a_roster). Set by an administrator from the roster
--     screen; reversible there. Agus is set off here.
--   * schedules_fill_office_days(): for each office-day employee -- active, on
--     the roster, not the back-up engineer (whose month is drawn by hand),
--     not a founder -- whose row in a period is entirely EMPTY gets the
--     office code on every day from their joining date: PH on a national
--     holiday, B at the weekend, D otherwise. A row holding anything was drawn
--     by hand and is never touched, so edits, leave and back-up months stand.
--   * It runs when a period is created and when an employee is saved (the
--     screens call it), and from the roster screen's "Fill office days" for
--     the periods already drawn (October's Aurelio).
--
-- The rotating crew is unchanged: their rotation is the generator's, with
-- its offsets, and stays a deliberate step.
-- ===========================================================================

begin;

alter table public.employees add column if not exists on_roster boolean not null default true;

-- Whether this person belongs on the schedule at all. The founders -- the
-- management role *and* exempt from review -- work no shifts, and anyone an
-- administrator has taken off the roster has no row.
create or replace function public.schedules_carries_a_roster(p_employee public.employees)
returns boolean
language sql
stable
as $$
    select coalesce(p_employee.on_roster, true)
       and not (coalesce(p_employee.is_management_role, false)
                and not coalesce(p_employee.kpi_review_required, true));
$$;

-- The office-day code for a date.
create or replace function public.schedules_office_code(p_day date)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
    select case
             when exists (select 1 from public.public_holidays h
                           where h.date = p_day and h.is_national) then 'PH'
             when extract(isodow from p_day) >= 6 then 'B'
             else 'D'
           end;
$$;

-- Fill the empty office-day cells: one employee, one period, or everyone and
-- every period. Returns the number of cells written.
create or replace function public.schedules_fill_office_days(
    p_employee_id uuid default null,
    p_schedule_id uuid default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    n int;
begin
    insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
    select gen_random_uuid(), s.id, e.id, g.d::date, public.schedules_office_code(g.d::date)
      from public.employees e
      join public.work_schedules s
        on (p_schedule_id is null or s.id = p_schedule_id)
       and s.end_date >= coalesce(e.date_of_joining, s.start_date)
     cross join lateral generate_series(greatest(s.start_date, coalesce(e.date_of_joining, s.start_date)),
                                        s.end_date, interval '1 day') g(d)
     where (p_employee_id is null or e.id = p_employee_id)
       and e.is_active
       and e.work_pattern = 'office_day'
       and not coalesce(e.is_backup_engineer, false)
       and public.schedules_carries_a_roster(e)
       -- Only a row with nothing in this period: one that holds anything was
       -- drawn by hand and is left as it is.
       and not exists (select 1 from public.shift_assignments a
                        where a.employee_id = e.id and a.schedule_id = s.id)
       -- Nor a day this person holds in another period.
       and not exists (select 1 from public.shift_assignments a
                        where a.employee_id = e.id and a.date = g.d::date)
    on conflict do nothing;
    get diagnostics n = row_count;
    return n;
end;
$$;

revoke all on function public.schedules_fill_office_days(uuid, uuid) from public, anon, authenticated;

-- POST /schedules/office-days -- fill now. Called by the screens right after
-- a period is created and after an employee is saved, and by an
-- administrator's "Fill office days". Not a trigger: code that creates a
-- period and writes its cells in one go (the generator, imports, tests) must
-- not find them already taken.
create or replace function public.schedules_fill_office_days_now(
    p_employee_id uuid default null,
    p_schedule_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not (public.is_admin() or public.can_manage_people()) then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;
    return jsonb_build_object('filled', public.schedules_fill_office_days(p_employee_id, p_schedule_id));
end;
$$;

revoke all on function public.schedules_fill_office_days_now(uuid, uuid) from public, anon;
grant execute on function public.schedules_fill_office_days_now(uuid, uuid) to authenticated;

-- PUT /schedules/employees/{id}/on-roster -- an administrator hides or shows a row.
create or replace function public.schedules_set_on_roster(p_employee_id uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    e public.employees;
begin
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;
    if p_on is null then
        raise exception 'on_roster is required' using errcode = 'PT422';
    end if;
    update public.employees set on_roster = p_on, updated_at = now()
     where id = p_employee_id
    returning * into e;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;
    perform public.log_activity(
        case when p_on then 'ROSTER_ROW_SHOWN' else 'ROSTER_ROW_HIDDEN' end,
        format('%s %s %s the roster', e.first_name, e.last_name,
               case when p_on then 'put back on' else 'taken off' end),
        e.id, null);
    return jsonb_build_object('id', e.id, 'on_roster', e.on_roster);
end;
$$;

-- GET /schedules/hidden -- who an administrator has taken off the roster.
create or replace function public.schedules_list_hidden()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.is_admin() then
        return '[]'::jsonb;
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'id', e.id, 'first_name', e.first_name, 'last_name', e.last_name)
                 order by e.first_name, e.last_name)
          from public.employees e
         where e.is_active and not e.on_roster
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.schedules_set_on_roster(uuid, boolean) from public, anon;
revoke all on function public.schedules_list_hidden() from public, anon;
grant execute on function public.schedules_set_on_roster(uuid, boolean) to authenticated;
grant execute on function public.schedules_list_hidden() to authenticated;

-- Agus carries no roster.
update public.employees set on_roster = false
 where lower(email) = 'agus.santoso@dtgeotech.com';

commit;
