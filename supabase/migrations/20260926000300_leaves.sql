-- ===========================================================================
-- Leaves: the FastAPI line's rules, in place of the older ones.
--
-- Ports app/api/routes/leaves.py, app/services/leave_service.py and
-- app/services/annual_leave.py. Lintang's functions (20260916000500 and
-- 20260921000100) implemented an earlier rule set -- one signature from an
-- administrator, the executive may overturn, four flat entitlements. The
-- FastAPI line has since changed all three, and it wins:
--
--   * Who approves. Nobody signs their own leave -- not even the director,
--     whose leave goes to the founders. An administrator (director or
--     executive) or anyone in management approves anybody else's; otherwise
--     only the requester's named manager. A decision is final: approve and
--     reject act on pending requests only. Nobody overturns.
--   * What kinds. The handbook's twelve (annual, sick, study, the family and
--     special leave), served per person: study only to those marked eligible,
--     the sex-limited ones only where the recorded gender allows.
--   * Annual leave is computed, not stored: opening balance plus one day a
--     month since joining, less every distinct date away -- roster AL cells and
--     approved annual requests, a date counted once. Approving an annual
--     request is the deduction; cancelling it is the refund. Only annual has a
--     card. Founders carry no balance and book no leave.
--
-- Function names Lintang used are kept where the endpoint is the same, so the
-- grants and anything that calls them carry on.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Small helpers.
-- ---------------------------------------------------------------------------

-- Python's str(float): 3.0 -> '3.0', 1.5 -> '1.5'. The backend's messages
-- and activity descriptions interpolate floats, and the screens show them.
create or replace function public.leaves_pyfloat(p double precision)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case
        when p is null then 'None'
        when p = trunc(p) and abs(p) < 1e16 then trunc(p)::bigint::text || '.0'
        else p::text
    end;
$$;

-- Python's format(x, 'g') for the values that occur here: 3.0 -> '3'.
create or replace function public.leaves_pyg(p double precision)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case
        when p = trunc(p) and abs(p) < 1e16 then trunc(p)::bigint::text
        else p::text
    end;
$$;

-- The handbook's leave types (app/models/enums.py LEAVE_RULES), in order.
create or replace function public.leaves_rules()
returns table (
    ord int,
    value text,
    label text,
    grp text,
    allowance_days numeric,
    note text,
    needs_document boolean,
    limited_to_gender text,
    by_grant_only boolean
)
language sql
immutable
set search_path = public, pg_temp
as $$
    values
    (1, 'annual', 'Annual leave', 'core', null::numeric,
        'Accrues at one day a month. Your balance is shown above.', false, null::text, false),
    (2, 'sick', 'Sick leave', 'core', null,
        'A medical certificate is expected for anything beyond a day.', false, null, false),
    (3, 'study', 'Study leave', 'core', null,
        'Granted in place of spending annual leave. Available to the people the administrator has marked eligible.',
        false, null, true),
    (4, 'maternity', 'Maternity leave', 'family', null,
        'At least 3 months, and up to 3 months more where a medical certificate supports it. The first 4 months are paid in full; the fifth and sixth are paid at 75% of wages, under UU No. 4/2024.',
        true, 'female', false),
    (5, 'paternity', 'Paternity / spousal support leave', 'family', 2,
        '2 days to accompany your wife during childbirth or a miscarriage, extendable by up to 3 days or as otherwise agreed. More time may be given where there are health complications.',
        false, 'male', false),
    (6, 'miscarriage', 'Miscarriage leave', 'family', null,
        '1.5 months, or the period recommended by a doctor, obstetrician, gynaecologist or midwife.',
        true, 'female', false),
    (7, 'menstrual', 'Menstrual leave', 'family', 2,
        'The first and second day, where you are in pain. Tell your lead engineer or a director. Fully paid, under Article 81 of Law 13/2003.',
        false, 'female', false),
    (8, 'marriage', 'Your marriage', 'special', 3, '3 days, fully paid.', false, null, false),
    (9, 'child_marriage', 'Your child''s marriage', 'special', 2, '2 days, fully paid.', false, null, false),
    (10, 'child_ceremony', 'Your child''s circumcision or baptism', 'special', 2, '2 days, fully paid.', false, null, false),
    (11, 'bereavement', 'Death of a spouse, parent, in-law or child', 'special', 2,
        '2 days, fully paid. Includes a son- or daughter-in-law.', false, null, false),
    (12, 'bereavement_household', 'Death of a family member in your household', 'special', 1,
        '1 day, fully paid.', false, null, false);
$$;

-- Peter and Mark: management, and exempt from review (leave_service.is_founder).
create or replace function public.leaves_is_founder(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (select e.is_management_role and not e.kpi_review_required
           from public.employees e where e.id = p_employee_id),
        false);
$$;

-- get_or_create_balances: seeds DEFAULT_LEAVE_ENTITLEMENTS, which is annual
-- alone, at a placeholder 0 -- annual is computed on read.
create or replace function public.leaves_seed_balances(p_employee_id uuid, p_year int)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
    insert into public.leave_balances (id, employee_id, leave_type, year, total_days, used_days)
    values (gen_random_uuid(), p_employee_id, 'annual', p_year, 0, 0)
    on conflict (employee_id, leave_type, year) do nothing;
$$;

-- The old flat defaults. Kept for anything that still reads them; annual is 0
-- now, and there is no sick, personal or unpaid entitlement.
create or replace function public.default_leave_entitlement(p_leave_type text)
returns double precision
language sql
immutable
as $$
    select 0.0::double precision;
$$;

-- ---------------------------------------------------------------------------
-- 1. Annual leave position (app/services/annual_leave.py).
--
-- As at p_through: entitlement (opening + accrual), distinct dates away from
-- roster AL cells and approved annual requests, and what is left. With
-- p_period_start, taken_in_period counts the dates inside the period.
-- ---------------------------------------------------------------------------
create or replace function public.leaves_annual_position(
    p_employee_id uuid,
    p_through date,
    p_period_start date default null
)
returns table (
    entitlement numeric,
    taken int,
    taken_in_period int,
    remaining numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with emp as (
        select coalesce(e.annual_leave_opening_balance, 0)::numeric
               + case when e.date_of_joining is null then 0
                      else public.accrued_annual_leave(e.date_of_joining, p_through) end as ent
          from public.employees e
         where e.id = p_employee_id
    ),
    days as (
        select a.date as d
          from public.shift_assignments a
         where a.employee_id = p_employee_id
           and a.shift_code = 'AL'
           and a.date <= p_through
        union
        select g::date
          from public.leave_requests lr,
               generate_series(lr.start_date, least(lr.end_date, p_through), interval '1 day') g
         where lr.employee_id = p_employee_id
           and lr.leave_type = 'annual'
           and lr.status = 'approved'
           and lr.start_date <= p_through
    ),
    counted as (
        select count(*)::int as n,
               count(*) filter (where p_period_start is null
                                   or d between p_period_start and p_through)::int as n_period
          from days
    )
    select coalesce((select ent from emp), 0),
           counted.n,
           counted.n_period,
           round(coalesce((select ent from emp), 0) - counted.n, 4)
      from counted;
$$;

-- ---------------------------------------------------------------------------
-- 2. The response shape.
-- ---------------------------------------------------------------------------
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
        'employee_name', case when e.id is null then null
                              else e.first_name || ' ' || e.last_name end,
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

-- The employee record behind the session, or the backend's 403.
create or replace function public.leaves_require_employee()
returns public.employees
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
begin
    select * into v_employee from public.employees where user_id = auth.uid() limit 1;
    if not found then
        raise exception 'No employee profile linked to this user account' using errcode = 'PT403';
    end if;
    return v_employee;
end;
$$;

create or replace function public.leaves_check_paging(p_page int, p_page_size int)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    if p_page < 1 then
        raise exception 'page must be greater than or equal to 1' using errcode = 'PT422';
    end if;
    if p_page_size < 1 or p_page_size > 100 then
        raise exception 'page_size must be between 1 and 100' using errcode = 'PT422';
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. GET /leaves/types
-- ---------------------------------------------------------------------------
create or replace function public.leaves_types()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
    v_gender text;
begin
    select * into v_employee from public.employees where user_id = auth.uid() limit 1;
    if not found then
        return '[]'::jsonb;
    end if;

    v_gender := nullif(lower(trim(coalesce(v_employee.gender, ''))), '');

    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'value', r.value,
                   'label', r.label,
                   'group', r.grp,
                   'allowance_days', r.allowance_days,
                   'note', r.note,
                   'needs_document', r.needs_document
               ) order by r.ord)
          from public.leaves_rules() r
         where not (r.by_grant_only and not v_employee.study_leave_eligible)
           and not (r.limited_to_gender is not null and v_gender is not null
                    and v_gender <> r.limited_to_gender)
    ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. GET /leaves  (the caller's own requests, newest first)
-- ---------------------------------------------------------------------------
create or replace function public.leaves_list_mine(
    p_page int default 1,
    p_page_size int default 20,
    p_status text default null,
    p_leave_type text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype := public.leaves_require_employee();
    v_total int;
    v_items jsonb;
begin
    perform public.leaves_check_paging(p_page, p_page_size);
    if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'cancelled') then
        raise exception 'Invalid status ''%''', p_status using errcode = 'PT422';
    end if;
    if p_leave_type is not null and not exists (select 1 from public.leaves_rules() r where r.value = p_leave_type) then
        raise exception 'Invalid leave_type ''%''', p_leave_type using errcode = 'PT422';
    end if;

    select count(*)::int into v_total
      from public.leave_requests lr
     where lr.employee_id = v_employee.id
       and (p_status is null or lr.status = p_status)
       and (p_leave_type is null or lr.leave_type = p_leave_type);

    select coalesce(jsonb_agg(public.leave_request_json(x.id) order by x.created_at desc), '[]'::jsonb)
      into v_items
      from (
          select lr.id, lr.created_at
            from public.leave_requests lr
           where lr.employee_id = v_employee.id
             and (p_status is null or lr.status = p_status)
             and (p_leave_type is null or lr.leave_type = p_leave_type)
           order by lr.created_at desc
           offset (p_page - 1) * p_page_size
           limit p_page_size
      ) x;

    return jsonb_build_object('items', v_items, 'total', v_total,
                              'page', p_page, 'page_size', p_page_size);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. GET /leaves/balances and /leaves/balances/{employee_id}
--
-- p_employee_id null: the caller's own. Otherwise the caller must be that
-- employee's named manager -- the backend does not open this to
-- administrators. Annual only, with the computed figures twice: as the year
-- will close, and as the current month closes. Founders get [].
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
    v_me public.employees%rowtype := public.leaves_require_employee();
    v_target public.employees%rowtype;
    v_year int := coalesce(p_year, extract(year from public.local_today())::int);
    v_year_end date;
    v_month_end date;
    v_now record;
    v_proj record;
    v_row public.leave_balances%rowtype;
begin
    if p_employee_id is null or p_employee_id = v_me.id then
        v_target := v_me;
    else
        select * into v_target from public.employees where id = p_employee_id;
        if not found then
            raise exception 'Employee not found' using errcode = 'PT404';
        end if;
        if v_target.manager_id is distinct from v_me.id then
            raise exception 'You are not the manager of this employee' using errcode = 'PT403';
        end if;
    end if;

    perform public.leaves_seed_balances(v_target.id, v_year);

    if public.leaves_is_founder(v_target.id) then
        return '[]'::jsonb;
    end if;

    v_year_end := make_date(v_year, 12, 31);
    v_month_end := least(
        (date_trunc('month', public.local_today()) + interval '1 month - 1 day')::date,
        v_year_end);

    select * into v_now from public.leaves_annual_position(v_target.id, v_month_end);
    select * into v_proj from public.leaves_annual_position(v_target.id, v_year_end);

    select * into v_row from public.leave_balances
     where employee_id = v_target.id and leave_type = 'annual' and year = v_year;

    return jsonb_build_array(jsonb_build_object(
        'id', v_row.id,
        'employee_id', v_row.employee_id,
        'leave_type', 'annual',
        'year', v_year,
        'total_days', round(v_proj.entitlement, 2),
        'used_days', v_proj.taken,
        'remaining_days', round(v_proj.remaining, 2),
        'as_at', v_month_end,
        'accrued_now', round(v_now.entitlement, 2),
        'used_now', v_now.taken,
        'remaining_now', round(v_now.remaining, 2),
        'year_end', v_year_end
    ));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. POST /leaves
-- ---------------------------------------------------------------------------
create or replace function public.submit_leave_request(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype := public.leaves_require_employee();
    v_leave_type text := p_payload->>'leave_type';
    v_start date;
    v_end date;
    v_days double precision;
    v_reason text := p_payload->>'reason';
    v_year int;
    v_remaining numeric;
    v_balance public.leave_balances%rowtype;
    v_id uuid := gen_random_uuid();
begin
    -- Request validation (the Pydantic schema's 422s).
    if v_leave_type is null or not exists (select 1 from public.leaves_rules() r where r.value = v_leave_type) then
        raise exception 'Invalid leave_type ''%''', coalesce(v_leave_type, '') using errcode = 'PT422';
    end if;
    begin
        v_start := (p_payload->>'start_date')::date;
        v_end := (p_payload->>'end_date')::date;
        v_days := (p_payload->>'days_requested')::double precision;
    exception when others then
        raise exception 'Invalid start_date, end_date or days_requested' using errcode = 'PT422';
    end;
    if v_start is null or v_end is null or v_days is null then
        raise exception 'start_date, end_date and days_requested are required' using errcode = 'PT422';
    end if;
    if v_end < v_start then
        raise exception 'end_date must be on or after start_date' using errcode = 'PT422';
    end if;
    if v_days <= 0 then
        raise exception 'days_requested must be positive' using errcode = 'PT422';
    end if;

    v_year := extract(year from v_start)::int;

    if public.leaves_is_founder(v_employee.id) then
        raise exception 'Founders do not carry a leave balance.' using errcode = 'PT403';
    end if;

    if v_leave_type = 'annual' then
        select p.remaining into v_remaining
          from public.leaves_annual_position(v_employee.id, make_date(v_year, 12, 31)) p;
        v_remaining := coalesce(v_remaining, 0);
        if v_remaining < v_days then
            raise exception 'Insufficient annual leave. % day(s) left at the end of %, % requested.',
                to_char(v_remaining, 'FM999999990.00'), v_year, public.leaves_pyg(v_days)
                using errcode = 'PT400';
        end if;
    else
        perform public.leaves_seed_balances(v_employee.id, v_year);
        select * into v_balance from public.leave_balances
         where employee_id = v_employee.id and leave_type = v_leave_type and year = v_year;
        if found and (v_balance.total_days - v_balance.used_days) < v_days then
            raise exception 'Insufficient % leave balance. Remaining: %, Requested: %',
                v_leave_type,
                public.leaves_pyfloat(v_balance.total_days - v_balance.used_days),
                public.leaves_pyfloat(v_days)
                using errcode = 'PT400';
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
               v_employee.first_name, v_employee.last_name,
               public.leaves_pyfloat(v_days), v_leave_type),
        v_id
    );

    return public.leave_request_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. GET /leaves/pending-approvals
--
-- Administrators and management: every pending request but their own.
-- Anyone else: their direct reports'. Oldest first.
-- ---------------------------------------------------------------------------
create or replace function public.leaves_pending_approvals(
    p_page int default 1,
    p_page_size int default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees%rowtype;
    v_has_me boolean;
    v_all boolean;
    v_total int;
    v_items jsonb;
begin
    perform public.leaves_check_paging(p_page, p_page_size);

    select * into v_me from public.employees where user_id = auth.uid() limit 1;
    v_has_me := found;
    v_all := public.is_admin() or (v_has_me and v_me.is_management_role);

    if not v_all and not v_has_me then
        return jsonb_build_object('items', '[]'::jsonb, 'total', 0,
                                  'page', p_page, 'page_size', p_page_size);
    end if;

    with queue as (
        select lr.id, lr.created_at
          from public.leave_requests lr
          join public.employees e on e.id = lr.employee_id
         where lr.status = 'pending'
           and case when v_all
                    then (not v_has_me or lr.employee_id <> v_me.id)
                    else e.manager_id = v_me.id
               end
    ),
    page as (
        select q.id, q.created_at from queue q
         order by q.created_at asc
        offset (p_page - 1) * p_page_size
         limit p_page_size
    )
    select (select count(*)::int from queue),
           coalesce((select jsonb_agg(public.leave_request_json(x.id) order by x.created_at asc)
                       from page x), '[]'::jsonb)
      into v_total, v_items;

    return jsonb_build_object('items', v_items, 'total', v_total,
                              'page', p_page, 'page_size', p_page_size);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. GET /leaves/{id}  (own, or a direct report's)
-- ---------------------------------------------------------------------------
create or replace function public.leaves_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees%rowtype := public.leaves_require_employee();
    v_request public.leave_requests%rowtype;
begin
    select * into v_request from public.leave_requests where id = p_id;
    if not found then
        raise exception 'Leave request not found' using errcode = 'PT404';
    end if;

    if v_request.employee_id <> v_me.id and not exists (
        select 1 from public.employees e
         where e.id = v_request.employee_id and e.manager_id = v_me.id
    ) then
        raise exception 'Access denied' using errcode = 'PT403';
    end if;

    return public.leave_request_json(p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Approve / reject
--
-- The gate, in the backend's order: the request exists; the reviewer has an
-- employee record unless they are an administrator; it is still pending;
-- nobody signs their own; then an administrator, management, or the named
-- manager.
-- ---------------------------------------------------------------------------
create or replace function public.assert_can_review_leave(p_request_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_reviewer public.employees%rowtype;
    v_has_reviewer boolean;
    v_request public.leave_requests%rowtype;
begin
    select * into v_request from public.leave_requests where id = p_request_id;
    if not found then
        raise exception 'Leave request not found' using errcode = 'PT404';
    end if;

    select * into v_reviewer from public.employees where user_id = auth.uid() limit 1;
    v_has_reviewer := found;
    if not v_has_reviewer and not public.is_admin() then
        raise exception 'No employee profile linked' using errcode = 'PT403';
    end if;

    if v_request.status <> 'pending' then
        raise exception 'Leave request is already ''%''', v_request.status using errcode = 'PT400';
    end if;

    if not v_has_reviewer then
        return null;
    end if;

    if v_request.employee_id = v_reviewer.id then
        raise exception 'You cannot approve your own leave.' using errcode = 'PT403';
    end if;

    if public.is_admin() or v_reviewer.is_management_role then
        return v_reviewer.id;
    end if;

    if not exists (
        select 1 from public.employees e
         where e.id = v_request.employee_id and e.manager_id = v_reviewer.id
    ) then
        raise exception 'You are not set up to approve this person''s leave.' using errcode = 'PT403';
    end if;

    return v_reviewer.id;
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

    -- Annual deducts itself: it is computed from the dates away. The other
    -- types keep a stored counter where one exists and move it.
    if v_request.leave_type <> 'annual' then
        update public.leave_balances
           set used_days = used_days + v_request.days_requested,
               updated_at = now()
         where employee_id = v_request.employee_id
           and leave_type = v_request.leave_type
           and year = extract(year from v_request.start_date)::int;
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
-- 10. POST /leaves/{id}/cancel -- own request, pending or approved.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_leave_request(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype := public.leaves_require_employee();
    v_request public.leave_requests%rowtype;
begin
    select * into v_request from public.leave_requests where id = p_id;
    if not found then
        raise exception 'Leave request not found' using errcode = 'PT404';
    end if;

    if v_request.employee_id <> v_employee.id then
        raise exception 'You can only cancel your own leave requests' using errcode = 'PT403';
    end if;

    if v_request.status not in ('pending', 'approved') then
        raise exception 'Cannot cancel a leave request with status ''%''', v_request.status
            using errcode = 'PT400';
    end if;

    -- Annual restores itself: the request leaves the set of dates away.
    if v_request.status = 'approved' and v_request.leave_type <> 'annual' then
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

-- leave_summary() (GET /leaves/summary) is unchanged: administrators only,
-- { leave_type: { status: count } }.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.leaves_pyfloat(double precision)             from public;
revoke all on function public.leaves_pyg(double precision)                 from public;
revoke all on function public.leaves_rules()                               from public;
revoke all on function public.leaves_is_founder(uuid)                      from public;
revoke all on function public.leaves_seed_balances(uuid, int)              from public;
revoke all on function public.leaves_annual_position(uuid, date, date)     from public;
revoke all on function public.leaves_require_employee()                    from public;
revoke all on function public.leaves_check_paging(int, int)                from public;
revoke all on function public.leaves_types()                               from public;
revoke all on function public.leaves_list_mine(int, int, text, text)       from public;
revoke all on function public.leaves_pending_approvals(int, int)           from public;
revoke all on function public.leaves_get(uuid)                             from public;
revoke all on function public.get_leave_balances(uuid, int)                from public;
revoke all on function public.submit_leave_request(jsonb)                  from public;
revoke all on function public.cancel_leave_request(uuid)                   from public;
revoke all on function public.assert_can_review_leave(uuid)                from public;
revoke all on function public.approve_leave_request(uuid, text)            from public;
revoke all on function public.reject_leave_request(uuid, text)             from public;

grant execute on function public.leaves_types()                         to authenticated;
grant execute on function public.leaves_list_mine(int, int, text, text) to authenticated;
grant execute on function public.leaves_pending_approvals(int, int)     to authenticated;
grant execute on function public.leaves_get(uuid)                       to authenticated;
grant execute on function public.get_leave_balances(uuid, int)          to authenticated;
grant execute on function public.submit_leave_request(jsonb)            to authenticated;
grant execute on function public.cancel_leave_request(uuid)             to authenticated;
grant execute on function public.approve_leave_request(uuid, text)      to authenticated;
grant execute on function public.reject_leave_request(uuid, text)       to authenticated;
grant execute on function public.leave_summary()                        to authenticated;

commit;
