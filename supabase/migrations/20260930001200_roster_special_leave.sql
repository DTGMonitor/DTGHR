-- ===========================================================================
-- Special leave on the roster: SP.
--
-- The handbook's paid special leave -- marriage, a child's marriage,
-- circumcision or baptism, bereavement, paternity -- had no cell on the
-- roster. Maulana's wedding in December could only be marked AL, which the
-- annual leave position counts, so it would have come out of his annual
-- leave. It must not: special leave is its own grant.
--
-- SP is a new roster code, "Special leave":
--
--   * accepted wherever a code is (schedules_valid_code);
--   * never counted by leaves_annual_position, which counts AL cells and
--     approved annual requests only -- so it leaves annual leave untouched;
--   * stepped over by the rotation generator like the other leave codes;
--   * counted as a day of leave by leaves_count_days (a crew member asking
--     for special leave on a day planned as SP is charged that day, as for
--     AL, SL and DL), and shown as away on the dashboard.
--
-- Otherwise the functions are as in 20260926000400_schedules.sql,
-- 20260930000800_leave_working_days.sql and
-- 20260930001000_finance_peter_approves.sql.
-- ===========================================================================

begin;

create or replace function public.schedules_valid_code(p_code text)
returns boolean
language sql
immutable
as $$
    select p_code in ('DS','NS','C','B','D','O','AL','SL','DL','SP','PH','TW','ST','T');
$$;

create or replace function public.schedules_continuation_offset(
    p_employee_id uuid,
    p_cycle text[],
    p_anchor date
)
returns int
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_recent text[];
    v_last text;
    v_run int := 0;
    v_n int := coalesce(array_length(p_cycle, 1), 0);
    v_code text;
    v_behind int;
    i int;
    j int;
begin
    if v_n = 0 then
        return null;
    end if;

    -- Leave and holidays are stepped over, not counted.
    select array_agg(a.shift_code order by a.date desc) into v_recent
      from public.shift_assignments a
      join public.work_schedules s on s.id = a.schedule_id
     where a.employee_id = p_employee_id
       and a.date < p_anchor
       and a.date >= p_anchor - 60
       and s.status = 'published'
       and a.shift_code not in ('AL','SL','DL','SP','PH','ST','T','TW','O');
    if v_recent is null then
        return null;
    end if;

    v_last := v_recent[1];
    if not (v_last = any(p_cycle)) then
        return null;
    end if;
    foreach v_code in array v_recent loop
        exit when v_code <> v_last;
        v_run := v_run + 1;
    end loop;

    -- A place in the cycle where this code has exactly v_run days behind it.
    for i in 0 .. v_n - 1 loop
        continue when p_cycle[i + 1] <> v_last;
        v_behind := 0;
        j := i;
        while p_cycle[((j % v_n) + v_n) % v_n + 1] = v_last and v_behind < v_n loop
            v_behind := v_behind + 1;
            j := j - 1;
        end loop;
        if v_behind = v_run then
            return (i + 1) % v_n;
        end if;
    end loop;

    -- A part-finished block that cannot be placed: the start of its block.
    return array_position(p_cycle, v_last) - 1;
end;
$$;

create or replace function public.leaves_count_days(p_employee_id uuid, p_start date, p_end date)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select count(*)::int
      from generate_series(p_start, p_end, interval '1 day') g(d)
      left join public.employees e on e.id = p_employee_id and e.work_pattern = 'roster'
      left join lateral (
            select a.shift_code
              from public.shift_assignments a
              join public.work_schedules s on s.id = a.schedule_id
             where e.id is not null
               and a.employee_id = e.id
               and a.date = g.d::date
             order by (s.status = 'published') desc, a.updated_at desc
             limit 1
      ) c on true
     where case
             when c.shift_code is not null then
                  c.shift_code in ('DS', 'NS', 'C', 'D', 'TW', 'T', 'AL', 'SL', 'DL', 'SP')
             else extract(isodow from g.d) < 6
                  and not exists (select 1 from public.public_holidays h
                                   where h.date = g.d::date and h.is_national)
           end;
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
                 and a.shift_code in ('AL', 'SL', 'DL', 'SP')
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
        v_finance_state := case when v_role = 'executive' then 'submitted'
                                when v_role = 'director' and public.finance_director_final_approval()
                                     then 'submitted' end;
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
                 where v_finance_state is not null and r.status in (v_finance_state, case when v_finance_state = 'submitted' then 'endorsed' end)), '[]'::jsonb));
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

commit;
