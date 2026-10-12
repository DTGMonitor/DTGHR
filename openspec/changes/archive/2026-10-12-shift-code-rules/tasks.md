# Tasks

The database goes first, in one migration that is safe under the current front
end. The two screens change after it.

## 1. Migration: columns and mapping

- [x] 1.1 New migration dated after `20261011000100`, in a single `begin; … commit;`, safe to re-run
- [x] 1.2 Add `is_working`, `is_leave`, `is_away`, `is_field_day`, `in_rotation` and `is_off` to `shift_codes`, all `boolean not null default false`. Set the values for the 14 codes as in the proposal's table
- [x] 1.3 Create `leave_type_codes`:
  - `leave_type text primary key`, `shift_code text not null` referencing `shift_codes`
  - seed the 12 types
  - RLS: signed-in users read, nobody writes through the API
- [x] 1.4 Add an assertion block that fails the migration if any mapped code lacks `is_away`

## 2. Migration: functions read the columns

- [x] 2.1 `leaves_roster_code`: make it `stable` and read `leave_type_codes`, with SP as the fallback
- [x] 2.2 `leaves_is_leave_day`: replace the list with `is_working or is_leave`
- [x] 2.3 `leaves_apply_to_roster` and `schedules_apply_roster_pattern`: replace the working lists with `is_working`
- [x] 2.4 `schedules_continuation_offset`, from `20261008000200`: replace the `not in` list with `in_rotation`
- [x] 2.5 `get_schedule_detail`, from `20260928000600`: `working_days` counts `is_working`
- [x] 2.6 `schedules_leave_and_loading`: PH loading counts `is_working`. The `'AL'` stays
- [x] 2.7 `payroll_roster_shift_days` and `schedules_visible_employee_ids_for`: use `is_field_day`
- [x] 2.8 `overview_at`, from `20261008000200`: the away subquery uses `is_away`. Nothing else changes
- [x] 2.9 `overview_shift_label`: read `shift_codes.label`
- [x] 2.10 Drop `annual_leave_state(uuid[], date, date)`. Grants and revokes for anything new

## 3. Database tests

- [x] 3.1 The 14 codes carry the meanings in the proposal's table. A new code with no meaning set counts as nothing
- [x] 3.2 Total days: a month with 10 DS and 2 TW gives 12. T on a national holiday counts towards PH loading
- [x] 3.3 Away: an ST cell today puts the person on the dashboard's away list. An annual request over an ST day isn't charged for it
- [x] 3.4 Field days: 4 DS and 2 TW give 4 payroll shift days
- [x] 3.5 The week strip labels an SP day "Special leave"
- [x] 3.6 Leave type mapping: mapping maternity to a newly added away code makes approval write that code. The assertion rejects a mapping to a working code
- [x] 3.7 Run the full suite (`npm run test:db`). Any existing expectation that changes must be one of the decided changes, and be noted

## 4. Front end

- [x] 4.1 Add the six booleans to `ShiftCodeRow`, and select them in the `GET /schedules/shift-codes` route
- [x] 4.2 `RosterGrid`: count people on duty with `is_working` from `useShiftCodes()`. Remove `WORKING_DAY_CODES`
- [x] 4.3 `WeekStrip`: work out off days from `is_off`
- [x] 4.4 `npm run build` passes

## 5. Check on a copy of production

- [x] 5.1 Load a local copy of production, as in `leave-writes-roster`. Keep the dumps in the scratchpad and delete them afterwards
- [x] 5.2 Take the old definitions as `pg_temp` copies. Compare old and new for every employee and day: `leaves_is_leave_day`, `payroll_roster_shift_days` per month, `schedules_leave_and_loading`, and the continuation offset
- [x] 5.3 List every difference. Each one must be TW or T in Total days or PH loading, or ST in the away list. Report the employees affected
  - The day rule, payroll shift days, balances, PH loading and rotation continuation are identical
  - Total days rise in 5 person-months, all from TW: Adib (Nov 2025 16→25, Apr 2026 17→18, Dec 2026 15→20), Nessy (Nov 2025 13→22), Lintang (Jun 2026 14→20)
  - Away: Nurhuda's ST on 18–19 May 2026
  - Labels: SP gains "Special leave". NS was "Night" in the legend and "Night shift" on the dashboard; the user chose "Night shift" everywhere, so the migration sets it

## 6. Ship

- [x] 6.1 Tell HR that Total days now count travel work and training (past months too), and that study leave shows as away
- [x] 6.2 Push the migration with migrations temporarily enabled in `config.toml`, after `migration list`. Then deploy the front end. The migration is on live (`migration list`, 12 Oct). The front end (the roster grid's on-duty count, the week strip's off days) deploys when the `feat/shift-code-rules` PR merges, along with this archive. The old front end works against the new database in the meantime
- [x] 6.3 On live: check a roster with TW or T shows the higher Total days, and that the week strip labels SP
