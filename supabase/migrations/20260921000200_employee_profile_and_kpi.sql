-- ===========================================================================
-- The employee profile and the KPI scorecards.
--
-- This is the schema behind the two screens Nurhuda built on the FastAPI
-- branch and which have no Supabase equivalent: the tabbed employee profile
-- (/employees/:id) and the KPI page (/kpi).
--
-- Entirely additive. No existing column changes type, nothing is dropped, and
-- every new column on `employees` is nullable or carries a default, so the
-- directory keeps working untouched while the profiles are filled in over
-- time.
--
-- The scoring arithmetic and the review chain are NOT here -- they land in the
-- next migration, against these tables.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Enums.
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_type where typname = 'work_pattern') then
        create type public.work_pattern as enum ('office_day', 'roster');
    end if;
    if not exists (select 1 from pg_type where typname = 'employment_type') then
        create type public.employment_type as enum ('permanent', 'contract', 'probation', 'intern');
    end if;
    if not exists (select 1 from pg_type where typname = 'kpi_period_type') then
        create type public.kpi_period_type as enum ('quarterly', 'half_year', 'annual');
    end if;
    if not exists (select 1 from pg_type where typname = 'kpi_review_status') then
        create type public.kpi_review_status as enum ('draft', 'submitted', 'approved', 'returned');
    end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The scorecard templates.
--
-- Six roles, ten weighted KPIs each, lifted from the role documents in
-- Documents/DTG/KPI/Role. Weights sum to 100 per template, which is what makes
-- "rated 3 throughout" total exactly 100.
-- ---------------------------------------------------------------------------
create table if not exists public.kpi_role_templates (
    id              uuid primary key default gen_random_uuid(),
    code            text not null unique,
    title           text not null,
    version         text not null default '2026',
    source_document text,
    bands           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists public.kpi_template_items (
    id           uuid primary key default gen_random_uuid(),
    template_id  uuid not null references public.kpi_role_templates(id) on delete cascade,
    number       text not null,
    category     text,
    name         text not null,
    weight       numeric(6,2) not null,
    target       text,
    how_measured text,
    evidence     text,
    sort_order   int not null default 0,
    unique (template_id, number)
);

create index if not exists ix_kpi_template_items_template
    on public.kpi_template_items (template_id, sort_order);

-- ---------------------------------------------------------------------------
-- 3. Reviews.
--
-- `period_label` is the human name of the period ("2026"). It is unique per
-- employee so the same period cannot be opened twice by two people racing.
--
-- Salary and bonus live here rather than on `employees` because they are a
-- fact about a review cycle, not about a person, and because keeping them on
-- one table means one RLS policy decides who may read them.
-- ---------------------------------------------------------------------------
create table if not exists public.kpi_reviews (
    id            uuid primary key default gen_random_uuid(),
    employee_id   uuid not null references public.employees(id) on delete cascade,
    template_id   uuid references public.kpi_role_templates(id),

    period_type   public.kpi_period_type not null default 'annual',
    period_label  text not null,
    period_start  date not null,
    period_end    date not null,

    status        public.kpi_review_status not null default 'draft',

    assessor_id   uuid references public.employees(id),
    approver_id   uuid references public.employees(id),
    submitted_at  timestamptz,
    approved_at   timestamptz,

    assessor_comment text,
    approver_comment text,

    -- The role documents' hard gate. A failed gate blocks any KPI-linked
    -- reward regardless of the score, so it is stored, not inferred.
    critical_gate_cleared boolean not null default true,
    hard_gate_note        text,

    -- Compensation. Admin, executive and finance only -- see the policies.
    target_bonus_amount   numeric(14,2),
    current_basic_salary  numeric(14,2),
    approved_increase_pct numeric(6,2),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    unique (employee_id, period_label)
);

create index if not exists ix_kpi_reviews_employee on public.kpi_reviews (employee_id);
create index if not exists ix_kpi_reviews_status   on public.kpi_reviews (status);

-- ---------------------------------------------------------------------------
-- 4. Review lines.
--
-- The template text is COPIED onto the line rather than referenced. Editing a
-- template must not silently rewrite what somebody was assessed against last
-- year; a scorecard is a record of what was agreed at the time.
-- ---------------------------------------------------------------------------
create table if not exists public.kpi_review_items (
    id               uuid primary key default gen_random_uuid(),
    review_id        uuid not null references public.kpi_reviews(id) on delete cascade,
    template_item_id uuid references public.kpi_template_items(id),

    number       text not null,
    category     text,
    name         text not null,
    weight       numeric(6,2) not null,
    target       text,
    how_measured text,
    evidence     text,
    sort_order   int not null default 0,

    -- 0..5, or NULL for "not yet rated". Not-applicable is its own flag: a
    -- KPI that could not be scored this period must not read as a zero.
    rating             int check (rating is null or rating between 0 and 5),
    is_not_applicable  boolean not null default false,
    actual_result      text,
    evidence_note      text,

    unique (review_id, number)
);

create index if not exists ix_kpi_review_items_review
    on public.kpi_review_items (review_id, sort_order);

-- ---------------------------------------------------------------------------
-- 5. The employee profile.
--
-- Every column is optional: a record stays creatable from a name, an email and
-- a role, and is completed later. Salary is deliberately NOT here -- only the
-- bank account a salary is paid into.
-- ---------------------------------------------------------------------------
alter table public.employees
    -- Personal
    add column if not exists date_of_birth   date,
    add column if not exists place_of_birth  text,
    add column if not exists gender          text,
    add column if not exists marital_status  text,
    add column if not exists religion        text,
    add column if not exists address         text,
    add column if not exists personal_email  text,

    -- Emergency contact
    add column if not exists emergency_contact_name         text,
    add column if not exists emergency_contact_relationship text,
    add column if not exists emergency_contact_phone        text,

    -- Indonesian statutory identifiers
    add column if not exists national_id        text,   -- NIK / KTP
    add column if not exists tax_id             text,   -- NPWP
    add column if not exists bpjs_health_no     text,   -- BPJS Kesehatan
    add column if not exists bpjs_employment_no text,   -- BPJS Ketenagakerjaan

    -- Payroll destination, not the amount
    add column if not exists bank_name           text,
    add column if not exists bank_account_number text,
    add column if not exists bank_account_holder text,

    -- Employment
    add column if not exists employment_type   public.employment_type,
    add column if not exists contract_end_date date,
    add column if not exists job_level         text,
    add column if not exists work_location     text,

    -- Scheduling. office_day is the safe default: a new record appearing on
    -- the rotating crew's roster would be worse than appearing on neither.
    add column if not exists work_pattern       public.work_pattern not null default 'office_day',
    add column if not exists is_backup_engineer boolean not null default false,

    -- Review
    add column if not exists kpi_template_id      uuid references public.kpi_role_templates(id),
    add column if not exists kpi_review_required  boolean not null default true,
    add column if not exists kpi_exemption_reason text,

    -- Object key in the private `employee-photos` bucket, never the bytes.
    add column if not exists photo_path text;

-- ---------------------------------------------------------------------------
-- 6. Row-level security.
--
-- Templates are readable by any signed-in user -- an engineer is entitled to
-- see what they are measured against. Everything else is decided by the RPCs
-- in the next migration, so no direct write path is opened here.
-- ---------------------------------------------------------------------------
alter table public.kpi_role_templates  enable row level security;
alter table public.kpi_template_items  enable row level security;
alter table public.kpi_reviews         enable row level security;
alter table public.kpi_review_items    enable row level security;

drop policy if exists kpi_templates_read on public.kpi_role_templates;
create policy kpi_templates_read on public.kpi_role_templates
    for select using (public.is_active_user());

drop policy if exists kpi_template_items_read on public.kpi_template_items;
create policy kpi_template_items_read on public.kpi_template_items
    for select using (public.is_active_user());

-- Reviews: the subject, the assessor, the approver and any administrator.
-- Finance is deliberately absent -- it reads compensation through a function
-- that returns the figures without the ratings or the comments.
drop policy if exists kpi_reviews_read on public.kpi_reviews;
create policy kpi_reviews_read on public.kpi_reviews
    for select using (
        public.is_admin()
        or employee_id = public.current_employee_id()
        or assessor_id = public.current_employee_id()
        or approver_id = public.current_employee_id()
    );

drop policy if exists kpi_review_items_read on public.kpi_review_items;
create policy kpi_review_items_read on public.kpi_review_items
    for select using (
        exists (
            select 1 from public.kpi_reviews r
             where r.id = review_id
               and (public.is_admin()
                    or r.employee_id = public.current_employee_id()
                    or r.assessor_id = public.current_employee_id()
                    or r.approver_id = public.current_employee_id())
        )
    );

grant select on public.kpi_role_templates to authenticated;
grant select on public.kpi_template_items to authenticated;
grant select on public.kpi_reviews        to authenticated;
grant select on public.kpi_review_items   to authenticated;

commit;
