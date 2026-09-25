-- ===========================================================================
-- A deactivated employee cannot sign in, however they were deactivated.
--
-- The Deactivate button (people_deactivate_employee) switches the login off
-- through set_login_enabled(). A record switched off any other way -- the
-- data move from the FastAPI line, an edit in the SQL editor -- left the
-- login on: Isabella, deactivated locally, could still sign in on live.
--
--   * a trigger keeps the login in step with the employee record whenever
--     its active flag changes, or when an inactive record gets linked;
--   * is_active_user() also refuses a deactivated employee, so RLS agrees
--     even before the trigger has run for older rows;
--   * every inactive employee and every inactive account on live now is
--     switched off properly: account inactive, auth user banned, sessions
--     ended.
-- ===========================================================================

begin;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce((select u.is_active from public.users u where u.id = auth.uid()), false)
       and not public.employee_deactivated(auth.uid());
$$;

create or replace function public.employees_sync_login()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if new.user_id is null then
        return null;
    end if;
    if tg_op = 'INSERT' then
        if not new.is_active then
            perform public.set_login_enabled(new.user_id, false);
        end if;
    elsif new.is_active is distinct from old.is_active then
        perform public.set_login_enabled(new.user_id, new.is_active);
    elsif new.user_id is distinct from old.user_id and not new.is_active then
        perform public.set_login_enabled(new.user_id, false);
    end if;
    return null;
end;
$$;

revoke all on function public.employees_sync_login() from public;

drop trigger if exists employees_sync_login on public.employees;
create trigger employees_sync_login
    after insert or update of is_active, user_id on public.employees
    for each row execute function public.employees_sync_login();

-- Everyone already switched off, switched off properly.
do $$
declare
    v uuid;
begin
    for v in
        select e.user_id from public.employees e where not e.is_active and e.user_id is not null
        union
        select u.id from public.users u where not u.is_active
    loop
        perform public.set_login_enabled(v, false);
    end loop;
end
$$;

commit;
