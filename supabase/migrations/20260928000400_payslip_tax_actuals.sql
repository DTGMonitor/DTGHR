-- ===========================================================================
-- The actual PPh 21 on payslips.
--
-- Finance (Himawan): the payroll sent for approval carries an ESTIMATED
-- PPh 21 (payroll_lines.income_tax), pitched so the money requested is never
-- short. The actual figure is known later, and the payslip must show the
-- actual so that it agrees with the annual A1 form. The tax is borne by the
-- company (grossed up), so net pay does not move: only the tax allowance, the
-- tax deduction and the two totals change.
--
-- The approved payroll itself is never touched. The actual is kept beside it
-- in payroll_tax_actuals, and a slip uses the actual where there is one and
-- otherwise the estimate, saying so (`tax_is_estimate`). Slips are released on
-- schedule with the estimate rather than held for the actual; entering or
-- clearing an actual rebuilds that person's slip at once if the month's slips
-- are already out.
--
-- Who: finance and the director (the platform administrator) enter and clear
-- actuals; the executive reads them; everybody else is answered 404. Payroll
-- viewers can also build any person's slip on demand (payslips_preview), from
-- the current figures, before its release moment.
--
-- Finance's dashboard lists each approved month still missing actuals.
-- overview_at() is otherwise exactly as in
-- 20260928000200_dashboard_national_holidays.sql.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_tax_actuals (
    payroll_line_id   uuid primary key references public.payroll_lines(id) on delete cascade,
    month_id          uuid not null references public.payroll_months(id) on delete cascade,
    income_tax_actual numeric not null check (income_tax_actual >= 0),
    note              text,
    updated_at        timestamptz not null default now(),
    updated_by_id     uuid references public.users(id) on delete set null
);
create index if not exists ix_payroll_tax_actuals_month_id on public.payroll_tax_actuals (month_id);
alter table public.payroll_tax_actuals enable row level security;

-- ---------------------------------------------------------------------------
-- 2. A slip's figures: the actual PPh 21 where there is one.
-- ---------------------------------------------------------------------------
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
        select nullif(btrim(e.first_name), '') into v_first from public.employees e where e.id = l.employee_id;
    end if;
    v_first := initcap(split_part(btrim(coalesce(v_first, l.person_name)), ' ', 1));

    return jsonb_build_object(
        'period_label', label,
        'year', m.year,
        'month', m.month,
        'issue_date', to_char(p_issue_date, 'YYYY-MM-DD'),
        'person_name', upper(btrim(l.person_name)),
        'first_name', v_first,
        'position', upper(btrim(coalesce(l.position, ''))),
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

-- Build or rebuild one line's slip, dated its month's release day. The month
-- must be approved. p_actor is recorded as who issued it (null: the schedule).
create or replace function public.payslips_issue_line(p_line_id uuid, p_actor uuid default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
    v_issue date;
begin
    select * into l from public.payroll_lines where id = p_line_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into m from public.payroll_months where id = l.month_id;
    if m.status <> 'approved' then
        raise exception 'Only an approved payroll month has payslips.' using errcode = 'PT409';
    end if;
    v_issue := (public.payslips_release_at(m.year, m.month) at time zone 'Asia/Jakarta')::date;
    insert into public.payslips (month_id, payroll_line_id, employee_id, year, month,
                                 issue_date, data, generated_at, generated_by_id)
    values (m.id, l.id, l.employee_id, m.year, m.month,
            v_issue, public.payslips_line_data(l.id, v_issue), now(), p_actor)
    on conflict (month_id, payroll_line_id) do update
       set employee_id = excluded.employee_id,
           year = excluded.year,
           month = excluded.month,
           issue_date = excluded.issue_date,
           data = excluded.data,
           generated_at = excluded.generated_at,
           generated_by_id = excluded.generated_by_id;
end;
$$;

-- If the line's month already has current slips, rebuild this line's so its
-- owner sees the new figure at once. Whoever issued the slip stays recorded
-- as its issuer. Before release nothing is written: the slip will be built
-- with the actual when it goes out.
create or replace function public.payslips_refresh_line(p_line_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
    v_by uuid;
begin
    select * into l from public.payroll_lines where id = p_line_id;
    select * into m from public.payroll_months where id = l.month_id;
    if m.status <> 'approved' or not exists (
        select 1 from public.payslips s where s.month_id = m.id and public.payslips_current(s, m)) then
        return false;
    end if;
    select s.generated_by_id into v_by from public.payslips s where s.payroll_line_id = l.id;
    perform public.payslips_issue_line(l.id, v_by);
    return true;
end;
$$;

-- What the slip for this line currently says about its tax: not issued, the
-- estimate, or the actual.
create or replace function public.payroll_tax_slip_state(p_line_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce((
        select case when coalesce((s.data ->> 'tax_is_estimate')::boolean, true)
                    then 'estimate' else 'actual' end
          from public.payslips s
          join public.payroll_months m on m.id = s.month_id
         where s.payroll_line_id = p_line_id
           and public.payslips_current(s, m)), 'not_issued');
$$;

-- One line as the Tax page shows it.
create or replace function public.payroll_tax_line_json(p_line_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'line_id', l.id,
        'month_id', l.month_id,
        'person_name', l.person_name,
        'employee_id', l.employee_id,
        'estimate', public.payslips_rupiah(l.income_tax),
        'actual', a.income_tax_actual,
        'difference', case when a.payroll_line_id is null then null
                           else a.income_tax_actual - public.payslips_rupiah(l.income_tax) end,
        'note', a.note,
        'updated_at', a.updated_at,
        'slip_status', public.payroll_tax_slip_state(l.id))
      from public.payroll_lines l
      left join public.payroll_tax_actuals a on a.payroll_line_id = l.id
     where l.id = p_line_id;
$$;

create or replace function public.payroll_tax_can_edit()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.is_active_user()
       and (coalesce(public.current_user_role()::text, '') = 'finance' or public.is_platform_admin());
$$;

-- ---------------------------------------------------------------------------
-- 3. The Tax (PPh 21) page.
-- ---------------------------------------------------------------------------

-- Every approved month of a year, newest first, each person's estimate and
-- actual.
create or replace function public.payroll_tax_list(p_year int)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.payslips_is_viewer() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if p_year is null or p_year < 2000 or p_year > 2100 then
        raise exception 'year must be between 2000 and 2100' using errcode = 'PT422';
    end if;
    return jsonb_build_object(
        'year', p_year,
        'can_edit', public.payroll_tax_can_edit(),
        'months', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'month_id', m.id,
                       'year', m.year,
                       'month', m.month,
                       'label', public.payroll_label(m.year, m.month),
                       'release_at', public.payslips_release_at(m.year, m.month),
                       'lines', coalesce((
                           select jsonb_agg(public.payroll_tax_line_json(l.id)
                                            order by (l.labour_group <> 'service'), l.row_no, l.created_at, l.id)
                             from public.payroll_lines l
                            where l.month_id = m.id), '[]'::jsonb))
                     order by m.month desc)
              from public.payroll_months m
             where m.year = p_year and m.status = 'approved'), '[]'::jsonb));
end;
$$;

-- Load the line and check the caller may change its actual.
create or replace function public.payroll_tax_require_edit(p_line_id uuid)
returns public.payroll_lines
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
begin
    if not public.payslips_is_viewer() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if not public.payroll_tax_can_edit() then
        raise exception 'Only finance or the director can enter the actual PPh 21.' using errcode = 'PT403';
    end if;
    select * into l from public.payroll_lines where id = p_line_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into m from public.payroll_months where id = l.month_id;
    if m.status <> 'approved' then
        raise exception 'The actual PPh 21 is entered once the month''s payroll is approved.'
            using errcode = 'PT409';
    end if;
    return l;
end;
$$;

create or replace function public.payroll_tax_money(p numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select to_char(round(p), 'FM999,999,999,999,990');
$$;

create or replace function public.payroll_tax_set(p_line_id uuid, p_actual numeric, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
    before numeric;
begin
    l := public.payroll_tax_require_edit(p_line_id);
    if p_actual is null or p_actual < 0 then
        raise exception 'The actual PPh 21 must be zero or more.' using errcode = 'PT422';
    end if;
    select * into m from public.payroll_months where id = l.month_id;
    select income_tax_actual into before from public.payroll_tax_actuals where payroll_line_id = l.id;

    insert into public.payroll_tax_actuals (payroll_line_id, month_id, income_tax_actual, note,
                                            updated_at, updated_by_id)
    values (l.id, l.month_id, p_actual, nullif(btrim(coalesce(p_note, '')), ''), now(), auth.uid())
    on conflict (payroll_line_id) do update
       set income_tax_actual = excluded.income_tax_actual,
           note = excluded.note,
           updated_at = excluded.updated_at,
           updated_by_id = excluded.updated_by_id;

    perform public.payslips_refresh_line(l.id);
    perform public.log_activity('PAYROLL_TAX_ACTUAL_SET',
        'Set the actual PPh 21 for ' || l.person_name || ', ' || public.payroll_label(m.year, m.month)
        || ': ' || case when before is null
                        then 'estimate ' || public.payroll_tax_money(l.income_tax::numeric)
                        else public.payroll_tax_money(before) end
        || ' -> ' || public.payroll_tax_money(p_actual),
        l.id, (select e.user_id from public.employees e where e.id = l.employee_id));
    return public.payroll_tax_line_json(l.id);
end;
$$;

create or replace function public.payroll_tax_clear(p_line_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
    before numeric;
begin
    l := public.payroll_tax_require_edit(p_line_id);
    select * into m from public.payroll_months where id = l.month_id;
    delete from public.payroll_tax_actuals where payroll_line_id = l.id
    returning income_tax_actual into before;
    if before is not null then
        perform public.payslips_refresh_line(l.id);
        perform public.log_activity('PAYROLL_TAX_ACTUAL_SET',
            'Cleared the actual PPh 21 for ' || l.person_name || ', '
            || public.payroll_label(m.year, m.month) || ': ' || public.payroll_tax_money(before)
            || ' -> estimate ' || public.payroll_tax_money(l.income_tax::numeric),
            l.id, (select e.user_id from public.employees e where e.id = l.employee_id));
    end if;
    return public.payroll_tax_line_json(l.id);
end;
$$;

-- Any person's slip for an approved month, built now from the current
-- figures and dated the month's release day. Payroll viewers only.
create or replace function public.payslips_preview(p_month_id uuid, p_line_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
    l public.payroll_lines;
begin
    if not public.payslips_is_viewer() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    m := public.payroll_load_month(p_month_id);
    select * into l from public.payroll_lines where id = p_line_id and month_id = m.id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if m.status <> 'approved' then
        raise exception 'Only an approved payroll month has payslips.' using errcode = 'PT409';
    end if;
    return public.payslips_line_data(l.id,
        (public.payslips_release_at(m.year, m.month) at time zone 'Asia/Jakarta')::date);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Finance's reminder: approved months with actuals still to enter.
-- ---------------------------------------------------------------------------
-- Approved months, from January of the year automatic slips began, with
-- people whose PPh 21 is still the estimate (a zero estimate needs nothing).
create or replace function public.payroll_tax_reminders(p_today date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
               'month_id', x.id,
               'label', public.payroll_label(x.year, x.month),
               'people', x.people)
             order by x.year, x.month), '[]'::jsonb)
      from (
          select m.id, m.year, m.month, count(*)::int as people
            from public.payroll_months m
            join public.payroll_lines l on l.month_id = m.id
           where m.status = 'approved'
             and make_date(m.year, m.month, 1) >= (
                 select date_trunc('year', s.start_month)::date from public.payslip_settings s where s.id = 1)
             and l.income_tax <> 0
             and not exists (select 1 from public.payroll_tax_actuals a where a.payroll_line_id = l.id)
           group by m.id, m.year, m.month
      ) x;
$$;

create or replace function public.overview_at(p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid uuid := auth.uid();
    v_user public.users%rowtype;
    v_role text;
    v_emp public.employees%rowtype;
    v_has_emp boolean;
    v_is_management boolean;
    v_week_end date := p_today + 6;
    v_month_end date := (date_trunc('month', p_today) + interval '1 month - 1 day')::date;
    v_week jsonb := '[]'::jsonb;
    v_holidays jsonb;
    v_next_holiday jsonb;
    v_leave jsonb := null;
    v_pos record;
    v_booked record;
    v_pending_mine int := 0;
    v_tickets_open int := null;
    v_my_tickets_open int := 0;
    v_finance_sent_back jsonb := null;
    v_payroll_desk jsonb := null;
    v_this_run text;
    v_days_left int;
    v_pending_approvals int := null;
    v_approvals jsonb := null;
    v_on_leave_today int := null;
    v_headcount int := null;
    v_salary_awaiting int := null;
    v_payroll_awaiting jsonb := null;
    v_kpi_awaiting int := null;
    v_on_duty jsonb := null;
    v_salary_states text[];
    v_payroll_states text[];
    v_away text[];
    v_finance_state text;
begin
    perform public.people_require_user();

    select * into v_user from public.users where id = v_uid;
    v_role := v_user.role::text;
    select * into v_emp from public.employees where user_id = v_uid limit 1;
    v_has_emp := found;

    v_is_management := coalesce(v_user.is_superuser, false)
        or v_role in ('director', 'executive')
        or (v_has_emp and coalesce(v_emp.is_management_role, false));

    -- ── The next seven days: published schedules only ──────────────────
    if v_has_emp then
        select jsonb_agg(jsonb_build_object(
                   'date', d::date,
                   'code', sa.code,
                   'label', public.overview_shift_label(sa.code),
                   'holiday', (select h.name from public.public_holidays h
                                where h.date = d::date and h.is_national limit 1),
                   'is_today', d::date = p_today)
               order by d)
          into v_week
          from generate_series(p_today, v_week_end, interval '1 day') d
          left join lateral (
              select max(a.shift_code)::text as code
                from public.shift_assignments a
                join public.work_schedules ws on ws.id = a.schedule_id
               where a.employee_id = v_emp.id
                 and a.date = d::date
                 and ws.status = 'published'
          ) sa on true;
    end if;

    -- ── Public holidays left this month, and the next of any month ─────
    select coalesce(jsonb_agg(jsonb_build_object(
               'date', h.date, 'name', h.name, 'is_national', coalesce(h.is_national, false))
             order by h.date), '[]'::jsonb)
      into v_holidays
      from public.public_holidays h
     where h.date between p_today and v_month_end
       and h.is_national;

    select jsonb_build_object('date', h.date, 'name', h.name)
      into v_next_holiday
      from public.public_holidays h
     where h.date >= p_today
       and h.is_national
     order by h.date
     limit 1;

    -- ── Leave balance: the Leave page's computed position ──────────────
    if v_has_emp then
        -- Founders (management, exempt from review) carry no balance.
        if not public.leaves_is_founder(v_emp.id) then
            select * into v_pos
              from public.leaves_annual_position(v_emp.id, make_date(extract(year from p_today)::int, 12, 31));
            if found then
                v_leave := jsonb_build_object(
                    'total', round(v_pos.entitlement, 2),
                    'used', v_pos.taken::double precision,
                    'remaining', round(v_pos.remaining, 2));
            end if;
        end if;

        select count(*)::int into v_pending_mine
          from public.leave_requests
         where employee_id = v_emp.id and status = 'pending';

        select lr.start_date, lr.end_date into v_booked
          from public.leave_requests lr
         where lr.employee_id = v_emp.id
           and lr.status = 'approved'
           and lr.end_date >= p_today
         order by lr.start_date
         limit 1;
        if found and v_leave is not null then
            v_leave := v_leave || jsonb_build_object(
                'next_from', v_booked.start_date, 'next_to', v_booked.end_date);
        end if;
    end if;

    -- ── IT support's queue, and everybody's own open tickets ───────────
    if v_has_emp and public.tickets_works_queue(v_emp.id) then
        select count(*)::int into v_tickets_open
          from public.support_tickets
         where status in ('open', 'in_progress', 'waiting');
    end if;
    if v_has_emp then
        select count(*)::int into v_my_tickets_open
          from public.support_tickets
         where reporter_id = v_emp.id
           and status in ('open', 'in_progress', 'waiting');
    end if;

    -- ── Finance's desk ─────────────────────────────────────────────────
    if v_role = 'finance' then
        select coalesce(jsonb_agg(jsonb_build_object(
                   'reference', r.reference, 'title', r.title, 'note', r.revision_note)
                 order by r.created_at), '[]'::jsonb)
          into v_finance_sent_back
          from public.finance_requests r
         where r.status = 'changes_requested';

        select pm.status into v_this_run
          from public.payroll_months pm
         where pm.year = extract(year from p_today)::int
           and pm.month = extract(month from p_today)::int;

        v_days_left := extract(day from v_month_end)::int - extract(day from p_today)::int;

        v_payroll_desk := jsonb_build_object(
            'sent_back', coalesce((
                select jsonb_agg(jsonb_build_object(
                           'label', public.payroll_label(pm.year, pm.month),
                           'note', pm.revision_note)
                       order by pm.year, pm.month)
                  from public.payroll_months pm
                 where pm.status = 'changes_requested'), '[]'::jsonb),
            'this_month', public.payroll_label(extract(year from p_today)::int,
                                               extract(month from p_today)::int),
            'this_month_status', v_this_run,
            'days_left', v_days_left,
            -- A week's warning, and only while the run can still be typed into.
            'due_soon', v_days_left <= 7 and v_this_run is not null
                        and v_this_run in ('draft', 'changes_requested'),
            'not_started', v_this_run is null and v_days_left <= 7,
            -- Approved months whose payslips still carry an estimated PPh 21.
            'tax_actuals_due', public.payroll_tax_reminders(p_today));
    end if;

    -- ── Waiting on management ──────────────────────────────────────────
    if v_is_management then
        -- Not their own: nobody approves their own leave.
        select count(*)::int into v_pending_approvals
          from public.leave_requests lr
         where lr.status = 'pending'
           and (not v_has_emp or lr.employee_id <> v_emp.id);

        -- Staff, not people: the founders are not headcount.
        select count(*)::int into v_headcount
          from public.employees e
         where e.is_active
           and not (e.is_management_role and not e.kpi_review_required);

        -- Who is covering the site today, and who is away -- from approved
        -- requests and from AL/SL/DL cells on the published roster.
        select coalesce(array_agg(name order by name collate "C"), '{}'::text[])
          into v_away
          from (
              select e.first_name as name
                from public.leave_requests lr
                join public.employees e on e.id = lr.employee_id
               where lr.status = 'approved'
                 and lr.start_date <= p_today
                 and lr.end_date >= p_today
              union
              select e.first_name
                from public.shift_assignments a
                join public.employees e on e.id = a.employee_id
                join public.work_schedules ws on ws.id = a.schedule_id
               where a.date = p_today
                 and ws.status = 'published'
                 and a.shift_code in ('AL', 'SL', 'DL')
          ) away;

        v_on_duty := jsonb_build_object(
            'dayshift', coalesce((
                select jsonb_agg(e.first_name order by e.first_name collate "C")
                  from public.shift_assignments a
                  join public.employees e on e.id = a.employee_id
                  join public.work_schedules ws on ws.id = a.schedule_id
                 where a.date = p_today and ws.status = 'published' and a.shift_code = 'DS'),
                '[]'::jsonb),
            'nightshift', coalesce((
                select jsonb_agg(e.first_name order by e.first_name collate "C")
                  from public.shift_assignments a
                  join public.employees e on e.id = a.employee_id
                  join public.work_schedules ws on ws.id = a.schedule_id
                 where a.date = p_today and ws.status = 'published' and a.shift_code = 'NS'),
                '[]'::jsonb),
            'on_leave', to_jsonb(v_away));
        v_on_leave_today := coalesce(array_length(v_away, 1), 0);

        -- Salary reviews on this person's signature; null when the role is
        -- not in the chain at all.
        v_salary_states := public.overview_salary_states(v_role);
        if cardinality(v_salary_states) > 0 then
            select count(*)::int into v_salary_awaiting
              from public.salary_reviews sr
             where sr.status = any (v_salary_states)
               and (not v_has_emp or sr.employee_id <> v_emp.id);
        end if;

        -- The payroll run on this person's signature.
        v_payroll_states := public.overview_payroll_states(v_role);
        if cardinality(v_payroll_states) > 0 then
            select jsonb_build_object(
                       'count', count(*)::int,
                       'label', (array_agg(public.payroll_label(pm.year, pm.month)
                                           order by pm.year, pm.month))[1])
              into v_payroll_awaiting
              from public.payroll_months pm
             where pm.status = any (v_payroll_states);
        end if;

        -- Scorecards waiting on this person's signature.
        if v_has_emp then
            select count(*)::int into v_kpi_awaiting
              from public.kpi_reviews k
             where k.approver_id = v_emp.user_id and k.status = 'submitted';
        else
            v_kpi_awaiting := 0;
        end if;

        -- The same queues by name, for the sentence at the top.
        v_finance_state := case v_role when 'director' then 'submitted'
                                       when 'executive' then 'endorsed' end;
        v_approvals := jsonb_build_object(
            'leave', coalesce((
                select jsonb_agg(jsonb_build_object(
                           'name', e.first_name,
                           'leave_type', lr.leave_type,
                           'start', lr.start_date,
                           'end', lr.end_date,
                           'days', lr.days_requested)
                       order by lr.start_date)
                  from public.leave_requests lr
                  join public.employees e on e.id = lr.employee_id
                 where lr.status = 'pending'
                   and (not v_has_emp or lr.employee_id <> v_emp.id)), '[]'::jsonb),
            'payroll', coalesce((
                select jsonb_agg(jsonb_build_object(
                           'label', public.payroll_label(pm.year, pm.month),
                           'submitted_by', sub.full_name,
                           -- Set when the executive sent it back to the director's review.
                           'sent_back_note', pm.revision_note,
                           'sent_back_by', case when pm.revision_note is not null then ret.full_name end)
                       order by pm.year, pm.month)
                  from public.payroll_months pm
                  left join public.users sub on sub.id = pm.submitted_by_id
                  left join public.users ret on ret.id = pm.revision_by_id
                 where pm.status = any (v_payroll_states)), '[]'::jsonb),
            'salary', coalesce((
                select jsonb_agg(jsonb_build_object('name', e.first_name))
                  from public.salary_reviews sr
                  join public.employees e on e.id = sr.employee_id
                 where sr.status = any (v_salary_states)
                   and (not v_has_emp or sr.employee_id <> v_emp.id)), '[]'::jsonb),
            'kpi', case when v_has_emp then coalesce((
                select jsonb_agg(jsonb_build_object('name', e.first_name, 'period', k.period_label))
                  from public.kpi_reviews k
                  join public.employees e on e.id = k.employee_id
                 where k.approver_id = v_emp.user_id and k.status = 'submitted'), '[]'::jsonb)
                else '[]'::jsonb end,
            'finance', coalesce((
                select jsonb_agg(jsonb_build_object(
                           'reference', r.reference,
                           'title', r.title,
                           'total', public.finance_total(r.id),
                           'requested_by', req.full_name,
                           'sent_back_note', r.revision_note,
                           'sent_back_by', case when r.revision_note is not null then ret.full_name end)
                       order by r.created_at)
                  from public.finance_requests r
                  left join public.users req on req.id = r.requested_by_id
                  left join public.users ret on ret.id = r.revision_by_id
                 where v_finance_state is not null and r.status = v_finance_state), '[]'::jsonb));
    end if;

    return jsonb_build_object(
        'is_management', v_is_management,
        'has_employee_record', v_has_emp,
        'week', coalesce(v_week, '[]'::jsonb),
        'holidays', v_holidays,
        'leave', v_leave,
        'pending_mine', v_pending_mine,
        'pending_approvals', v_pending_approvals,
        'on_leave_today', v_on_leave_today,
        'headcount', v_headcount,
        'salary_awaiting', v_salary_awaiting,
        'payroll_awaiting', v_payroll_awaiting,
        'payroll_desk', v_payroll_desk,
        'finance_sent_back', v_finance_sent_back,
        'tickets_open', v_tickets_open,
        'my_tickets_open', v_my_tickets_open,
        'kpi_awaiting', v_kpi_awaiting,
        'approvals', v_approvals,
        'on_duty', v_on_duty,
        'next_holiday', v_next_holiday);
end;
$$;

revoke all on function public.overview_at(date) from public;

-- ---------------------------------------------------------------------------
-- 5. Grants.
-- ---------------------------------------------------------------------------
do $$
declare
    f text;
begin
    foreach f in array array[
        'public.payslips_line_data(uuid, date)',
        'public.payslips_issue_line(uuid, uuid)',
        'public.payslips_refresh_line(uuid)',
        'public.payroll_tax_slip_state(uuid)',
        'public.payroll_tax_line_json(uuid)',
        'public.payroll_tax_can_edit()',
        'public.payroll_tax_require_edit(uuid)',
        'public.payroll_tax_money(numeric)',
        'public.payroll_tax_reminders(date)'
    ] loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
    end loop;

    foreach f in array array[
        'public.payroll_tax_list(int)',
        'public.payroll_tax_set(uuid, numeric, text)',
        'public.payroll_tax_clear(uuid)',
        'public.payslips_preview(uuid, uuid)'
    ] loop
        execute format('revoke all on function %s from public, anon', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Slips already out carry the estimate flag: rebuild every current slip
--    (Nurhuda's January to August 2026 among them), keeping who issued it.
--    Idempotent.
-- ---------------------------------------------------------------------------
do $$
declare
    r record;
begin
    for r in
        select s.payroll_line_id, s.generated_by_id
          from public.payslips s
          join public.payroll_months m on m.id = s.month_id
         where public.payslips_current(s, m)
    loop
        perform public.payslips_issue_line(r.payroll_line_id, r.generated_by_id);
    end loop;
end $$;

commit;
