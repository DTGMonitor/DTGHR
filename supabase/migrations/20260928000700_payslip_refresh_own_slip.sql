-- ===========================================================================
-- Entering an actual PPh 21 refreshes that person's slip -- never issues one.
--
-- payslips_refresh_line() asked whether the MONTH had slips, not whether the
-- PERSON did. August 2026 had only Nurhuda's (issued to try the feature), so
-- typing and clearing an actual for Aris issued Aris a slip nobody meant to
-- release. It now rebuilds a slip only where that line already has a current
-- one; an actual entered before the release is simply used when slips go out.
--
-- The slips issued that way are withdrawn: before the month automatic
-- release starts (payslip_settings.start_month), the only slips meant to
-- exist are Nurhuda's, issued to try the feature.
-- ===========================================================================

begin;

create or replace function public.payslips_refresh_line(p_line_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
    s public.payslips;
begin
    select * into l from public.payroll_lines where id = p_line_id;
    select * into m from public.payroll_months where id = l.month_id;
    select * into s from public.payslips where payroll_line_id = l.id;
    if not found or m.status <> 'approved' or not public.payslips_current(s, m) then
        return false;
    end if;
    perform public.payslips_issue_line(l.id, s.generated_by_id);
    return true;
end;
$$;

revoke all on function public.payslips_refresh_line(uuid) from public, anon, authenticated;

delete from public.payslips p
 using public.payroll_months m, public.payslip_settings st
 where m.id = p.month_id
   and st.id = 1
   and make_date(m.year, m.month, 1) < st.start_month
   and p.employee_id is distinct from (
         select e.id from public.employees e
          where lower(e.email) = 'nurhuda.santoso@dtgeotech.com' limit 1);

commit;
