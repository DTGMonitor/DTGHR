-- Recreates the pre-migration state: Supabase's auth plumbing plus the schema
-- Alembic left behind at revision 0009.

create schema if not exists extensions;
create schema if not exists auth;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth schema, as GoTrue shapes it (only the columns this migration touches)
-- ---------------------------------------------------------------------------
create table auth.users (
    instance_id uuid,
    id uuid primary key,
    aud varchar(255),
    role varchar(255),
    email varchar(255) unique,
    encrypted_password varchar(255),
    email_confirmed_at timestamptz,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    created_at timestamptz,
    updated_at timestamptz,
    confirmation_token varchar(255),
    recovery_token varchar(255),
    email_change_token_new varchar(255),
    email_change varchar(255)
);

create table auth.identities (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    provider_id text not null,
    identity_data jsonb not null,
    provider text not null,
    last_sign_in_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- Application schema at Alembic head 0009
-- ---------------------------------------------------------------------------
create table public.users (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    email varchar(255) not null,
    hashed_password varchar not null,
    full_name varchar(255) not null,
    is_active boolean not null default true,
    is_superuser boolean not null default false,
    password_change_required boolean not null default false
);
create unique index ix_users_email on public.users (email);

create table public.employees (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    employee_id varchar(50) not null,
    first_name varchar(100) not null,
    last_name varchar(100) not null,
    email varchar(255) not null,
    phone varchar(20),
    department varchar(100) not null,
    position varchar(100) not null,
    date_of_joining date not null,
    is_active boolean not null default true,
    annual_leave_opening_balance double precision not null default 0,
    user_id uuid unique references public.users(id),
    manager_id uuid references public.employees(id)
);
create unique index ix_employees_employee_id on public.employees (employee_id);
create unique index ix_employees_email on public.employees (email);

create table public.leave_balances (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    employee_id uuid not null references public.employees(id) on delete cascade,
    leave_type varchar(20) not null,
    year integer not null,
    total_days double precision not null default 0,
    used_days double precision not null default 0,
    constraint uq_leave_balance_emp_type_year unique (employee_id, leave_type, year)
);

create table public.leave_requests (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    employee_id uuid not null references public.employees(id) on delete cascade,
    leave_type varchar(20) not null,
    start_date date not null,
    end_date date not null,
    days_requested double precision not null,
    reason text,
    status varchar(20) not null default 'pending',
    reviewed_by uuid references public.employees(id),
    reviewed_at timestamp,
    reviewer_note text
);

create table public.work_schedules (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    name varchar(200) not null,
    start_date date not null,
    end_date date not null,
    status varchar(20) not null default 'draft'
);

create table public.shift_assignments (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    schedule_id uuid not null references public.work_schedules(id) on delete cascade,
    employee_id uuid not null references public.employees(id) on delete cascade,
    date date not null,
    shift_code varchar(5) not null,
    start_time time,
    end_time time,
    constraint uq_shift_assignment_schedule_emp_date unique (schedule_id, employee_id, date)
);

create table public.shift_change_requests (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    schedule_id uuid not null references public.work_schedules(id) on delete cascade,
    status varchar(24) not null default 'pending',
    reason varchar(500),
    review_note varchar(500),
    requested_by_id uuid not null references public.users(id) on delete cascade,
    reviewed_by_id uuid references public.users(id) on delete set null,
    reviewed_at timestamp
);

create table public.shift_change_items (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    request_id uuid not null references public.shift_change_requests(id) on delete cascade,
    employee_id uuid not null references public.employees(id) on delete cascade,
    date date not null,
    current_code varchar(5),
    requested_code varchar(5),
    status varchar(24) not null default 'pending',
    constraint uq_shift_change_item_request_emp_date unique (request_id, employee_id, date)
);

create table public.public_holidays (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    date date not null,
    name varchar(200) not null,
    is_national boolean not null default true,
    constraint uq_public_holiday_date unique (date)
);

create table public.activity_logs (
    id uuid primary key,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    action varchar(50) not null,
    actor_id uuid references public.users(id) on delete set null,
    target_id uuid,
    target_user_id uuid references public.users(id) on delete set null,
    description text not null
);

-- Supabase's default grants: RLS, not privileges, is what scopes these.
grant all on all tables in schema public to anon, authenticated, service_role;
