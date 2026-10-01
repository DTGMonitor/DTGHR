-- ===========================================================================
-- Leave counts the days somebody would have worked.
--
-- The request form counted Monday to Friday and the server took its number
-- as given. That is right for office staff, apart from public holidays, and
-- wrong for the rotating crew: a Break on a weekday cost a day of leave, and
-- a day shift on a Saturday cost nothing.
--
-- leaves_count_days() counts, for each day in the range:
--
--   * where the person has a roster cell: a working code (DS, NS, C, D, TW,
--     T) or a leave code already planned there (AL, SL, DL) counts; B, PH,
--     O and ST do not. A published schedule's cell wins over a draft's.
--   * where there is no cell yet (a month not rostered): Monday to Friday,
--     less national holidays. Cuti bersama counts: it is taken from annual
--     leave.
--
-- submit_leave_request() now counts the days itself; days_requested in the
-- payload is ignored. GET /leaves/working-days gives the form the same
-- number before it is sent. A request already made keeps its count.
-- Otherwise submit_leave_request() is as in 20260926000300_leaves.sql.
-- ===========================================================================

begin;

create or replace function public.leaves_count_days(p_employee_id uuid, p_start date, p_end date)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select count(*)::int
      from generate_series(p_start, p_end, interval '1 day') g(d)
      left join lateral (
            select a.shift_code
              from public.shift_assignments a
              join public.work_schedules s on s.id = a.schedule_id
             where a.employee_id = p_employee_id
               and a.date = g.d::date
             order by (s.status = 'published') desc, a.updated_at desc
             limit 1
      ) c on true
     where case
             when c.shift_code is not null then
                  c.shift_code in ('DS', 'NS', 'C', 'D', 'TW', 'T', 'AL', 'SL', 'DL')
             else extract(isodow from g.d) < 6
                  and not exists (select 1 from public.public_holidays h
                                   where h.date = g.d::date and h.is_national)
           end;
$$;

revoke all on function public.leaves_count_days(uuid, date, date) from public, anon, authenticated;

-- GET /leaves/working-days: the caller's own count, for the request form.
create or replace function public.leaves_working_days(p_start date, p_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype := public.leaves_require_employee();
begin
    if p_start is null or p_end is null or p_end < p_start then
        return jsonb_build_object('days', 0);
    end if;
    if p_end - p_start > 366 then
        raise exception 'A leave request can cover at most a year.' using errcode = 'PT422';
    end if;
    return jsonb_build_object('days', public.leaves_count_days(v_employee.id, p_start, p_end));
end;
$$;

revoke all on function public.leaves_working_days(date, date) from public, anon;
grant execute on function public.leaves_working_days(date, date) to authenticated;

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
    exception when others then
        raise exception 'Invalid start_date or end_date' using errcode = 'PT422';
    end;
    if v_start is null or v_end is null then
        raise exception 'start_date and end_date are required' using errcode = 'PT422';
    end if;
    if v_end < v_start then
        raise exception 'end_date must be on or after start_date' using errcode = 'PT422';
    end if;
    -- Counted here, from the roster and the holiday calendar; whatever the
    -- browser sent as days_requested is not trusted.
    v_days := public.leaves_count_days(v_employee.id, v_start, v_end);
    if v_days <= 0 then
        raise exception 'There are no working days between those dates.' using errcode = 'PT422';
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

commit;
