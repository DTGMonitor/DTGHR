# Tasks

## 1. Migration

- [x] 1.1 New migration dated after `20261012000100`, in a single `begin; … commit;`, safe to re-run
- [x] 1.2 `schedules_visible_employee_ids()`: `null` for administrators. Otherwise all active employees, plus the viewer's own row
- [x] 1.3 `schedules_visible_employee_ids_for(p_schedule_id)`: return `schedules_visible_employee_ids()`, keeping the signature
- [x] 1.4 `get_schedule_detail`, from `20261012000100`:
  - `leaves` only when the viewer is an administrator, otherwise `[]`
  - `annual_leave_days` only for the viewer's own row or an administrator, otherwise `null`

## 2. Tests

- [x] 2.1 Rewrite the steps that pin the split in `schedules.test.mjs`: office staff see the crew, the crew see the office, and the back-up engineer and finance see both in every month
- [x] 2.2 Former staff: hidden from a non-administrator, shown to an administrator. A deactivated person still sees their own row
- [x] 2.3 RLS: a non-administrator reading `shift_assignments` directly gets every active staff member's published cells, and no draft cells
- [x] 2.4 Leave list: empty for a non-administrator, filled for an administrator
- [x] 2.5 Balance: the viewer's own row has a number, colleagues have `null`, and an administrator gets every number
- [x] 2.6 Run the full suite (`npm run test:db`). Note any other expectation that changes

## 3. Front end

- [x] 3.1 `WorkingDaysSummary.annual_leave_days` becomes `number | null`. `TotalCells` shows "—" for `null`
- [x] 3.2 Update the comments in `SchedulesPage` that describe the old split
- [x] 3.3 `npm run build` passes

## 4. Ship

- [x] 4.1 Push the migration with migrations temporarily enabled in `config.toml`, after `migration list`. Then merge, so the front end deploys
- [x] 4.2 On live, as your own account: October 2026 shows Adib, Aris and Lintang. Colleagues' balances show a dash and yours shows a number
- [x] 4.3 Tell staff the roster now shows everyone
