-- ===========================================================================
-- Integration: what the areas of the port need from each other once merged.
--
-- The people area narrowed the `employees` read policy to the caller's own
-- row plus management. Two of the older leave policies found a manager's
-- team by reading `employees` inside the policy, which runs as the caller --
-- so a manager outside management would stop seeing their team's leave.
-- `manages_employee()` answers the question as the owner instead.
-- ===========================================================================

begin;

-- Whether the signed-in person is the named manager of an employee.
create or replace function public.manages_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.employees e
         where e.id = p_employee_id
           and e.manager_id = public.current_employee_id()
    );
$$;

revoke all on function public.manages_employee(uuid) from public;
grant execute on function public.manages_employee(uuid) to authenticated;

drop policy if exists leave_balances_select on public.leave_balances;
create policy leave_balances_select on public.leave_balances
    for select to authenticated
    using (
        (select public.is_admin())
        or employee_id = (select public.current_employee_id())
        or public.manages_employee(employee_id)
    );

drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests
    for select to authenticated
    using (
        (select public.is_admin())
        or employee_id = (select public.current_employee_id())
        or public.manages_employee(employee_id)
    );

commit;
