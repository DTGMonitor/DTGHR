-- ===========================================================================
-- Payroll: the monthly run and the pay forecast.
--
-- Ported from the FastAPI line: app/api/routes/payroll.py,
-- app/api/routes/compensation.py, app/services/payroll_service.py,
-- app/services/backup_shifts.py and app/models/payroll.py / compensation.py.
--
-- The tables keep the SQLAlchemy names, columns and types exactly, because
-- scripts/import_payroll_month.py writes to them directly.
--
-- The arithmetic is the *Revised PT DTG - Salaries 2026* workbook's, column by
-- column, and is computed here so that every response carries the derived
-- figures and the page never works out the sheet for itself:
--
--     base paid (G)          = salary x part days / divisor, or the salary
--     total shift (L)        = shift rate (J) x shift days (K)
--     public holiday rate (O)= G / K x 1.333333, or the typed override
--     public holiday pay (P) = N x O
--     before tax & BPJS (R)  = G + H + I + L + M + P + Q
--     before tax (U)         = R + S + T
--     total expense (Y)      = U + X
--
-- Service Labour carries the month's markup (7.5% by default) and is rounded
-- up to ten thousand on the invoiced figure; Admin Labour is rounded on cost.
--
-- Who may see payroll: finance, the director and the executive. Everybody
-- else gets a 404, as the backend answered -- a 403 confirms the page exists.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_months (
    id                 uuid primary key default gen_random_uuid(),
    year               integer not null,
    month              integer not null,
    status             varchar(20) not null default 'draft',
    service_markup_pct double precision not null default 7.5,
    notes              text,
    submitted_at       timestamptz,
    submitted_by_id    uuid references public.users(id) on delete set null,
    endorsed_at        timestamptz,
    endorsed_by_id     uuid references public.users(id) on delete set null,
    approved_at        timestamptz,
    approved_by_id     uuid references public.users(id) on delete set null,
    revision_note      text,
    revision_at        timestamptz,
    revision_by_id     uuid references public.users(id) on delete set null,
    created_at         timestamp not null default now(),
    updated_at         timestamp not null default now(),
    constraint uq_payroll_month unique (year, month)
);
create index if not exists ix_payroll_months_year  on public.payroll_months (year);
create index if not exists ix_payroll_months_month on public.payroll_months (month);

create table if not exists public.payroll_lines (
    id                           uuid primary key default gen_random_uuid(),
    month_id                     uuid not null references public.payroll_months(id) on delete cascade,
    -- Nullable on purpose: the sheet carries people with no staff record.
    employee_id                  uuid references public.employees(id) on delete set null,
    labour_group                 varchar(20) not null,
    row_no                       integer not null default 0,
    -- The snapshot, copied at the time and never read back through the employee.
    person_name                  varchar(160) not null,
    position                     varchar(120),
    bank_name                    varchar(60),
    bank_account_number          varchar(64),
    bank_account_name            varchar(160),
    tax_id                       varchar(32),
    ptkp_status                  varchar(10),
    -- What is paid (G-Q). `base` is always the full month's salary.
    base                         double precision not null default 0,
    health_allowance             double precision not null default 0,
    responsibility_allowance     double precision not null default 0,
    shift_allowance_rate         double precision not null default 0,
    shift_days                   double precision not null default 0,
    overtime_allowance           double precision not null default 0,
    public_holiday_days          double precision not null default 0,
    public_holiday_rate_override double precision,
    bonus_other                  double precision not null default 0,
    -- What it costs on top (S, T, X).
    bpjs_employment              double precision not null default 0,
    bpjs_health                  double precision not null default 0,
    income_tax                   double precision not null default 0,
    -- A part month, as the two numbers the sheet divides by.
    part_days                    double precision,
    part_divisor                 double precision,
    notes                        text,
    created_at                   timestamp not null default now(),
    updated_at                   timestamp not null default now()
);
create index if not exists ix_payroll_lines_month_id    on public.payroll_lines (month_id);
create index if not exists ix_payroll_lines_employee_id on public.payroll_lines (employee_id);

create table if not exists public.compensation_plans (
    id               uuid primary key default gen_random_uuid(),
    employee_id      uuid not null references public.employees(id) on delete cascade,
    year             integer not null,
    current_basic    double precision,
    current_gross    double precision,
    increase_pct     double precision,
    additional_gross double precision,
    bpjs_employment  double precision,
    bpjs_health      double precision,
    tax_bearer       varchar(20),
    income_tax       double precision,
    bonus_amount     double precision,
    notes            text,
    created_at       timestamp not null default now(),
    updated_at       timestamp not null default now(),
    constraint uq_compensation_plan_employee_year unique (employee_id, year)
);
create index if not exists ix_compensation_plans_employee_id on public.compensation_plans (employee_id);
create index if not exists ix_compensation_plans_year        on public.compensation_plans (year);

-- The AUD/IDR rate the forecast shows alongside rupiah. The backend fetched it
-- live from open.er-api.com and cached it in the process; Postgres cannot
-- fetch, so the last known rate is kept here and written by
-- compensation_record_rate() (by an administrator, or later an Edge
-- Function). No row means no rate, and the page shows rupiah alone.
create table if not exists public.compensation_fx_rates (
    id          uuid primary key default gen_random_uuid(),
    idr_per_aud double precision not null,
    as_of       varchar(64) not null default '',
    fetched_at  timestamptz not null default now(),
    created_at  timestamp not null default now(),
    updated_at  timestamp not null default now()
);

alter table public.payroll_months        enable row level security;
alter table public.payroll_lines         enable row level security;
alter table public.compensation_plans    enable row level security;
alter table public.compensation_fx_rates enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Internal helpers. Not granted to anybody: the RPCs below call them.
-- ---------------------------------------------------------------------------

-- Python's round(x, 2) on a float.
create or replace function public.payroll_r2(p double precision)
returns double precision
language sql
immutable
set search_path = public, pg_temp
as $$
    select round(p::numeric, 2)::double precision;
$$;

-- The sheet's ROUNDUP(x, -4): up to the next ten thousand rupiah.
create or replace function public.payroll_roundup_10k(p double precision)
returns double precision
language sql
immutable
set search_path = public, pg_temp
as $$
    select case when p = 0 then 0::double precision
                else ceil(p / 10000) * 10000 end;
$$;

create or replace function public.payroll_label(p_year int, p_month int)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select (array['January','February','March','April','May','June','July',
                  'August','September','October','November','December'])[p_month]
           || ' ' || p_year;
$$;

create or replace function public.payroll_days_in_month(p_year int, p_month int)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
    select extract(day from (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day'))::int;
$$;

-- Which role a run at this status is waiting on, or null.
create or replace function public.payroll_awaiting(p_status text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_status when 'submitted' then 'director'
                         when 'endorsed'  then 'executive' end;
$$;

-- Finance, who prepares it, and the two who sign for the money. 404 otherwise.
create or replace function public.payroll_require_access()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if coalesce(public.current_user_role()::text, '') not in ('finance', 'director', 'executive') then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
end;
$$;

create or replace function public.payroll_load_month(p_month_id uuid)
returns public.payroll_months
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
begin
    select * into m from public.payroll_months where id = p_month_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    return m;
end;
$$;

-- Refuse an edit to a run that is not finance's to change.
create or replace function public.payroll_require_draft(m public.payroll_months)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    if m.status in ('draft', 'changes_requested') then
        return;
    end if;
    raise exception '%', public.payroll_label(m.year, m.month) || ' '
        || case m.status
               when 'submitted' then 'is with the director for review'
               when 'endorsed'  then 'is with the executive for approval'
               else 'has been approved and paid' end
        || '. '
        || case when m.status = 'approved' then 'An approved run cannot be edited.'
                else 'Ask for it to be sent back if it needs changing.' end
        using errcode = 'PT409';
end;
$$;

-- Refuse a decision from somebody the run is not waiting on.
create or replace function public.payroll_require_signatory(m public.payroll_months)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    waiting text := public.payroll_awaiting(m.status);
begin
    if waiting is null then
        raise exception '% is not waiting on a decision.', public.payroll_label(m.year, m.month)
            using errcode = 'PT409';
    end if;
    if coalesce(public.current_user_role()::text, '') <> waiting then
        raise exception '% is waiting on the %, not on you.',
            public.payroll_label(m.year, m.month), waiting
            using errcode = 'PT403';
    end if;
end;
$$;

-- One line's derived figures, the workbook's arithmetic exactly.
create or replace function public.payroll_line_figures(l public.payroll_lines, p_days_in_month int)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    divisor double precision;
    g double precision;   -- base paid
    lt double precision;  -- total shift allowance
    o double precision;   -- public holiday rate
    p double precision;   -- public holiday allowance
    r double precision;   -- before tax and BPJS
    u double precision;   -- before tax
    y double precision;   -- total expense
begin
    if l.part_days is null then
        g := public.payroll_r2(l.base);
    else
        divisor := case when coalesce(l.part_divisor, 0) <> 0 then l.part_divisor
                        else p_days_in_month::double precision end;
        if divisor = 0 then
            g := public.payroll_r2(l.base);
        else
            g := public.payroll_r2(l.base * l.part_days / divisor);
        end if;
    end if;

    lt := public.payroll_r2(l.shift_allowance_rate * l.shift_days);

    if l.public_holiday_rate_override is not null then
        o := public.payroll_r2(l.public_holiday_rate_override);
    elsif coalesce(l.shift_days, 0) = 0 then
        o := 0;
    else
        o := public.payroll_r2(g / l.shift_days * 1.333333::double precision);
    end if;

    p := public.payroll_r2(l.public_holiday_days * o);
    r := public.payroll_r2(g + l.health_allowance + l.responsibility_allowance + lt
                           + l.overtime_allowance + p + l.bonus_other);
    u := public.payroll_r2(r + l.bpjs_employment + l.bpjs_health);
    y := public.payroll_r2(u + l.income_tax);

    return jsonb_build_object(
        'base_paid', g,
        'is_part_month', l.part_days is not null,
        'total_shift_allowance', lt,
        'public_holiday_rate', o,
        'public_holiday_allowance', p,
        'before_tax_and_bpjs', r,
        'before_tax', u,
        'total_expense', y,
        -- Not on the wire: what the group footer adds up as "allowances".
        '_allowances', l.health_allowance + l.responsibility_allowance + lt
                       + l.overtime_allowance + p
    );
end;
$$;

-- A line in the PayrollLineResponse shape. p_with_staff false leaves
-- employee_active / employee_position null, as the add-line response does.
create or replace function public.payroll_line_json(p_line_id uuid, p_with_staff boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
    v_active boolean;
    v_position text;
begin
    select * into l from public.payroll_lines where id = p_line_id;
    select * into m from public.payroll_months where id = l.month_id;
    -- Absent from the staff table stays null rather than becoming false:
    -- never employed here and no longer employed here are different facts.
    if p_with_staff and l.employee_id is not null then
        select e.is_active, e.position into v_active, v_position
          from public.employees e where e.id = l.employee_id;
    end if;
    return (to_jsonb(l) - 'month_id' - 'created_at' - 'updated_at')
        || (public.payroll_line_figures(l, public.payroll_days_in_month(m.year, m.month)) - '_allowances')
        || jsonb_build_object(
               'employee_active', v_active,
               'employee_position', v_position);
end;
$$;

-- A whole month in the PayrollMonthResponse shape, totals included.
create or replace function public.payroll_month_json(p_month_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
    days int;
    v_lines jsonb;
    v_totals jsonb := '[]'::jsonb;
    grp text;
    t record;
    markup double precision;
    invoiced double precision;
    grand double precision := 0;
begin
    select * into m from public.payroll_months where id = p_month_id;
    days := public.payroll_days_in_month(m.year, m.month);

    select coalesce(jsonb_agg(public.payroll_line_json(l.id, true)
                              order by (l.labour_group <> 'service'), l.row_no, l.created_at, l.id),
                    '[]'::jsonb)
      into v_lines
      from public.payroll_lines l
     where l.month_id = m.id;

    foreach grp in array array['service', 'admin'] loop
        select count(*)::int as people,
               public.payroll_r2(coalesce(sum(l.base), 0)) as base,
               public.payroll_r2(coalesce(sum((f ->> '_allowances')::float8), 0)) as allowances,
               public.payroll_r2(coalesce(sum(l.bonus_other), 0)) as bonus_other,
               public.payroll_r2(coalesce(sum((f ->> 'before_tax_and_bpjs')::float8), 0)) as before_tax_and_bpjs,
               public.payroll_r2(coalesce(sum(l.bpjs_employment), 0)) as bpjs_employment,
               public.payroll_r2(coalesce(sum(l.bpjs_health), 0)) as bpjs_health,
               public.payroll_r2(coalesce(sum((f ->> 'before_tax')::float8), 0)) as before_tax,
               public.payroll_r2(coalesce(sum(l.income_tax), 0)) as income_tax,
               public.payroll_r2(coalesce(sum((f ->> 'total_expense')::float8), 0)) as total_expense
          into t
          from public.payroll_lines l
          cross join lateral public.payroll_line_figures(l, days) f
         where l.month_id = m.id and l.labour_group = grp;

        markup := null;
        invoiced := null;
        if grp = 'service' then
            markup := public.payroll_r2(t.total_expense * (m.service_markup_pct / 100));
            invoiced := public.payroll_r2(t.total_expense + markup);
        end if;

        v_totals := v_totals || jsonb_build_array(jsonb_build_object(
            'group', grp,
            'people', t.people,
            'base', t.base,
            'allowances', t.allowances,
            'bonus_other', t.bonus_other,
            'before_tax_and_bpjs', t.before_tax_and_bpjs,
            'bpjs_employment', t.bpjs_employment,
            'bpjs_health', t.bpjs_health,
            'before_tax', t.before_tax,
            'income_tax', t.income_tax,
            'total_expense', t.total_expense,
            'markup', markup,
            'invoiced', invoiced,
            'rounded', public.payroll_roundup_10k(coalesce(invoiced, t.total_expense))
        ));
        grand := grand + t.total_expense;
    end loop;

    return jsonb_build_object(
        'id', m.id,
        'year', m.year,
        'month', m.month,
        'label', public.payroll_label(m.year, m.month),
        'status', m.status,
        'service_markup_pct', m.service_markup_pct,
        'notes', m.notes,
        'is_editable', m.status in ('draft', 'changes_requested'),
        'awaiting', public.payroll_awaiting(m.status),
        'submitted_at', m.submitted_at,
        'endorsed_at', m.endorsed_at,
        'approved_at', m.approved_at,
        'revision_note', m.revision_note,
        'revision_at', m.revision_at,
        'days_in_month', days,
        'lines', v_lines,
        'totals', v_totals,
        'grand_total', public.payroll_r2(grand)
    );
end;
$$;

-- Where somebody sits when nothing else is going on: the crew is service.
create or replace function public.payroll_standing_group(p_work_pattern text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case when p_work_pattern = 'roster' then 'service' else 'admin' end;
$$;

-- Where somebody belongs on this line, back-up rule included.
create or replace function public.payroll_group_for(p_employee_id uuid, p_shift_days double precision)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select case when e.is_backup_engineer
                then case when p_shift_days > 0 then 'service' else 'admin' end
                else public.payroll_standing_group(e.work_pattern::text) end
      from public.employees e
     where e.id = p_employee_id;
$$;

-- Move a line to a group, at the end of it. True if it actually moved.
create or replace function public.payroll_seat_in(p_line_id uuid, p_group text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    next_row int;
begin
    select * into l from public.payroll_lines where id = p_line_id;
    if l.labour_group = p_group then
        return false;
    end if;
    select coalesce(max(row_no), 0) + 1 into next_row
      from public.payroll_lines
     where month_id = l.month_id and id <> l.id and labour_group = p_group;
    update public.payroll_lines
       set labour_group = p_group, row_no = next_row, updated_at = now()
     where id = l.id;
    return true;
end;
$$;

-- DS and NS days on the published roster, or null if nothing is published
-- for that month at all: an unpublished month says nothing about who works it.
create or replace function public.payroll_roster_shift_days(p_employee_id uuid, p_year int, p_month int)
returns int
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    first_day date := make_date(p_year, p_month, 1);
    last_day date := make_date(p_year, p_month, public.payroll_days_in_month(p_year, p_month));
begin
    if not exists (
        select 1 from public.shift_assignments sa
          join public.work_schedules ws on ws.id = sa.schedule_id
         where ws.status::text = 'published' and sa.date between first_day and last_day
    ) then
        return null;
    end if;
    return (
        select count(*)::int from public.shift_assignments sa
          join public.work_schedules ws on ws.id = sa.schedule_id
         where ws.status::text = 'published'
           and sa.employee_id = p_employee_id
           and sa.date between first_day and last_day
           and sa.shift_code::text in ('DS', 'NS'));
end;
$$;

-- Set a back-up engineer's shift days from the roster. True if anything changed.
-- A line given shifts and no rate takes the rate they were last paid.
create or replace function public.payroll_fill_from_roster(p_line_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
    is_backup boolean;
    days int;
    last_rate double precision;
    changed boolean;
begin
    select * into l from public.payroll_lines where id = p_line_id;
    if l.employee_id is null then
        return false;
    end if;
    select e.is_backup_engineer into is_backup from public.employees e where e.id = l.employee_id;
    if not coalesce(is_backup, false) then
        return false;
    end if;
    select * into m from public.payroll_months where id = l.month_id;
    days := public.payroll_roster_shift_days(l.employee_id, m.year, m.month);
    if days is null then
        return false;
    end if;
    changed := l.shift_days <> days;
    update public.payroll_lines set shift_days = days, updated_at = now() where id = l.id;
    if days <> 0 and l.shift_allowance_rate = 0 then
        select pl.shift_allowance_rate into last_rate
          from public.payroll_lines pl
          join public.payroll_months pm on pm.id = pl.month_id
         where pl.employee_id = l.employee_id and pl.shift_allowance_rate > 0
         order by pm.year desc, pm.month desc
         limit 1;
        if coalesce(last_rate, 0) <> 0 then
            update public.payroll_lines set shift_allowance_rate = last_rate where id = l.id;
            changed := true;
        end if;
    end if;
    return changed;
end;
$$;

-- Put anybody active but absent onto the run, details filled and pay at
-- zero. Founders are left off: they take drawings, not a salary. Returns
-- the names added.
create or replace function public.payroll_add_missing_staff(p_month_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    e record;
    grp text;
    next_row int;
    added text[] := '{}';
    name text;
begin
    for e in
        select * from public.employees
         where is_active
           and not (is_management_role and not kpi_review_required)
           and id not in (select employee_id from public.payroll_lines
                           where month_id = p_month_id and employee_id is not null)
         order by work_pattern, employee_id
    loop
        grp := public.payroll_standing_group(e.work_pattern::text);
        select coalesce(max(row_no), 0) + 1 into next_row
          from public.payroll_lines where month_id = p_month_id and labour_group = grp;
        name := btrim(e.first_name || ' ' || e.last_name);
        insert into public.payroll_lines (
            month_id, employee_id, labour_group, row_no, person_name, position,
            bank_name, bank_account_number, bank_account_name, tax_id, ptkp_status)
        values (
            p_month_id, e.id, grp, next_row, name, e.position,
            e.bank_name, e.bank_account_number, e.bank_account_holder, e.tax_id, e.ptkp_status);
        added := added || name;
    end loop;
    return added;
end;
$$;

-- A month summary in the PayrollMonthSummary shape, over some of its lines.
create or replace function public.payroll_summary_json(m public.payroll_months, p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    people int;
    total double precision;
begin
    select count(*)::int,
           public.payroll_r2(coalesce(sum((public.payroll_line_figures(l, public.payroll_days_in_month(m.year, m.month)) ->> 'total_expense')::float8), 0))
      into people, total
      from public.payroll_lines l
     where l.month_id = m.id and (p_employee_id is null or l.employee_id = p_employee_id);
    return jsonb_build_object(
        'id', m.id, 'year', m.year, 'month', m.month,
        'label', public.payroll_label(m.year, m.month),
        'status', m.status, 'people', people, 'total_expense', total);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Months.
-- ---------------------------------------------------------------------------

-- GET /payroll/months: every run, newest first.
create or replace function public.payroll_list_months(p_year int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.payroll_require_access();
    if p_year is not null and (p_year < 2000 or p_year > 2100) then
        raise exception 'year must be between 2000 and 2100' using errcode = 'PT422';
    end if;
    return coalesce((
        select jsonb_agg(public.payroll_summary_json(m, null) order by m.year desc, m.month desc)
          from public.payroll_months m
         where p_year is null or m.year = p_year), '[]'::jsonb);
end;
$$;

-- GET /payroll/months/{id}
create or replace function public.payroll_get_month(p_month_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.payroll_require_access();
    perform public.payroll_load_month(p_month_id);
    return public.payroll_month_json(p_month_id);
end;
$$;

-- POST /payroll/months: open a month, as a copy of the one before.
create or replace function public.payroll_create_month(
    p_year int,
    p_month int,
    p_copy_previous boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    new_id uuid;
    prev public.payroll_months;
    src public.payroll_lines;
    active boolean;
    left_behind text[] := '{}';
    added text[];
    parts text[] := '{}';
    l record;
    wanted text;
begin
    perform public.payroll_require_access();
    if p_year is null or p_year < 2000 or p_year > 2100 then
        raise exception 'year must be between 2000 and 2100' using errcode = 'PT422';
    end if;
    if p_month is null or p_month < 1 or p_month > 12 then
        raise exception 'month must be between 1 and 12' using errcode = 'PT422';
    end if;
    if exists (select 1 from public.payroll_months where year = p_year and month = p_month) then
        raise exception '% already exists.', public.payroll_label(p_year, p_month)
            using errcode = 'PT409';
    end if;

    insert into public.payroll_months (year, month) values (p_year, p_month)
    returning id into new_id;

    if coalesce(p_copy_previous, true) then
        select * into prev from public.payroll_months
         where (year, month) = (case when p_month = 1 then p_year - 1 else p_year end,
                                case when p_month = 1 then 12 else p_month - 1 end);

        if found then
            for src in select * from public.payroll_lines where month_id = prev.id
                        order by labour_group, row_no, created_at, id loop
                if src.employee_id is not null then
                    select e.is_active into active from public.employees e where e.id = src.employee_id;
                    if found and not active then
                        left_behind := left_behind || src.person_name::text;
                        continue;
                    end if;
                end if;
                insert into public.payroll_lines (
                    month_id, employee_id, labour_group, row_no, person_name, position,
                    bank_name, bank_account_number, bank_account_name, tax_id, ptkp_status,
                    base, health_allowance, responsibility_allowance, shift_allowance_rate,
                    shift_days, overtime_allowance, public_holiday_days,
                    public_holiday_rate_override,
                    bonus_other,            -- one-offs are exactly that
                    bpjs_employment, bpjs_health, income_tax,
                    part_days, part_divisor, -- a proration belongs to its month
                    notes)
                values (
                    new_id, src.employee_id, src.labour_group, src.row_no, src.person_name, src.position,
                    src.bank_name, src.bank_account_number, src.bank_account_name, src.tax_id, src.ptkp_status,
                    src.base, src.health_allowance, src.responsibility_allowance, src.shift_allowance_rate,
                    src.shift_days, src.overtime_allowance, src.public_holiday_days,
                    src.public_holiday_rate_override,
                    0,
                    src.bpjs_employment, src.bpjs_health, src.income_tax,
                    null, null,
                    src.notes);
            end loop;

            -- Anybody who has joined since last month's run.
            added := public.payroll_add_missing_staff(new_id);

            -- A back-up engineer's days come from this month's published
            -- roster, and the days decide which group they sit in.
            for l in select id, employee_id from public.payroll_lines
                      where month_id = new_id
                      order by (labour_group <> 'service'), row_no, created_at, id loop
                if l.employee_id is not null then
                    perform public.payroll_fill_from_roster(l.id);
                    if exists (select 1 from public.employees
                                where id = l.employee_id and is_backup_engineer) then
                        select public.payroll_group_for(pl.employee_id, pl.shift_days) into wanted
                          from public.payroll_lines pl where pl.id = l.id;
                        perform public.payroll_seat_in(l.id, wanted);
                    end if;
                end if;
            end loop;

            if cardinality(left_behind) > 0 then
                parts := parts || ('Left off, no longer employed: '
                    || (select string_agg(x, ', ' order by x collate "C") from unnest(left_behind) x) || '.');
            end if;
            if cardinality(added) > 0 then
                parts := parts || ('Added, new since last month: '
                    || (select string_agg(x, ', ' order by x collate "C") from unnest(added) x) || '.');
            end if;
            update public.payroll_months
               set notes = nullif(array_to_string(parts, ' '), '')
             where id = new_id;
        else
            perform public.payroll_add_missing_staff(new_id);
        end if;
    end if;

    perform public.log_activity('PAYROLL_MONTH_OPENED',
        'Opened the payroll run for ' || public.payroll_label(p_year, p_month));
    return public.payroll_month_json(new_id);
end;
$$;

-- PATCH /payroll/months/{id}: the markup or the notes.
create or replace function public.payroll_update_month(p_month_id uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
    k text;
    pct double precision;
begin
    perform public.payroll_require_access();
    p_changes := coalesce(p_changes, '{}'::jsonb);
    for k in select jsonb_object_keys(p_changes) loop
        if k not in ('service_markup_pct', 'notes') then
            raise exception 'Unknown field: %', k using errcode = 'PT422';
        end if;
    end loop;
    if p_changes ? 'service_markup_pct' then
        if jsonb_typeof(p_changes -> 'service_markup_pct') = 'null' then
            raise exception 'service_markup_pct must be a number' using errcode = 'PT422';
        end if;
        pct := (p_changes ->> 'service_markup_pct')::double precision;
        if pct < 0 or pct > 100 then
            raise exception 'service_markup_pct must be between 0 and 100' using errcode = 'PT422';
        end if;
    end if;

    m := public.payroll_load_month(p_month_id);
    perform public.payroll_require_draft(m);

    update public.payroll_months
       set service_markup_pct = case when p_changes ? 'service_markup_pct' then pct else service_markup_pct end,
           notes = case when p_changes ? 'notes' then p_changes ->> 'notes' else notes end,
           updated_at = now()
     where id = m.id;
    return public.payroll_month_json(m.id);
end;
$$;

-- DELETE /payroll/months/{id}
create or replace function public.payroll_delete_month(p_month_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
begin
    perform public.payroll_require_access();
    m := public.payroll_load_month(p_month_id);
    perform public.payroll_require_draft(m);
    delete from public.payroll_months where id = m.id;
    perform public.log_activity('PAYROLL_MONTH_DELETED',
        'Deleted the payroll run for ' || public.payroll_label(m.year, m.month));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The chain: finance prepares, the director reviews, the executive approves.
-- ---------------------------------------------------------------------------

create or replace function public.payroll_submit_month(p_month_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
begin
    perform public.payroll_require_access();
    m := public.payroll_load_month(p_month_id);
    perform public.payroll_require_draft(m);
    if not exists (select 1 from public.payroll_lines where month_id = m.id) then
        raise exception 'There is nobody on this run to approve.' using errcode = 'PT409';
    end if;
    update public.payroll_months
       set status = 'submitted', submitted_at = now(), submitted_by_id = auth.uid(),
           revision_note = null, revision_at = null, revision_by_id = null,
           updated_at = now()
     where id = m.id;
    perform public.log_activity('PAYROLL_MONTH_SUBMITTED',
        'Sent the ' || public.payroll_label(m.year, m.month) || ' payroll for approval');
    return public.payroll_month_json(m.id);
end;
$$;

create or replace function public.payroll_endorse_month(p_month_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
begin
    perform public.payroll_require_access();
    m := public.payroll_load_month(p_month_id);
    perform public.payroll_require_signatory(m);
    update public.payroll_months
       set status = 'endorsed', endorsed_at = now(), endorsed_by_id = auth.uid(),
           revision_note = null, revision_at = null, revision_by_id = null,
           updated_at = now()
     where id = m.id;
    perform public.log_activity('PAYROLL_MONTH_ENDORSED',
        'Reviewed the ' || public.payroll_label(m.year, m.month)
        || ' payroll and passed it to the executive');
    return public.payroll_month_json(m.id);
end;
$$;

create or replace function public.payroll_approve_month(p_month_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
begin
    perform public.payroll_require_access();
    m := public.payroll_load_month(p_month_id);
    perform public.payroll_require_signatory(m);
    update public.payroll_months
       set status = 'approved', approved_at = now(), approved_by_id = auth.uid(),
           updated_at = now()
     where id = m.id;
    perform public.log_activity('PAYROLL_MONTH_APPROVED',
        'Approved the ' || public.payroll_label(m.year, m.month) || ' payroll');
    return public.payroll_month_json(m.id);
end;
$$;

-- POST /payroll/months/{id}/request-changes: back to finance, or -- the
-- executive's alone, once the director has passed it on -- to the director.
create or replace function public.payroll_request_changes(
    p_month_id uuid,
    p_note text,
    p_send_to text default 'finance'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
    note text;
    send_to text := coalesce(p_send_to, 'finance');
begin
    if p_note is null or char_length(p_note) < 3 then
        raise exception 'Say what needs changing: at least 3 characters.' using errcode = 'PT422';
    end if;
    if char_length(p_note) > 2000 then
        raise exception 'The reason can be at most 2000 characters.' using errcode = 'PT422';
    end if;
    if send_to not in ('finance', 'director') then
        raise exception 'send_to must be finance or director' using errcode = 'PT422';
    end if;

    perform public.payroll_require_access();
    m := public.payroll_load_month(p_month_id);
    note := btrim(p_note);

    if send_to = 'director' then
        if coalesce(public.current_user_role()::text, '') <> 'executive'
           or m.status not in ('endorsed', 'approved') then
            raise exception 'Only the executive can send a run back to the director, once the director has passed it on.'
                using errcode = 'PT403';
        end if;
        update public.payroll_months
           set status = 'submitted',
               revision_note = note, revision_at = now(), revision_by_id = auth.uid(),
               endorsed_at = null, endorsed_by_id = null,
               approved_at = null, approved_by_id = null,
               updated_at = now()
         where id = m.id;
        perform public.log_activity('PAYROLL_MONTH_CHANGES_REQUESTED',
            'Sent the ' || public.payroll_label(m.year, m.month)
            || ' payroll back to the director: ' || note);
        return public.payroll_month_json(m.id);
    end if;

    if m.status = 'approved' then
        -- Undoing an approval reverses somebody else's signature: never finance's.
        if coalesce(public.current_user_role()::text, '') not in ('director', 'executive') then
            raise exception 'Only the director or the executive can reopen an approved run.'
                using errcode = 'PT403';
        end if;
    else
        perform public.payroll_require_signatory(m);
    end if;

    update public.payroll_months
       set status = 'changes_requested',
           revision_note = note, revision_at = now(), revision_by_id = auth.uid(),
           endorsed_at = null, endorsed_by_id = null,
           approved_at = null, approved_by_id = null,
           updated_at = now()
     where id = m.id;
    perform public.log_activity('PAYROLL_MONTH_CHANGES_REQUESTED',
        'Sent the ' || public.payroll_label(m.year, m.month)
        || ' payroll back to finance: ' || note);
    return public.payroll_month_json(m.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Lines.
-- ---------------------------------------------------------------------------

-- POST /payroll/months/{id}/lines: a joiner, or a name the staff list has not got.
create or replace function public.payroll_add_line(p_month_id uuid, p_line jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    m public.payroll_months;
    p jsonb := coalesce(p_line, '{}'::jsonb);
    grp text := p ->> 'labour_group';
    pname text := p ->> 'person_name';
    rn int := coalesce((p ->> 'row_no')::int, 0);
    emp uuid := nullif(p ->> 'employee_id', '')::uuid;
    new_id uuid;
begin
    perform public.payroll_require_access();
    if grp is null or grp not in ('service', 'admin') then
        raise exception 'labour_group must be service or admin' using errcode = 'PT422';
    end if;
    if pname is null or char_length(pname) < 1 or char_length(pname) > 160 then
        raise exception 'person_name must be 1 to 160 characters' using errcode = 'PT422';
    end if;

    m := public.payroll_load_month(p_month_id);
    perform public.payroll_require_draft(m);

    if rn = 0 then
        select coalesce(max(row_no), 0) + 1 into rn
          from public.payroll_lines where month_id = m.id and labour_group = grp;
    end if;

    insert into public.payroll_lines (
        month_id, employee_id, labour_group, row_no, person_name, position,
        bank_name, bank_account_number, bank_account_name, tax_id, ptkp_status,
        base, health_allowance, responsibility_allowance, shift_allowance_rate, shift_days,
        overtime_allowance, public_holiday_days, public_holiday_rate_override, bonus_other,
        bpjs_employment, bpjs_health, income_tax, part_days, part_divisor, notes)
    values (
        m.id, emp, grp, rn, pname, p ->> 'position',
        p ->> 'bank_name', p ->> 'bank_account_number', p ->> 'bank_account_name',
        p ->> 'tax_id', p ->> 'ptkp_status',
        coalesce((p ->> 'base')::float8, 0),
        coalesce((p ->> 'health_allowance')::float8, 0),
        coalesce((p ->> 'responsibility_allowance')::float8, 0),
        coalesce((p ->> 'shift_allowance_rate')::float8, 0),
        coalesce((p ->> 'shift_days')::float8, 0),
        coalesce((p ->> 'overtime_allowance')::float8, 0),
        coalesce((p ->> 'public_holiday_days')::float8, 0),
        (p ->> 'public_holiday_rate_override')::float8,
        coalesce((p ->> 'bonus_other')::float8, 0),
        coalesce((p ->> 'bpjs_employment')::float8, 0),
        coalesce((p ->> 'bpjs_health')::float8, 0),
        coalesce((p ->> 'income_tax')::float8, 0),
        (p ->> 'part_days')::float8,
        (p ->> 'part_divisor')::float8,
        p ->> 'notes')
    returning id into new_id;

    perform public.log_activity('PAYROLL_LINE_ADDED',
        'Added ' || pname || ' to the payroll run for ' || public.payroll_label(m.year, m.month),
        emp);
    return public.payroll_line_json(new_id, false);
end;
$$;

-- PUT /payroll/lines/{id}: one cell at a time; the whole month comes back.
create or replace function public.payroll_update_line(p_line_id uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    p jsonb := coalesce(p_changes, '{}'::jsonb);
    l public.payroll_lines;
    m public.payroll_months;
    k text;
    asked text;
    moved_to text;
    required_cols text[] := array[
        'row_no', 'person_name', 'base', 'health_allowance', 'responsibility_allowance',
        'shift_allowance_rate', 'shift_days', 'overtime_allowance', 'public_holiday_days',
        'bonus_other', 'bpjs_employment', 'bpjs_health', 'income_tax'];
    allowed text[] := array[
        'labour_group', 'row_no', 'person_name', 'position', 'bank_name',
        'bank_account_number', 'bank_account_name', 'tax_id', 'ptkp_status', 'base',
        'health_allowance', 'responsibility_allowance', 'shift_allowance_rate', 'shift_days',
        'overtime_allowance', 'public_holiday_days', 'public_holiday_rate_override',
        'bonus_other', 'bpjs_employment', 'bpjs_health', 'income_tax', 'part_days',
        'part_divisor', 'notes'];
begin
    perform public.payroll_require_access();
    for k in select jsonb_object_keys(p) loop
        if not (k = any(allowed)) then
            raise exception 'Unknown field: %', k using errcode = 'PT422';
        end if;
        if k = any(required_cols) and jsonb_typeof(p -> k) = 'null' then
            raise exception '% cannot be empty', k using errcode = 'PT422';
        end if;
    end loop;
    if p ? 'person_name' and (char_length(p ->> 'person_name') < 1
                              or char_length(p ->> 'person_name') > 160) then
        raise exception 'person_name must be 1 to 160 characters' using errcode = 'PT422';
    end if;
    asked := p ->> 'labour_group';
    if asked is not null and asked not in ('service', 'admin') then
        raise exception 'labour_group must be service or admin' using errcode = 'PT422';
    end if;

    select * into l from public.payroll_lines where id = p_line_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    m := public.payroll_load_month(l.month_id);
    perform public.payroll_require_draft(m);

    update public.payroll_lines set
        row_no = case when p ? 'row_no' then (p ->> 'row_no')::int else row_no end,
        person_name = case when p ? 'person_name' then p ->> 'person_name' else person_name end,
        position = case when p ? 'position' then p ->> 'position' else position end,
        bank_name = case when p ? 'bank_name' then p ->> 'bank_name' else bank_name end,
        bank_account_number = case when p ? 'bank_account_number' then p ->> 'bank_account_number' else bank_account_number end,
        bank_account_name = case when p ? 'bank_account_name' then p ->> 'bank_account_name' else bank_account_name end,
        tax_id = case when p ? 'tax_id' then p ->> 'tax_id' else tax_id end,
        ptkp_status = case when p ? 'ptkp_status' then p ->> 'ptkp_status' else ptkp_status end,
        base = case when p ? 'base' then (p ->> 'base')::float8 else base end,
        health_allowance = case when p ? 'health_allowance' then (p ->> 'health_allowance')::float8 else health_allowance end,
        responsibility_allowance = case when p ? 'responsibility_allowance' then (p ->> 'responsibility_allowance')::float8 else responsibility_allowance end,
        shift_allowance_rate = case when p ? 'shift_allowance_rate' then (p ->> 'shift_allowance_rate')::float8 else shift_allowance_rate end,
        shift_days = case when p ? 'shift_days' then (p ->> 'shift_days')::float8 else shift_days end,
        overtime_allowance = case when p ? 'overtime_allowance' then (p ->> 'overtime_allowance')::float8 else overtime_allowance end,
        public_holiday_days = case when p ? 'public_holiday_days' then (p ->> 'public_holiday_days')::float8 else public_holiday_days end,
        public_holiday_rate_override = case when p ? 'public_holiday_rate_override' then (p ->> 'public_holiday_rate_override')::float8 else public_holiday_rate_override end,
        bonus_other = case when p ? 'bonus_other' then (p ->> 'bonus_other')::float8 else bonus_other end,
        bpjs_employment = case when p ? 'bpjs_employment' then (p ->> 'bpjs_employment')::float8 else bpjs_employment end,
        bpjs_health = case when p ? 'bpjs_health' then (p ->> 'bpjs_health')::float8 else bpjs_health end,
        income_tax = case when p ? 'income_tax' then (p ->> 'income_tax')::float8 else income_tax end,
        part_days = case when p ? 'part_days' then (p ->> 'part_days')::float8 else part_days end,
        part_divisor = case when p ? 'part_divisor' then (p ->> 'part_divisor')::float8 else part_divisor end,
        notes = case when p ? 'notes' then p ->> 'notes' else notes end,
        updated_at = now()
    where id = l.id
    returning * into l;

    if asked is not null then
        -- An explicit move wins over anything derived.
        moved_to := asked;
    elsif p ? 'shift_days' and l.employee_id is not null
          and exists (select 1 from public.employees where id = l.employee_id and is_backup_engineer) then
        -- A back-up engineer follows the shifts they actually covered.
        moved_to := public.payroll_group_for(l.employee_id, l.shift_days);
    end if;

    if moved_to is not null and l.labour_group <> moved_to then
        perform public.payroll_seat_in(l.id, moved_to);
    end if;

    perform public.log_activity('PAYROLL_LINE_UPDATED',
        case when moved_to is not null
             then 'Moved ' || l.person_name || ' to '
                  || case when moved_to = 'service' then 'Service' else 'Admin' end
                  || ' Labour for ' || public.payroll_label(m.year, m.month)
             else 'Updated ' || l.person_name || '''s pay for ' || public.payroll_label(m.year, m.month)
        end,
        l.employee_id);
    return public.payroll_month_json(m.id);
end;
$$;

-- DELETE /payroll/lines/{id}
create or replace function public.payroll_delete_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    l public.payroll_lines;
    m public.payroll_months;
begin
    perform public.payroll_require_access();
    select * into l from public.payroll_lines where id = p_line_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    m := public.payroll_load_month(l.month_id);
    perform public.payroll_require_draft(m);
    delete from public.payroll_lines where id = l.id;
    perform public.log_activity('PAYROLL_LINE_REMOVED',
        'Removed ' || l.person_name || ' from the payroll run for '
        || public.payroll_label(m.year, m.month));
end;
$$;

-- GET /payroll/staff/{employee_id}: what one person cost, month by month.
create or replace function public.payroll_person_by_month(p_employee_id uuid, p_year int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    yr int := coalesce(p_year, extract(year from current_date)::int);
begin
    perform public.payroll_require_access();
    if yr < 2000 or yr > 2100 then
        raise exception 'year must be between 2000 and 2100' using errcode = 'PT422';
    end if;
    return coalesce((
        select jsonb_agg(public.payroll_summary_json(m, p_employee_id) order by m.month)
          from public.payroll_months m
         where m.year = yr
           and exists (select 1 from public.payroll_lines l
                        where l.month_id = m.id and l.employee_id = p_employee_id)), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. A change of back-up status moves where somebody's pay is counted.
--
-- The backend did this in PUT /employees/{id}. Done here as a trigger so it
-- holds however the employee record is updated. Only runs finance can still
-- edit are touched: a submitted or approved month is a record.
-- ---------------------------------------------------------------------------
create or replace function public.payroll_reseat_on_backup_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r record;
    wanted text;
    shift double precision;
begin
    for r in
        select l.id, l.person_name, l.shift_days, m.year, m.month
          from public.payroll_lines l
          join public.payroll_months m on m.id = l.month_id
         where l.employee_id = new.id
           and m.status in ('draft', 'changes_requested')
         order by m.year, m.month, l.row_no
    loop
        if new.is_backup_engineer and coalesce(r.shift_days, 0) = 0 then
            perform public.payroll_fill_from_roster(r.id);
        end if;
        select shift_days into shift from public.payroll_lines where id = r.id;
        wanted := case when new.is_backup_engineer
                       then case when shift > 0 then 'service' else 'admin' end
                       else public.payroll_standing_group(new.work_pattern::text) end;
        if public.payroll_seat_in(r.id, wanted) then
            perform public.log_activity('PAYROLL_LINE_REGROUPED',
                'Moved ' || r.person_name || ' to '
                || case when wanted = 'service' then 'Service' else 'Admin' end
                || ' Labour for ' || r.year || '-' || lpad(r.month::text, 2, '0')
                || ' after a change of back-up engineer status',
                new.id);
        end if;
    end loop;
    return new;
end;
$$;

drop trigger if exists payroll_reseat_on_backup_change on public.employees;
create trigger payroll_reseat_on_backup_change
    after update of is_backup_engineer on public.employees
    for each row
    when (old.is_backup_engineer is distinct from new.is_backup_engineer)
    execute function public.payroll_reseat_on_backup_change();

-- ---------------------------------------------------------------------------
-- 7. The pay forecast (/compensation).
-- ---------------------------------------------------------------------------

-- Management and administrators. 404 for everybody else.
create or replace function public.compensation_require_management()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if public.is_admin()
       or coalesce(public.current_user_role()::text, '') in ('director', 'executive')
       or coalesce((public.current_employee()).is_management_role, false) then
        return;
    end if;
    raise exception 'Not found' using errcode = 'PT404';
end;
$$;

-- One person's plan in the CompensationRow shape, the Salary_Forecast arithmetic.
create or replace function public.compensation_row_json(
    e public.employees,
    c public.compensation_plans,
    p_kpi jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    has_plan boolean := c.id is not null;
    proposed_basic double precision;
    proposed_gross double precision;
    monthly double precision;
    annual double precision;
    with_bonus double precision;
    uplift double precision := 0;
begin
    if has_plan then
        if c.current_basic is not null and c.increase_pct is not null then
            proposed_basic := public.payroll_r2(c.current_basic * (1 + c.increase_pct / 100));
        end if;
        if c.current_gross is not null then
            if proposed_basic is not null and c.current_basic is not null then
                uplift := proposed_basic - c.current_basic;
            end if;
            proposed_gross := public.payroll_r2(c.current_gross + uplift + coalesce(c.additional_gross, 0));
        end if;
        if proposed_gross is not null then
            monthly := proposed_gross + coalesce(c.bpjs_employment, 0) + coalesce(c.bpjs_health, 0);
            if c.tax_bearer = 'company' then
                monthly := monthly + coalesce(c.income_tax, 0);
            end if;
            monthly := public.payroll_r2(monthly);
            annual := public.payroll_r2(monthly * 12);
        end if;
        if annual is null then
            with_bonus := case when coalesce(c.bonus_amount, 0) = 0 then null
                               else public.payroll_r2(c.bonus_amount) end;
        else
            with_bonus := public.payroll_r2(annual + coalesce(c.bonus_amount, 0));
        end if;
    end if;

    return jsonb_build_object(
        'employee_id', e.id,
        'employee_name', btrim(e.first_name || ' ' || e.last_name),
        'position', e.position,
        'work_pattern', e.work_pattern::text,
        'bonus_eligible', coalesce(e.bonus_eligible, false),
        'kpi_period', p_kpi -> 'kpi_period',
        'kpi_score', p_kpi -> 'kpi_score',
        'kpi_band', p_kpi -> 'kpi_band',
        'kpi_multiplier', p_kpi -> 'kpi_multiplier',
        'current_basic', c.current_basic,
        'current_gross', c.current_gross,
        'increase_pct', c.increase_pct,
        'additional_gross', c.additional_gross,
        'bpjs_employment', c.bpjs_employment,
        'bpjs_health', c.bpjs_health,
        'tax_bearer', c.tax_bearer,
        'income_tax', c.income_tax,
        'bonus_amount', c.bonus_amount,
        'notes', c.notes,
        'proposed_basic', proposed_basic,
        'proposed_gross', proposed_gross,
        'monthly_cost', monthly,
        'annual_cost', annual,
        'annual_cost_with_bonus', with_bonus
    );
end;
$$;

-- The latest published KPI result for one person, scored as kpi_service does:
-- N/A lines removed and the rest renormalised to 100, out of 130.
create or replace function public.compensation_kpi_json(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    rv record;
    applicable_weight double precision;
    applicable_count int;
    rated_count int;
    total double precision := 0;
    complete boolean;
    band text;
    mult double precision;
begin
    select r.id, r.period_label into rv
      from public.kpi_reviews r
     where r.employee_id = p_employee_id and r.status::text = 'published'
     order by r.period_start desc
     limit 1;
    if not found then
        return jsonb_build_object('kpi_period', null, 'kpi_score', null,
                                  'kpi_band', null, 'kpi_multiplier', null);
    end if;

    select coalesce(sum(i.weight::float8), 0), count(*)::int
      into applicable_weight, applicable_count
      from public.kpi_review_items i
     where i.review_id = rv.id and not i.is_not_applicable;

    if applicable_count = 0 or applicable_weight <= 0 then
        total := 0;
        complete := false;
    else
        select coalesce(sum(i.weight::float8 * (100.0::float8 / applicable_weight)
                            * case i.rating when 5 then 1.30 when 4 then 1.15 when 3 then 1.00
                                            when 2 then 0.75 when 1 then 0.50 else 0.00 end::float8), 0),
               count(*)::int
          into total, rated_count
          from public.kpi_review_items i
         where i.review_id = rv.id and not i.is_not_applicable and i.rating is not null;
        total := public.payroll_r2(total);
        complete := rated_count = applicable_count;
    end if;

    if complete then
        band := case when total >= 115 then 'Outstanding / Key Talent'
                     when total >= 105 then 'Exceeds Expectations'
                     when total >= 85  then 'Meets Expectations'
                     when total >= 70  then 'Developing'
                     else 'Below Expectations' end;
        mult := case when total >= 115 then 1.5
                     when total >= 105 then 1.25
                     when total >= 95  then 1.0
                     when total >= 85  then 0.5
                     else 0.0 end;
    end if;

    return jsonb_build_object('kpi_period', rv.period_label, 'kpi_score', total,
                              'kpi_band', band, 'kpi_multiplier', mult);
end;
$$;

-- GET /compensation?year=: everybody's proposed pay for one year, with what it costs.
create or replace function public.compensation_list(p_year int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    yr int := coalesce(p_year, extract(year from current_date)::int + 1);
    items jsonb;
    rate jsonb;
    fx public.compensation_fx_rates;
begin
    perform public.compensation_require_management();
    if yr < 2000 or yr > 2100 then
        raise exception 'year must be between 2000 and 2100' using errcode = 'PT422';
    end if;

    select coalesce(jsonb_agg(
               public.compensation_row_json(e, c, public.compensation_kpi_json(e.id))
               order by e.work_pattern, e.employee_id), '[]'::jsonb)
      into items
      from public.employees e
      left join public.compensation_plans c on c.employee_id = e.id and c.year = yr
     where e.is_active
       -- Founders take drawings, not a salary budgeted as staff cost.
       and not (e.is_management_role and not e.kpi_review_required);

    select * into fx from public.compensation_fx_rates order by fetched_at desc limit 1;
    if found then
        rate := jsonb_build_object(
            'idr_per_aud', fx.idr_per_aud,
            'as_of', fx.as_of,
            'stale', fx.fetched_at < now() - interval '36 hours');
    end if;

    return jsonb_build_object(
        'year', yr,
        'items', items,
        'rate', rate,
        'totals', (
            select jsonb_build_object(
                'roster_annual', public.payroll_r2(coalesce(sum(coalesce((x ->> 'annual_cost_with_bonus')::float8, 0))
                                    filter (where x ->> 'work_pattern' = 'roster'), 0)),
                'office_annual', public.payroll_r2(coalesce(sum(coalesce((x ->> 'annual_cost_with_bonus')::float8, 0))
                                    filter (where x ->> 'work_pattern' is distinct from 'roster'), 0)),
                'bonus_total', public.payroll_r2(coalesce(sum(coalesce((x ->> 'bonus_amount')::float8, 0)), 0)),
                'annual_total', public.payroll_r2(coalesce(sum(coalesce((x ->> 'annual_cost_with_bonus')::float8, 0)), 0)),
                'monthly_total', public.payroll_r2(coalesce(sum(coalesce((x ->> 'monthly_cost')::float8, 0)), 0)),
                'people', count(x)::int)
              from jsonb_array_elements(items) x)
    );
end;
$$;

-- PUT /compensation/{employee_id}?year=: set one person's figures for the year.
create or replace function public.compensation_upsert(
    p_employee_id uuid,
    p_changes jsonb,
    p_year int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    yr int := coalesce(p_year, extract(year from current_date)::int + 1);
    p jsonb := coalesce(p_changes, '{}'::jsonb);
    e public.employees;
    c public.compensation_plans;
    k text;
    v double precision;
    allowed text[] := array['current_basic', 'current_gross', 'increase_pct', 'additional_gross',
                            'bpjs_employment', 'bpjs_health', 'tax_bearer', 'income_tax',
                            'bonus_amount', 'notes'];
begin
    perform public.compensation_require_management();
    if yr < 2000 or yr > 2100 then
        raise exception 'year must be between 2000 and 2100' using errcode = 'PT422';
    end if;
    for k in select jsonb_object_keys(p) loop
        if not (k = any(allowed)) then
            continue;  -- pydantic ignored unknown fields here
        end if;
        if k in ('tax_bearer', 'notes') or jsonb_typeof(p -> k) = 'null' then
            continue;
        end if;
        v := (p ->> k)::double precision;
        if k = 'increase_pct' and (v < -100 or v > 1000) then
            raise exception 'increase_pct must be between -100 and 1000' using errcode = 'PT422';
        end if;
        if k in ('current_basic', 'current_gross', 'bpjs_employment', 'bpjs_health',
                 'income_tax', 'bonus_amount') and v < 0 then
            raise exception '% cannot be negative', k using errcode = 'PT422';
        end if;
    end loop;

    select * into e from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    -- A bonus for somebody who is not eligible for one is a typo, not an intention.
    if coalesce((p ->> 'bonus_amount')::float8, 0) <> 0 and not coalesce(e.bonus_eligible, false) then
        raise exception '% is not bonus-eligible. Turn Bonus on in Settings first.', e.first_name
            using errcode = 'PT409';
    end if;

    insert into public.compensation_plans (employee_id, year) values (e.id, yr)
    on conflict (employee_id, year) do nothing;

    update public.compensation_plans set
        current_basic = case when p ? 'current_basic' then (p ->> 'current_basic')::float8 else current_basic end,
        current_gross = case when p ? 'current_gross' then (p ->> 'current_gross')::float8 else current_gross end,
        increase_pct = case when p ? 'increase_pct' then (p ->> 'increase_pct')::float8 else increase_pct end,
        additional_gross = case when p ? 'additional_gross' then (p ->> 'additional_gross')::float8 else additional_gross end,
        bpjs_employment = case when p ? 'bpjs_employment' then (p ->> 'bpjs_employment')::float8 else bpjs_employment end,
        bpjs_health = case when p ? 'bpjs_health' then (p ->> 'bpjs_health')::float8 else bpjs_health end,
        tax_bearer = case when p ? 'tax_bearer' then p ->> 'tax_bearer' else tax_bearer end,
        income_tax = case when p ? 'income_tax' then (p ->> 'income_tax')::float8 else income_tax end,
        bonus_amount = case when p ? 'bonus_amount' then (p ->> 'bonus_amount')::float8 else bonus_amount end,
        notes = case when p ? 'notes' then p ->> 'notes' else notes end,
        updated_at = now()
    where employee_id = e.id and year = yr
    returning * into c;

    perform public.log_activity('COMPENSATION_PLAN_UPDATED',
        'Updated the ' || yr || ' pay forecast for ' || e.first_name || ' ' || e.last_name,
        e.id);

    -- The PUT response carries no KPI figures: they are read-only context.
    return public.compensation_row_json(e, c,
        jsonb_build_object('kpi_period', null, 'kpi_score', null,
                           'kpi_band', null, 'kpi_multiplier', null));
end;
$$;

-- Record the AUD/IDR rate the forecast shows. An administrator, or a future
-- Edge Function holding the service role, writes it; nothing invents one.
create or replace function public.compensation_record_rate(p_idr_per_aud double precision, p_as_of text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.is_admin() and current_user <> 'service_role' then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if p_idr_per_aud is null or p_idr_per_aud <= 0 then
        raise exception 'idr_per_aud must be a positive number' using errcode = 'PT422';
    end if;
    insert into public.compensation_fx_rates (idr_per_aud, as_of)
    values (p_idr_per_aud, coalesce(p_as_of, ''));
    return jsonb_build_object('idr_per_aud', p_idr_per_aud, 'as_of', coalesce(p_as_of, ''), 'stale', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Grants.
-- ---------------------------------------------------------------------------
do $$
declare
    f text;
begin
    -- Internal helpers: nobody calls these directly.
    foreach f in array array[
        'public.payroll_r2(double precision)',
        'public.payroll_roundup_10k(double precision)',
        'public.payroll_label(int, int)',
        'public.payroll_days_in_month(int, int)',
        'public.payroll_awaiting(text)',
        'public.payroll_require_access()',
        'public.payroll_load_month(uuid)',
        'public.payroll_require_draft(public.payroll_months)',
        'public.payroll_require_signatory(public.payroll_months)',
        'public.payroll_line_figures(public.payroll_lines, int)',
        'public.payroll_line_json(uuid, boolean)',
        'public.payroll_month_json(uuid)',
        'public.payroll_standing_group(text)',
        'public.payroll_group_for(uuid, double precision)',
        'public.payroll_seat_in(uuid, text)',
        'public.payroll_roster_shift_days(uuid, int, int)',
        'public.payroll_fill_from_roster(uuid)',
        'public.payroll_add_missing_staff(uuid)',
        'public.payroll_summary_json(public.payroll_months, uuid)',
        'public.payroll_reseat_on_backup_change()',
        'public.compensation_require_management()',
        'public.compensation_row_json(public.employees, public.compensation_plans, jsonb)',
        'public.compensation_kpi_json(uuid)'
    ] loop
        execute format('revoke all on function %s from public', f);
    end loop;

    -- The RPCs the screens call.
    foreach f in array array[
        'public.payroll_list_months(int)',
        'public.payroll_get_month(uuid)',
        'public.payroll_create_month(int, int, boolean)',
        'public.payroll_update_month(uuid, jsonb)',
        'public.payroll_delete_month(uuid)',
        'public.payroll_submit_month(uuid)',
        'public.payroll_endorse_month(uuid)',
        'public.payroll_approve_month(uuid)',
        'public.payroll_request_changes(uuid, text, text)',
        'public.payroll_add_line(uuid, jsonb)',
        'public.payroll_update_line(uuid, jsonb)',
        'public.payroll_delete_line(uuid)',
        'public.payroll_person_by_month(uuid, int)',
        'public.compensation_list(int)',
        'public.compensation_upsert(uuid, jsonb, int)',
        'public.compensation_record_rate(double precision, text)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
    execute 'grant execute on function public.compensation_record_rate(double precision, text) to service_role';
end $$;

commit;
