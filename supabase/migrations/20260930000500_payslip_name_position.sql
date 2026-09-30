-- ===========================================================================
-- A payslip names the person as their profile does and gives the role they
-- held that month.
--
-- Slips took the name and position from the payroll line, i.e. the payroll
-- sheet as imported: "NURHUDA SANTOSO, ENGINEER" on the director's slips,
-- and Nessy's slips still gave her engineering role after she moved to
-- Business Support. For a line tied to an employee the slip now reads:
--
--   * name: the profile's first and last name;
--   * position: the career-history entry in force on the last day of the
--     slip's month, else the profile's position.
--
-- Lines with no employee record keep the sheet's name and position. The
-- payroll sheet itself is not changed.
--
-- Slips are a stored snapshot, so every issued slip is rebuilt here, and is
-- rebuilt again whenever the person's name or career history changes. A
-- rebuild keeps the slip's issue date and generated_at; only its data
-- changes. Otherwise payslips_line_data() is as in
-- 20260928000400_payslip_tax_actuals.sql.
-- ===========================================================================

begin;

create or replace function public.payslips_line_data(p_line_id uuid, p_issue_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
    days int;
    f jsonb;
    v_first text;
    v_name text;
    v_position text;
    label text;
    divisor double precision;
    base_amt bigint;   base_rate bigint;   base_unit text;
    health bigint;     resp bigint;
    shift_amt bigint;  shift_rate bigint;  shift_unit text;
    overtime bigint;
    bpjs_e bigint;     bpjs_h bigint;      tax bigint;
    others bigint;
    total_e bigint;    total_d bigint;
    v_actual numeric;
    v_estimate boolean;
begin
    select * into l from public.payroll_lines where id = p_line_id;
    select * into m from public.payroll_months where id = l.month_id;
    days := public.payroll_days_in_month(m.year, m.month);
    f := public.payroll_line_figures(l, days);
    label := public.payroll_label(m.year, m.month);

    base_amt := public.payslips_rupiah((f ->> 'base_paid')::float8);
    base_rate := public.payslips_rupiah(l.base);
    if l.part_days is null then
        base_unit := '1';
    else
        divisor := case when coalesce(l.part_divisor, 0) <> 0 then l.part_divisor
                        else days::double precision end;
        base_unit := public.payslips_count_text(l.part_days) || '/' || public.payslips_count_text(divisor);
    end if;
    if base_amt = 0 then
        base_rate := 0;
        base_unit := '0';
    end if;

    health := public.payslips_rupiah(l.health_allowance);
    resp := public.payslips_rupiah(l.responsibility_allowance);

    shift_amt := public.payslips_rupiah((f ->> 'total_shift_allowance')::float8);
    shift_rate := public.payslips_rupiah(l.shift_allowance_rate);
    shift_unit := public.payslips_count_text(l.shift_days);
    if shift_amt = 0 then
        shift_rate := 0;
        shift_unit := '0';
    end if;

    overtime := public.payslips_rupiah(l.overtime_allowance);
    bpjs_e := public.payslips_rupiah(l.bpjs_employment);
    bpjs_h := public.payslips_rupiah(l.bpjs_health);
    tax := public.payslips_rupiah(l.income_tax);
    -- The actual PPh 21 where finance has entered it; otherwise the estimate
    -- the payroll was approved with, flagged as such. A zero estimate with no
    -- actual is not flagged: there is no tax to revise.
    select a.income_tax_actual into v_actual
      from public.payroll_tax_actuals a where a.payroll_line_id = l.id;
    if found then
        tax := round(v_actual)::bigint;
        v_estimate := false;
    else
        v_estimate := tax <> 0;
    end if;
    -- Public holiday pay and the one-offs (THR, bonus) have no row of their own.
    others := public.payslips_rupiah((f ->> 'public_holiday_allowance')::float8 + l.bonus_other);

    total_e := base_amt + health + resp + shift_amt + overtime + bpjs_e + bpjs_h + tax + others;
    total_d := bpjs_e + bpjs_h + tax;

    if l.employee_id is not null then
        select nullif(btrim(e.first_name), ''),
               nullif(btrim(concat_ws(' ', btrim(e.first_name), btrim(e.last_name))), '')
          into v_first, v_name
          from public.employees e where e.id = l.employee_id;
        -- The role held at the end of the slip's month, from career history.
        select nullif(btrim(c.position), '') into v_position
          from public.employee_career c
         where c.employee_id = l.employee_id
           and c.effective_date <= (make_date(m.year, m.month, 1) + interval '1 month - 1 day')::date
         order by c.effective_date desc
         limit 1;
        if v_position is null then
            select nullif(btrim(e.position), '') into v_position
              from public.employees e where e.id = l.employee_id;
        end if;
    end if;
    v_first := initcap(split_part(btrim(coalesce(v_first, l.person_name)), ' ', 1));

    return jsonb_build_object(
        'period_label', label,
        'year', m.year,
        'month', m.month,
        'issue_date', to_char(p_issue_date, 'YYYY-MM-DD'),
        'person_name', upper(coalesce(v_name, btrim(l.person_name))),
        'first_name', v_first,
        'position', upper(coalesce(v_position, btrim(coalesce(l.position, '')))),
        'tax_bearer', btrim(coalesce(l.ptkp_status, '')),
        'file_name', 'Payslip ' || label || ' - ' || v_first || '.pdf',
        'earnings', jsonb_build_object(
            'base', jsonb_build_object('rate', base_rate, 'unit', base_unit, 'amount', base_amt),
            'health', jsonb_build_object('rate', health, 'unit', case when health = 0 then '0' else '1' end, 'amount', health),
            'responsibility', jsonb_build_object('rate', resp, 'unit', case when resp = 0 then '0' else '1' end, 'amount', resp),
            'shift', jsonb_build_object('rate', shift_rate, 'unit', shift_unit, 'amount', shift_amt),
            'overtime', jsonb_build_object('rate', overtime, 'unit', case when overtime = 0 then '0' else '1' end, 'amount', overtime),
            'bpjs_employment', bpjs_e,
            'bpjs_health', bpjs_h,
            'income_tax', tax,
            'others', others),
        'deductions', jsonb_build_object(
            'bpjs_employment', bpjs_e,
            'bpjs_health', bpjs_h,
            'income_tax', tax),
        'total_earnings', total_e,
        'total_deductions', total_d,
        'net_pay', total_e - total_d,
        'tax_is_estimate', v_estimate
    );
end;
$$;

-- Rebuild one person's issued slips.
create or replace function public.payslips_rebuild_employee(p_employee_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    n int;
begin
    update public.payslips p
       set data = public.payslips_line_data(p.payroll_line_id, p.issue_date)
     where p.employee_id = p_employee_id;
    get diagnostics n = row_count;
    return n;
end;
$$;

revoke all on function public.payslips_rebuild_employee(uuid) from public, anon, authenticated;

create or replace function public.payslips_on_career_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if tg_op in ('UPDATE', 'DELETE') then
        perform public.payslips_rebuild_employee(old.employee_id);
    end if;
    if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.employee_id is distinct from old.employee_id) then
        perform public.payslips_rebuild_employee(new.employee_id);
    end if;
    return null;
end;
$$;

drop trigger if exists trg_payslips_career on public.employee_career;
create trigger trg_payslips_career
    after insert or update or delete on public.employee_career
    for each row execute function public.payslips_on_career_change();

create or replace function public.payslips_on_employee_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.payslips_rebuild_employee(new.id);
    return null;
end;
$$;

drop trigger if exists trg_payslips_employee on public.employees;
create trigger trg_payslips_employee
    after update of first_name, last_name, position on public.employees
    for each row
    when (old.first_name is distinct from new.first_name
       or old.last_name is distinct from new.last_name
       or old.position is distinct from new.position)
    execute function public.payslips_on_employee_change();

-- Every slip already issued, January 2026 on.
update public.payslips p
   set data = public.payslips_line_data(p.payroll_line_id, p.issue_date);

commit;
