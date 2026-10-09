# Tasks

The database goes first, in one migration that is safe to run under the
current front end. The screens change after it.

## 0. Before the migration (on live; the user runs these)

- [x] 0.1 Preflight: `select distinct shift_code from public.shift_assignments where shift_code not in ('DS','NS','C','B','D','O','AL','SL','DL','SP','PH','TW','ST','T')`. Expect no rows. If any come back, stop and decide what to do with each value before going on
- [x] 0.2 `select public.schedules_valid_code('SP')` returns true on live, which means `20261008000200_roster_special_leave.sql` is applied. If it isn't, `db push` will apply it first, because it is dated earlier

## 1. Migration: the table

- [x] 1.1 New migration dated after `20261009000100`, in a single `begin; … commit;`
- [x] 1.2 Create `public.shift_codes` as set out in design §2: `code` PK `^[A-Z]{1,5}$`, `label`, `bg`/`fg` hex checks, `sort_order`, `blank_in_grid`, `active`, `is_system`, `updated_at`, `updated_by → public.users(id) on delete set null`, and `check (active or not is_system)`
- [x] 1.3 Seed the 14 rows from `SHIFT_STYLES` and `SHIFT_CODE_ORDER`: exact labels and hex colours, `blank_in_grid` on B, `sort_order` in legend order, all active, and `is_system` on DS, NS, D, B, AL and PH
- [x] 1.4 Enable RLS, add a `select` policy for `authenticated using (true)`, grant `select` to `authenticated`, and add no write policies. Revoke from `anon`

## 2. Migration: the FK and validation

- [x] 2.1 Stray-value check: if any `shift_assignments.shift_code` value has no row in `shift_codes`, raise an exception listing the distinct values. The transaction aborts
- [x] 2.2 Add an FK from `shift_assignments.shift_code` to `shift_codes(code)`, `on update restrict on delete restrict`
- [x] 2.3 Redefine `schedules_valid_code(p_code text)` as `stable`: true when an active row exists. Keep the signature and the revoke from `public`

## 3. Database tests

- [x] 3.1 Add a step to `supabase/test/areas/schedules.test.mjs` checking that the table holds exactly the 14 codes, with `is_system` on the six
- [x] 3.2 A direct insert into `shift_assignments` with an unknown code fails on the FK. Deleting or renaming a code that a cell uses fails
- [x] 3.3 `set_schedule_cell` with an unknown code, and with a code made inactive inside the test transaction, both raise "is not a shift code". SP succeeds
- [x] 3.4 An inactive code also fails in `save_schedule_assignments`, `propose_shift_changes` and `apply_roster_pattern`. An existing cell that holds the inactive code is still returned by `get_schedule_detail`
- [x] 3.5 Setting `active = false` on a system code fails the check
- [x] 3.6 RLS: a non-admin can read every row. An admin's insert, update and delete through the API change nothing. `anon` reads nothing
- [x] 3.7 Stray-value guard: in a scratch run, insert an unknown code before the migration and check that it raises with that code named
- [x] 3.8 Run the whole suite (`supabase/test/run.mjs` and every area). Existing fixtures use only the 14 codes and must still pass

## 4. Front end: data

- [x] 4.1 Add the fixed route `GET /schedules/shift-codes` in `src/lib/routes/schedules.ts`, registered before `/schedules/:id`. It reads `shift_codes` ordered by `sort_order`
- [x] 4.2 Add a `ShiftCodeRow` type and `scheduleService.shiftCodes()` in `src/services/scheduleService.ts`
- [x] 4.3 Add a `useShiftCodes()` hook with one shared module-level promise per page load. It exposes `codes`, `activeCodes` and `styleOf(code)`, where `styleOf` falls back to a neutral style showing the code for unknown codes or before loading
- [x] 4.4 In `src/types/schedule.ts`:
  - `ShiftCode` becomes `string`
  - add a `SystemShiftCode` const for DS, NS, D, B, AL and PH
  - remove `SHIFT_STYLES` and `SHIFT_CODE_ORDER`
  - keep the `ShiftStyle` shape

## 5. Front end: screens

- [x] 5.1 `ShiftLegend`: rows come from `codes`, in order
- [x] 5.2 `RosterGrid`: cell colours and the change overlay use `styleOf`
- [x] 5.3 `CellEditor`: the picker lists `activeCodes`
- [x] 5.4 `RosterPatternModal`: the picker lists `activeCodes`. Presets use `SystemShiftCode`. The preview uses `styleOf`, with blank-in-grid read from the row
- [x] 5.5 `WeekStrip` and the `DashboardPage` today tile use `styleOf`
- [x] 5.6 `SchedulesPage`: the AL count uses `SystemShiftCode.AL`
- [x] 5.7 `npm run build` passes (the project has no lint script), and no reference to `SHIFT_STYLES` or `SHIFT_CODE_ORDER` remains

## 6. Docs and wrap-up

- [x] 6.1 Update the out-of-scope note in `openspec/changes/port-ui-and-kpi-to-supabase/proposal.md`: "fourteen hardcoded codes", now in `shift_codes` (this change). Admin editing and rule columns are still to come
- [x] 6.2 Check by hand in the app: the roster legend, grid, cell editor (SP can be picked and saved), pattern modal and dashboard week strip all look as they did before
- [x] 6.3 After deploy, on live: `select count(*) from public.shift_codes` returns 14. The FK exists, and setting a cell to SP works
