-- ===========================================================================
-- Role assignment, and an audit trail for every role and sign-in switch.
-- openspec/changes/role-assignment.
--
-- An account's role (employee, director, executive, finance) decides who
-- approves pay, who prepares purchases and who reads salaries. Until now
-- nothing in the app could set it: every login started as `employee` and the
-- rest was done by hand in the SQL editor, leaving no record of who changed
-- what. The purchasing flow leans on `finance` and `executive` -- the person
-- who keeps the books never releases the money -- so a role that can change
-- silently undermines the control it exists for.
--
--   * roles_set_user_role(): the director sets employee, finance or director
--     on an active, linked account. Nobody changes their own role, and
--     `executive` is never granted or removed here: the executive is the
--     final signature on the director's own work.
--   * roles_list(): the director's read for the Settings matrix.
--   * A trigger on public.users logs every change to role or is_active,
--     whoever made it and however -- the app, the SQL editor, the dashboard,
--     a migration. Logged, not notified: only an app change notifies.
--
-- Redefines nothing that already exists. Safe to re-run.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The label a person reads for a role.
-- ---------------------------------------------------------------------------
create or replace function public.roles_label(p_role public.user_role)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_role
        when 'director'  then 'Director'
        when 'executive' then 'Executive'
        when 'finance'   then 'Finance'
        when 'employee'  then 'Employee'
    end;
$$;

-- The name a log or notification uses for an account: the staff record's
-- name when there is one, else the login's.
create or replace function public.roles_person_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (select nullif(btrim(e.first_name || ' ' || e.last_name), '')
           from public.employees e where e.user_id = p_user_id
          order by e.is_active desc limit 1),
        (select coalesce(nullif(btrim(u.full_name), ''), u.email)
           from public.users u where u.id = p_user_id),
        'Someone');
$$;

-- ---------------------------------------------------------------------------
-- 2. The audit trigger.
--
-- A trigger, not a line in roles_set_user_role(), because the writes that
-- motivated this are the ones that never pass through the app. The WHEN
-- clause keeps it free on every other update to users. log_activity()
-- swallows its own errors, so a failed log never undoes the change.
-- ---------------------------------------------------------------------------
create or replace function public.users_audit_role_and_activation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_name text := public.roles_person_name(new.id);
    v_suffix text := case when auth.uid() is null then ' (outside the app)' else '' end;
begin
    if new.role is distinct from old.role then
        perform public.log_activity(
            'ROLE_CHANGED',
            format('%s: %s → %s%s', v_name,
                   public.roles_label(old.role), public.roles_label(new.role), v_suffix),
            new.id,
            new.id);
    end if;

    if new.is_active is distinct from old.is_active then
        perform public.log_activity(
            case when new.is_active then 'ACCOUNT_REACTIVATED' else 'ACCOUNT_DEACTIVATED' end,
            format('%s: sign-in %s%s', v_name,
                   case when new.is_active then 'switched back on' else 'switched off' end, v_suffix),
            new.id,
            new.id);
    end if;

    return null;
end;
$$;

drop trigger if exists users_audit_role_and_activation on public.users;
create trigger users_audit_role_and_activation
    after update of role, is_active on public.users
    for each row
    when (old.role is distinct from new.role or old.is_active is distinct from new.is_active)
    execute function public.users_audit_role_and_activation();

-- ---------------------------------------------------------------------------
-- 3. Setting a role.
-- ---------------------------------------------------------------------------
create or replace function public.roles_set_user_role(p_user_id uuid, p_role public.user_role)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_me uuid := auth.uid();
    v_target public.users%rowtype;
    v_emp public.employees%rowtype;
    v_old public.user_role;
    v_name text;
    v_by text;
    v_headline text;
begin
    if v_me is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    -- The director alone: not the executive, whose independence this
    -- protects, and not the people-admin flag.
    if not public.is_hr_admin() then
        raise exception 'Only the director can change roles.' using errcode = 'PT403';
    end if;
    if p_role is null then
        raise exception 'role: required' using errcode = 'PT422';
    end if;

    select * into v_target from public.users where id = p_user_id for update;
    if not found then
        raise exception 'Account not found' using errcode = 'PT404';
    end if;

    if v_target.id = v_me then
        raise exception 'You cannot change your own role.' using errcode = 'PT403';
    end if;
    if v_target.role = 'executive' or p_role = 'executive' then
        raise exception 'The executive role is set outside the app.' using errcode = 'PT403';
    end if;
    if not v_target.is_active then
        raise exception 'This account is deactivated.' using errcode = 'PT422';
    end if;

    select * into v_emp from public.employees
     where user_id = p_user_id order by is_active desc limit 1;
    if v_emp.id is null then
        raise exception 'This login is not linked to a staff record. Link it before giving it a role.'
            using errcode = 'PT422';
    end if;
    if not v_emp.is_active then
        raise exception 'This person''s staff record is deactivated.' using errcode = 'PT422';
    end if;

    v_old := v_target.role;
    if v_old = p_role then
        return jsonb_build_object('user_id', v_target.id, 'role', v_target.role,
                                  'is_superuser', v_target.is_superuser);
    end if;

    -- users_sync_superuser (before) keeps is_superuser in step; the audit
    -- trigger (after) writes the log.
    update public.users
       set role = p_role, updated_at = now()
     where id = p_user_id
    returning * into v_target;

    -- Tell the executives and the person. A failure never undoes the change.
    begin
        v_name := public.roles_person_name(p_user_id);
        v_by := coalesce(public.notifications_actor_name(), 'The director');
        v_headline := format('%s is now %s', v_name, public.roles_label(p_role));

        perform public.notifications_enqueue(
            public.notifications_role_users('executive'),
            array[v_me],
            'role_changed',
            v_headline,
            public.notifications_payload(
                'reminder', 'Roles',
                v_headline,
                null,
                array['Person', v_name,
                      'From', public.roles_label(v_old),
                      'To', public.roles_label(p_role),
                      'Changed by', v_by],
                null, null,
                '/activity', 'Open the activity log'),
            'users', p_user_id);

        perform public.notifications_enqueue(
            array[p_user_id],
            array[v_me],
            'role_changed',
            format('You now have the %s role', public.roles_label(p_role)),
            public.notifications_payload(
                case when p_role in ('finance', 'director') then 'success' else 'reminder' end,
                'Your account',
                format('You now have the %s role', public.roles_label(p_role)),
                format('%s changed your role. It applies the next time you refresh the page or sign in.', v_by),
                array['From', public.roles_label(v_old),
                      'To', public.roles_label(p_role)],
                null, null,
                '/', 'Open DTG People'),
            'users', p_user_id);
    exception when others then
        raise warning 'roles_set_user_role notify: %', sqlerrm;
    end;

    return jsonb_build_object('user_id', v_target.id, 'role', v_target.role,
                              'is_superuser', v_target.is_superuser);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The Settings matrix's read: one role per active, linked account.
-- ---------------------------------------------------------------------------
create or replace function public.roles_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.is_hr_admin() then
        raise exception 'Only the director can see roles.' using errcode = 'PT403';
    end if;

    return jsonb_build_object(
        'items', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'user_id', u.id,
                       'employee_id', e.id,
                       'role', u.role) order by e.first_name, e.last_name, e.id)
              from public.users u
              join public.employees e on e.user_id = u.id
             where u.is_active and e.is_active
        ), '[]'::jsonb),
        'finance_count', (
            select count(*)::int
              from public.users u
             where u.role = 'finance'
               and u.is_active
               and not public.employee_deactivated(u.id)
        ));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants. Supabase grants new functions to anon and authenticated by
-- default, so the internal ones are revoked from both by name.
-- ---------------------------------------------------------------------------
revoke all on function public.roles_label(public.user_role)          from public;
revoke all on function public.roles_person_name(uuid)                from public;
revoke all on function public.users_audit_role_and_activation()      from public;
revoke all on function public.roles_set_user_role(uuid, public.user_role) from public;
revoke all on function public.roles_list()                           from public;
do $$ begin
    execute 'revoke all on function public.roles_label(public.user_role) from anon, authenticated';
    execute 'revoke all on function public.roles_person_name(uuid) from anon, authenticated';
    execute 'revoke all on function public.users_audit_role_and_activation() from anon, authenticated';
    execute 'revoke all on function public.roles_set_user_role(uuid, public.user_role) from anon';
    execute 'revoke all on function public.roles_list() from anon';
end $$;
grant execute on function public.roles_set_user_role(uuid, public.user_role) to authenticated;
grant execute on function public.roles_list()                           to authenticated;

commit;
