-- ===========================================================================
-- Port core: what every other area of the FastAPI line needs first.
--
-- The screens coming across from `ui/dtg-theme-profile-kpi` read a richer
-- session and a richer employee record than this branch had. This adds them,
-- and the helpers the area migrations after it build on:
--
--   * the capability columns on `employees` -- who may manage people, write
--     the bulletin, handle contracts, work the IT queue, be bonus-eligible,
--     take study leave -- plus the management flag and PTKP status;
--   * the KPI columns the review chain uses (published, cached score and
--     band, the bonus-availability and hard-gate flags);
--   * `is_director()`, `is_platform_admin()`, `can_manage_people()` and
--     friends, so a rule is written once and read the same everywhere;
--   * a session that carries all of it, in the shape the screens expect.
--
-- Entirely additive: new columns with defaults, new functions, and
-- `session_role_json()` replaced with a superset of what it returned.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Employees: capabilities, management, PTKP.
--
-- Capabilities are flags on the employee, set in Settings by the platform
-- administrator. Each is separate on purpose: giving somebody the bulletin
-- does not give them the directory.
-- ---------------------------------------------------------------------------
alter table public.employees
    add column if not exists ptkp_status          varchar(10),
    add column if not exists is_management_role   boolean not null default false,
    add column if not exists can_write_articles   boolean not null default false,
    add column if not exists can_manage_people    boolean not null default false,
    add column if not exists can_manage_contracts boolean not null default false,
    add column if not exists bonus_eligible       boolean not null default false,
    add column if not exists is_it_support        boolean not null default false,
    add column if not exists study_leave_eligible boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. KPI: what the review chain reads and writes.
-- ---------------------------------------------------------------------------
alter table public.kpi_role_templates
    add column if not exists is_active boolean not null default true;

alter table public.kpi_template_items
    add column if not exists created_at timestamp not null default now(),
    add column if not exists updated_at timestamp not null default now();

alter table public.kpi_review_items
    add column if not exists created_at timestamp not null default now(),
    add column if not exists updated_at timestamp not null default now();

alter table public.kpi_reviews
    add column if not exists published_at        timestamp,
    add column if not exists total_score         double precision,
    add column if not exists band                varchar(16),
    add column if not exists bonus_available     boolean not null default true,
    add column if not exists hard_gate_triggered boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. Helpers.
--
-- SECURITY DEFINER and STABLE, like the ones before them: policies call them
-- once per statement, and they read `employees` without recursing through
-- its own policies.
-- ---------------------------------------------------------------------------

-- The signed-in person's employee record, or null.
create or replace function public.current_employee()
returns public.employees
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select e.* from public.employees e where e.user_id = auth.uid() limit 1;
$$;

create or replace function public.is_director()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.current_user_role() = 'director', false);
$$;

-- Who runs the platform itself: Settings, and what people may do. The
-- director -- not every superuser. Peter and Mark are superusers as
-- management and still do not administer the platform.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.is_director();
$$;

-- Adding and editing employee records: the flag and nothing but the flag.
-- Not implied by being an administrator -- Nurhuda names who gets it.
create or replace function public.can_manage_people()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce((public.current_employee()).can_manage_people, false);
$$;

create or replace function public.can_manage_contracts()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce((public.current_employee()).can_manage_contracts, false);
$$;

create or replace function public.can_write_articles()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce((public.current_employee()).can_write_articles, false);
$$;

-- A founder: management, and exempt from review. Peter and Mark.
create or replace function public.is_founder()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (public.current_employee()).is_management_role
            and not (public.current_employee()).kpi_review_required,
        false);
$$;

-- Whether the employee record linked to a user has been deactivated.
-- Deactivating somebody switches off the record, not the account; reading
-- the record means a leaver is locked out the moment they are deactivated.
create or replace function public.employee_deactivated(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (select not e.is_active from public.employees e where e.user_id = p_user_id limit 1),
        false);
$$;

-- ---------------------------------------------------------------------------
-- 4. The session, in the shape the screens read.
--
-- `session_role_json()` is merged into bootstrap_session() and, through it,
-- complete_password_change(). Replacing it with a superset gives both the
-- fields the screens from the FastAPI line expect, without touching either.
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
            public.current_user_role() in ('director', 'executive', 'finance'), false),
        'is_management', coalesce((public.current_employee()).is_management_role, false),
        'can_write_articles', public.can_write_articles(),
        'can_manage_people', public.can_manage_people(),
        'can_manage_contracts', public.can_manage_contracts(),
        'is_it_support', coalesce((public.current_employee()).is_it_support, false),
        'is_founder', public.is_founder(),
        'is_platform_admin', public.is_platform_admin()
    );
$$;

revoke all on function public.current_employee()            from public;
revoke all on function public.is_director()                 from public;
revoke all on function public.is_platform_admin()           from public;
revoke all on function public.can_manage_people()           from public;
revoke all on function public.can_manage_contracts()        from public;
revoke all on function public.can_write_articles()          from public;
revoke all on function public.is_founder()                  from public;
revoke all on function public.employee_deactivated(uuid)    from public;
grant execute on function public.current_employee()         to authenticated;
grant execute on function public.is_director()              to authenticated;
grant execute on function public.is_platform_admin()        to authenticated;
grant execute on function public.can_manage_people()        to authenticated;
grant execute on function public.can_manage_contracts()     to authenticated;
grant execute on function public.can_write_articles()       to authenticated;
grant execute on function public.is_founder()               to authenticated;
grant execute on function public.employee_deactivated(uuid) to authenticated;

commit;
