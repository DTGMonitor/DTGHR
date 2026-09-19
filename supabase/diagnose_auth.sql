-- ===========================================================================
-- Diagnose "I applied the migrations but nobody can log in".
--
-- Read-only. Paste the whole thing into the Supabase SQL editor.
--
-- The thing to understand first: migration 20260916000100 is wrapped in a
-- single transaction. If it errored anywhere, ALL of it rolled back --
-- including the copy into auth.users -- while migrations 2 to 6 would still
-- have applied cleanly on top. That leaves RLS switched on over an empty
-- auth.users, which locks out everyone and looks exactly like a bad password.
--
-- Query 1 is the one that settles it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Did the copy happen at all?
--
--    profiles == auth_users == matched_ids  -> the copy landed
--    migration_1_rolled_back = true         -> it did not; re-run that file
--                                              and read the error it gives
-- ---------------------------------------------------------------------------
select
    (select count(*) from public.users)                                    as profiles,
    (select count(*) from auth.users)                                      as auth_users,
    (select count(*) from auth.users a join public.users u on u.id = a.id) as matched_ids,
    (select count(*) from auth.identities where provider = 'email')        as email_identities,
    exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'users'
           and column_name = 'hashed_password'
    )                                                                      as migration_1_rolled_back;

-- ---------------------------------------------------------------------------
-- 2. What does each auth account actually look like?
--
--    no_password = true   -> was 'entra-id-managed'; SSO only, cannot sign in
--                            with a password (expected for some accounts)
--    hash_prefix          -> should be $2a, $2b or $2y. Anything else means
--                            the value that came across was not a bcrypt hash
--    confirmed = false    -> GoTrue will refuse the password grant
--    identities = 0       -> GoTrue treats the account as having no linked
--                            provider and refuses the password grant
--    banned_until/deleted_at should both be null
-- ---------------------------------------------------------------------------
select
    a.email,
    a.encrypted_password is null                                  as no_password,
    left(a.encrypted_password, 4)                                 as hash_prefix,
    length(a.encrypted_password)                                  as hash_length,
    a.email_confirmed_at is not null                              as confirmed,
    a.aud,
    a.role,
    a.banned_until,
    a.deleted_at,
    (select count(*) from auth.identities i where i.user_id = a.id) as identities
from auth.users a
order by a.created_at;

-- ---------------------------------------------------------------------------
-- 3. The profile side. is_active = false is refused by bootstrap_session().
-- ---------------------------------------------------------------------------
select id, email, full_name, is_active, is_superuser, password_change_required
from public.users
order by email;

-- ---------------------------------------------------------------------------
-- 4. Are the later migrations in place? Expect ~30 rows and 10 tables.
-- ---------------------------------------------------------------------------
select
    (select count(*) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
            'bootstrap_session','is_admin','current_employee_id','get_schedule_detail',
            'apply_roster_pattern','submit_leave_request','dashboard_stats',
            'create_employee_account','list_change_requests','propose_shift_changes'
        ))                                                      as key_functions_present,  -- expect 10
    (select count(*) from pg_tables
      where schemaname = 'public' and rowsecurity)              as tables_with_rls,        -- expect 10
    (select count(*) from pg_views
      where schemaname = 'public'
        and viewname in ('employees_view','leave_requests_view','activity_logs_view'))
                                                                as views_present;          -- expect 3

-- ---------------------------------------------------------------------------
-- 5. Does the trigger that provisions a profile exist?
-- ---------------------------------------------------------------------------
select tgname, tgenabled
from pg_trigger
where tgrelid = 'auth.users'::regclass and not tgisinternal;
