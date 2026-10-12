# Design: shift code rules

## Context

These are the current definitions of every hardcoded list of codes, taken
from each function's latest migration:

| Function (latest migration) | List today | Becomes |
|---|---|---|
| `get_schedule_detail` (backup_roster_by_month) | `working_days`: DS NS C D | `is_working` (adds TW, T) |
| `schedules_leave_and_loading` (leave_writes_roster) | PH loading: DS NS C D. Balance: `= 'AL'` | `is_working`. AL stays by name |
| `leaves_is_leave_day` (leave_writes_roster) | DS NS C D TW T AL SL DL SP | `is_working or is_leave` |
| `leaves_apply_to_roster` (leave_writes_roster) | DS NS C D TW T, twice | `is_working` |
| `schedules_apply_roster_pattern` (leave_writes_roster) | DS NS C D TW T. `'PH'` and `'B'` by name | `is_working`. PH and B stay |
| `leaves_roster_code` (leave_writes_roster) | CASE: annual AL, sick SL, study ST, else SP | `leave_type_codes` |
| `overview_at` (roster_special_leave) | Away: AL SL DL SP. Crews: `= 'DS'`, `= 'NS'` | `is_away` (adds ST). The crews stay by name |
| `overview_shift_label` (overview) | CASE of 13 labels, no SP | `shift_codes.label` |
| `payroll_roster_shift_days` (payroll) | DS NS | `is_field_day` |
| `schedules_visible_employee_ids_for` (backup_roster_by_month) | DS NS | `is_field_day` |
| `schedules_continuation_offset` (roster_special_leave) | `not in` AL SL DL SP PH ST T TW O | `in_rotation` (DS NS C D B) |
| `schedules_apply_holiday` (roster_follows_holidays) | D ↔ PH, B on weekends | Unchanged. They are named on purpose |
| `leaves_annual_position` (leave_writes_roster) | `= 'AL'` | Unchanged. The balance is annual leave by definition |
| `annual_leave_state` (rpc_schedules) | AL, DS NS C D | Dropped. Only the 19 September `get_schedule_detail` called it, and that has been replaced three times |
| `reactivate_employee` (holidays_offboarding) | AL, DS NS C D | Unchanged. The app doesn't call it |

On the front end, `RosterGrid` counts how many people are on duty each day
using `WORKING_DAY_CODES` (DS NS C D). `WeekStrip` treats `O` and `B` as
off. `useShiftCodes()` already loads every column of `shift_codes`.

## Goals / Non-Goals

**Goals:**

- Each rule about codes is stated once, as a column. Every function and
  screen that applies the rule reads that column.
- The three decided changes: TW and T count as worked days, ST is away, and
  SP has its label.
- Everything else gives identical results, shown on a copy of production.

**Non-Goals:**

- Editing meanings from a screen, or effective-dating.
- Codes named on purpose, and `reactivate_employee`.

## Decisions

### 1. Boolean columns, one per rule, not a category

A single `category` (work, leave, absence, off) can't express the overlaps:

- ST is away but not leave;
- B is in the rotation and also an off day;
- DS is working, a field day and in the rotation.

Separate booleans keep each rule independent, and each one is named after
the question a function asks.

The columns are `not null default false`. A new code therefore starts as
meaning nothing (not working, not leave, not in the rotation) until a
migration says otherwise. That is the safe default for counts and pay.

### 2. `in_rotation` lists what the rotation uses, not what it skips

Today the continuation search skips nine codes. The new column lists the
five it uses: DS, NS, C, D and B. Behaviour is the same for all 14 codes,
and a code added later is skipped unless someone marks it.

### 3. Functions read the columns with a subquery, not a join

For example, `a.shift_code in (select code from public.shift_codes where is_working)`.

- The table has 14 rows, so the planner keeps it cheap.
- Each function's structure barely changes, which keeps the diff against
  each previous definition small to review.
- No helper function: a `shift_code_is(code, 'working')` would hide the rule
  behind a string.

### 4. `leave_type_codes(leave_type text primary key, shift_code text → shift_codes)`

- It is seeded with all 12 types from `leaves_rules()`.
- `leaves_roster_code()` becomes `stable` and reads the table, falling back
  to SP for a type that has no row. Its callers stay the same.
- RLS: signed-in users may read it, and nobody writes it through the API.
  This follows `shift_codes`.
- Every mapped code must have `is_away` set, so a leave can't be mapped to a
  working code. A CHECK can't look into `shift_codes`, so the migration
  asserts this after seeding and a test pins it.

### 5. The labels come from the table

`overview_shift_label(code)` becomes
`select label from shift_codes where code = p_code`. Its one caller,
`overview_at`, gets SP's label without any other change, and so would any
code added later.

### 6. Front end: the columns arrive with the codes

- `ShiftCodeRow` gains the six booleans, and the route selects them.
- `RosterGrid` counts people on duty with `row.is_working`, using a set
  built from `useShiftCodes().codes`.
- `WeekStrip` decides off days with `is_off`. Before the codes load, the off
  check falls back to "no code".
- `WORKING_DAY_CODES` is removed.

### 7. Proving nothing else changed

Apart from the PGlite suite, a comparison runs on a local copy of
production, as for `leave-writes-roster`:

- **Day by day, for every employee:** the old definitions, loaded as
  `pg_temp` copies, against the new ones. That covers
  `leaves_is_leave_day`, `payroll_roster_shift_days` per month,
  `schedules_leave_and_loading` and the continuation offset.
- **Expected differences**, all of which must be explained:
  - TW and T in Total days and PH loading;
  - ST in the away list.

  Any other difference is a bug.

## Risks / Trade-offs

- **[Total days go up on past rosters with TW or T]** → This is intended.
  Payroll lines keep their stored figures, so no amounts change. Tell HR
  that the column now counts travel and training.
- **[PH loading rises for TW or T worked on a national holiday]** → It is a
  guide on the roster only. Finance types the holiday days onto payroll
  lines. Mention it alongside the Total days note.
- **[A future code added without its columns set]** → It counts as nothing,
  safely. The migration that adds a code should set its columns. The design
  of the config center will need a form for this.
- **[Redefining `overview_at` means copying a large function]** → It is
  copied from `20261008000200` with only the away subquery changed. The
  existing overview tests cover the rest.

## Migration Plan

1. One migration in a single transaction:
   - the columns, with an update that sets each code's values;
   - `leave_type_codes`, seeded, with its RLS;
   - the redefined functions;
   - `drop function annual_leave_state`;
   - grants.
2. Deploy the front end after the migration. The old front end keeps working
   against the new database, because the new columns are only additions.
3. Push with migrations temporarily enabled in `config.toml`, after checking
   `migration list` and the local comparison.

**Rollback:** re-apply each function's previous definition and restore
`annual_leave_state` from `20260916000600`. The columns and table can stay,
because nothing old reads them.

## Open Questions

None. The user decided:
- TW and T are working;
- ST is permitted absence: away, not charged;
- field days stay DS and NS;
- the leave type table is included;
- the fixes go in this change.
