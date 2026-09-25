-- ===========================================================================
-- Overview: the dashboard and the activity log.
--
-- Ports app/api/routes/overview.py (GET /overview), app/api/routes/activity.py
-- (GET /activity/recent) and replaces Lintang's dashboard_stats() (GET
-- /dashboard/stats, app/api/routes/dashboard.py) so its annual figures come
-- from the same computed position the Leave page shows.
--
-- Nothing new is stored: every figure is read from the tables the other areas
-- own, through the helpers they already enforce their rules with --
--   * leaves_annual_position / leaves_is_founder  (leaves)
--   * payroll_awaiting / payroll_label            (payroll)
--   * tickets_works_queue                         (tickets)
--   * finance statuses submitted -> director, endorsed -> executive (finance)
--   * SALARY_AWAITS: submitted -> executive       (salary)
-- so the dashboard and the pages it links to cannot disagree about whose turn
-- it is.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Helpers.
-- ---------------------------------------------------------------------------

-- SHIFT_LABELS: how the roster workbook names each code, for the week strip.
create or replace function public.overview_shift_label(p_code text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_code
        when 'DS' then 'Dayshift'
        when 'NS' then 'Night shift'
        when 'C'  then 'Cross'
        when 'B'  then 'Break'
        when 'D'  then 'Day only'
        when 'O'  then 'Swap off'
        when 'AL' then 'Annual leave'
        when 'SL' then 'Sick leave'
        when 'DL' then 'Discretionary leave'
        when 'PH' then 'Public holiday'
        when 'TW' then 'Travel work'
        when 'ST' then 'Study leave'
        when 'T'  then 'Training'
    end;
$$;

-- PAYROLL_AWAITS inverted: the run states waiting on this role.
create or replace function public.overview_payroll_states(p_role text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
    select coalesce(array_agg(s), '{}'::text[])
      from unnest(array['draft', 'submitted', 'endorsed', 'approved', 'changes_requested']) s
     where public.payroll_awaiting(s) = p_role;
$$;

-- SALARY_AWAITS inverted: only a submitted review waits, on the executive.
create or replace function public.overview_salary_states(p_role text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
    select case when p_role = 'executive' then array['submitted'] else '{}'::text[] end;
$$;

-- ---------------------------------------------------------------------------
-- 1. GET /overview, as at a given day.
--
-- overview_at() takes the day so the tests can pin it; the client calls
-- overview_get(), which passes today. Not granted to clients.
-- ---------------------------------------------------------------------------
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
                   'holiday', (select h.name from public.public_holidays h where h.date = d::date limit 1),
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
     where h.date between p_today and v_month_end;

    select jsonb_build_object('date', h.date, 'name', h.name)
      into v_next_holiday
      from public.public_holidays h
     where h.date >= p_today
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
            'not_started', v_this_run is null and v_days_left <= 7);
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

create or replace function public.overview_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    return public.overview_at(public.local_today());
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. GET /activity/recent
--
-- Superusers see everything; everyone else what they did and what was done
-- to them.
-- ---------------------------------------------------------------------------
create or replace function public.activity_recent(p_page int default 1, p_page_size int default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid uuid := auth.uid();
    v_all boolean;
    v_total int;
    v_items jsonb;
begin
    perform public.people_require_user();
    if p_page is null or p_page < 1 then
        raise exception 'page must be greater than or equal to 1' using errcode = 'PT422';
    end if;
    if p_page_size is null or p_page_size < 1 or p_page_size > 50 then
        raise exception 'page_size must be between 1 and 50' using errcode = 'PT422';
    end if;

    v_all := coalesce((select is_superuser from public.users where id = v_uid), false);

    select count(*)::int into v_total
      from public.activity_logs l
     where v_all or l.actor_id = v_uid or l.target_user_id = v_uid;

    select coalesce(jsonb_agg(jsonb_build_object(
               'id', x.id,
               'action', x.action,
               'description', x.description,
               'actor_name', x.actor_name,
               'created_at', x.created_at)
             order by x.created_at desc, x.id), '[]'::jsonb)
      into v_items
      from (
          select l.id, l.action, l.description, l.created_at,
                 coalesce(u.full_name, 'System') as actor_name
            from public.activity_logs l
            left join public.users u on u.id = l.actor_id
           where v_all or l.actor_id = v_uid or l.target_user_id = v_uid
           order by l.created_at desc, l.id
          offset (p_page - 1) * p_page_size
           limit p_page_size
      ) x;

    return jsonb_build_object(
        'items', v_items,
        'total', v_total,
        'page', p_page,
        'page_size', p_page_size);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. GET /dashboard/stats (dashboard.py), replacing Lintang's.
--
-- Same shape. The annual figures used to read leave_balances, which now
-- carries a placeholder 0 for annual (the leaves area computes it on read);
-- they now come from leaves_annual_position through the year end, the same
-- total and remaining the Leave page shows. Founders carry none: 0.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_today date := public.local_today();
    v_year int := extract(year from public.local_today())::int;
    v_employee_id uuid;
    v_total numeric;
    v_remaining numeric;
    v_sick public.leave_balances%rowtype;
begin
    perform public.people_require_user();

    if public.is_admin() then
        return jsonb_build_object(
            'role', 'admin',
            'total_employees',
                (select count(*)::int from public.employees where is_active),
            'pending_approvals',
                (select count(*)::int from public.leave_requests where status = 'pending'),
            'on_leave_today',
                (select count(*)::int from public.leave_requests
                  where status = 'approved' and start_date <= v_today and end_date >= v_today),
            'new_this_month',
                (select count(*)::int from public.employees
                  where date_of_joining >= date_trunc('month', v_today)::date)
        );
    end if;

    v_employee_id := public.current_employee_id();

    if v_employee_id is null then
        return jsonb_build_object(
            'role', 'employee',
            'annual_remaining', 0, 'annual_total', 0,
            'sick_remaining', 0, 'sick_total', 0,
            'pending_requests', 0, 'total_used', 0
        );
    end if;

    if not public.leaves_is_founder(v_employee_id) then
        select p.entitlement, p.remaining into v_total, v_remaining
          from public.leaves_annual_position(v_employee_id, make_date(v_year, 12, 31)) p;
    end if;
    select * into v_sick from public.leave_balances
     where employee_id = v_employee_id and leave_type = 'sick' and year = v_year;

    return jsonb_build_object(
        'role', 'employee',
        'annual_remaining', coalesce(round(v_remaining, 2), 0),
        'annual_total', coalesce(round(v_total, 2), 0),
        'sick_remaining', coalesce(v_sick.total_days - v_sick.used_days, 0),
        'sick_total', coalesce(v_sick.total_days, 0),
        'pending_requests',
            (select count(*)::int from public.leave_requests
              where employee_id = v_employee_id and status = 'pending'),
        'total_used',
            coalesce((select sum(days_requested) from public.leave_requests
                       where employee_id = v_employee_id
                         and status = 'approved'
                         and start_date >= make_date(v_year, 1, 1)), 0)::double precision
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.overview_shift_label(text)     from public;
revoke all on function public.overview_payroll_states(text)  from public;
revoke all on function public.overview_salary_states(text)   from public;
revoke all on function public.overview_at(date)              from public;
revoke all on function public.overview_get()                 from public;
revoke all on function public.activity_recent(int, int)      from public;
revoke all on function public.dashboard_stats()              from public;

grant execute on function public.overview_get()              to authenticated;
grant execute on function public.activity_recent(int, int)   to authenticated;
grant execute on function public.dashboard_stats()           to authenticated;

commit;
