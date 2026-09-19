-- ===========================================================================
-- Session and employee RPCs.
--
-- These replace /auth/me, /auth/change-password and the five /employees
-- endpoints. Everything that used to be a 403 branch in a route handler is a
-- raise here.
--
-- Error convention, for PostgREST's benefit: a SQLSTATE of the form PTnnn is
-- returned to the browser as HTTP nnn, and its message becomes the response
-- body's `message`. P0001 (a bare `raise exception`) lands as 400, which is
-- what the old HTTPException(400) cases want.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Session
-- ---------------------------------------------------------------------------

-- Replaces GET /auth/me.
--
-- Also does the work `_employee_for_user` used to do on every request: claim
-- the unclaimed roster row whose address matches. The trigger on auth.users
-- covers accounts created from here on, but an account that predates this
-- migration has never passed through it, and HR may add the employee record
-- after the login exists.
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
        -- An auth user with no profile: possible if the trigger was added
        -- after the account. Build it from the token's own claims.
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
    );
end;
$$;

-- Called after supabase.auth.updateUser({ password }) succeeds. The password
-- itself is GoTrue's business now; this only clears the "must change it" flag
-- the old /auth/change-password used to reset alongside the hash.
create or replace function public.complete_password_change()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;

    update public.users
       set password_change_required = false,
           updated_at = now()
     where id = auth.uid();

    return public.bootstrap_session();
end;
$$;

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------

create or replace function public.employee_json(p_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', e.id,
        'employee_id', e.employee_id,
        'first_name', e.first_name,
        'last_name', e.last_name,
        'email', e.email,
        'phone', e.phone,
        'department', e.department,
        'position', e.position,
        'date_of_joining', e.date_of_joining,
        'annual_leave_opening_balance', e.annual_leave_opening_balance,
        'is_active', e.is_active,
        'has_account', e.user_id is not null,
        'on_leave_today', e.id in (select public.employees_on_leave_today()),
        'created_at', e.created_at,
        'updated_at', e.updated_at
    )
    from public.employees e
    where e.id = p_employee_id;
$$;

-- Replaces POST /employees. Keeps the DTG-001, DTG-002, ... sequence, which
-- is derived from the current maximum rather than a real sequence because the
-- roster import seeded ids that a sequence would not know about.
create or replace function public.create_employee(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid := gen_random_uuid();
    v_max text;
    v_next int;
    v_employee_code text;
    v_email text := p_payload->>'email';
    v_first text := p_payload->>'first_name';
    v_last  text := p_payload->>'last_name';
begin
    if not public.is_admin() then
        raise exception 'Only admin/HR can create employees' using errcode = 'PT403';
    end if;

    if coalesce(v_email, '') = '' or coalesce(v_first, '') = '' or coalesce(v_last, '') = '' then
        raise exception 'first_name, last_name and email are required' using errcode = 'P0001';
    end if;

    if exists (select 1 from public.employees where email = v_email) then
        raise exception 'An employee with this email already exists' using errcode = 'PT409';
    end if;

    select max(employee_id) into v_max
      from public.employees
     where employee_id like 'DTG-%';

    v_next := coalesce(
        (select (regexp_match(v_max, '^DTG-(\d+)$'))[1]::int + 1),
        1
    );
    v_employee_code := 'DTG-' || lpad(v_next::text, 3, '0');

    insert into public.employees (
        id, employee_id, first_name, last_name, email, phone, department, position,
        date_of_joining, annual_leave_opening_balance, is_active
    )
    values (
        v_id,
        v_employee_code,
        v_first,
        v_last,
        v_email,
        nullif(p_payload->>'phone', ''),
        p_payload->>'department',
        p_payload->>'position',
        (p_payload->>'date_of_joining')::date,
        coalesce((p_payload->>'annual_leave_opening_balance')::double precision, 0),
        true
    );

    perform public.log_activity(
        'EMPLOYEE_CREATED',
        format('Added new employee %s %s (%s)', v_first, v_last, v_employee_code),
        v_id
    );

    return public.employee_json(v_id);
end;
$$;

-- Replaces PUT /employees/{id}. Only the keys present in the payload are
-- touched, matching the old `exclude_unset` behaviour.
create or replace function public.update_employee(p_employee_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
begin
    if not public.is_admin() then
        raise exception 'Only admin/HR can update employees' using errcode = 'PT403';
    end if;

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    update public.employees e
       set first_name  = coalesce(p_payload->>'first_name', e.first_name),
           last_name   = coalesce(p_payload->>'last_name', e.last_name),
           email       = coalesce(p_payload->>'email', e.email),
           phone       = case when p_payload ? 'phone'
                              then nullif(p_payload->>'phone', '')
                              else e.phone end,
           department  = coalesce(p_payload->>'department', e.department),
           position    = coalesce(p_payload->>'position', e.position),
           date_of_joining = coalesce((p_payload->>'date_of_joining')::date, e.date_of_joining),
           annual_leave_opening_balance =
                coalesce((p_payload->>'annual_leave_opening_balance')::double precision,
                         e.annual_leave_opening_balance),
           is_active   = coalesce((p_payload->>'is_active')::boolean, e.is_active),
           updated_at  = now()
     where e.id = p_employee_id
     returning * into v_employee;

    perform public.log_activity(
        'EMPLOYEE_UPDATED',
        format('Updated employee %s %s', v_employee.first_name, v_employee.last_name),
        v_employee.id
    );

    return public.employee_json(p_employee_id);
end;
$$;

-- Replaces DELETE /employees/{id} -- which never deleted anything.
create or replace function public.deactivate_employee(p_employee_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
begin
    if not public.is_admin() then
        raise exception 'Only admin/HR can deactivate employees' using errcode = 'PT403';
    end if;

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    update public.employees set is_active = false, updated_at = now() where id = p_employee_id;

    perform public.log_activity(
        'EMPLOYEE_DEACTIVATED',
        format('Deactivated employee %s %s', v_employee.first_name, v_employee.last_name),
        v_employee.id
    );
end;
$$;

-- Replaces POST /employees/{id}/create-account.
--
-- Writing auth.users by hand is the one thing here that reaches outside the
-- application's own schema. The alternative -- GoTrue's admin API -- needs the
-- service role key, which cannot go in a browser, so it would mean standing up
-- an Edge Function and paying a cold start on exactly the kind of rare,
-- interactive action that makes a cold start most noticeable. The insert
-- mirrors the one in the auth migration, and the trigger on auth.users builds
-- the profile row.
create or replace function public.create_employee_account(p_employee_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
    v_user_id uuid := gen_random_uuid();
    v_temp_password text;
    v_full_name text;
begin
    if not public.is_admin() then
        raise exception 'Only HR administrators can create user accounts' using errcode = 'PT403';
    end if;

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    if v_employee.user_id is not null then
        raise exception 'This employee already has an account' using errcode = 'PT409';
    end if;

    if exists (select 1 from auth.users where lower(email) = lower(v_employee.email)) then
        raise exception 'A user account with this email already exists' using errcode = 'PT409';
    end if;

    -- URL-safe, same shape as the secrets.token_urlsafe(12) it replaces.
    v_temp_password := translate(
        encode(extensions.gen_random_bytes(12), 'base64'),
        '+/=', '-_'
    );
    v_full_name := v_employee.first_name || ' ' || v_employee.last_name;

    insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change
    )
    values (
        '00000000-0000-0000-0000-000000000000',
        v_user_id,
        'authenticated',
        'authenticated',
        lower(v_employee.email),
        extensions.crypt(v_temp_password, extensions.gen_salt('bf')),
        now(),
        jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
        jsonb_build_object(
            'full_name', v_full_name,
            'email', lower(v_employee.email),
            'email_verified', true,
            'password_change_required', true
        ),
        now(), now(), '', '', '', ''
    );

    if exists (
        select 1 from information_schema.columns
        where table_schema = 'auth' and table_name = 'identities' and column_name = 'provider_id'
    ) then
        insert into auth.identities (id, user_id, provider_id, identity_data, provider,
                                     last_sign_in_at, created_at, updated_at)
        values (gen_random_uuid(), v_user_id, v_user_id::text,
                jsonb_build_object('sub', v_user_id::text, 'email', lower(v_employee.email),
                                   'email_verified', true),
                'email', now(), now(), now());
    else
        insert into auth.identities (id, user_id, identity_data, provider,
                                     last_sign_in_at, created_at, updated_at)
        values (gen_random_uuid(), v_user_id,
                jsonb_build_object('sub', v_user_id::text, 'email', lower(v_employee.email),
                                   'email_verified', true),
                'email', now(), now(), now());
    end if;

    update public.employees set user_id = v_user_id, updated_at = now() where id = p_employee_id;

    perform public.log_activity(
        'ACCOUNT_CREATED',
        format('Created login account for %s', v_full_name),
        p_employee_id,
        v_user_id
    );

    return jsonb_build_object(
        'user_id', v_user_id,
        'email', v_employee.email,
        'temp_password', v_temp_password
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. SECURITY DEFINER functions are callable by anyone who can reach
-- them, so the default PUBLIC execute grant has to go first.
-- ---------------------------------------------------------------------------
revoke all on function public.bootstrap_session()                from public;
revoke all on function public.complete_password_change()         from public;
revoke all on function public.employee_json(uuid)                from public;
revoke all on function public.create_employee(jsonb)             from public;
revoke all on function public.update_employee(uuid, jsonb)       from public;
revoke all on function public.deactivate_employee(uuid)          from public;
revoke all on function public.create_employee_account(uuid)      from public;

grant execute on function public.bootstrap_session()           to authenticated;
grant execute on function public.complete_password_change()    to authenticated;
grant execute on function public.employee_json(uuid)           to authenticated;
grant execute on function public.create_employee(jsonb)        to authenticated;
grant execute on function public.update_employee(uuid, jsonb)  to authenticated;
grant execute on function public.deactivate_employee(uuid)     to authenticated;
grant execute on function public.create_employee_account(uuid) to authenticated;

commit;
