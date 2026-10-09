# Shift codes: one table instead of separate lists

## Why

The list of roster shift codes is kept in two separate places, and nothing
checks that they match:

- In the front end: the `ShiftCode` enum, `SHIFT_STYLES` and
  `SHIFT_CODE_ORDER` in `src/types/schedule.ts`.
- In the database: the `schedules_valid_code()` function.

This week an admin tried to set a cell to SP (special leave) and got
"'SP' is not a shift code". The front end already offered SP, but the live
database hadn't yet applied the migration that adds it.

The column itself, `shift_assignments.shift_code`, is a plain `varchar(5)`.
It accepts any string; only the RPCs check the value.

A table makes the database the single source of truth. Both the database
and the screens read from it. The future config center needs a table like
this anyway, so this is also its first option list.

## What Changes

- **New `public.shift_codes` table.** One row per code. It holds the code,
  the label, the cell colours, the legend order, whether the cell is drawn
  blank, `active`, and `is_system`. It is seeded with today's 14 codes and
  their exact labels and colours.
  - `code` is the primary key and is never renamed.
  - `is_system` marks the codes the logic refers to by name: DS, NS, D, B,
    AL and PH.
- **`shift_assignments.shift_code` gets a foreign key** to the new table.
  - The migration first looks for values that aren't one of the 14 codes.
    If it finds any, it stops, lists them, and changes nothing. Values are
    never mapped automatically.
  - The same check is documented as a query to run on live before pushing.
- **`schedules_valid_code()` reads the table.** A code is valid when an
  active row exists for it.
  - The four RPCs that call it don't change: `set_schedule_cell`,
    `save_schedule_assignments`, `propose_shift_changes` and the roster
    pattern.
  - An inactive code can't be set on a new cell. Existing cells that hold it
    still display correctly.
- **Read-only to everyone signed in.** Writes happen only through
  migrations until the config center exists.
- **The front end reads the codes from the database.** It fetches the list
  once per session and caches it.
  - This replaces `SHIFT_STYLES` and `SHIFT_CODE_ORDER` for the legend, grid
    cells, cell editor, roster pattern modal, dashboard week strip and the
    dashboard's today tile.
  - The pickers offer active codes only.
  - A small TypeScript type remains for the system codes the screens refer
    to by name, such as the AL count on the roster and the DS/NS/B/D roster
    presets.
- **Corrects the out-of-scope note** in `port-ui-and-kpi-to-supabase`: there
  are fourteen hardcoded codes, not thirteen, and the note now points at this
  change.

### Non-goals

- **Rule columns** (`is_leave`, `is_working_day`, `is_on_shift`,
  `counts_field_day`, `skips_rotation`), and rewriting the SQL functions that
  hardcode subsets of the codes. These are leave counts, the dashboard,
  payroll field days and the rotation generator. That is a follow-up change.
  Adding the columns before anything reads them would create another copy of
  the same information.
- **An admin screen** for editing codes. That belongs to the config center.
- **Effective-dating** codes or their rules.

## Capabilities

### New Capabilities

- `shift-codes`: the set of roster shift codes, kept in one place. It covers
  what each code is called and how it looks, which codes can be set on a
  cell, and how the roster screens get the list.

### Modified Capabilities

None. No existing spec covers the roster.

## Impact

- **Database:** a new migration dated after `20261009000100`. It creates and
  seeds `shift_codes`, enables RLS with a read policy, adds the FK on
  `shift_assignments.shift_code`, and redefines `schedules_valid_code()` as
  `stable`.
- **Prerequisite:** `20261008000200_roster_special_leave.sql` must be applied
  on live first, so SP is accepted before the table is seeded with it.
- **Front end:**
  - A route or fetch for the codes, plus a cache shared by the roster and
    dashboard screens.
  - Files that change: `src/types/schedule.ts`, `src/services/scheduleService.ts`,
    `src/components/schedules/{ShiftLegend,RosterGrid,CellEditor,RosterPatternModal}.tsx`,
    `src/components/dashboard/WeekStrip.tsx`, `src/pages/DashboardPage.tsx`
    and `src/pages/SchedulesPage.tsx`.
- **Tests:** a new step in `supabase/test/areas/schedules.test.mjs`:
  - unknown codes are refused by the RPCs and by the FK;
  - an inactive code is refused for new cells but still readable.

  Existing fixtures already use only the 14 codes.
- **Unchanged:** every SQL function that hardcodes subsets of codes
  (overview, leave counts, payroll, rotation). They behave exactly as before.
