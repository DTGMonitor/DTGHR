-- ===========================================================================
-- Holidays 2026-2027, off-boarding, and the leave activity feed.
--
-- 1. The Indonesian holiday calendar for 2026 and 2027, exactly as the SKB 3
--    Menteri publishes it (2026: signed 19 Sep 2025; 2027: signed 15 Sep
--    2026). The 2026 rows the roster seed wrote were out by a day around
--    Idul Fitri and were missing most cuti bersama, which moved PH loading.
-- 2. Deactivating an employee now also shuts their login, and can be undone.
-- 3. leave_activity_view -- the audit trail for leave, joined to the request
--    it is about, so the Leaves page can show "your request was approved"
--    with the dates and the reviewer's note.
-- 4. PH loading gains a year-to-date figure alongside the month's.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Public holidays
--
-- An upsert on the date: names and national/cuti flags are corrected in place,
-- and any holiday HR added by hand on another date is left alone. The one
-- seeded row that is not on the official calendar at all (25 Mar 2026) is
-- removed, but only if it still carries the seed's name.
-- ---------------------------------------------------------------------------
insert into public.public_holidays (id, date, name, is_national)
select gen_random_uuid(), h.date::date, h.name, h.is_national
  from (values
    -- 2026: 17 libur nasional ------------------------------------------------
    ('2026-01-01', 'Tahun Baru 2026 Masehi', true),
    ('2026-01-16', 'Isra Mikraj Nabi Muhammad SAW', true),
    ('2026-02-17', 'Tahun Baru Imlek 2577 Kongzili', true),
    ('2026-03-19', 'Hari Suci Nyepi (Tahun Baru Saka 1948)', true),
    ('2026-03-21', 'Idul Fitri 1447 Hijriah', true),
    ('2026-03-22', 'Idul Fitri 1447 Hijriah', true),
    ('2026-04-03', 'Wafat Yesus Kristus', true),
    ('2026-04-05', 'Kebangkitan Yesus Kristus (Paskah)', true),
    ('2026-05-01', 'Hari Buruh Internasional', true),
    ('2026-05-14', 'Kenaikan Yesus Kristus', true),
    ('2026-05-27', 'Idul Adha 1447 Hijriah', true),
    ('2026-05-31', 'Hari Raya Waisak 2570 BE', true),
    ('2026-06-01', 'Hari Lahir Pancasila', true),
    ('2026-06-16', 'Tahun Baru Islam 1448 Hijriah', true),
    ('2026-08-17', 'Hari Kemerdekaan Republik Indonesia', true),
    ('2026-08-25', 'Maulid Nabi Muhammad SAW', true),
    ('2026-12-25', 'Hari Raya Natal', true),
    -- 2026: 8 cuti bersama ---------------------------------------------------
    ('2026-02-16', 'Cuti Bersama Tahun Baru Imlek', false),
    ('2026-03-18', 'Cuti Bersama Hari Suci Nyepi', false),
    ('2026-03-20', 'Cuti Bersama Idul Fitri', false),
    ('2026-03-23', 'Cuti Bersama Idul Fitri', false),
    ('2026-03-24', 'Cuti Bersama Idul Fitri', false),
    ('2026-05-15', 'Cuti Bersama Kenaikan Yesus Kristus', false),
    ('2026-05-28', 'Cuti Bersama Idul Adha', false),
    ('2026-12-24', 'Cuti Bersama Hari Raya Natal', false),
    -- 2027: 18 libur nasional ------------------------------------------------
    ('2027-01-01', 'Tahun Baru 2027 Masehi', true),
    ('2027-01-05', 'Isra Mikraj Nabi Muhammad SAW 1448 H', true),
    ('2027-02-06', 'Tahun Baru Imlek 2578 Kongzili', true),
    ('2027-03-08', 'Hari Suci Nyepi (Tahun Baru Saka 1949)', true),
    ('2027-03-10', 'Idul Fitri 1448 Hijriah', true),
    ('2027-03-11', 'Idul Fitri 1448 Hijriah', true),
    ('2027-03-26', 'Wafat Yesus Kristus', true),
    ('2027-03-28', 'Kebangkitan Yesus Kristus (Paskah)', true),
    ('2027-05-01', 'Hari Buruh Internasional', true),
    ('2027-05-06', 'Kenaikan Yesus Kristus', true),
    ('2027-05-17', 'Idul Adha 1448 Hijriah', true),
    ('2027-05-20', 'Hari Raya Waisak 2571 BE', true),
    ('2027-06-01', 'Hari Lahir Pancasila', true),
    ('2027-06-06', 'Tahun Baru Islam 1449 Hijriah', true),
    ('2027-08-15', 'Maulid Nabi Muhammad SAW', true),
    ('2027-08-17', 'Hari Kemerdekaan Republik Indonesia', true),
    ('2027-12-25', 'Hari Raya Natal', true),
    ('2027-12-26', 'Isra Mikraj Nabi Muhammad SAW 1449 H', true),
    -- 2027: 8 cuti bersama ---------------------------------------------------
    ('2027-02-05', 'Cuti Bersama Tahun Baru Imlek', false),
    ('2027-03-09', 'Cuti Bersama Idul Fitri', false),
    ('2027-03-12', 'Cuti Bersama Idul Fitri', false),
    ('2027-03-15', 'Cuti Bersama Idul Fitri', false),
    ('2027-03-25', 'Cuti Bersama Wafat Yesus Kristus', false),
    ('2027-05-18', 'Cuti Bersama Idul Adha', false),
    ('2027-05-19', 'Cuti Bersama Hari Raya Waisak', false),
    ('2027-12-24', 'Cuti Bersama Hari Raya Natal', false)
  ) as h(date, name, is_national)
on conflict (date) do update
   set name = excluded.name,
       is_national = excluded.is_national,
       updated_at = now();

delete from public.public_holidays
 where date = '2026-03-25' and name = 'Cuti Bersama Idul Fitri';

-- ---------------------------------------------------------------------------
-- 2. Off-boarding
--
-- Deactivating used to flip employees.is_active and nothing else, so someone
-- who had left could still sign in. It now also:
--   * marks the profile inactive -- is_active_user() then fails every RLS
--     check and bootstrap_session() refuses the session outright;
--   * bans the auth user, so GoTrue will not issue new tokens;
--   * drops their sessions, so refresh tokens stop working now rather than
--     when they expire.
-- auth.sessions only exists on a real Supabase project, hence the guard.
-- ---------------------------------------------------------------------------
create or replace function public.set_login_enabled(p_user_id uuid, p_enabled boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
    if p_user_id is null then
        return;
    end if;

    update public.users
       set is_active = p_enabled, updated_at = now()
     where id = p_user_id;

    update auth.users
       set banned_until = case when p_enabled then null else 'infinity'::timestamptz end,
           updated_at = now()
     where id = p_user_id;

    if not p_enabled and to_regclass('auth.sessions') is not null then
        execute 'delete from auth.sessions where user_id = $1' using p_user_id;
    end if;
end;
$$;

revoke all on function public.set_login_enabled(uuid, boolean) from public, anon, authenticated;

create or replace function public.deactivate_employee(p_employee_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
begin
    if not public.is_admin() then
        raise exception 'Only admin/HR can deactivate employees' using errcode = 'PT403';
    end if;

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    if v_employee.user_id = auth.uid() then
        raise exception 'You cannot deactivate your own account' using errcode = 'P0001';
    end if;

    update public.employees set is_active = false, updated_at = now() where id = p_employee_id;
    perform public.set_login_enabled(v_employee.user_id, false);

    perform public.log_activity(
        'EMPLOYEE_DEACTIVATED',
        format('Deactivated employee %s %s%s', v_employee.first_name, v_employee.last_name,
               case when v_employee.user_id is not null then ' and revoked their sign-in' else '' end),
        v_employee.id,
        v_employee.user_id
    );
end;
$$;

create or replace function public.reactivate_employee(p_employee_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
begin
    if not public.is_admin() then
        raise exception 'Only admin/HR can reactivate employees' using errcode = 'PT403';
    end if;

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    update public.employees set is_active = true, updated_at = now() where id = p_employee_id;
    perform public.set_login_enabled(v_employee.user_id, true);

    perform public.log_activity(
        'EMPLOYEE_REACTIVATED',
        format('Reactivated employee %s %s', v_employee.first_name, v_employee.last_name),
        v_employee.id,
        v_employee.user_id
    );

    return public.employee_json(p_employee_id);
end;
$$;

revoke all on function public.reactivate_employee(uuid) from public;
grant execute on function public.reactivate_employee(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Leave activity feed
--
-- Every LEAVE_* log row carries the request id as target_id. Scoped like
-- leave_requests_view: HR sees everything, a manager their reports', everyone
-- else their own. status / reviewer_note are the request's current state.
-- ---------------------------------------------------------------------------
drop view if exists public.leave_activity_view;
create view public.leave_activity_view
with (security_invoker = false) as
select
    l.id,
    l.action,
    l.description,
    l.actor_id,
    coalesce(u.full_name, 'System') as actor_name,
    l.created_at,
    lr.id as leave_request_id,
    lr.employee_id,
    (e.first_name || ' ' || e.last_name) as employee_name,
    lr.leave_type,
    lr.start_date,
    lr.end_date,
    lr.days_requested,
    lr.status,
    lr.reviewer_note
from public.activity_logs l
join public.leave_requests lr on lr.id = l.target_id
join public.employees e on e.id = lr.employee_id
left join public.users u on u.id = l.actor_id
where l.action like 'LEAVE\_%'
  and public.is_active_user()
  and (
        public.is_admin()
     or lr.employee_id = public.current_employee_id()
     or e.manager_id = public.current_employee_id()
  );

revoke all on public.leave_activity_view from anon, authenticated;
grant select on public.leave_activity_view to authenticated;

-- ---------------------------------------------------------------------------
-- 4. PH loading, month and year to date
--
-- Same rule as before -- a national holiday (not cuti bersama) on which the
-- employee was rostered DS, NS, C or D -- counted over the period and over
-- 1 January to the period's end. The return type changes, so drop first;
-- get_schedule_detail is plpgsql and does not hold a dependency on it.
-- ---------------------------------------------------------------------------
drop function if exists public.annual_leave_state(uuid[], date, date);

create function public.annual_leave_state(
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
        select e.id,
               e.date_of_joining,
               coalesce(e.annual_leave_opening_balance, 0)::numeric as opening
          from public.employees e
         where e.id = any(p_employee_ids)
    ),
    al as (
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
        select a.employee_id,
               count(*) filter (where a.date >= p_start)::int as n,
               count(*)::int as ytd,
               array_agg(a.date order by a.date) filter (where a.date >= p_start) as dates
          from public.shift_assignments a
          join public.public_holidays h
            on h.date = a.date and h.is_national
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

revoke all on function public.annual_leave_state(uuid[], date, date) from public;

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
                   'public_holiday_loading', coalesce(x.ph_loading, 0),
                   'public_holiday_loading_ytd', coalesce(x.ph_loading_ytd, 0),
                   'public_holiday_dates', to_jsonb(coalesce(x.ph_dates, '{}'::date[]))
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

commit;
