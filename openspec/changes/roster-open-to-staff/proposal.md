# The roster, open to all staff

## Why

The roster is split by work pattern. Office-day staff see only office-day
rows, the rotating crew see only crew rows, and there are exceptions for the
back-up engineer and for finance. An office worker who opens October 2026
sees no Adib, Aris or Lintang.

The rule came across one-for-one from the FastAPI line when the roster moved
to Supabase on 26 September. Nobody revisited it at the time, and its reason
was never written down. The company wants everyone to see the whole roster.

Opening the roster also opens what comes with it. Two pieces of personal
data travel with the schedule today, and they shouldn't reach every
colleague:

- **The leave list.** `get_schedule_detail` returns each visible person's
  approved leave *with its type*: menstrual, miscarriage, maternity,
  bereavement. No screen shows this list, but the API returns it.
- **Leave balances.** The roster totals show each person's remaining annual
  leave.

## What Changes

- **Every signed-in user sees every active staff member's published
  roster:**
  - the grid's name list, the schedule's rows and totals, and direct reads
    of `shift_assignments`;
  - the back-up engineer and finance exceptions go away, because everyone
    now sees both groups.
- **Former staff stay visible to administrators only.**
- **The leave list in `get_schedule_detail` is returned to administrators
  only.** Everyone else gets an empty list. The roster's own cells (SL, SP,
  AL and so on) still show, and SP reads "Special leave" without the reason.
- **The annual leave balance in the totals is filled in only on the
  viewer's own row.** Administrators see everyone's. Other rows carry
  `null`, and the grid shows a dash.
- **Unchanged:**
  - drafts are visible to administrators only;
  - founders don't appear on the grid;
  - staff propose changes only on their own row, and see pending proposals
    only for their own row;
  - only administrators apply changes.

### Non-goals

- Changing who may edit the roster or review proposals.
- Hiding the leave codes on the grid. SL and SP are visible to everyone, as
  on a shared roster workbook.

## Capabilities

### New Capabilities

- `roster-visibility`: who sees which rows of the roster, and which personal
  data the roster carries to whom.

### Modified Capabilities

None. No existing spec covers who can see the roster.

## Impact

- **Database:** one migration, dated after `20261012000100`.
  - `schedules_visible_employee_ids()` returns all active staff for any
    signed-in user, or `null` (meaning everyone) for administrators.
    `schedules_visible_employee_ids_for(schedule)` returns the same.
  - The grid's name list and the `shift_assignments` read policy follow
    from these two functions with no other change.
  - `get_schedule_detail` returns its leave list only to administrators,
    and the balance only for the viewer's own row unless the viewer is an
    administrator.
- **Front end:**
  - `RosterGrid` shows a dash where the balance is `null`, instead of 0.
  - `WorkingDaysSummary.annual_leave_days` can now be `null`.
  - The rule comments in `SchedulesPage` are updated.
- **Tests:** the five steps in `schedules.test.mjs` that pin the split are
  rewritten for the new rule. New steps cover the leave list and the
  balance.
- **People:** tell staff that the roster now shows everyone.
