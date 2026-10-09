# Tasks

This change is a single migration. No front-end change is needed: the
roster already draws AL, SL, ST and SP.

## 1. Migration: the rule and the mapping

- [x] 1.1 New migration dated after `20261010000100`, in a single `begin; … commit;`, safe to re-run
- [x] 1.2 `leaves_roster_code(leave_type)`: annual → AL, sick → SL, study → ST, any other type → SP. Immutable
- [x] 1.3 `leaves_is_leave_day(employee_id, date)`: the per-day body of `leaves_count_days` from `20261008000200`
- [x] 1.4 Redefine `leaves_count_days` as a count of 1.3 over the range. Its results must not change

## 2. Migration: the record and the flag

- [x] 2.1 Add `leave_requests.on_roster boolean not null default false`, with `if not exists`
- [x] 2.2 Create `leave_roster_cells`:
  - columns `leave_request_id` (FK, `on delete cascade`), `employee_id`, `date`, `leave_code`, `previous_code` (FK to `shift_codes`)
  - primary key `(leave_request_id, date)`
  - RLS enabled, no policies, `revoke all` from `anon` and `authenticated`

## 3. Migration: writing and restoring

- [x] 3.1 `leaves_apply_to_roster(request_id)`: for each leave day in the range, write the leave code on that employee's cells that hold a working code (DS, NS, C, D, TW, T). Upsert the record, keeping an existing `previous_code`
- [x] 3.2 `leaves_remove_from_roster(request_id)`: restore `previous_code` on cells that still hold `leave_code`, then delete the records
- [x] 3.3 Redefine `approve_leave_request` from `20260926000300`: also set `on_roster = true` and call 3.1. Everything else stays the same
- [x] 3.4 Redefine `cancel_leave_request`: when the request is approved and `on_roster`, call 3.2 before setting the status. Everything else stays the same

## 4. Migration: the generator

- [x] 4.1 Redefine `schedules_apply_roster_pattern` from `20260926000400`. After `v_code` is decided, if it is a working code and an approved `on_roster` request of that employee covers the day:
  - upsert the record with `previous_code = v_code`
  - write that request's leave code instead

## 5. Migration: the annual balance

- [x] 5.1 Redefine `leaves_annual_position`: request days count only where `leaves_is_leave_day` holds. Keep the union with AL cells
- [x] 5.2 Redefine `schedules_leave_and_loading` from `20260926000400` with the same change to `al_dates`
- [x] 5.3 Grants and revokes for the new functions, as in the leaves and schedules migrations

## 6. Tests

- [x] 6.1 `leaves_count_days` gives the same numbers as before on the existing cases. The existing leave suite passes unchanged. One expectation changed on purpose: `run.mjs` "approving deducts" now expects 4 days used, not 5, because 20–22 September 2026 runs Sunday to Tuesday (the balance fix)
- [x] 6.2 Approving sick leave over DS cells turns them into SL. B, O and PH cells in the range stay as they are. Days with no cell get none
- [x] 6.3 Every type maps to its code: annual AL, study ST, and paternity, marriage and maternity SP
- [x] 6.4 Payroll and dashboard: after approval in a published month, `payroll_roster_shift_days` drops by the leave days, and the overview lists the person as away
- [x] 6.5 Cancelling restores DS. A cell edited to NS after approval stays NS. The records are gone
- [x] 6.6 Generator: a month generated after approval contains the leave. Regenerating with overwrite keeps it. Cancelling afterwards restores the pattern code
- [x] 6.7 Cutoff: a request approved before the migration (`on_roster = false`) is not written by the generator, and the migration itself changes no cell. The second half is checked by reading the migration, which writes no cells, rather than by a test
- [x] 6.8 Balance: an office worker's Friday-to-Monday annual request takes 2 days. A crew request over 4 DS and 4 B days takes 4. An AL cell inside a request is counted once
- [x] 6.9 Run the whole suite (`npm run test:db`)

## 7. Ship

- [x] 7.1 Tell HR that annual balances will be recalculated (some go up), and that leave approved before go-live is not added to the roster by itself
- [x] 7.2 Push the migration with migrations temporarily enabled in `supabase/config.toml`. Check `migration list` first. Done before the local test: `migration list` shows `20261011000100` on live. A local copy of production then confirmed that the day counts and all 13 annual balances are unchanged, and the approve, cancel and generator flows worked when clicked through
- [x] 7.3 On live: approve a test leave and check that the roster shows it. Cancel it and check that the roster is restored
