-- ===========================================================================
-- Authorisation helpers and row-level security.
--
-- With FastAPI gone, every rule that used to live in a route decorator or an
-- `if not current_user.is_superuser` branch has to be expressed here instead:
-- the browser now talks to PostgREST directly, so the database is the only
-- thing standing between a user and a table.
--
-- Reads go straight through these policies. Writes almost all go through the
-- SECURITY DEFINER functions in the later migrations, which is why most tables
-- below get a SELECT policy and nothing else: with RLS on, an action with no
-- permissive policy is refused.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Helpers
--
-- All SECURITY DEFINER, because a policy on `users` that had to read `users`
-- would recurse. All STABLE, so that when a policy wraps a call in a scalar
-- subquery -- `(select public.is_admin())` -- the planner hoists it into an
-- InitPlan and evaluates it once per statement instead of once per row.
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (select u.is_superuser and u.is_active
           from public.users u
          where u.id = auth.uid()),
        false
    );
$$;

comment on function public.is_admin() is
    'True when the caller is an active superuser (HR / admin). Replaces the backend''s _require_admin().';

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce((select u.is_active from public.users u where u.id = auth.uid()), false);
$$;

-- The roster row belonging to the signed-in user. NULL when HR has not linked
-- one -- the old backend returned 403 in that case, and the callers below
-- reproduce that.
create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select e.id from public.employees e where e.user_id = auth.uid() limit 1;
$$;

create or replace function public.schedule_is_visible(p_schedule_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.is_admin()
        or exists (
            select 1 from public.work_schedules s
             where s.id = p_schedule_id
               and s.status = 'published'
        );
$$;

-- Employees currently on approved leave. A set-returning function rather than
-- a correlated subquery so the employee list evaluates it once per statement;
-- SECURITY DEFINER because leave_requests is otherwise scoped to rows the
-- caller owns or manages, and the roster has always shown this for everyone.
create or replace function public.employees_on_leave_today()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select distinct lr.employee_id
      from public.leave_requests lr
     where lr.status = 'approved'
       and lr.start_date <= current_date
       and lr.end_date >= current_date;
$$;

-- Audit trail. Fire-and-forget, exactly like the service it replaces: a
-- failure to log must never take down the action being logged.
create or replace function public.log_activity(
    p_action text,
    p_description text,
    p_target_id uuid default null,
    p_target_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.activity_logs (id, action, actor_id, target_id, target_user_id, description)
    values (gen_random_uuid(), p_action, auth.uid(), p_target_id, p_target_user_id, p_description);
exception
    when others then
        null;
end;
$$;

revoke all on function public.log_activity(text, text, uuid, uuid) from public, anon, authenticated;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_active_user() to authenticated;
grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.schedule_is_visible(uuid) to authenticated;
grant execute on function public.employees_on_leave_today() to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.users                  enable row level security;
alter table public.employees              enable row level security;
alter table public.leave_balances         enable row level security;
alter table public.leave_requests         enable row level security;
alter table public.work_schedules         enable row level security;
alter table public.shift_assignments      enable row level security;
alter table public.shift_change_requests  enable row level security;
alter table public.shift_change_items     enable row level security;
alter table public.public_holidays        enable row level security;
alter table public.activity_logs          enable row level security;

-- users --------------------------------------------------------------------
-- Own profile only. Other people's names reach the UI through the definer
-- views and RPCs, which hand out full_name without exposing is_superuser or
-- the rest of the row.
drop policy if exists users_select_self on public.users;
create policy users_select_self on public.users
    for select to authenticated
    using (id = (select auth.uid()) or (select public.is_admin()));

-- employees ----------------------------------------------------------------
-- Any signed-in user can read the directory; that is what the old
-- GET /employees did, and the roster grid needs every name to draw a row.
drop policy if exists employees_select_all on public.employees;
create policy employees_select_all on public.employees
    for select to authenticated
    using ((select public.is_active_user()));

-- leave_balances -----------------------------------------------------------
drop policy if exists leave_balances_select on public.leave_balances;
create policy leave_balances_select on public.leave_balances
    for select to authenticated
    using (
        (select public.is_admin())
        or employee_id = (select public.current_employee_id())
        or exists (
            select 1 from public.employees e
             where e.id = leave_balances.employee_id
               and e.manager_id = (select public.current_employee_id())
        )
    );

-- leave_requests -----------------------------------------------------------
-- Own requests, plus direct reports' for a manager, plus everything for
-- admin -- the same three cases the backend's list / pending-approvals /
-- get endpoints each hand-rolled.
drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests
    for select to authenticated
    using (
        (select public.is_admin())
        or employee_id = (select public.current_employee_id())
        or exists (
            select 1 from public.employees e
             where e.id = leave_requests.employee_id
               and e.manager_id = (select public.current_employee_id())
        )
    );

-- work_schedules -----------------------------------------------------------
drop policy if exists work_schedules_select on public.work_schedules;
create policy work_schedules_select on public.work_schedules
    for select to authenticated
    using ((select public.is_admin()) or status = 'published');

-- shift_assignments --------------------------------------------------------
drop policy if exists shift_assignments_select on public.shift_assignments;
create policy shift_assignments_select on public.shift_assignments
    for select to authenticated
    using (public.schedule_is_visible(schedule_id));

-- shift_change_requests ----------------------------------------------------
-- A proposal is "yours" if you raised it or any of its cells sits on your
-- roster row.
drop policy if exists shift_change_requests_select on public.shift_change_requests;
create policy shift_change_requests_select on public.shift_change_requests
    for select to authenticated
    using (
        (select public.is_admin())
        or requested_by_id = (select auth.uid())
        or exists (
            select 1 from public.shift_change_items i
             where i.request_id = shift_change_requests.id
               and i.employee_id = (select public.current_employee_id())
        )
    );

-- shift_change_items -------------------------------------------------------
drop policy if exists shift_change_items_select on public.shift_change_items;
create policy shift_change_items_select on public.shift_change_items
    for select to authenticated
    using (
        (select public.is_admin())
        or employee_id = (select public.current_employee_id())
        or exists (
            select 1 from public.shift_change_requests r
             where r.id = shift_change_items.request_id
               and r.requested_by_id = (select auth.uid())
        )
    );

-- public_holidays ----------------------------------------------------------
drop policy if exists public_holidays_select on public.public_holidays;
create policy public_holidays_select on public.public_holidays
    for select to authenticated
    using ((select public.is_active_user()));

drop policy if exists public_holidays_write on public.public_holidays;
create policy public_holidays_write on public.public_holidays
    for all to authenticated
    using ((select public.is_admin()))
    with check ((select public.is_admin()));

-- activity_logs ------------------------------------------------------------
drop policy if exists activity_logs_select on public.activity_logs;
create policy activity_logs_select on public.activity_logs
    for select to authenticated
    using (
        (select public.is_admin())
        or actor_id = (select auth.uid())
        or target_user_id = (select auth.uid())
    );

-- ---------------------------------------------------------------------------
-- Indexes backing the policy predicates above.
--
-- Every one of these is now evaluated on the read path of ordinary queries,
-- so the lookups they make need to be index hits.
-- ---------------------------------------------------------------------------
create index if not exists ix_employees_manager_id on public.employees (manager_id);
create index if not exists ix_employees_user_id on public.employees (user_id);
create index if not exists ix_leave_requests_status_dates
    on public.leave_requests (status, start_date, end_date);
create index if not exists ix_shift_assignments_employee_date
    on public.shift_assignments (employee_id, date);
create index if not exists ix_shift_assignments_schedule_date
    on public.shift_assignments (schedule_id, date);
create index if not exists ix_work_schedules_start_date
    on public.work_schedules (start_date desc);
create index if not exists ix_activity_logs_created_at
    on public.activity_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- Nothing in this application is public.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

commit;
