-- ===========================================================================
-- People: the directory, the employee record, role history, profile change
-- requests and employee photos.
--
-- Ported from the FastAPI line (`employees.py`, `profile_requests.py`,
-- `auth.py`, `visibility.py`, `deps.py`). Where Lintang's earlier functions
-- (`create_employee`, `update_employee`, `deactivate_employee`,
-- `employees_view`, the `employees` select policy) disagree with the rules
-- agreed since, the FastAPI rules win and those objects are replaced here:
--
--   * adding and editing a record is the `can_manage_people` flag alone --
--     not implied by being an administrator;
--   * capability flags change only at the platform administrator's hand (the
--     director), judged on the flags that actually change;
--   * nobody deactivates the platform administrator, or themselves;
--   * the staff directory is management's; everyone else reads their own
--     record only -- including through PostgREST;
--   * employee numbers are DTG-YY-NNN by joining year;
--   * a change of position, level or department is written to the role
--     history before it is overwritten.
--
-- `reactivate_employee()` and `create_employee_account()` are left as Lintang
-- wrote them: the latter already matches `POST /employees/{id}/create-account`
-- rule for rule, and the former has no FastAPI counterpart (reactivation there
-- is `PUT /employees/{id}` with `is_active: true`, which people_update_employee
-- handles, sign-in included).
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------

-- What somebody's job was before it was what it is now (role_history.py).
create table if not exists public.employee_role_changes (
    id                   uuid primary key default gen_random_uuid(),
    created_at           timestamp not null default now(),
    updated_at           timestamp not null default now(),
    employee_id          uuid not null references public.employees(id) on delete cascade,
    effective_date       date not null,
    previous_position    varchar(200),
    new_position         varchar(200),
    previous_job_level   varchar(100),
    new_job_level        varchar(100),
    previous_department  varchar(100),
    new_department       varchar(100),
    note                 text,
    recorded_by          uuid references public.users(id) on delete set null,
    -- The salary review that went with it. salary_reviews belongs to the
    -- salary area's migration, so the foreign key is not declared here.
    salary_review_id     uuid
);
create index if not exists ix_employee_role_changes_employee_id
    on public.employee_role_changes (employee_id);
create index if not exists ix_employee_role_changes_effective_date
    on public.employee_role_changes (effective_date);

-- Asking for a personal detail to be changed (profile_request.py).
create table if not exists public.profile_change_requests (
    id               uuid primary key default gen_random_uuid(),
    created_at       timestamp not null default now(),
    updated_at       timestamp not null default now(),
    employee_id      uuid not null references public.employees(id) on delete cascade,
    requested_by     uuid references public.users(id) on delete set null,
    field            varchar(60) not null,
    current_value    text,
    requested_value  text,
    reason           text,
    status           varchar(20) not null default 'pending',
    reviewed_by      uuid references public.users(id) on delete set null,
    reviewed_at      timestamp,
    review_note      text
);
create index if not exists ix_profile_change_requests_employee_id
    on public.profile_change_requests (employee_id);
create index if not exists ix_profile_change_requests_status
    on public.profile_change_requests (status);

-- Reads and writes both go through the functions below.
alter table public.employee_role_changes   enable row level security;
alter table public.profile_change_requests enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Helpers.
-- ---------------------------------------------------------------------------

-- get_current_user(): a signed-in, active user whose employee record (if
-- any) has not been deactivated.
create or replace function public.people_require_user()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.is_active_user() or public.employee_deactivated(auth.uid()) then
        raise exception 'User not found or inactive' using errcode = 'PT401';
    end if;
end;
$$;

-- _require_directory_access(): management, an administrator, or whoever
-- holds the people-admin flag. Everyone else reads their own record only.
create or replace function public.people_can_read_directory()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.is_admin()
        or coalesce(public.current_user_role() in ('director', 'executive'), false)
        or public.can_manage_people()
        or coalesce((public.current_employee()).is_management_role, false);
$$;

create or replace function public.people_require_directory()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.people_can_read_directory() then
        raise exception 'The staff directory is available to management. Your own record is on your profile.'
            using errcode = 'PT403';
    end if;
end;
$$;

-- _require_people_admin().
create or replace function public.people_require_people_admin()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.can_manage_people() then
        raise exception 'You are not set up to add or edit employee records.'
            using errcode = 'PT403';
    end if;
end;
$$;

-- _refuse_locking_out(): nobody deactivates the platform administrator, or
-- themselves.
create or replace function public.people_refuse_locking_out(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if p_user_id is null then
        return;
    end if;
    if p_user_id = auth.uid() then
        raise exception 'You cannot deactivate your own account.' using errcode = 'PT403';
    end if;
    if exists (select 1 from public.users u where u.id = p_user_id and u.role = 'director') then
        raise exception 'The platform administrator cannot be deactivated here.'
            using errcode = 'PT403';
    end if;
end;
$$;

-- DTG-YY-NNN: the next free sequence for the year somebody joined
-- (services/employee_id.py). Counts from the highest sequence it recognises,
-- so a gap is never reused and a hand-edited number is skipped.
create or replace function public.people_next_employee_id(p_joining date)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_prefix text := 'DTG-' || lpad((extract(year from p_joining)::int % 100)::text, 2, '0') || '-';
    v_highest numeric;
    v_next text;
begin
    select coalesce(max(substr(e.employee_id, length(v_prefix) + 1)::numeric), 0)
      into v_highest
      from public.employees e
     where left(e.employee_id, length(v_prefix)) = v_prefix
       and substr(e.employee_id, length(v_prefix) + 1) ~ '^[0-9]+$';

    v_next := (v_highest + 1)::text;
    return v_prefix || lpad(v_next, greatest(3, length(v_next)), '0');
end;
$$;

-- REQUESTABLE_FIELDS, in the order the backend serves them.
create or replace function public.people_profile_fields()
returns table (key text, label text, ord int)
language sql
immutable
set search_path = public, pg_temp
as $$
    select * from (values
        ('phone', 'Phone', 1),
        ('personal_email', 'Personal email', 2),
        ('address', 'Address', 3),
        ('marital_status', 'Marital status', 4),
        ('ptkp_status', 'PTKP status', 5),
        ('religion', 'Religion', 6),
        ('emergency_contact_name', 'Emergency contact name', 7),
        ('emergency_contact_relationship', 'Emergency contact relationship', 8),
        ('emergency_contact_phone', 'Emergency contact phone', 9),
        ('national_id', 'NIK (KTP)', 10),
        ('tax_id', 'NPWP', 11),
        ('bpjs_health_no', 'BPJS Kesehatan', 12),
        ('bpjs_employment_no', 'BPJS Ketenagakerjaan', 13),
        ('bank_name', 'Bank', 14),
        ('bank_account_number', 'Account number', 15),
        ('bank_account_holder', 'Account holder', 16)
    ) as f(key, label, ord);
$$;

create or replace function public.people_profile_field_label(p_field text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select coalesce((select f.label from public.people_profile_fields() f where f.key = p_field), p_field);
$$;

-- EmployeeDetailResponse: EmployeeResponse plus every profile field, whether
-- a photo exists, and the scorecard's title.
create or replace function public.people_employee_detail_json(p_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.employee_json(e.id) || jsonb_build_object(
        'date_of_birth', e.date_of_birth,
        'place_of_birth', e.place_of_birth,
        'gender', e.gender,
        'marital_status', e.marital_status,
        'religion', e.religion,
        'ptkp_status', e.ptkp_status,
        'address', e.address,
        'personal_email', e.personal_email,
        'emergency_contact_name', e.emergency_contact_name,
        'emergency_contact_relationship', e.emergency_contact_relationship,
        'emergency_contact_phone', e.emergency_contact_phone,
        'national_id', e.national_id,
        'tax_id', e.tax_id,
        'bpjs_health_no', e.bpjs_health_no,
        'bpjs_employment_no', e.bpjs_employment_no,
        'bank_name', e.bank_name,
        'bank_account_number', e.bank_account_number,
        'bank_account_holder', e.bank_account_holder,
        'employment_type', e.employment_type,
        'contract_end_date', e.contract_end_date,
        'job_level', e.job_level,
        'work_location', e.work_location
    ) || jsonb_build_object(
        'work_pattern', e.work_pattern,
        'is_backup_engineer', e.is_backup_engineer,
        'kpi_template_id', e.kpi_template_id,
        'kpi_review_required', e.kpi_review_required,
        'kpi_exemption_reason', e.kpi_exemption_reason,
        'is_management_role', e.is_management_role,
        'can_write_articles', e.can_write_articles,
        'can_manage_people', e.can_manage_people,
        'can_manage_contracts', e.can_manage_contracts,
        'bonus_eligible', e.bonus_eligible,
        'study_leave_eligible', e.study_leave_eligible,
        'is_it_support', e.is_it_support,
        'has_photo', e.photo_path is not null,
        'kpi_template_title', (select t.title from public.kpi_role_templates t where t.id = e.kpi_template_id)
    )
    from public.employees e
    where e.id = p_employee_id;
$$;

create or replace function public.people_role_change_json(r public.employee_role_changes)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', r.id,
        'employee_id', r.employee_id,
        'effective_date', r.effective_date,
        'previous_position', r.previous_position,
        'new_position', r.new_position,
        'previous_job_level', r.previous_job_level,
        'new_job_level', r.new_job_level,
        'previous_department', r.previous_department,
        'new_department', r.new_department,
        'note', r.note,
        'created_at', r.created_at
    );
$$;

create or replace function public.people_profile_request_json(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', r.id,
        'employee_id', r.employee_id,
        'employee_name', trim(e.first_name || ' ' || e.last_name),
        'field', r.field,
        'field_label', public.people_profile_field_label(r.field),
        'current_value', r.current_value,
        'requested_value', r.requested_value,
        'reason', r.reason,
        'status', r.status,
        'review_note', r.review_note,
        'reviewed_at', r.reviewed_at,
        'created_at', r.created_at
    )
    from public.profile_change_requests r
    join public.employees e on e.id = r.employee_id
    where r.id = p_request_id;
$$;

-- ---------------------------------------------------------------------------
-- 3. The directory: GET /employees, GET /employees/{id}.
-- ---------------------------------------------------------------------------
create or replace function public.people_list_employees(
    p_page int default 1,
    p_page_size int default 20,
    p_search text default null,
    p_department text default null,
    p_include_inactive boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_page int := coalesce(p_page, 1);
    v_size int := coalesce(p_page_size, 20);
    v_search text := nullif(p_search, '');
    v_department text := nullif(p_department, '');
    v_all boolean := coalesce(p_include_inactive, false) and public.is_admin();
    v_total int;
    v_items jsonb;
begin
    perform public.people_require_user();

    if v_page < 1 then
        raise exception 'page must be at least 1' using errcode = 'PT422';
    end if;
    if v_size < 1 or v_size > 100 then
        raise exception 'page_size must be between 1 and 100' using errcode = 'PT422';
    end if;

    perform public.people_require_directory();

    with matched as (
        select e.*
          from public.employees e
         where (v_all or e.is_active)
           and (v_search is null
                or e.first_name  ilike '%' || v_search || '%'
                or e.last_name   ilike '%' || v_search || '%'
                or e.email       ilike '%' || v_search || '%'
                or e.employee_id ilike '%' || v_search || '%')
           and (v_department is null or e.department ilike '%' || v_department || '%')
    ),
    on_leave as (
        select distinct lr.employee_id
          from public.leave_requests lr
         where lr.status = 'approved'
           and lr.start_date <= public.local_today()
           and lr.end_date >= public.local_today()
    ),
    page as (
        select m.*
          from matched m
         order by m.employee_id
         offset (v_page - 1) * v_size
         limit v_size
    )
    select (select count(*)::int from matched),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'employee_id', p.employee_id,
               'first_name', p.first_name,
               'last_name', p.last_name,
               'email', p.email,
               'phone', p.phone,
               'department', p.department,
               'position', p.position,
               'date_of_joining', p.date_of_joining,
               'annual_leave_opening_balance', p.annual_leave_opening_balance,
               'is_active', p.is_active,
               'has_account', p.user_id is not null,
               'on_leave_today', p.id in (select employee_id from on_leave),
               'created_at', p.created_at,
               'updated_at', p.updated_at
           ) order by p.employee_id), '[]'::jsonb)
      into v_total, v_items
      from page p;

    return jsonb_build_object(
        'items', v_items,
        'total', v_total,
        'page', v_page,
        'page_size', v_size
    );
end;
$$;

create or replace function public.people_get_employee(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
begin
    perform public.people_require_user();

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    if v_employee.user_id is distinct from auth.uid() then
        perform public.people_require_directory();
    end if;

    return public.people_employee_detail_json(p_employee_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Writing the record: POST, PUT, DELETE /employees.
-- ---------------------------------------------------------------------------
create or replace function public.people_create_employee(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid := gen_random_uuid();
    v_code text;
    v_joining date;
begin
    perform public.people_require_user();
    -- Entering a new starter is exactly what the people-admin flag is for.
    perform public.people_require_people_admin();

    if coalesce(p_payload->>'first_name', '') = '' or coalesce(p_payload->>'last_name', '') = ''
       or coalesce(p_payload->>'email', '') = '' or coalesce(p_payload->>'department', '') = ''
       or coalesce(p_payload->>'position', '') = '' or coalesce(p_payload->>'date_of_joining', '') = '' then
        raise exception 'first_name, last_name, email, department, position and date_of_joining are required'
            using errcode = 'PT422';
    end if;

    if exists (select 1 from public.employees where email = p_payload->>'email') then
        raise exception 'An employee with this email already exists' using errcode = 'PT409';
    end if;

    v_joining := (p_payload->>'date_of_joining')::date;
    v_code := public.people_next_employee_id(v_joining);

    insert into public.employees (
        id, employee_id, first_name, last_name, email, phone, department, position,
        date_of_joining, annual_leave_opening_balance, is_active
    ) values (
        v_id, v_code,
        p_payload->>'first_name',
        p_payload->>'last_name',
        p_payload->>'email',
        p_payload->>'phone',
        p_payload->>'department',
        p_payload->>'position',
        v_joining,
        coalesce((p_payload->>'annual_leave_opening_balance')::double precision, 0),
        true
    );

    perform public.log_activity(
        'EMPLOYEE_CREATED',
        format('Added new employee %s %s (%s)', p_payload->>'first_name', p_payload->>'last_name', v_code),
        v_id
    );

    return public.employee_json(v_id);
end;
$$;

create or replace function public.people_update_employee(p_employee_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    -- Permissions, as opposed to employee data.
    c_capabilities constant text[] := array[
        'can_write_articles', 'can_manage_people', 'can_manage_contracts',
        'bonus_eligible', 'study_leave_eligible', 'is_it_support',
        'is_management_role', 'is_backup_engineer', 'kpi_review_required'];
    -- Everything EmployeeUpdate accepts. Anything else in the payload is
    -- ignored, as pydantic ignored it.
    c_fields constant text[] := array[
        'employee_id', 'first_name', 'last_name', 'email', 'phone', 'department',
        'position', 'date_of_joining', 'annual_leave_opening_balance', 'is_active',
        'date_of_birth', 'place_of_birth', 'gender', 'marital_status', 'religion',
        'ptkp_status', 'address', 'personal_email', 'emergency_contact_name',
        'emergency_contact_relationship', 'emergency_contact_phone', 'national_id',
        'tax_id', 'bpjs_health_no', 'bpjs_employment_no', 'bank_name',
        'bank_account_number', 'bank_account_holder', 'employment_type',
        'contract_end_date', 'job_level', 'work_location', 'work_pattern',
        'is_backup_engineer', 'kpi_template_id', 'kpi_review_required',
        'kpi_exemption_reason', 'is_management_role', 'can_write_articles',
        'can_manage_people', 'can_manage_contracts', 'bonus_eligible',
        'study_leave_eligible', 'is_it_support'];
    -- Columns that cannot hold null: a null sent for one leaves it alone.
    c_not_null constant text[] := array[
        'employee_id', 'first_name', 'last_name', 'email', 'department', 'position',
        'date_of_joining', 'annual_leave_opening_balance', 'is_active', 'work_pattern',
        'is_backup_engineer', 'kpi_review_required', 'is_management_role',
        'can_write_articles', 'can_manage_people', 'can_manage_contracts',
        'bonus_eligible', 'study_leave_eligible', 'is_it_support'];
    v_patch jsonb;
    v_keys text[];
    v_employee public.employees%rowtype;
    v_new public.employees%rowtype;
    v_current jsonb;
    v_changes_capabilities boolean;
    v_pos boolean;
    v_lvl boolean;
    v_dep boolean;
begin
    perform public.people_require_user();

    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      into v_patch
      from jsonb_each(coalesce(p_payload, '{}'::jsonb)) as j(k, v)
     where k = any(c_fields);
    v_keys := array(select jsonb_object_keys(v_patch));

    -- Two permissions through one endpoint: editing the record needs the
    -- people-admin flag; changing what somebody may do needs the director.
    -- Splitting them is what stops a delegate widening their own delegation.
    if exists (select 1 from unnest(v_keys) k where not (k = any(c_capabilities))) then
        perform public.people_require_people_admin();
    end if;

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;
    v_current := to_jsonb(v_employee);

    -- Judged on the flags that actually change, so a form that sends the
    -- record back with its permissions untouched still saves.
    v_changes_capabilities := exists (
        select 1 from unnest(v_keys) k
         where k = any(c_capabilities)
           and v_patch->k is distinct from v_current->k
    );
    if v_changes_capabilities and not public.is_platform_admin() then
        raise exception 'Only the platform administrator can change what somebody is allowed to do.'
            using errcode = 'PT403';
    end if;

    if v_patch->'is_active' = 'false'::jsonb and v_employee.is_active then
        perform public.people_refuse_locking_out(v_employee.user_id);
    end if;

    -- Uniqueness, answered as a conflict rather than a constraint error.
    if v_patch ? 'email' and v_patch->>'email' is distinct from v_employee.email
       and exists (select 1 from public.employees where email = v_patch->>'email' and id <> p_employee_id) then
        raise exception 'An employee with this email already exists' using errcode = 'PT409';
    end if;
    if v_patch ? 'employee_id' and v_patch->>'employee_id' is distinct from v_employee.employee_id
       and exists (select 1 from public.employees where employee_id = v_patch->>'employee_id' and id <> p_employee_id) then
        raise exception 'An employee with this employee number already exists' using errcode = 'PT409';
    end if;

    -- A null for a column that cannot hold one is dropped rather than failing.
    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      into v_patch
      from jsonb_each(v_patch) as j(k, v)
     where not (jsonb_typeof(v) = 'null' and k = any(c_not_null));

    v_new := jsonb_populate_record(v_employee, v_patch);

    -- Record a change of job before overwriting it: position, level and
    -- department describe what the job is.
    v_pos := v_patch ? 'position'   and v_new.position   is distinct from v_employee.position;
    v_lvl := v_patch ? 'job_level'  and v_new.job_level  is distinct from v_employee.job_level;
    v_dep := v_patch ? 'department' and v_new.department is distinct from v_employee.department;
    if v_pos or v_lvl or v_dep then
        insert into public.employee_role_changes (
            employee_id, effective_date,
            previous_position, new_position,
            previous_job_level, new_job_level,
            previous_department, new_department,
            recorded_by
        ) values (
            v_employee.id, public.local_today(),
            case when v_pos then v_employee.position end,  case when v_pos then v_new.position end,
            case when v_lvl then v_employee.job_level end, case when v_lvl then v_new.job_level end,
            case when v_dep then v_employee.department end, case when v_dep then v_new.department end,
            auth.uid()
        );
    end if;

    update public.employees e set
        employee_id = v_new.employee_id,
        first_name = v_new.first_name,
        last_name = v_new.last_name,
        email = v_new.email,
        phone = v_new.phone,
        department = v_new.department,
        position = v_new.position,
        date_of_joining = v_new.date_of_joining,
        annual_leave_opening_balance = v_new.annual_leave_opening_balance,
        is_active = v_new.is_active,
        date_of_birth = v_new.date_of_birth,
        place_of_birth = v_new.place_of_birth,
        gender = v_new.gender,
        marital_status = v_new.marital_status,
        religion = v_new.religion,
        ptkp_status = v_new.ptkp_status,
        address = v_new.address,
        personal_email = v_new.personal_email,
        emergency_contact_name = v_new.emergency_contact_name,
        emergency_contact_relationship = v_new.emergency_contact_relationship,
        emergency_contact_phone = v_new.emergency_contact_phone,
        national_id = v_new.national_id,
        tax_id = v_new.tax_id,
        bpjs_health_no = v_new.bpjs_health_no,
        bpjs_employment_no = v_new.bpjs_employment_no,
        bank_name = v_new.bank_name,
        bank_account_number = v_new.bank_account_number,
        bank_account_holder = v_new.bank_account_holder,
        employment_type = v_new.employment_type,
        contract_end_date = v_new.contract_end_date,
        job_level = v_new.job_level,
        work_location = v_new.work_location,
        work_pattern = v_new.work_pattern,
        is_backup_engineer = v_new.is_backup_engineer,
        kpi_template_id = v_new.kpi_template_id,
        kpi_review_required = v_new.kpi_review_required,
        kpi_exemption_reason = v_new.kpi_exemption_reason,
        is_management_role = v_new.is_management_role,
        can_write_articles = v_new.can_write_articles,
        can_manage_people = v_new.can_manage_people,
        can_manage_contracts = v_new.can_manage_contracts,
        bonus_eligible = v_new.bonus_eligible,
        study_leave_eligible = v_new.study_leave_eligible,
        is_it_support = v_new.is_it_support,
        updated_at = now()
     where e.id = p_employee_id;

    -- Deactivating somebody locks them out (deps.employee_deactivated); here
    -- that is the profile switched off, the auth user banned and their
    -- sessions dropped. Reactivating opens the door again.
    if v_new.is_active is distinct from v_employee.is_active then
        perform public.set_login_enabled(v_employee.user_id, v_new.is_active);
    end if;

    -- NOT PORTED HERE: a change of back-up engineer status re-seats this
    -- person's lines on every still-editable payroll month (employees.py
    -- `_reseat_open_payrolls`: fill_from_roster + seat_in, logging
    -- PAYROLL_LINE_REGROUPED). Payroll is its own area; its migration is
    -- expected to hook this change (e.g. a trigger on
    -- employees.is_backup_engineer) rather than this function reaching into
    -- tables it does not own.

    perform public.log_activity(
        'EMPLOYEE_UPDATED',
        format('Updated employee %s %s', v_new.first_name, v_new.last_name),
        v_employee.id
    );

    return public.employee_json(p_employee_id);
end;
$$;

create or replace function public.people_deactivate_employee(p_employee_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
begin
    perform public.people_require_user();

    if not public.is_admin() then
        raise exception 'Only an administrator can deactivate an employee.' using errcode = 'PT403';
    end if;

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    perform public.people_refuse_locking_out(v_employee.user_id);

    update public.employees set is_active = false, updated_at = now() where id = p_employee_id;
    perform public.set_login_enabled(v_employee.user_id, false);

    perform public.log_activity(
        'EMPLOYEE_DEACTIVATED',
        format('Deactivated employee %s %s', v_employee.first_name, v_employee.last_name),
        v_employee.id,
        v_employee.user_id
    );
end;
$$;

-- Lintang's names, kept callable (PostgREST exposes them) but now answering
-- to the same rules as the routes, so they are not a way around them.
create or replace function public.create_employee(p_payload jsonb)
returns jsonb
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
    select public.people_create_employee(p_payload);
$$;

create or replace function public.update_employee(p_employee_id uuid, p_payload jsonb)
returns jsonb
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
    select public.people_update_employee(p_employee_id, p_payload);
$$;

create or replace function public.deactivate_employee(p_employee_id uuid)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
    select public.people_deactivate_employee(p_employee_id);
$$;

-- ---------------------------------------------------------------------------
-- 5. Role history: GET /employees/{id}/history, PATCH .../history/{change}.
-- ---------------------------------------------------------------------------
create or replace function public.people_role_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.people_require_user();
    perform public.people_require_directory();

    return coalesce((
        select jsonb_agg(public.people_role_change_json(r)
                         order by r.effective_date desc, r.created_at desc)
          from public.employee_role_changes r
         where r.employee_id = p_employee_id
    ), '[]'::jsonb);
end;
$$;

create or replace function public.people_amend_role_change(
    p_employee_id uuid,
    p_change_id uuid,
    p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_change public.employee_role_changes%rowtype;
begin
    perform public.people_require_user();
    perform public.people_require_people_admin();

    select * into v_change
      from public.employee_role_changes
     where id = p_change_id and employee_id = p_employee_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    update public.employee_role_changes r set
        effective_date = case
            when p_payload ? 'effective_date' and jsonb_typeof(p_payload->'effective_date') <> 'null'
            then (p_payload->>'effective_date')::date else r.effective_date end,
        note = case when p_payload ? 'note' then p_payload->>'note' else r.note end,
        updated_at = now()
     where r.id = p_change_id
     returning * into v_change;

    return public.people_role_change_json(v_change);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Photos, in the private `employee-photos` bucket. The route uploads and
-- downloads; these decide who may and keep `photo_path`.
-- ---------------------------------------------------------------------------

-- PUT /employees/{id}/photo, before the upload: may this person, is it an
-- image a browser renders inline, is it within 2 MB. Returns the object key.
create or replace function public.people_prepare_photo(
    p_employee_id uuid,
    p_content_type text,
    p_byte_size bigint
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.people_require_user();
    perform public.people_require_people_admin();

    if not exists (select 1 from public.employees where id = p_employee_id) then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    if p_content_type is null or p_content_type not in ('image/jpeg', 'image/png', 'image/webp') then
        raise exception 'Unsupported image type %. Use a JPEG, PNG or WebP.',
            coalesce('''' || p_content_type || '''', 'None')
            using errcode = 'PT415';
    end if;
    if coalesce(p_byte_size, 0) <= 0 then
        raise exception 'Empty file' using errcode = 'PT400';
    end if;
    if p_byte_size > 2 * 1024 * 1024 then
        raise exception 'Photo is larger than 2 MB.' using errcode = 'PT413';
    end if;

    return p_employee_id::text || '/photo';
end;
$$;

-- PUT /employees/{id}/photo, after the upload.
create or replace function public.people_record_photo(p_employee_id uuid, p_path text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
begin
    perform public.people_require_user();
    perform public.people_require_people_admin();

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;
    if p_path is distinct from p_employee_id::text || '/photo' then
        raise exception 'Unexpected photo path' using errcode = 'PT422';
    end if;

    -- updated_at moves too: the client uses it to bust its cached copy.
    update public.employees set photo_path = p_path, updated_at = now() where id = p_employee_id;

    perform public.log_activity(
        'EMPLOYEE_UPDATED',
        format('Updated photo for %s %s', v_employee.first_name, v_employee.last_name),
        p_employee_id
    );
end;
$$;

-- GET /employees/{id}/photo: any signed-in user, as before.
create or replace function public.people_photo_path(p_employee_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_path text;
begin
    perform public.people_require_user();
    select photo_path into v_path from public.employees where id = p_employee_id;
    if v_path is null then
        raise exception 'No photo' using errcode = 'PT404';
    end if;
    return v_path;
end;
$$;

-- DELETE /employees/{id}/photo. Returns the key the route should remove from
-- the bucket, or null when there was none.
create or replace function public.people_delete_photo(p_employee_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_path text;
begin
    perform public.people_require_user();
    perform public.people_require_people_admin();

    select photo_path into v_path from public.employees where id = p_employee_id;
    if v_path is not null then
        update public.employees set photo_path = null, updated_at = now() where id = p_employee_id;
    end if;
    return v_path;
end;
$$;

do $$
begin
    if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
        insert into storage.buckets (id, name, public)
        values ('employee-photos', 'employee-photos', false)
        on conflict (id) do nothing;

        execute 'drop policy if exists employee_photos_read on storage.objects';
        execute $p$create policy employee_photos_read on storage.objects
            for select to authenticated
            using (bucket_id = 'employee-photos'
                   and public.is_active_user()
                   and not public.employee_deactivated(auth.uid()))$p$;

        execute 'drop policy if exists employee_photos_insert on storage.objects';
        execute $p$create policy employee_photos_insert on storage.objects
            for insert to authenticated
            with check (bucket_id = 'employee-photos' and public.can_manage_people())$p$;

        execute 'drop policy if exists employee_photos_update on storage.objects';
        execute $p$create policy employee_photos_update on storage.objects
            for update to authenticated
            using (bucket_id = 'employee-photos' and public.can_manage_people())
            with check (bucket_id = 'employee-photos' and public.can_manage_people())$p$;

        execute 'drop policy if exists employee_photos_delete on storage.objects';
        execute $p$create policy employee_photos_delete on storage.objects
            for delete to authenticated
            using (bucket_id = 'employee-photos' and public.can_manage_people())$p$;
    end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Profile change requests: /profile-requests.
-- ---------------------------------------------------------------------------

-- _can_review(): an administrator, or whoever holds the people-admin flag.
create or replace function public.people_can_review_profile_requests()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.is_admin() or public.can_manage_people();
$$;

create or replace function public.people_profile_request_fields()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.people_require_user();
    return (select jsonb_agg(jsonb_build_object('key', f.key, 'label', f.label) order by f.ord)
              from public.people_profile_fields() f);
end;
$$;

create or replace function public.people_list_profile_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_reviewer boolean;
    v_mine uuid;
    v_items jsonb;
begin
    perform public.people_require_user();
    v_reviewer := public.people_can_review_profile_requests();
    v_mine := public.current_employee_id();

    if not v_reviewer and v_mine is null then
        return jsonb_build_object('items', '[]'::jsonb, 'can_review', false, 'pending', 0);
    end if;

    select coalesce(jsonb_agg(public.people_profile_request_json(r.id) order by r.created_at desc), '[]'::jsonb)
      into v_items
      from public.profile_change_requests r
     where v_reviewer or r.employee_id = v_mine;

    return jsonb_build_object(
        'items', v_items,
        'can_review', v_reviewer,
        'pending', (select count(*)::int from jsonb_array_elements(v_items) i where i->>'status' = 'pending')
    );
end;
$$;

create or replace function public.people_raise_profile_request(
    p_field text,
    p_requested_value text default null,
    p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
    v_label text;
    v_current text;
    v_id uuid;
begin
    perform public.people_require_user();

    select * into v_employee from public.employees where user_id = auth.uid() limit 1;
    if not found then
        raise exception 'No employee record is linked to your account.' using errcode = 'PT404';
    end if;

    select f.label into v_label from public.people_profile_fields() f where f.key = p_field;
    if v_label is null then
        raise exception 'That detail cannot be changed by request.' using errcode = 'PT422';
    end if;

    execute format('select %I::text from public.employees where id = $1', p_field)
       into v_current using v_employee.id;

    if coalesce(v_current, '') = coalesce(p_requested_value, '') then
        raise exception 'That is already what the record says.' using errcode = 'PT409';
    end if;

    -- One open request per field.
    if exists (select 1 from public.profile_change_requests
                where employee_id = v_employee.id and field = p_field and status = 'pending') then
        raise exception 'A request to change % is already waiting.', v_label using errcode = 'PT409';
    end if;

    insert into public.profile_change_requests
        (employee_id, requested_by, field, current_value, requested_value, reason)
    values (v_employee.id, auth.uid(), p_field, v_current, p_requested_value, p_reason)
    returning id into v_id;

    perform public.log_activity(
        'PROFILE_CHANGE_REQUESTED',
        format('Asked to change %s', v_label),
        v_employee.id
    );

    return public.people_profile_request_json(v_id);
end;
$$;

create or replace function public.people_approve_profile_request(p_request_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_req public.profile_change_requests%rowtype;
    v_employee public.employees%rowtype;
    v_label text;
    v_now text;
begin
    perform public.people_require_user();
    if not public.people_can_review_profile_requests() then
        raise exception 'You are not set up to review profile requests.' using errcode = 'PT403';
    end if;

    select * into v_req from public.profile_change_requests where id = p_request_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into v_employee from public.employees where id = v_req.employee_id;

    if v_req.status <> 'pending' then
        raise exception 'That request is already decided.' using errcode = 'PT409';
    end if;

    v_label := public.people_profile_field_label(v_req.field);
    -- Only fields on the list are ever written, whatever the row says.
    if not exists (select 1 from public.people_profile_fields() f where f.key = v_req.field) then
        raise exception 'That detail cannot be changed by request.' using errcode = 'PT422';
    end if;

    execute format('select %I::text from public.employees where id = $1', v_req.field)
       into v_now using v_employee.id;

    -- If the record moved since the request was raised, say so rather than
    -- quietly overwriting whatever somebody else put there.
    if coalesce(v_now, '') <> coalesce(v_req.current_value, '') then
        raise exception '% has changed since this was raised — it now reads %. Ask for a fresh request.',
            v_label, coalesce(nullif(v_now, ''), 'nothing')
            using errcode = 'PT409';
    end if;

    execute format('update public.employees set %I = $1, updated_at = now() where id = $2', v_req.field)
      using v_req.requested_value, v_employee.id;

    update public.profile_change_requests
       set status = 'approved',
           reviewed_by = auth.uid(),
           reviewed_at = timezone('utc', now()),
           review_note = p_note,
           updated_at = now()
     where id = p_request_id;

    perform public.log_activity(
        'PROFILE_CHANGE_APPROVED',
        format('%s for %s %s: %s → %s', v_label, v_employee.first_name, v_employee.last_name,
               coalesce(nullif(v_req.current_value, ''), 'not set'),
               coalesce(nullif(v_req.requested_value, ''), 'not set')),
        v_employee.id
    );

    return public.people_profile_request_json(p_request_id);
end;
$$;

create or replace function public.people_decline_profile_request(p_request_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_req public.profile_change_requests%rowtype;
begin
    perform public.people_require_user();
    if not public.people_can_review_profile_requests() then
        raise exception 'You are not set up to review profile requests.' using errcode = 'PT403';
    end if;
    if coalesce(trim(p_note), '') = '' then
        raise exception 'Say why, so they know what to do next.' using errcode = 'PT422';
    end if;

    select * into v_req from public.profile_change_requests where id = p_request_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_req.status <> 'pending' then
        raise exception 'That request is already decided.' using errcode = 'PT409';
    end if;

    update public.profile_change_requests
       set status = 'declined',
           reviewed_by = auth.uid(),
           reviewed_at = timezone('utc', now()),
           review_note = p_note,
           updated_at = now()
     where id = p_request_id;

    return public.people_profile_request_json(p_request_id);
end;
$$;

create or replace function public.people_cancel_profile_request(p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_req public.profile_change_requests%rowtype;
    v_mine uuid;
begin
    perform public.people_require_user();

    select * into v_req from public.profile_change_requests where id = p_request_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    v_mine := public.current_employee_id();
    if v_mine is null or v_req.employee_id <> v_mine then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_req.status <> 'pending' then
        raise exception 'That request is already decided.' using errcode = 'PT409';
    end if;

    update public.profile_change_requests
       set status = 'cancelled', updated_at = now()
     where id = p_request_id;

    return public.people_profile_request_json(p_request_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Directory visibility outside the functions.
--
-- The employees table carries NIK, NPWP, BPJS numbers, bank accounts and home
-- addresses. Lintang's policy let any signed-in user read every row through
-- PostgREST; the FastAPI rule is that the directory is management's and
-- everyone else reads their own record. Every screen reads through the
-- SECURITY DEFINER functions, which are unaffected.
-- ---------------------------------------------------------------------------
drop policy if exists employees_select_all on public.employees;
drop policy if exists employees_select_scoped on public.employees;
create policy employees_select_scoped on public.employees
    for select to authenticated
    using (
        (select public.is_active_user())
        and (user_id = (select auth.uid()) or (select public.people_can_read_directory()))
    );

create or replace view public.employees_view
with (security_invoker = false) as
select
    e.id,
    e.employee_id,
    e.first_name,
    e.last_name,
    e.email,
    e.phone,
    e.department,
    e.position,
    e.date_of_joining,
    e.annual_leave_opening_balance,
    e.is_active,
    e.user_id,
    e.manager_id,
    e.created_at,
    e.updated_at,
    (e.user_id is not null) as has_account,
    (e.id in (select public.employees_on_leave_today())) as on_leave_today
from public.employees e
where public.is_active_user()
  and (e.user_id = auth.uid() or public.people_can_read_directory());

-- ---------------------------------------------------------------------------
-- 9. Grants.
-- ---------------------------------------------------------------------------
revoke all on function public.people_require_user()                          from public;
revoke all on function public.people_can_read_directory()                    from public;
revoke all on function public.people_require_directory()                     from public;
revoke all on function public.people_require_people_admin()                  from public;
revoke all on function public.people_refuse_locking_out(uuid)                from public, anon, authenticated;
revoke all on function public.people_next_employee_id(date)                  from public, anon, authenticated;
revoke all on function public.people_profile_fields()                        from public;
revoke all on function public.people_profile_field_label(text)               from public;
revoke all on function public.people_employee_detail_json(uuid)              from public, anon, authenticated;
revoke all on function public.people_role_change_json(public.employee_role_changes) from public, anon, authenticated;
revoke all on function public.people_profile_request_json(uuid)              from public, anon, authenticated;
revoke all on function public.people_list_employees(int, int, text, text, boolean) from public;
revoke all on function public.people_get_employee(uuid)                      from public;
revoke all on function public.people_create_employee(jsonb)                  from public;
revoke all on function public.people_update_employee(uuid, jsonb)            from public;
revoke all on function public.people_deactivate_employee(uuid)               from public;
revoke all on function public.create_employee(jsonb)                         from public;
revoke all on function public.update_employee(uuid, jsonb)                   from public;
revoke all on function public.deactivate_employee(uuid)                      from public;
revoke all on function public.people_role_history(uuid)                      from public;
revoke all on function public.people_amend_role_change(uuid, uuid, jsonb)    from public;
revoke all on function public.people_prepare_photo(uuid, text, bigint)       from public;
revoke all on function public.people_record_photo(uuid, text)                from public;
revoke all on function public.people_photo_path(uuid)                        from public;
revoke all on function public.people_delete_photo(uuid)                      from public;
revoke all on function public.people_can_review_profile_requests()           from public;
revoke all on function public.people_profile_request_fields()                from public;
revoke all on function public.people_list_profile_requests()                 from public;
revoke all on function public.people_raise_profile_request(text, text, text) from public;
revoke all on function public.people_approve_profile_request(uuid, text)     from public;
revoke all on function public.people_decline_profile_request(uuid, text)     from public;
revoke all on function public.people_cancel_profile_request(uuid)            from public;

grant execute on function public.people_require_user()                          to authenticated;
grant execute on function public.people_can_read_directory()                    to authenticated;
grant execute on function public.people_require_directory()                     to authenticated;
grant execute on function public.people_require_people_admin()                  to authenticated;
grant execute on function public.people_profile_fields()                        to authenticated;
grant execute on function public.people_profile_field_label(text)               to authenticated;
grant execute on function public.people_list_employees(int, int, text, text, boolean) to authenticated;
grant execute on function public.people_get_employee(uuid)                      to authenticated;
grant execute on function public.people_create_employee(jsonb)                  to authenticated;
grant execute on function public.people_update_employee(uuid, jsonb)            to authenticated;
grant execute on function public.people_deactivate_employee(uuid)               to authenticated;
grant execute on function public.create_employee(jsonb)                         to authenticated;
grant execute on function public.update_employee(uuid, jsonb)                   to authenticated;
grant execute on function public.deactivate_employee(uuid)                      to authenticated;
grant execute on function public.people_role_history(uuid)                      to authenticated;
grant execute on function public.people_amend_role_change(uuid, uuid, jsonb)    to authenticated;
grant execute on function public.people_prepare_photo(uuid, text, bigint)       to authenticated;
grant execute on function public.people_record_photo(uuid, text)                to authenticated;
grant execute on function public.people_photo_path(uuid)                        to authenticated;
grant execute on function public.people_delete_photo(uuid)                      to authenticated;
grant execute on function public.people_can_review_profile_requests()           to authenticated;
grant execute on function public.people_profile_request_fields()                to authenticated;
grant execute on function public.people_list_profile_requests()                 to authenticated;
grant execute on function public.people_raise_profile_request(text, text, text) to authenticated;
grant execute on function public.people_approve_profile_request(uuid, text)     to authenticated;
grant execute on function public.people_decline_profile_request(uuid, text)     to authenticated;
grant execute on function public.people_cancel_profile_request(uuid)            to authenticated;

commit;
