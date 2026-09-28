-- ===========================================================================
-- Payslips for everyone from January 2026, and automatic from then on.
--
-- The January-August 2026 slips were first issued to Nurhuda alone, to try
-- the feature. Tried and accepted: everyone on those months' payroll gets
-- theirs, each dated that month's last day, carrying the actual PPh 21 where
-- finance has entered one and marked as an estimate otherwise. Automatic
-- release now counts from January 2026, so a corrected and re-approved month
-- is re-issued on its own, as later months are.
-- ===========================================================================

begin;

update public.payslip_settings
   set start_month = '2026-01-01', updated_at = now()
 where id = 1 and start_month > '2026-01-01';

do $$
declare
    r record;
begin
    for r in
        select m.id from public.payroll_months m
         where m.year = 2026 and m.month between 1 and 8 and m.status = 'approved'
         order by m.month
    loop
        perform public.payslips_issue_month(r.id, null, null);
    end loop;
end $$;

commit;
