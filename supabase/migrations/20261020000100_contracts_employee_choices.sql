-- ===========================================================================
-- Contracts: the employee picker for whoever manages contracts.
--
-- Nessy holds the contracts flag but could not add a manpower contract: the
-- Employee list was empty. The screen filled it from the staff directory
-- (people_list_employees), which is management's and HR's; anyone else gets
-- a 403 and an empty picker. contracts_employee_choices() gives the active
-- staff's names -- id, name and position, nothing more -- to anyone
-- contracts_can_manage() allows. Everybody else: 403.
-- ===========================================================================

begin;

create or replace function public.contracts_employee_choices()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.contracts_can_manage() then
        raise exception 'Only someone who manages contracts can do that.' using errcode = 'PT403';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'id', e.id,
                   'first_name', e.first_name,
                   'last_name', e.last_name,
                   'position', e.position,
                   'is_active', true)
                 order by e.first_name, e.last_name)
          from public.employees e
         where e.is_active
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.contracts_employee_choices() from public, anon;
grant execute on function public.contracts_employee_choices() to authenticated;

commit;
