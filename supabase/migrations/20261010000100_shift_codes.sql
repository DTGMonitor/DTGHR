-- ===========================================================================
-- Shift codes: one table, read by the database and the screens.
--
-- The roster's codes were listed twice -- in schedules_valid_code() and in
-- the frontend's SHIFT_STYLES -- and nothing kept the two in step: the screen
-- offered SP before the database accepted it. shift_assignments.shift_code
-- was a bare varchar(5) that took any string from a direct write.
--
--   * public.shift_codes holds each code once: label, colours, legend order,
--     whether the grid draws it blank, active, and is_system. Seeded with the
--     fourteen codes exactly as src/types/schedule.ts drew them.
--   * A code is never renamed or deleted (the FK restricts both); one that is
--     no longer wanted is made inactive. Cells that hold it keep it.
--   * is_system marks the codes the logic names -- DS, NS, D, B, AL, PH: the
--     holiday trigger writes D, B and PH, the roster presets use DS, NS, B and
--     D, and AL feeds the annual leave position. They cannot be made inactive.
--   * shift_assignments.shift_code references the table, so no write path --
--     the RPCs, change approval, the holiday trigger, the service role -- can
--     store an unknown code. A roster already holding one stops this
--     migration, naming the codes; nothing is mapped.
--   * schedules_valid_code() asks the table: a code may be set on a cell when
--     it is active. Its callers and their message are unchanged.
--   * Signed-in users read; nobody writes through the API.
--
-- Which codes count as leave, as working days, as field days and so on is
-- still written into the functions that use them; that is a later change.
--
-- Safe to re-run.
-- ===========================================================================

begin;

create table if not exists public.shift_codes (
    code          text primary key check (code ~ '^[A-Z]{1,5}$'),
    label         text not null check (btrim(label) <> ''),
    bg            text not null check (bg ~ '^#[0-9A-Fa-f]{6}$'),
    fg            text not null check (fg ~ '^#[0-9A-Fa-f]{6}$'),
    sort_order    int not null,
    blank_in_grid boolean not null default false,
    active        boolean not null default true,
    is_system     boolean not null default false,
    updated_at    timestamptz not null default now(),
    updated_by    uuid references public.users (id) on delete set null,
    constraint ck_shift_codes_system_active check (active or not is_system)
);

insert into public.shift_codes (code, label, bg, fg, sort_order, blank_in_grid, is_system) values
    ('DS', 'Dayshift',            '#FFFF00', '#000000',  1, false, true),
    ('NS', 'Night',               '#002060', '#FFFFFF',  2, false, true),
    ('C',  'Cross',               '#F59D87', '#000000',  3, false, false),
    ('D',  'Day only',            '#B8DFC9', '#000000',  4, false, true),
    ('B',  'Break',               '#00B0F0', '#FFFFFF',  5, true,  true),
    ('AL', 'Annual leave',        '#AFABAB', '#FFFFFF',  6, false, true),
    ('SL', 'Sick leave',          '#D8A141', '#000000',  7, false, false),
    ('DL', 'Discretionary leave', '#0070C0', '#FFFFFF',  8, false, false),
    ('SP', 'Special leave',       '#C2185B', '#FFFFFF',  9, false, false),
    ('PH', 'Public holiday',      '#00B050', '#000000', 10, false, true),
    ('O',  'Swap off',            '#591BB6', '#FFFFFF', 11, false, false),
    ('TW', 'Travel work',         '#CC3610', '#FFFFFF', 12, false, false),
    ('ST', 'Study leave',         '#CC3610', '#FFFFFF', 13, false, false),
    ('T',  'Training',            '#7030A0', '#FFFFFF', 14, false, false)
on conflict (code) do nothing;

alter table public.shift_codes enable row level security;
revoke all on public.shift_codes from anon, authenticated;
grant select on public.shift_codes to authenticated;
drop policy if exists shift_codes_select on public.shift_codes;
create policy shift_codes_select on public.shift_codes
    for select to authenticated using (true);

-- A roster cell holding a code that is not in the table: stop, and say which.
do $$
declare
    v_unknown text;
begin
    select string_agg(distinct format('%L', a.shift_code), ', ' order by format('%L', a.shift_code))
      into v_unknown
      from public.shift_assignments a
     where not exists (select 1 from public.shift_codes c where c.code = a.shift_code);
    if v_unknown is not null then
        raise exception 'shift_assignments holds codes that are not shift codes: %', v_unknown
            using hint = 'Correct or remove those cells, or add the codes to public.shift_codes, then run this migration again.';
    end if;
end;
$$;

do $$
begin
    if not exists (select 1 from pg_constraint
                    where conname = 'fk_shift_assignments_shift_code'
                      and conrelid = 'public.shift_assignments'::regclass) then
        alter table public.shift_assignments
            add constraint fk_shift_assignments_shift_code
            foreign key (shift_code) references public.shift_codes (code)
            on update restrict on delete restrict;
    end if;
end;
$$;

create or replace function public.schedules_valid_code(p_code text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
    select exists (select 1 from public.shift_codes where code = p_code and active);
$$;

revoke all on function public.schedules_valid_code(text) from public;

commit;
