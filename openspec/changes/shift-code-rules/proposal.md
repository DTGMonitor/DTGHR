# Shift codes: what each code means, in the table

## Why

`shift_codes` holds each code's name and look. What a code *means* is still
written into the functions that use it, about a dozen lists in all.

Those lists have drifted apart:

- **TW and T disagree with themselves.** Travel work and training are
  working days when leave is charged or written to the roster. But they are
  left out of the roster's Total days and its public-holiday loading.
- **ST counts as nothing.** Study leave shows on the dashboard as neither
  away nor working.
- **SP has no dashboard label.** `overview_shift_label()` is a third copy of
  the labels, and it has no entry for SP. The week strip shows "SP" instead
  of "Special leave".

Adding a code, such as a separate code for maternity leave, means finding
and editing every list. A missed list silently treats the new code as
nothing.

## What Changes

- **New columns on `shift_codes`**, one per rule the functions apply today:

  | Column | Codes | Meaning |
  |---|---|---|
  | `is_working` | DS NS C D TW T | A worked day. Leave replaces it and is charged for it |
  | `is_leave` | AL SL DL SP | Leave. A request covering the day is charged for it |
  | `is_away` | AL SL DL SP ST | Shown as away on the dashboard |
  | `is_field_day` | DS NS | A shift for payroll's shift days, and for when a back-up engineer sees the roster |
  | `in_rotation` | DS NS C D B | Part of a rotation the generator continues from |
  | `is_off` | O B | An off day on the dashboard week strip |

- **A new `leave_type_codes` table**, mapping each leave type to its roster
  code: annual AL, sick SL, study ST, every other type SP. A separate code
  per type becomes two data changes: a `shift_codes` row, and a changed
  mapping.
- **Every function that kept a list reads the columns or the table
  instead:**
  - the roster's Total days and PH loading;
  - the leave-day rule, leave writing and the generator;
  - the dashboard's away list;
  - payroll shift days and back-up engineer visibility;
  - where the rotation continues from;
  - the leave type to code mapping.

  The week strip's labels come from `shift_codes`.
- **The front end reads the same columns** through `useShiftCodes()`, for
  the roster's Total days and the week strip's off days.
  `WORKING_DAY_CODES` goes away.
- **Unused code removed:** `annual_leave_state()`, which only a replaced
  version of `get_schedule_detail` called.
- **Behaviour changes, decided on purpose:**
  - **TW and T count as worked days.** They are business activity, so they
    now count in the roster's Total days and its PH loading.
  - **ST shows as away on the dashboard.** It is permitted absence, so it
    still isn't charged as leave.
  - **The week strip shows "Special leave"** for SP.
  - **NS is "Night shift" everywhere.** The legend said "Night" and the
    dashboard "Night shift"; with one source, they now agree.

  Everything else gives the same results as before. Payroll amounts don't
  change: holiday days on payroll lines are typed in, not taken from the
  roster's PH loading.

### Non-goals

- **Editing codes or their meanings from a screen.** That belongs to the
  config center. Columns change by migration.
- **Effective-dating.** A changed meaning applies to past days too. That
  matters only once the meanings can be edited.
- **Codes the logic names on purpose stay named:** AL for the annual
  balance, DS and NS for the dashboard's day and night crews, and D, PH and B
  for the holiday trigger and the generator.
- **`reactivate_employee()`** keeps its own lists. The app doesn't call it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `shift-codes`: the table also holds what each code means, and the roster
  and dashboard take their counts from it. This adds requirements for the
  meaning columns, worked days including TW and T, ST as away, and labels
  read from the table everywhere.
- `leave-on-roster`: the leave type mapping lives in `leave_type_codes`, and
  the leave-day rule is stated in terms of `is_working` and `is_leave`
  instead of lists of codes.

## Impact

- **Database:** one migration, dated after `20261011000100`.
  - Adds the columns and backfills them, and creates `leave_type_codes`.
  - Redefines these functions:
    - `get_schedule_detail`, `schedules_leave_and_loading`;
    - `leaves_is_leave_day`, `leaves_apply_to_roster`, `leaves_roster_code`;
    - `schedules_apply_roster_pattern`, `schedules_continuation_offset`;
    - `overview_at`, `overview_shift_label`;
    - `payroll_roster_shift_days`, `schedules_visible_employee_ids_for`.
  - Drops `annual_leave_state`.
- **Front end:** `src/types/schedule.ts`, `src/lib/useShiftCodes.ts`,
  `RosterGrid.tsx` and `WeekStrip.tsx`.
- **Tests:** the area suites, plus a comparison of old and new results on a
  copy of production.
- **People:**
  - Roster Total days rise for anyone with TW or T days, past months
    included, because the column is recomputed.
  - The dashboard lists people on study leave as away.
