-- ===========================================================================
-- TEMPORARY: the director opens other people's payslips too.
--
-- Only finance opens someone else's slip (20260928000500). The director has
-- no way to see finance's screens -- she cannot sign in as Himawan -- and
-- asked to have the same access while she reviews the payslip screens and
-- downloads. The executive still does not. To take it away again, re-create
-- payslips_opens_others() as finance-only in a new migration and drop
-- `|| director` from canDownload / canOpen in PayrollTaxPage and PayrollPage.
-- ===========================================================================

begin;

create or replace function public.payslips_opens_others()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.is_active_user()
       and (coalesce(public.current_user_role()::text, '') = 'finance'
            or public.is_platform_admin());
$$;

revoke all on function public.payslips_opens_others() from public, anon, authenticated;

commit;
