# Design: the roster, open to all staff

## Context

Two functions decide whose rows a viewer sees:

- `schedules_visible_employee_ids()`, from `20260926000400`;
- `schedules_visible_employee_ids_for(schedule)`, from `20261012000100`,
  which applies the per-month back-up engineer rule.

Both return `null` for administrators, meaning everyone. For anyone else
they return a list of employee ids: the viewer's own work pattern, plus the
crew for a back-up engineer in a month they work it, plus both groups for
finance, limited to active staff, and always including the viewer.

Everything else reads one of those two functions:

```
 schedules_visible_employee_ids()      ──▶ schedules_can_see_employee()
                                       ──▶ schedules_list_employees()     (grid names)
 schedules_visible_employee_ids_for()  ──▶ schedules_can_see_cell()       (RLS on shift_assignments)
                                       ──▶ get_schedule_detail()          (rows, leave list, totals)
```

What `get_schedule_detail` returns, filtered by the viewer's list of ids:

- `assignments`, the cells;
- `leaves`, approved requests with `leave_type`, which no screen reads;
- `working_days`, the totals: Total days, the cell counts by code,
  `annual_leave_days` (the balance), `annual_leave_taken`, and PH loading;
- `pending_changes`, which uses its own rule, `visible_change_request_ids`.

On the front end, `RosterGrid`'s `TotalCells` shows
`annual_leave_days ?? 0`. `SchedulesPage` hides rows with no cells from
non-administrators.

## Goals / Non-Goals

**Goals:**

- Any signed-in user sees every active staff member's published roster.
- No colleague's leave reasons, and no colleague's leave balance, reach a
  non-administrator.
- One small diff: change the two functions at the root, and gate two fields.

**Non-Goals:**

- Editing rights, proposals, drafts, founders, and which leave codes the
  grid shows.

## Decisions

### 1. Change the two root functions, and leave everything that reads them alone

- `schedules_visible_employee_ids()` becomes:
  - `null` for administrators;
  - otherwise, the ids of all active employees, plus the viewer's own row
    if the viewer is inactive.
- `schedules_visible_employee_ids_for(p_schedule_id)` returns
  `schedules_visible_employee_ids()`. It keeps its signature, because the
  RLS policy and `get_schedule_detail` call it.

The name list, the read policy and the rows of the schedule then follow with
no change of their own. The back-up engineer and finance branches go away.

The alternative was to return `null` (everyone) for all viewers. That would
show former staff to everybody. Returning a list keeps "active only" for
non-administrators.

**Accounts with no employee row:**
- *today*, they see nothing;
- *after this*, they see the active staff, like any signed-in user. Every
  account here belongs to staff.

### 2. Gate the two personal fields inside `get_schedule_detail`

The function is redefined from `20261012000100`, with two changes:

- `v_leaves` is computed only when `v_admin`. Otherwise it is `'[]'`.
- Each totals row has
  `'annual_leave_days', case when v_admin or e.user_id = auth.uid() then
  coalesce(x.balance, 0) end`, which is `null` for colleagues.

The balance alone is gated. `annual_leave_taken` (the AL days in the period)
can already be counted from the visible AL cells, so it stays. Total days
and PH loading carry no personal reason, so they stay too.

Removing `leaves` entirely was considered. Keeping it for administrators
keeps the API shape unchanged, and doesn't remove something an admin tool
might later want.

### 3. The front end shows a dash for a balance it may not see

`annual_leave_days` becomes `number | null`. `TotalCells` shows "—" for
`null`, instead of falling back to 0, which would read as "no leave left".

## Risks / Trade-offs

- **[SL and SP on the grid are now visible to everyone]** → The user
  accepted this: a shared roster shows who is away. SP doesn't reveal the
  reason, and the leave list that does is admin-only.
- **[A tool reading `shift_assignments` directly now sees all staff]** →
  That's the intent. Former staff stay hidden from non-administrators.
- **[A non-administrator's empty rows]** → `SchedulesPage` still hides rows
  with no cells from non-administrators, so staff not yet rostered don't
  show as blank rows.

## Migration Plan

1. One migration:
   - redefine the two visibility functions;
   - redefine `get_schedule_detail` with the two gates.
2. Deploy the front end after it. The old front end still works with the
   new database. It would show 0 instead of a dash for colleagues'
   balances until it is deployed, so deploy soon after.
3. Push with migrations temporarily enabled in `config.toml`, after
   `migration list`.

**Rollback:** re-apply the two visibility functions from `20260926000400`
and `20261012000100`, and `get_schedule_detail` from `20261012000100`.

## Open Questions

None. The user decided:
- all staff see the whole roster;
- the leave list is for administrators only;
- the balance shows on the viewer's own row only;
- former staff stay visible to administrators only.
