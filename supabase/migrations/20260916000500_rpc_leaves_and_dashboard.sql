-- ===========================================================================
-- Leave and dashboard RPCs.
--
-- Ports app/services/leave_service.py and the two read-only aggregate
-- endpoints. Listing leave requests is not here: that goes through
-- leave_requests_view, which RLS already scopes to own / managed / all.
-- ===========================================================================

begin;

-- Default annual entitlements, from app/models/enums.py.
create or replace function public.default_leave_entitlement(p_leave_type text)
returns double precision
language sql
immutable
as $$
    select case p_leave_type
        when 'annual'   then 12.0
        when 'sick'     then 10.0
        when 'personal' then 5.0
        when 'unpaid'   then 0.0   -- unlimited: tracked but not capped
        else 0.0
    end;
$$;

create or replace function public.leave_request_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', lr.id,
        'employee_id', lr.employee_id,
        'employee_name', e.first_name || ' ' || e.last_name,
        'leave_type', lr.leave_type,
        'start_date', lr.start_date,
        'end_date', lr.end_date,
        'days_requested', lr.days_requested,
        'reason', lr.reason,
        'status', lr.status,
        'reviewed_by', lr.reviewed_by,
        'reviewed_at', lr.reviewed_at,
        'reviewer_note', lr.reviewer_note,
        'created_at', lr.created_at,
        'updated_at', lr.updated_at
    )
    from public.leave_requests lr
    left join public.employees e on e.id = lr.employee_id
    where lr.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Balances
--
-- Seeds the four default rows on first read for a year, which is what
-- get_or_create_balances did. That write is why this is an RPC and not a view.
-- ---------------------------------------------------------------------------
create or replace function public.get_leave_balances(
    p_employee_id uuid default null,
    p_year int default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee_id uuid := coalesce(p_employee_id, public.current_employee_id());
    v_year int := coalesce(p_year, extract(year from current_date)::int);
    v_me uuid := public.current_employee_id();
begin
    if v_employee_id is null then
        raise exception 'No employee profile linked to this user account' using errcode = 'PT403';
    end if;

    if v_employee_id <> coalesce(v_me, '00000000-0000-0000-0000-000000000000'::uuid) then
        if not public.is_admin()
           and not exists (
               select 1 from public.employees e
                where e.id = v_employee_id and e.manager_id = v_me
           )
        then
            raise exception 'You are not the manager of this employee' using errcode = 'PT403';
        end if;
    end if;

    insert into public.leave_balances (id, employee_id, leave_type, year, total_days, used_days)
    select gen_random_uuid(), v_employee_id, t.leave_type, v_year,
           public.default_leave_entitlement(t.leave_type), 0
      from (values ('annual'), ('sick'), ('personal'), ('unpaid')) as t(leave_type)
     where not exists (
         select 1 from public.leave_balances b
          where b.employee_id = v_employee_id
            and b.leave_type = t.leave_type
            and b.year = v_year
     );

    return coalesce(
        (select jsonb_agg(
            jsonb_build_object(
                'id', b.id,
                'employee_id', b.employee_id,
                'leave_type', b.leave_type,
                'year', b.year,
                'total_days', b.total_days,
                'used_days', b.used_days,
                'remaining_days', b.total_days - b.used_days
            )
            order by b.leave_type
        )
        from public.leave_balances b
        where b.employee_id = v_employee_id and b.year = v_year),
        '[]'::jsonb
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Submit
-- ---------------------------------------------------------------------------
create or replace function public.submit_leave_request(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
    v_leave_type text := p_payload->>'leave_type';
    v_start date := (p_payload->>'start_date')::date;
    v_end date := (p_payload->>'end_date')::date;
    v_days double precision := (p_payload->>'days_requested')::double precision;
    v_reason text := nullif(p_payload->>'reason', '');
    v_year int;
    v_remaining double precision;
    v_id uuid := gen_random_uuid();
begin
    select * into v_employee from public.employees where id = public.current_employee_id();
    if not found then
        raise exception 'No employee profile linked to this user account' using errcode = 'PT403';
    end if;

    if v_leave_type not in ('annual', 'sick', 'personal', 'unpaid') then
        raise exception 'Unknown leave type %', v_leave_type using errcode = 'P0001';
    end if;
    if v_end < v_start then
        raise exception 'end_date must be on or after start_date' using errcode = 'P0001';
    end if;
    if v_days is null or v_days <= 0 then
        raise exception 'days_requested must be greater than zero' using errcode = 'P0001';
    end if;

    v_year := extract(year from v_start)::int;

    -- Unpaid leave is uncapped, so it skips the balance check entirely.
    if v_leave_type <> 'unpaid' then
        perform public.get_leave_balances(v_employee.id, v_year);

        select b.total_days - b.used_days into v_remaining
          from public.leave_balances b
         where b.employee_id = v_employee.id
           and b.leave_type = v_leave_type
           and b.year = v_year;

        if v_remaining is null then
            raise exception 'No balance record for leave type ''%''', v_leave_type using errcode = 'P0001';
        end if;

        if v_remaining < v_days then
            raise exception 'Insufficient % leave balance. Remaining: %, Requested: %',
                v_leave_type, v_remaining, v_days using errcode = 'P0001';
        end if;
    end if;

    if exists (
        select 1 from public.leave_requests lr
         where lr.employee_id = v_employee.id
           and lr.status in ('pending', 'approved')
           and lr.start_date <= v_end
           and lr.end_date >= v_start
    ) then
        raise exception 'Overlapping leave request already exists for the selected dates'
            using errcode = 'PT409';
    end if;

    insert into public.leave_requests (
        id, employee_id, leave_type, start_date, end_date, days_requested, reason, status
    )
    values (v_id, v_employee.id, v_leave_type, v_start, v_end, v_days, v_reason, 'pending');

    perform public.log_activity(
        'LEAVE_REQUESTED',
        format('%s %s requested %s day(s) of %s leave',
               v_employee.first_name, v_employee.last_name, v_days, v_leave_type),
        v_id
    );

    return public.leave_request_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancel / approve / reject
-- ---------------------------------------------------------------------------
create or replace function public.cancel_leave_request(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_request public.leave_requests%rowtype;
    v_employee public.employees%rowtype;
begin
    select * into v_employee from public.employees where id = public.current_employee_id();
    if not found then
        raise exception 'No employee profile linked to this user account' using errcode = 'PT403';
    end if;

    select * into v_request from public.leave_requests where id = p_id;
    if not found then
        raise exception 'Leave request not found' using errcode = 'PT404';
    end if;

    if v_request.employee_id <> v_employee.id then
        raise exception 'You can only cancel your own leave requests' using errcode = 'PT403';
    end if;

    if v_request.status not in ('pending', 'approved') then
        raise exception 'Cannot cancel a leave request with status ''%''', v_request.status
            using errcode = 'P0001';
    end if;

    -- An approved request has already been deducted; give the days back.
    if v_request.status = 'approved' and v_request.leave_type <> 'unpaid' then
        update public.leave_balances
           set used_days = greatest(0, used_days - v_request.days_requested),
               updated_at = now()
         where employee_id = v_request.employee_id
           and leave_type = v_request.leave_type
           and year = extract(year from v_request.start_date)::int;
    end if;

    update public.leave_requests
       set status = 'cancelled', updated_at = now()
     where id = p_id;

    perform public.log_activity(
        'LEAVE_CANCELLED',
        format('%s %s cancelled their %s leave request',
               v_employee.first_name, v_employee.last_name, v_request.leave_type),
        p_id,
        auth.uid()
    );

    return public.leave_request_json(p_id);
end;
$$;

-- Shared by approve and reject: a reviewer must be the requester's manager, or
-- a superuser. A superuser with no employee record of their own is still
-- allowed -- that is the HR admin account.
create or replace function public.assert_can_review_leave(p_request_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_reviewer_id uuid := public.current_employee_id();
    v_request public.leave_requests%rowtype;
begin
    select * into v_request from public.leave_requests where id = p_request_id;
    if not found then
        raise exception 'Leave request not found' using errcode = 'PT404';
    end if;

    if v_request.status <> 'pending' then
        raise exception 'Leave request is already ''%''', v_request.status using errcode = 'P0001';
    end if;

    if v_reviewer_id is null then
        if not public.is_admin() then
            raise exception 'No employee profile linked' using errcode = 'PT403';
        end if;
        return null;
    end if;

    if not public.is_admin()
       and not exists (
           select 1 from public.employees e
            where e.id = v_request.employee_id and e.manager_id = v_reviewer_id
       )
    then
        raise exception 'You are not the manager of this employee' using errcode = 'PT403';
    end if;

    return v_reviewer_id;
end;
$$;

create or replace function public.approve_leave_request(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_reviewer_id uuid := public.assert_can_review_leave(p_id);
    v_request public.leave_requests%rowtype;
    v_name text;
    v_target_user uuid;
begin
    select * into v_request from public.leave_requests where id = p_id;

    update public.leave_requests
       set status = 'approved',
           reviewed_by = v_reviewer_id,
           reviewed_at = (now() at time zone 'utc'),
           reviewer_note = p_note,
           updated_at = now()
     where id = p_id;

    if v_request.leave_type <> 'unpaid' then
        update public.leave_balances
           set used_days = used_days + v_request.days_requested,
               updated_at = now()
         where employee_id = v_request.employee_id
           and leave_type = v_request.leave_type
           and year = extract(year from v_request.start_date)::int;

        if not found then
            raise exception 'Leave balance record missing - this should not happen'
                using errcode = 'PT500';
        end if;
    end if;

    select e.first_name || ' ' || e.last_name, e.user_id
      into v_name, v_target_user
      from public.employees e where e.id = v_request.employee_id;

    perform public.log_activity(
        'LEAVE_APPROVED',
        format('Approved %s''s %s leave request', coalesce(v_name, 'Employee'), v_request.leave_type),
        p_id,
        v_target_user
    );

    return public.leave_request_json(p_id);
end;
$$;

create or replace function public.reject_leave_request(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_reviewer_id uuid := public.assert_can_review_leave(p_id);
    v_request public.leave_requests%rowtype;
    v_name text;
    v_target_user uuid;
begin
    select * into v_request from public.leave_requests where id = p_id;

    update public.leave_requests
       set status = 'rejected',
           reviewed_by = v_reviewer_id,
           reviewed_at = (now() at time zone 'utc'),
           reviewer_note = p_note,
           updated_at = now()
     where id = p_id;

    select e.first_name || ' ' || e.last_name, e.user_id
      into v_name, v_target_user
      from public.employees e where e.id = v_request.employee_id;

    perform public.log_activity(
        'LEAVE_REJECTED',
        format('Rejected %s''s %s leave request', coalesce(v_name, 'Employee'), v_request.leave_type),
        p_id,
        v_target_user
    );

    return public.leave_request_json(p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Aggregates
-- ---------------------------------------------------------------------------
create or replace function public.leave_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.is_admin() then
        raise exception 'Admin only' using errcode = 'PT403';
    end if;

    return coalesce(
        (select jsonb_object_agg(leave_type, by_status)
           from (
               select lr.leave_type,
                      jsonb_object_agg(lr.status, lr.n) as by_status
                 from (
                     select leave_type, status, count(*)::int as n
                       from public.leave_requests
                      group by leave_type, status
                 ) lr
                group by lr.leave_type
           ) grouped),
        '{}'::jsonb
    );
end;
$$;

create or replace function public.dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_today date := current_date;
    v_year int := extract(year from current_date)::int;
    v_employee_id uuid;
    v_annual public.leave_balances%rowtype;
    v_sick public.leave_balances%rowtype;
begin
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

    select * into v_annual from public.leave_balances
     where employee_id = v_employee_id and leave_type = 'annual' and year = v_year;
    select * into v_sick from public.leave_balances
     where employee_id = v_employee_id and leave_type = 'sick' and year = v_year;

    return jsonb_build_object(
        'role', 'employee',
        'annual_remaining', coalesce(v_annual.total_days - v_annual.used_days, 0),
        'annual_total', coalesce(v_annual.total_days, 0),
        'sick_remaining', coalesce(v_sick.total_days - v_sick.used_days, 0),
        'sick_total', coalesce(v_sick.total_days, 0),
        'pending_requests',
            (select count(*)::int from public.leave_requests
              where employee_id = v_employee_id and status = 'pending'),
        'total_used',
            coalesce((select sum(days_requested) from public.leave_requests
                       where employee_id = v_employee_id
                         and status = 'approved'
                         and start_date >= make_date(v_year, 1, 1)), 0)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.default_leave_entitlement(text)          from public;
revoke all on function public.leave_request_json(uuid)                 from public;
revoke all on function public.get_leave_balances(uuid, int)            from public;
revoke all on function public.submit_leave_request(jsonb)              from public;
revoke all on function public.cancel_leave_request(uuid)               from public;
revoke all on function public.assert_can_review_leave(uuid)            from public;
revoke all on function public.approve_leave_request(uuid, text)        from public;
revoke all on function public.reject_leave_request(uuid, text)         from public;
revoke all on function public.leave_summary()                          from public;
revoke all on function public.dashboard_stats()                        from public;

grant execute on function public.get_leave_balances(uuid, int)     to authenticated;
grant execute on function public.submit_leave_request(jsonb)       to authenticated;
grant execute on function public.cancel_leave_request(uuid)        to authenticated;
grant execute on function public.approve_leave_request(uuid, text) to authenticated;
grant execute on function public.reject_leave_request(uuid, text)  to authenticated;
grant execute on function public.leave_summary()                   to authenticated;
grant execute on function public.dashboard_stats()                 to authenticated;

commit;
