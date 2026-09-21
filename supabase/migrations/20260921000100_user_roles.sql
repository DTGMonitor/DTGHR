-- ===========================================================================
-- Four roles in place of one boolean.
--
-- `is_superuser` could only say "may administer" or "may not". It cannot
-- express a finance role that reads pay without approving leave, nor an
-- executive whose authority differs from the administrator's by DOMAIN rather
-- than by degree:
--
--   leave  -- one signature, from either the admin or the executive, and the
--            executive may overturn a decision the admin already made.
--   pay    -- two signatures in sequence, admin then executive. Deliberately
--            the opposite: leave is reversible and urgent, pay is neither.
--
-- Finance reads the directory and (once they exist) the compensation columns,
-- and nothing else. Not leave approval, not employee edits, not accounts, and
-- never the ratings or written assessments behind a bonus.
--
-- `is_superuser` is kept and mirrored from the role, so nothing that still
-- reads it breaks mid-deploy. The role is the source of truth.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The enum and the column.
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_type where typname = 'user_role') then
        create type public.user_role as enum ('admin', 'executive', 'finance', 'employee');
    end if;
end
$$;

alter table public.users
    add column if not exists role public.user_role not null default 'employee';

-- Backfill: today's superusers are administrators. Peter is promoted to
-- executive by hand afterwards -- there is nothing in the data that
-- distinguishes him, and guessing from a name would be worse than asking.
update public.users
   set role = 'admin'
 where is_superuser
   and role = 'employee';

-- ---------------------------------------------------------------------------
-- 2. Keep is_superuser mirrored from the role.
--
-- Both directions, so an old code path that flips is_superuser still lands
-- somewhere sane rather than leaving the two contradicting each other.
-- ---------------------------------------------------------------------------
create or replace function public.sync_superuser_with_role()
returns trigger
language plpgsql
as $$
begin
    if tg_op = 'INSERT' then
        new.is_superuser := new.role in ('admin', 'executive');
        return new;
    end if;

    if new.role is distinct from old.role then
        new.is_superuser := new.role in ('admin', 'executive');
    elsif new.is_superuser is distinct from old.is_superuser then
        -- Only demote/promote between admin and employee here. Executive and
        -- finance are deliberate choices and are never inferred.
        if new.is_superuser and new.role = 'employee' then
            new.role := 'admin';
        elsif not new.is_superuser and new.role = 'admin' then
            new.role := 'employee';
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists users_sync_superuser on public.users;
create trigger users_sync_superuser
    before insert or update on public.users
    for each row execute function public.sync_superuser_with_role();

update public.users
   set is_superuser = (role in ('admin', 'executive'))
 where is_superuser is distinct from (role in ('admin', 'executive'));

-- ---------------------------------------------------------------------------
-- 3. Helpers.
--
-- `is_admin()` keeps its existing meaning of "may administer people", and now
-- covers the executive too -- Peter is admin-like by design. Every RLS policy
-- and RPC that already calls it therefore continues to be correct, and
-- finance is excluded because it is neither.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select u.role
      from public.users u
     where u.id = auth.uid() and u.is_active;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.current_user_role() in ('admin', 'executive'), false);
$$;

-- The strict first signature: the administrator alone, not the executive.
create or replace function public.is_hr_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.current_user_role() = 'admin', false);
$$;

create or replace function public.is_executive()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.current_user_role() = 'executive', false);
$$;

create or replace function public.is_finance()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.current_user_role() = 'finance', false);
$$;

-- ---------------------------------------------------------------------------
-- 4. Leave: the executive may overturn a settled decision.
--
-- The gate previously refused anything that was not pending, which is right
-- for everyone else: a decision is final unless the executive says otherwise.
-- ---------------------------------------------------------------------------
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

    -- The executive alone may revisit a settled request. For everyone else a
    -- decision stands.
    if v_request.status <> 'pending' and not public.is_executive() then
        raise exception 'Leave request is already ''%''', v_request.status using errcode = 'P0001';
    end if;

    if v_request.status not in ('pending', 'approved', 'rejected') then
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
        raise exception 'Not authorised to review this request' using errcode = 'PT403';
    end if;

    return v_reviewer_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Approve / reject, reconciling the balance on a reversal.
--
-- Approving used to add the days unconditionally, which was safe only because
-- the gate guaranteed the request was pending. Now that the executive can
-- overturn, the days must move only on an actual transition -- otherwise
-- re-approving an approved request double-counts, and overturning an approval
-- silently leaves the days spent.
-- ---------------------------------------------------------------------------
create or replace function public.apply_leave_balance_delta(
    p_request public.leave_requests,
    p_was text,
    p_now text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_delta numeric := 0;
begin
    if p_request.leave_type = 'unpaid' then
        return;
    end if;

    if p_was <> 'approved' and p_now = 'approved' then
        v_delta := p_request.days_requested;
    elsif p_was = 'approved' and p_now <> 'approved' then
        v_delta := -p_request.days_requested;
    else
        return;
    end if;

    update public.leave_balances
       set used_days = greatest(used_days + v_delta, 0),
           updated_at = now()
     where employee_id = p_request.employee_id
       and leave_type = p_request.leave_type
       and year = extract(year from p_request.start_date)::int;
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
    v_was text;
    v_name text;
    v_target_user uuid;
begin
    select * into v_request from public.leave_requests where id = p_id;
    v_was := v_request.status;

    update public.leave_requests
       set status = 'approved',
           reviewed_by = v_reviewer_id,
           reviewed_at = (now() at time zone 'utc'),
           reviewer_note = p_note,
           updated_at = now()
     where id = p_id;

    perform public.apply_leave_balance_delta(v_request, v_was, 'approved');

    select e.first_name || ' ' || e.last_name, e.user_id
      into v_name, v_target_user
      from public.employees e where e.id = v_request.employee_id;

    perform public.log_activity(
        'LEAVE_APPROVED',
        case when v_was = 'rejected'
             then format('Overturned a rejection and approved %s''s %s leave request',
                         coalesce(v_name, 'Employee'), v_request.leave_type)
             else format('Approved %s''s %s leave request',
                         coalesce(v_name, 'Employee'), v_request.leave_type)
        end,
        -- The entity is the REQUEST, not the employee: leave_activity_view
        -- joins on it, and the fourth argument is who it happened to.
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
    v_was text;
    v_name text;
    v_target_user uuid;
begin
    select * into v_request from public.leave_requests where id = p_id;
    v_was := v_request.status;

    update public.leave_requests
       set status = 'rejected',
           reviewed_by = v_reviewer_id,
           reviewed_at = (now() at time zone 'utc'),
           reviewer_note = p_note,
           updated_at = now()
     where id = p_id;

    perform public.apply_leave_balance_delta(v_request, v_was, 'rejected');

    select e.first_name || ' ' || e.last_name, e.user_id
      into v_name, v_target_user
      from public.employees e where e.id = v_request.employee_id;

    perform public.log_activity(
        'LEAVE_REJECTED',
        case when v_was = 'approved'
             then format('Overturned an approval and rejected %s''s %s leave request',
                         coalesce(v_name, 'Employee'), v_request.leave_type)
             else format('Rejected %s''s %s leave request',
                         coalesce(v_name, 'Employee'), v_request.leave_type)
        end,
        -- The entity is the REQUEST, not the employee: leave_activity_view
        -- joins on it, and the fourth argument is who it happened to.
        p_id,
        v_target_user
    );

    return public.leave_request_json(p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Hand the role to the client.
--
-- The frontend keys its navigation and actions off this, so it has to arrive
-- with the session rather than in a second round trip.
-- ---------------------------------------------------------------------------
create or replace function public.session_role_json()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'role', coalesce(public.current_user_role()::text, 'employee'),
        'is_superuser', public.is_admin(),
        'can_approve_leave', public.is_admin(),
        'can_overturn_leave', public.is_executive(),
        'can_read_compensation', coalesce(
            public.current_user_role() in ('admin', 'executive', 'finance'), false)
    );
$$;

-- Replaced wholesale rather than wrapped: the original builds its object
-- inline, and the client needs the role in the same payload. Everything else
-- here is verbatim from 20260916000400.
create or replace function public.bootstrap_session()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid uuid := auth.uid();
    v_user public.users%rowtype;
    v_employee_id uuid;
begin
    if v_uid is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;

    select * into v_user from public.users where id = v_uid;

    if not found then
        insert into public.users (id, email, full_name, is_active, is_superuser, password_change_required)
        select
            u.id,
            u.email,
            coalesce(
                nullif(u.raw_user_meta_data->>'full_name', ''),
                nullif(u.raw_user_meta_data->>'name', ''),
                split_part(u.email, '@', 1)
            ),
            true, false, false
        from auth.users u
        where u.id = v_uid
        on conflict (id) do nothing;

        select * into v_user from public.users where id = v_uid;
    end if;

    if not coalesce(v_user.is_active, false) then
        raise exception 'User account is inactive' using errcode = 'PT403';
    end if;

    update public.employees
       set user_id = v_uid
     where user_id is null
       and lower(email) = lower(v_user.email);

    select id into v_employee_id from public.employees where user_id = v_uid limit 1;

    return jsonb_build_object(
        'id', v_user.id,
        'email', v_user.email,
        'full_name', v_user.full_name,
        'is_active', v_user.is_active,
        'is_superuser', v_user.is_superuser,
        'password_change_required', v_user.password_change_required,
        'created_at', v_user.created_at,
        'employee_id', v_employee_id
    ) || public.session_role_json();
end;
$$;

revoke all on function public.current_user_role()  from public;
revoke all on function public.is_hr_admin()        from public;
revoke all on function public.is_executive()       from public;
revoke all on function public.is_finance()         from public;
revoke all on function public.session_role_json()  from public;
revoke all on function public.apply_leave_balance_delta(public.leave_requests, text, text) from public;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.is_hr_admin()       to authenticated;
grant execute on function public.is_executive()      to authenticated;
grant execute on function public.is_finance()        to authenticated;
grant execute on function public.session_role_json() to authenticated;

commit;
