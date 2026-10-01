-- ===========================================================================
-- Finance requests go to Peter.
--
-- The chain was finance -> the director reviews -> the executive approves.
-- That is not how it runs: Himawan sends a request to Peter, Peter approves
-- it, and the director is only copied in. Now:
--
--   finance submits -> Peter (executive) approves or sends back -> finance pays
--
-- * The director sees every request and is told of each one, but has
--   nothing to do -- unless the setting (finance_settings.director_final_
--   approval) is on, when the director may approve or send back as well.
-- * Sending back goes to finance only; there is no review to return to.
-- * finance_review() answers as finance_approve(), for an older screen.
-- * A request left at 'endorsed' by the old chain is approved the same way.
--
-- The dashboard's approvals list and the email follow. Otherwise the
-- functions are as in 20260926000800_finance.sql, 20260926001300_
-- notifications.sql and 20260928000400_payslip_tax_actuals.sql.
-- ===========================================================================

begin;

create or replace function public.finance_request_json(r public.finance_requests)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', r.id,
        'reference', r.reference,
        'title', r.title,
        'notes', r.notes,
        'due_date', r.due_date,
        'status', r.status,
        'total', public.finance_total(r.id),
        'items', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', i.id, 'category', i.category,
                       'description', i.description, 'amount', i.amount)
                   order by i.sort_order, i.created_at, i.id)
              from public.finance_request_items i where i.request_id = r.id), '[]'::jsonb),
        'documents', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', d.id, 'filename', d.filename, 'content_type', d.content_type,
                       'byte_size', d.byte_size, 'created_at', d.created_at)
                   order by d.created_at, d.id)
              from public.finance_request_documents d where d.request_id = r.id), '[]'::jsonb),
        'requested_by_name', (select full_name from public.users where id = r.requested_by_id),
        'submitted_at', r.submitted_at,
        'reviewed_by_name', (select full_name from public.users where id = r.reviewed_by_id),
        'reviewed_at', r.reviewed_at,
        'approved_by_name', (select full_name from public.users where id = r.approved_by_id),
        'approved_at', r.approved_at,
        'revision_note', r.revision_note,
        'revision_by_name', (select full_name from public.users where id = r.revision_by_id),
        'paid_on', r.paid_on,
        'paid_by_name', (select full_name from public.users where id = r.paid_by_id),
        'payment_note', r.payment_note,
        'awaiting', case when r.status in ('submitted', 'endorsed') then 'executive' end,
        'is_editable', r.status in ('draft', 'changes_requested'),
        'created_at', r.created_at
    );
$$;

create or replace function public.finance_approve(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
    v_role text := coalesce(public.current_user_role()::text, '');
begin
    perform public.finance_require_see();
    if not (v_role = 'executive'
            or (v_role = 'director' and public.finance_director_final_approval())) then
        raise exception 'Only Peter approves a finance request.' using errcode = 'PT403';
    end if;
    r := public.finance_load(p_id);
    -- 'endorsed' is the old second step; anything left there is approved the same way.
    perform public.finance_require_state(r, array['submitted', 'endorsed'], 'approved');
    update public.finance_requests
       set status = 'approved', approved_at = now(), approved_by_id = auth.uid(),
           revision_note = null, revision_at = null, revision_by_id = null,
           updated_at = now()
     where id = r.id
    returning * into r;
    perform public.log_activity('FINANCE_REQUEST_APPROVED',
        format('Approved %s', public.finance_label(r)), r.id, null);
    return public.finance_request_json(r);
end;
$$;

create or replace function public.finance_review(p_id uuid)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
    select public.finance_approve(p_id);
$$;

create or replace function public.finance_send_back(p_id uuid, p_note text, p_send_to text default 'finance')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.finance_requests;
    v_role text := coalesce(public.current_user_role()::text, '');
    v_to text := coalesce(p_send_to, 'finance');
    v_status text;
    v_where text;
begin
    perform public.finance_require_see();
    if p_note is null or char_length(p_note) < 3 or char_length(p_note) > 2000 then
        raise exception 'Say why it is going back (3 to 2000 characters).' using errcode = 'PT422';
    end if;
    if v_to not in ('finance', 'director') then
        raise exception 'send_to must be "finance" or "director".' using errcode = 'PT422';
    end if;
    r := public.finance_load(p_id);

    -- There is no review step to send it back to any more: only to finance,
    -- by whoever may approve it.
    if v_to = 'director' then
        raise exception 'A request goes back to finance only.' using errcode = 'PT422';
    end if;
    if not (v_role = 'executive'
            or (v_role = 'director' and public.finance_director_final_approval())) then
        raise exception 'Only whoever approves it can send it back.' using errcode = 'PT403';
    end if;
    if r.status not in ('submitted', 'endorsed', 'approved') then
        raise exception '% is %; it cannot be sent back now.', r.reference, r.status
            using errcode = 'PT409';
    end if;
    v_status := 'changes_requested';
    v_where := 'finance';

    update public.finance_requests
       set status = v_status,
           revision_note = btrim(p_note), revision_at = now(), revision_by_id = auth.uid(),
           -- Signatures no longer stand for what comes back.
           reviewed_at = null, reviewed_by_id = null,
           approved_at = null, approved_by_id = null,
           updated_at = now()
     where id = r.id
    returning * into r;
    perform public.log_activity('FINANCE_REQUEST_SENT_BACK',
        format('Sent %s back to %s: %s', public.finance_label(r), v_where, r.revision_note), r.id, null);
    return public.finance_request_json(r);
end;
$$;

create or replace function public.notifications_on_finance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_actor uuid[] := array_remove(array[auth.uid()], null);
    v_what text := 'Finance request ' || new.reference;
    v_total text := 'IDR ' || to_char(round(public.finance_total(new.id)::numeric),
                                       'FM999,999,999,999,999,990');
begin
    begin
        if new.status = 'submitted' and old.status in ('draft', 'changes_requested') then
            perform public.notifications_enqueue(
                public.notifications_role_users('executive'), v_actor, 'finance_submitted',
                v_what || ' has been submitted for approval',
                array['Finance has submitted a request for approval.',
                      'Reference: ' || new.reference || E'\n'
                          || 'Title: ' || new.title || E'\n'
                          || 'Total: ' || v_total
                          || coalesce(E'\nDue: ' || public.notifications_date(new.due_date), '')],
                '/finance-requests', 'Open finance requests', 'finance_requests', new.id);
            -- The director is copied in: asked to approve only when handed that.
            perform public.notifications_enqueue(
                public.notifications_role_users('director'), v_actor, 'finance_submitted_cc',
                case when public.finance_director_final_approval()
                     then v_what || ' has been submitted for approval'
                     else v_what || ' has been sent to Peter (for your information)' end,
                array[case when public.finance_director_final_approval()
                           then 'Finance has submitted a request for approval.'
                           else 'Finance has sent a request to Peter for approval. No action is needed from you.' end,
                      'Reference: ' || new.reference || E'\n'
                          || 'Title: ' || new.title || E'\n'
                          || 'Total: ' || v_total
                          || coalesce(E'\nDue: ' || public.notifications_date(new.due_date), '')],
                '/finance-requests', 'Open finance requests', 'finance_requests', new.id);
        elsif new.status = 'changes_requested' then
            perform public.notifications_enqueue(
                public.notifications_role_users('finance'), v_actor, 'finance_sent_back',
                v_what || ' has been sent back for changes',
                array[v_what || ' (' || new.title || ') has been sent back to finance for changes.',
                      case when new.revision_note is not null
                           then 'The reason given: ' || new.revision_note end],
                '/finance-requests', 'Open finance requests', 'finance_requests', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_finance: %', sqlerrm;
    end;
    return null;
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
