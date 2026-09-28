-- ===========================================================================
-- Only finance opens other people's payslips.
--
-- Everyone reads their own slips on My Profile. Finance (Himawan) prepares
-- them and may open or download anyone's; the director and the executive do
-- not -- a slip is personal. They still see, on the Payroll page, when a
-- month's slips are released, and the director still sets the schedule and
-- may issue a month early.
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
       and coalesce(public.current_user_role()::text, '') = 'finance';
$$;

revoke all on function public.payslips_opens_others() from public, anon, authenticated;

create or replace function public.payslips_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    s public.payslips;
    m public.payroll_months;
begin
    select * into s from public.payslips where id = p_id;
    if found then
        select * into m from public.payroll_months where id = s.month_id;
    end if;
    if not found
       or not (public.payslips_opens_others()
               or (public.is_active_user()
                   and s.employee_id is not null
                   -- coalesce: with no employee record the comparison is
                   -- null, and "not (false or null)" would let anyone in.
                   and coalesce(s.employee_id = public.current_employee_id(), false)
                   and public.payslips_current(s, m))) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return jsonb_build_object(
        'id', s.id,
        'year', s.year,
        'month', s.month,
        'issue_date', to_char(s.issue_date, 'YYYY-MM-DD'),
        'data', s.data);
end;
$$;

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
    if not public.payslips_opens_others() then
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

create or replace function public.payslips_template()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    emp uuid := public.current_employee_id();
begin
    if auth.uid() is null or not public.is_active_user() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if not public.payslips_opens_others()
       and not (emp is not null and exists (
                select 1 from public.payslips s
                  join public.payroll_months m on m.id = s.month_id
                 where s.employee_id = emp and public.payslips_current(s, m))) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return (select translate(encode(pdf, 'base64'), E'\n\r', '') from public.payslip_template where id = 1);
end;
$$;

create or replace function public.payslips_for_month(p_month_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
    st public.payslip_settings;
    v_slips jsonb;
    v_issue date;
begin
    if not public.payslips_is_viewer() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    m := public.payroll_load_month(p_month_id);
    select * into st from public.payslip_settings where id = 1;

    select coalesce(jsonb_agg(jsonb_build_object(
                'id', s.id,
                'person_name', s.data ->> 'person_name',
                'employee_id', s.employee_id,
                'file_name', s.data ->> 'file_name')
              order by (l.labour_group <> 'service'), l.row_no, l.created_at, l.id), '[]'::jsonb),
           max(s.issue_date)
      into v_slips, v_issue
      from public.payslips s
      join public.payroll_lines l on l.id = s.payroll_line_id
     where s.month_id = m.id
       and public.payslips_current(s, m);

    return jsonb_build_object(
        'month_id', m.id,
        'status', m.status,
        'release_at', public.payslips_release_at(m.year, m.month),
        'automatic', st.auto_enabled and make_date(m.year, m.month, 1) >= st.start_month,
        'issued', jsonb_array_length(v_slips) > 0,
        'issue_date', to_char(v_issue, 'YYYY-MM-DD'),
        -- The slips themselves: finance only.
        'slips', case when public.payslips_opens_others() then v_slips else '[]'::jsonb end);
end;
$$;

commit;
