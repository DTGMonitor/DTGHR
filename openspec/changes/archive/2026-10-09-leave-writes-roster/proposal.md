# Approved leave shows on the roster

## Why

Approving a leave request doesn't change the roster at all. The cells stay
DS, NS or D.

- `get_schedule_detail()` already returns the month's approved leave, but no
  screen reads it.
- Everything that reads roster cells therefore treats someone on approved
  leave as working:
  - payroll's field days (`payroll_roster_shift_days` counts DS and NS);
  - the dashboard's "on shift" and "away" lists;
  - the roster's Total days column and its public-holiday loading.

A crew member on approved sick leave keeps showing as DS in all of these.

There is a second problem. The annual balance deducts every calendar day of
an approved annual request, weekends, Break days and national holidays
included. But the request itself is charged only the days the person would
have worked (`leaves_count_days`). So a Friday-to-Monday request for an
office worker is charged 2 days when it's made, and the balance drops by 4.

## What Changes

- **Each leave type maps to a roster code:**

  | Leave type | Code |
  |---|---|
  | annual | AL |
  | sick | SL |
  | study | ST |
  | every family and special type (maternity, miscarriage, paternity, menstrual, marriage, child's marriage, child's ceremony, both bereavements) | SP |

  The mapping is defined in one place.
- **Approving puts the leave on the roster.** The request is marked
  `on_roster`.
  - On each day the person would have worked, every existing cell that holds
    a working code (DS, NS, C, D, TW, T) gets the leave code.
  - The code it replaced is remembered.
  - B, O, PH and leave days are left alone. These are exactly the days
    `leaves_count_days` doesn't charge.
- **Months generated later pick up the leave.** When
  `schedules_apply_roster_pattern` builds or overwrites a month, an
  `on_roster` leave wins over the pattern on working days, and the pattern
  code is remembered. Regenerating a month never wipes leave.
- **Cancelling puts the roster back.** Cancelling an approved, `on_roster`
  request restores the remembered code on each cell that still holds the
  leave code it wrote. A cell someone has edited since is left alone.
- **Only leave approved after go-live goes on the roster.**
  - Requests approved before the deploy keep `on_roster = false`, and
    neither approval nor the generator ever writes them.
  - No past roster cell changes, so past payroll inputs stay as they are.
  - HR can still set those cells by hand if they want them shown.
- **The annual balance counts leave days only.**
  `leaves_annual_position` and `schedules_leave_and_loading` count AL cells,
  plus the days of approved annual requests that are leave days. A leave
  day uses the same rule as `leaves_count_days`: a rostered working day, or
  a weekday that isn't a national holiday where no cell exists. Weekends,
  Break days and national holidays stop being charged. **Some balances go
  up**, because they were over-charged.

### Non-goals

- **Backfilling** leave approved before go-live.
- **Showing pending requests** on the roster.
- **Refreshing payroll months that already exist.** Payroll takes shift days
  from the roster when a month is created. A leave approved after that
  doesn't change the month's lines. That stays as it is today.
- **A separate code per leave type**, such as MAT or PAT. It waits for the
  change that moves the code rules into `shift_codes`.

## Capabilities

### New Capabilities

- `leave-on-roster`: how approved leave becomes roster cells. Covers the
  leave type to code mapping, which days are written, approval, cancelling,
  the generator, and the go-live cutoff.
- `annual-leave-balance`: which days an approved annual request takes from
  the balance.

### Modified Capabilities

None. No existing spec covers leave or the roster's write paths. The
`shift-codes` requirements don't change.

## Impact

- **Database:** a new migration, dated after `20261010000100`.
  - Adds `leave_requests.on_roster` and a table remembering the replaced
    codes, keyed by request, employee and date.
  - Adds `leaves_roster_code(leave_type)` and a per-day
    `leaves_is_leave_day(employee, date)`. `leaves_count_days` becomes a
    count of that predicate, so its numbers don't change.
  - Redefines `approve_leave_request`, `cancel_leave_request`,
    `schedules_apply_roster_pattern`, `leaves_annual_position` and
    `schedules_leave_and_loading`.
- **Front end:** none needed. The roster shows the leave codes it already
  draws. The leave pages already show balances.
- **Tests:** `supabase/test/areas/leaves.test.mjs` and `schedules.test.mjs`.
- **People:** tell HR that annual balances will be recalculated, and that
  leave approved before go-live is not added to the roster by itself.
