-- ===========================================================================
-- Career history: what somebody's job has been, as a list of periods.
--
-- The director: "Nessy changed to Business Support in August; before that she
-- was a Geotechnical Monitoring Engineer. It's hard to update when someone is
-- promoted -- I myself went from Engineer to Senior to Director. It should be
-- more editable."
--
-- employee_role_changes (20260926000200_people.sql) recorded before/after
-- pairs, only from the day the Hub started watching, and only the date and
-- note could be corrected. employee_career replaces it on screen:
--
--   * One row per period: the day it started, position, level, department and
--     a note. A period ends where the next one starts; the latest is the
--     current role.
--   * Backfilled from the profile and, where there are any, the recorded role
--     changes (people_career_backfill, below).
--   * Written automatically when position, level or department changes on the
--     profile, dated today in Jakarta (one entry per day: a second change the
--     same day updates it).
--   * Editable by whoever may edit employee records (can_manage_people);
--     readable by whoever may read the profile, the employee included.
--   * After an add, edit or delete, the profile's position, level and
--     department are set from the latest entry, without that write coming
--     back round as another automatic entry.
--
-- employee_role_changes stays, and people_update_employee still writes it;
-- the screens no longer show it.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------
create table if not exists public.employee_career (
    id              uuid primary key default gen_random_uuid(),
    employee_id     uuid not null references public.employees(id) on delete cascade,
    effective_date  date not null,
    position        varchar(100) not null,
    job_level       varchar(100),
    department      varchar(100),
    note            text,
    created_by      uuid references public.users(id) on delete set null,
    updated_by      uuid references public.users(id) on delete set null,
    created_at      timestamp not null default now(),
    updated_at      timestamp not null default now(),
    constraint uq_employee_career_date unique (employee_id, effective_date)
);

alter table public.employee_career enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Helpers.
-- ---------------------------------------------------------------------------

-- One entry as the screen reads it. end_date is the day before the next
-- entry starts, or null for the latest.
create or replace function public.people_career_json(c public.employee_career)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', c.id,
        'employee_id', c.employee_id,
        'effective_date', to_char(c.effective_date, 'YYYY-MM-DD'),
        'end_date', (
            select to_char(min(n.effective_date) - 1, 'YYYY-MM-DD')
              from public.employee_career n
             where n.employee_id = c.employee_id and n.effective_date > c.effective_date
        ),
        'is_current', not exists (
            select 1 from public.employee_career n
             where n.employee_id = c.employee_id and n.effective_date > c.effective_date
        ),
        'position', c.position,
        'job_level', c.job_level,
        'department', c.department,
        'note', c.note,
        'created_at', c.created_at,
        'updated_at', c.updated_at
    );
$$;

-- Set the profile's position, level and department from the latest entry.
-- The flag stops the profile trigger below writing that back as a new entry.
create or replace function public.people_career_sync(p_employee_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_latest public.employee_career%rowtype;
begin
    select * into v_latest
      from public.employee_career
     where employee_id = p_employee_id
     order by effective_date desc
     limit 1;
    if not found then
        return;
    end if;

    perform set_config('dtg.career_sync', 'on', true);
    update public.employees e set
        position   = v_latest.position,
        job_level  = v_latest.job_level,
        -- The profile's department cannot be empty; an entry's can.
        department = coalesce(nullif(v_latest.department, ''), e.department),
        updated_at = now()
     where e.id = p_employee_id
       and (e.position, e.job_level, e.department)
           is distinct from (v_latest.position, v_latest.job_level,
                             coalesce(nullif(v_latest.department, ''), e.department));
    perform set_config('dtg.career_sync', 'off', true);
end;
$$;

-- The first history for somebody who has none: their joining-date role, then
-- one entry per recorded role change.
--
-- Walks the role changes newest first, from the profile as it stands now,
-- undoing each change to find what came before it. A field whose previous
-- value was "not set" is treated as filled in rather than changed ("LEVEL not
-- set -> Engineer" means the level was always Engineer, just not typed in):
-- it is not undone, and a change made only of those is not an entry. A
-- change dated on or before joining lands on the joining date. Consecutive
-- entries that say the same thing are merged into the earlier one.
create or replace function public.people_career_backfill(p_employee_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_emp public.employees%rowtype;
    v_pos text;
    v_lvl text;
    v_dep text;
    r public.employee_role_changes%rowtype;
    v_real boolean;
begin
    select * into v_emp from public.employees where id = p_employee_id;
    if not found then
        return;
    end if;
    if exists (select 1 from public.employee_career where employee_id = p_employee_id) then
        return;
    end if;

    v_pos := v_emp.position;
    v_lvl := v_emp.job_level;
    v_dep := v_emp.department;

    for r in
        select * from public.employee_role_changes
         where employee_id = p_employee_id
         order by effective_date desc, created_at desc
    loop
        v_real := r.previous_position is not null
               or r.previous_job_level is not null
               or r.previous_department is not null;
        if v_real then
            -- Newest first, so on a shared date the later change wins.
            insert into public.employee_career
                (employee_id, effective_date, position, job_level, department, note, created_by)
            values
                (p_employee_id, greatest(r.effective_date, v_emp.date_of_joining),
                 v_pos, v_lvl, v_dep, r.note, r.recorded_by)
            on conflict (employee_id, effective_date) do nothing;
        end if;
        if r.previous_position is not null then v_pos := r.previous_position; end if;
        if r.previous_job_level is not null then v_lvl := r.previous_job_level; end if;
        if r.previous_department is not null then v_dep := r.previous_department; end if;
    end loop;

    insert into public.employee_career (employee_id, effective_date, position, job_level, department)
    values (p_employee_id, v_emp.date_of_joining, v_pos, v_lvl, v_dep)
    on conflict (employee_id, effective_date) do nothing;

    delete from public.employee_career c
     using (
        select id,
               (position, job_level, department) is not distinct from
               (lag(position) over w, lag(job_level) over w, lag(department) over w) as same,
               row_number() over w as n
          from public.employee_career
         where employee_id = p_employee_id
        window w as (order by effective_date)
     ) d
     where c.id = d.id and d.n > 1 and d.same;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill everybody who has no history yet.
-- ---------------------------------------------------------------------------
do $$
declare
    v_id uuid;
begin
    for v_id in select id from public.employees loop
        perform public.people_career_backfill(v_id);
    end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Automatic entries from the profile.
-- ---------------------------------------------------------------------------

-- A new employee starts with their joining-date role.
create or replace function public.people_career_on_employee_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.employee_career
        (employee_id, effective_date, position, job_level, department, created_by, updated_by)
    values
        (new.id, coalesce(new.date_of_joining, public.local_today()),
         new.position, new.job_level, new.department, auth.uid(), auth.uid())
    on conflict (employee_id, effective_date) do nothing;
    return null;
end;
$$;

-- Position, level or department changed on the profile: an entry dated today,
-- or today's entry brought up to date.
create or replace function public.people_career_on_employee_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if coalesce(current_setting('dtg.career_sync', true), 'off') = 'on' then
        return null;
    end if;
    if (new.position, new.job_level, new.department)
       is not distinct from (old.position, old.job_level, old.department) then
        return null;
    end if;

    insert into public.employee_career
        (employee_id, effective_date, position, job_level, department, created_by, updated_by)
    values
        (new.id, public.local_today(), new.position, new.job_level, new.department, auth.uid(), auth.uid())
    on conflict (employee_id, effective_date) do update set
        position   = excluded.position,
        job_level  = excluded.job_level,
        department = excluded.department,
        updated_by = excluded.updated_by,
        updated_at = now();
    return null;
end;
$$;

drop trigger if exists trg_employee_career_insert on public.employees;
create trigger trg_employee_career_insert
    after insert on public.employees
    for each row execute function public.people_career_on_employee_insert();

drop trigger if exists trg_employee_career_update on public.employees;
create trigger trg_employee_career_update
    after update of position, job_level, department on public.employees
    for each row execute function public.people_career_on_employee_update();

-- ---------------------------------------------------------------------------
-- 5. Reading and editing.
-- ---------------------------------------------------------------------------

-- Whoever may read the profile: the person themself, or the directory.
create or replace function public.people_career_require_read(p_employee_id uuid)
returns public.employees
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
    return v_employee;
end;
$$;

-- The checks shared by add and update.
create or replace function public.people_career_validate(
    p_effective_date date,
    p_position text
)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
    if p_effective_date is null then
        raise exception 'Start date is required.' using errcode = 'PT422';
    end if;
    -- Not ahead of time: the latest entry is the profile's current role, so a
    -- promotion recorded early would change it at once.
    if p_effective_date > public.local_today() then
        raise exception 'The start date can''t be in the future.' using errcode = 'PT422';
    end if;
    if p_position is null or btrim(p_position) = '' then
        raise exception 'Position is required.' using errcode = 'PT422';
    end if;
end;
$$;

create or replace function public.people_career_date(p_payload jsonb)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    if p_payload->'effective_date' is null or jsonb_typeof(p_payload->'effective_date') = 'null'
       or btrim(p_payload->>'effective_date') = '' then
        return null;
    end if;
    return (p_payload->>'effective_date')::date;
exception when others then
    raise exception 'Start date is not a valid date.' using errcode = 'PT422';
end;
$$;

create or replace function public.people_career_list(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.people_career_require_read(p_employee_id);
    return coalesce((
        select jsonb_agg(public.people_career_json(c) order by c.effective_date desc)
          from public.employee_career c
         where c.employee_id = p_employee_id
    ), '[]'::jsonb);
end;
$$;

create or replace function public.people_career_add(p_employee_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
    v_date date;
    v_position text;
    v_row public.employee_career%rowtype;
begin
    perform public.people_require_user();
    perform public.people_require_people_admin();

    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    v_date := public.people_career_date(p_payload);
    v_position := btrim(p_payload->>'position');
    perform public.people_career_validate(v_date, v_position);

    if exists (select 1 from public.employee_career
                where employee_id = p_employee_id and effective_date = v_date) then
        raise exception 'There is already an entry on that date.' using errcode = 'PT409';
    end if;

    insert into public.employee_career
        (employee_id, effective_date, position, job_level, department, note, created_by, updated_by)
    values
        (p_employee_id, v_date, v_position,
         nullif(btrim(p_payload->>'job_level'), ''),
         nullif(btrim(p_payload->>'department'), ''),
         nullif(btrim(p_payload->>'note'), ''),
         auth.uid(), auth.uid())
    returning * into v_row;

    perform public.people_career_sync(p_employee_id);

    perform public.log_activity(
        'CAREER_ENTRY_ADDED',
        format('Added career entry for %s %s: %s from %s',
               v_employee.first_name, v_employee.last_name, v_position, v_date),
        p_employee_id,
        v_employee.user_id
    );

    return public.people_career_json(v_row);
end;
$$;

create or replace function public.people_career_update(p_entry_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.employee_career%rowtype;
    v_employee public.employees%rowtype;
    v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
    v_date date;
    v_position text;
begin
    perform public.people_require_user();
    perform public.people_require_people_admin();

    select * into v_row from public.employee_career where id = p_entry_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    select * into v_employee from public.employees where id = v_row.employee_id;

    v_date := case when v_payload ? 'effective_date'
                   then public.people_career_date(v_payload) else v_row.effective_date end;
    v_position := case when v_payload ? 'position'
                       then btrim(v_payload->>'position') else v_row.position end;
    perform public.people_career_validate(v_date, v_position);

    if v_date <> v_row.effective_date and exists (
        select 1 from public.employee_career
         where employee_id = v_row.employee_id and effective_date = v_date and id <> p_entry_id) then
        raise exception 'There is already an entry on that date.' using errcode = 'PT409';
    end if;

    update public.employee_career c set
        effective_date = v_date,
        position = v_position,
        job_level = case when v_payload ? 'job_level'
                         then nullif(btrim(v_payload->>'job_level'), '') else c.job_level end,
        department = case when v_payload ? 'department'
                          then nullif(btrim(v_payload->>'department'), '') else c.department end,
        note = case when v_payload ? 'note'
                    then nullif(btrim(v_payload->>'note'), '') else c.note end,
        updated_by = auth.uid(),
        updated_at = now()
     where c.id = p_entry_id
     returning * into v_row;

    perform public.people_career_sync(v_row.employee_id);

    perform public.log_activity(
        'CAREER_ENTRY_UPDATED',
        format('Updated career entry for %s %s: %s from %s',
               v_employee.first_name, v_employee.last_name, v_row.position, v_row.effective_date),
        v_row.employee_id,
        v_employee.user_id
    );

    return public.people_career_json(v_row);
end;
$$;

create or replace function public.people_career_delete(p_entry_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.employee_career%rowtype;
    v_employee public.employees%rowtype;
begin
    perform public.people_require_user();
    perform public.people_require_people_admin();

    select * into v_row from public.employee_career where id = p_entry_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if not exists (select 1 from public.employee_career
                    where employee_id = v_row.employee_id and id <> p_entry_id) then
        raise exception 'This is the only entry in the career history. Edit it instead.'
            using errcode = 'PT409';
    end if;
    select * into v_employee from public.employees where id = v_row.employee_id;

    delete from public.employee_career where id = p_entry_id;
    perform public.people_career_sync(v_row.employee_id);

    perform public.log_activity(
        'CAREER_ENTRY_DELETED',
        format('Deleted career entry for %s %s: %s from %s',
               v_employee.first_name, v_employee.last_name, v_row.position, v_row.effective_date),
        v_row.employee_id,
        v_employee.user_id
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants.
-- ---------------------------------------------------------------------------
revoke all on function public.people_career_json(public.employee_career)   from public, anon, authenticated;
revoke all on function public.people_career_sync(uuid)                     from public, anon, authenticated;
revoke all on function public.people_career_backfill(uuid)                 from public, anon, authenticated;
revoke all on function public.people_career_on_employee_insert()           from public, anon, authenticated;
revoke all on function public.people_career_on_employee_update()           from public, anon, authenticated;
revoke all on function public.people_career_require_read(uuid)             from public, anon, authenticated;
revoke all on function public.people_career_validate(date, text)           from public, anon, authenticated;
revoke all on function public.people_career_date(jsonb)                    from public, anon, authenticated;
revoke all on function public.people_career_list(uuid)                     from public;
revoke all on function public.people_career_add(uuid, jsonb)               from public;
revoke all on function public.people_career_update(uuid, jsonb)            from public;
revoke all on function public.people_career_delete(uuid)                   from public;

grant execute on function public.people_career_list(uuid)                  to authenticated;
grant execute on function public.people_career_add(uuid, jsonb)            to authenticated;
grant execute on function public.people_career_update(uuid, jsonb)         to authenticated;
grant execute on function public.people_career_delete(uuid)                to authenticated;

commit;
