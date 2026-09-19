-- ===========================================================================
-- Move authentication from FastAPI into Supabase Auth.
--
-- The old backend kept its own `public.users` table with bcrypt hashes and
-- signed its own HS256 tokens. Three tables carry foreign keys to it
-- (employees.user_id, activity_logs.actor_id / target_user_id,
-- shift_change_requests.requested_by_id / reviewed_by_id), so the ids must
-- survive the move or every one of those references breaks.
--
-- This migration therefore copies each row into `auth.users` keeping the SAME
-- uuid, and demotes `public.users` to a profile table hanging off it. Nobody
-- resets a password: GoTrue verifies bcrypt in Go and accepts the $2b$ hashes
-- Python's bcrypt produced.
--
-- Safe to re-run.
-- ===========================================================================

begin;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Guard: refuse to run if an auth user already holds one of these addresses
-- under a different id. Copying on top of that would orphan a profile.
-- ---------------------------------------------------------------------------
do $guard$
declare
    clash text;
begin
    if not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'users'
          and column_name = 'hashed_password'
    ) then
        raise notice 'public.users.hashed_password already dropped - auth migration appears to have run.';
        return;
    end if;

    select string_agg(u.email, ', ')
      into clash
      from public.users u
      join auth.users a on lower(a.email) = lower(u.email)
     where a.id <> u.id;

    if clash is not null then
        raise exception
            'auth.users already contains these addresses under different ids: %. Resolve by hand before migrating.',
            clash;
    end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 1. Copy profiles into auth.users, id for id.
--
-- 'entra-id-managed' was the placeholder the backend wrote for users
-- auto-provisioned from an Entra token; it is not a real hash, so those
-- accounts get a NULL password and can only ever sign in through SSO.
-- ---------------------------------------------------------------------------
do $copy_users$
begin
    if not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'users'
          and column_name = 'hashed_password'
    ) then
        return;
    end if;

    execute $sql$
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        )
        select
            '00000000-0000-0000-0000-000000000000',
            u.id,
            'authenticated',
            'authenticated',
            lower(u.email),
            nullif(u.hashed_password, 'entra-id-managed'),
            coalesce(u.created_at, now()),
            jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
            jsonb_build_object('full_name', u.full_name, 'email', lower(u.email), 'email_verified', true),
            coalesce(u.created_at, now()),
            coalesce(u.updated_at, now()),
            '', '', '', ''
        from public.users u
        on conflict (id) do nothing
    $sql$;
end
$copy_users$;

-- ---------------------------------------------------------------------------
-- 2. Matching auth.identities rows. Without one, GoTrue treats the account as
--    having no linked provider and refuses the password grant.
--
--    `provider_id` was added to this table in a later GoTrue release and is
--    NOT NULL where it exists, so the insert is built to match whichever
--    shape this project is on.
-- ---------------------------------------------------------------------------
do $identities$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'auth' and table_name = 'identities'
          and column_name = 'provider_id'
    ) then
        insert into auth.identities (
            id, user_id, provider_id, identity_data, provider,
            last_sign_in_at, created_at, updated_at
        )
        select
            gen_random_uuid(), a.id, a.id::text,
            jsonb_build_object('sub', a.id::text, 'email', a.email, 'email_verified', true),
            'email', a.created_at, a.created_at, a.created_at
        from auth.users a
        where not exists (
            select 1 from auth.identities i
            where i.user_id = a.id and i.provider = 'email'
        );
    else
        insert into auth.identities (
            id, user_id, identity_data, provider,
            last_sign_in_at, created_at, updated_at
        )
        select
            gen_random_uuid(), a.id,
            jsonb_build_object('sub', a.id::text, 'email', a.email, 'email_verified', true),
            'email', a.created_at, a.created_at, a.created_at
        from auth.users a
        where not exists (
            select 1 from auth.identities i
            where i.user_id = a.id and i.provider = 'email'
        );
    end if;
end
$identities$;

-- ---------------------------------------------------------------------------
-- 3. Demote public.users to a profile table.
--
-- `is_superuser`, `full_name` and `password_change_required` stay here rather
-- than moving into the JWT: app_metadata can only be written with the service
-- role key, which a browser must never hold, and a lookup on this table is a
-- single primary-key hit inside the same query a policy is already running.
-- ---------------------------------------------------------------------------
alter table public.users drop column if exists hashed_password;

do $fk$
begin
    if not exists (select 1 from pg_constraint where conname = 'fk_users_id_auth_users') then
        alter table public.users
            add constraint fk_users_id_auth_users
            foreign key (id) references auth.users(id) on delete cascade;
    end if;
end
$fk$;

-- ---------------------------------------------------------------------------
-- 4. Provision a profile whenever Supabase Auth creates a user.
--
-- This covers both HR creating an account and somebody arriving through
-- Microsoft SSO for the first time. It also carries over the old backend's
-- auto-link: roster rows imported from the workbook have no user_id, because
-- the workbook only ever knew names, so the first sign-in claims the unclaimed
-- employee record whose address matches.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
    insert into public.users (id, email, full_name, is_active, is_superuser, password_change_required)
    values (
        new.id,
        new.email,
        coalesce(
            nullif(new.raw_user_meta_data->>'full_name', ''),
            nullif(new.raw_user_meta_data->>'name', ''),
            split_part(new.email, '@', 1)
        ),
        true,
        false,
        coalesce((new.raw_user_meta_data->>'password_change_required')::boolean, false)
    )
    on conflict (id) do nothing;

    update public.employees
       set user_id = new.id
     where user_id is null
       and lower(email) = lower(new.email);

    return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- 5. Backfill the same link for accounts that already existed.
-- ---------------------------------------------------------------------------
update public.employees e
   set user_id = u.id
  from public.users u
 where e.user_id is null
   and lower(e.email) = lower(u.email);

commit;
