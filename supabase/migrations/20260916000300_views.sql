-- ===========================================================================
-- Read models.
--
-- Three of the old endpoints returned a row plus something joined onto it --
-- an employee's account status, a requester's name, an actor's name. Those
-- become views so the frontend can keep paginating and filtering through
-- PostgREST (`?select=*&limit=&offset=` with an exact count) instead of
-- needing an RPC per list.
--
-- Each view is deliberately SECURITY DEFINER (`security_invoker = false`) and
-- carries its own WHERE clause. A view that ran as the caller could not reach
-- the rows it has to join -- `on_leave_today` reads leave_requests, which RLS
-- narrows to the caller's own -- so the scoping is written out here instead,
-- in terms of the same helpers the policies use. `is_admin()` and `auth.uid()`
-- describe the *session*, not the view owner, so they still answer correctly.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- employees_view -- the directory, as GET /employees returned it.
-- ---------------------------------------------------------------------------
drop view if exists public.employees_view;
create view public.employees_view
with (security_invoker = false) as
select
    e.id,
    e.employee_id,
    e.first_name,
    e.last_name,
    e.email,
    e.phone,
    e.department,
    e.position,
    e.date_of_joining,
    e.annual_leave_opening_balance,
    e.is_active,
    e.user_id,
    e.manager_id,
    e.created_at,
    e.updated_at,
    (e.user_id is not null) as has_account,
    (e.id in (select public.employees_on_leave_today())) as on_leave_today
from public.employees e
where public.is_active_user();

-- ---------------------------------------------------------------------------
-- leave_requests_view -- adds employee_name, and scopes to own / managed / all.
-- ---------------------------------------------------------------------------
drop view if exists public.leave_requests_view;
create view public.leave_requests_view
with (security_invoker = false) as
select
    lr.id,
    lr.employee_id,
    (e.first_name || ' ' || e.last_name) as employee_name,
    lr.leave_type,
    lr.start_date,
    lr.end_date,
    lr.days_requested,
    lr.reason,
    lr.status,
    lr.reviewed_by,
    lr.reviewed_at,
    lr.reviewer_note,
    lr.created_at,
    lr.updated_at
from public.leave_requests lr
join public.employees e on e.id = lr.employee_id
where public.is_active_user()
  and (
        public.is_admin()
     or lr.employee_id = public.current_employee_id()
     or e.manager_id = public.current_employee_id()
  );

-- ---------------------------------------------------------------------------
-- activity_logs_view -- adds actor_name. Admin sees everything; everyone else
-- sees what they did and what was done to them.
-- ---------------------------------------------------------------------------
drop view if exists public.activity_logs_view;
create view public.activity_logs_view
with (security_invoker = false) as
select
    l.id,
    l.action,
    l.description,
    coalesce(u.full_name, 'System') as actor_name,
    l.created_at
from public.activity_logs l
left join public.users u on u.id = l.actor_id
where public.is_active_user()
  and (
        public.is_admin()
     or l.actor_id = auth.uid()
     or l.target_user_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- These are read models; nothing writes through them.
-- ---------------------------------------------------------------------------
revoke all on public.employees_view      from anon, authenticated;
revoke all on public.leave_requests_view from anon, authenticated;
revoke all on public.activity_logs_view  from anon, authenticated;

grant select on public.employees_view      to authenticated;
grant select on public.leave_requests_view to authenticated;
grant select on public.activity_logs_view  to authenticated;

commit;
