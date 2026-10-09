# Design: shift codes table

## Context

Today the list of shift codes is defined twice, and nothing checks that the
two copies agree:

```
 src/types/schedule.ts                  supabase (latest definitions)
 ───────────────────────────            ─────────────────────────────────────
 enum ShiftCode           (14)          schedules_valid_code()  (14, from
 SHIFT_STYLES bg/fg/label/blank           20261008000200_roster_special_leave)
 SHIFT_CODE_ORDER (legend order)        shift_assignments.shift_code varchar(5)
                                          -- no CHECK, no FK
```

**Who calls `schedules_valid_code()`.** It is marked `immutable`. It is
called from plpgsql only, by four functions:

- `set_schedule_cell`, which raises `'shift_code: ''%'' is not a shift
  code'` with errcode `PT422`
- `save_schedule_assignments`
- `propose_shift_changes`
- `schedules_apply_roster_pattern`

No index, CHECK constraint or generated column uses it.

**Writes that skip the check.** Two write paths don't call it:

- `review_shift_change` writes a code that was already checked when the
  change was proposed.
- `roster_follows_holidays` changes D to PH, and PH back to D or B.

**Which screens use the codes:**

| File | What it uses |
|---|---|
| `ShiftLegend` | `SHIFT_CODE_ORDER`, `SHIFT_STYLES` |
| `RosterGrid` | `SHIFT_STYLES` for cell colours and the change overlay |
| `CellEditor` | `SHIFT_CODE_ORDER` as the picker |
| `RosterPatternModal` | picker, presets naming DS/NS/B/D, preview colours |
| `WeekStrip`, `DashboardPage` | `SHIFT_STYLES[code]` for codes that arrive as strings from `overview_at` |
| `SchedulesPage` | `ShiftCode.AL` in the annual leave running count |

In the front end, data reaches the screens through `src/lib/api.ts`. Area
modules in `src/lib/routes/*` map REST-shaped paths to PostgREST or RPC
calls. There is no query-cache library in the project.

## Goals / Non-Goals

**Goals:**

- The database is the only definition of which codes exist, what each is
  called, and how it looks. The screens read it from there.
- The column can't hold an unknown code, whichever path writes it.
- Set the pattern for later option lists in the config center: one table per
  list, an immutable code, `active`, `is_system`, and audit columns.
- No change in behaviour for any existing roster, leave, dashboard or payroll
  calculation.

**Non-Goals:**

- Rule columns, and rewriting the functions that hardcode subsets of the
  codes. That is a follow-up change.
- An admin screen for editing codes, and effective-dating.

## Decisions

### 1. One table per list, not a generic options table

`public.shift_codes` is its own table, not a row type in a shared
`options(list, code, label, …)` table.

A shared table can't be the target of a foreign key for one list only. It
would also force the later rule columns, such as `is_leave`, into JSON or a
separate attribute table. The config center gets consistency from shared
column conventions instead:

| Column | Why |
|---|---|
| `code` | Primary key, never renamed |
| `label` | Display name |
| `sort_order` | Order in the legend and pickers |
| `active` | Soft delete |
| `is_system` | Marks codes the logic names |
| `updated_at`, `updated_by` | Audit |

### 2. The code itself is the key; no surrogate id

```
 shift_codes
   code          text primary key   check (code ~ '^[A-Z]{1,5}$')
   label         text not null
   bg            text not null      check (bg ~ '^#[0-9A-Fa-f]{6}$')
   fg            text not null      check (fg ~ '^#[0-9A-Fa-f]{6}$')
   sort_order    int  not null
   blank_in_grid boolean not null default false
   active        boolean not null default true
   is_system     boolean not null default false
   updated_at    timestamptz not null default now()
   updated_by    uuid null references public.users(id) on delete set null
   check (active or not is_system)
```

Using the code as the key means `shift_assignments.shift_code` can point at
it directly, without rewriting any rows. The 1–5 capital letters rule matches
the existing `varchar(5)` column and every current code.

`check (active or not is_system)` means a future migration or the config
center can't deactivate DS, NS, D, B, AL or PH. The holiday trigger writes D,
B and PH, the roster presets use DS, NS, B and D, and AL feeds the annual
leave balance. All of them depend on those codes being active.

### 3. FK with `on update restrict on delete restrict`; deactivate, never delete

Codes are never renamed or deleted, so both actions restrict. Old rosters
keep pointing at inactive codes.

The FK sits on top of `schedules_valid_code()`, it doesn't replace it:

- The FK closes the direct-write gap, covering the holiday trigger, review
  approval and any service-role write. It can't express "active".
- The function gives the readable `PT422` message the cell editor shows. An
  FK violation would surface as a raw constraint error.

### 4. Unknown existing values: stop and list them

Before adding the FK, the migration selects the distinct
`shift_assignments.shift_code` values that aren't in the 14 codes. If there
are any, it raises an exception that lists them, and the whole transaction
rolls back.

Alternatives considered:

- **`NOT VALID` FK:** this leaves bad rows in place and hides them.
- **Mapping strays to a code:** this guesses what someone meant on a payroll
  input.

Neither is safe. The same select is documented as a query to run on live
before `db push`, so a failure is found in advance rather than during the
push.

### 5. `schedules_valid_code()` becomes `stable` and reads the table

```sql
select exists (select 1 from public.shift_codes where code = p_code and active)
```

- The signature stays the same, so the four callers and their messages don't
  change.
- Nothing indexes on it or uses it in a constraint, so dropping `immutable`
  is safe.
- It stays `security definer`-free. It runs inside `security definer`
  callers, and the table's read policy allows any signed-in user anyway.

**Inactive code on a pending request.** A proposed change whose code is
deactivated before review still applies when approved. The FK holds, and the
code was valid when it was proposed. In this change only a migration can
deactivate a code, so that migration can deal with pending requests itself if
it ever needs to.

### 6. RLS: read for `authenticated`, no write policies

- RLS is enabled, with `select … to authenticated using (true)` and a grant
  of `select` to `authenticated`.
- There are no insert, update or delete policies, so only migrations and the
  service role write.
- `anon` gets nothing. The sign-in page shows no roster.

### 7. Front end: fetch once, cache in a module-level promise

- **Route.** A fixed route `GET /schedules/shift-codes` in
  `src/lib/routes/schedules.ts`, registered before `/schedules/:id` like the
  other fixed paths. It reads `shift_codes` through PostgREST, ordered by
  `sort_order`.
- **Hook.** A `useShiftCodes()` hook holds one shared promise per page load.
  It exposes three things:
  - `codes`, for the legend and anything that displays inactive codes;
  - `activeCodes`, for the pickers;
  - `styleOf(code)`.

  This follows the project's current approach of plain hooks and contexts,
  with no query library.
- **Unknown or not-yet-loaded codes.** `styleOf` returns a neutral grey
  style with the code as its text. A cell never renders blank or crashes
  while loading, or if a code appears that the screen doesn't know.
- **Types.** `ShiftCode` becomes `string` for data. A
  `SystemShiftCode = "DS" | "NS" | "D" | "B" | "AL" | "PH"` const object
  stays, for the places that refer to a code by name: the AL count and the
  roster presets. `SHIFT_STYLES` and `SHIFT_CODE_ORDER` are removed.

### 8. Seed values are copied exactly

The seed rows copy `SHIFT_STYLES` and `SHIFT_CODE_ORDER`: labels, hex
colours, `blankInGrid` on B, and the legend order. Every row is
`active = true`. `is_system` is set on DS, NS, D, B, AL and PH.

## Risks / Trade-offs

- **[Live holds a code outside the 14]** → The migration stops and lists the
  values. Run the preflight query on live first, and decide what to do per
  value.
- **[SP migration not yet applied on live]** → The new migration seeds SP in
  any case. Because of the date order, `db push` would apply `20261008000200`
  first, so the order is guaranteed.
- **[Front end deployed before the migration]** → The codes route would fail
  and cells would fall back to grey. Deploy the database first. The old front
  end works unchanged against the new database, because the RPCs, their
  messages and the column are the same.
- **[A cached list goes stale in an open tab]** → Codes change only by
  migration, and usually alongside a front-end deploy. A reload picks up the
  change. No realtime subscription is needed.
- **[The hardcoded subsets in SQL drift from the table]** → They are still a
  second copy of the rule information until the follow-up change. This change
  doesn't make that worse, and the proposal records it as the next step.

## Migration Plan

1. On live, run the preflight query:
   `select distinct shift_code from shift_assignments where shift_code not in (…14…)`.
   Expect no rows.
2. Make sure `20261008000200_roster_special_leave.sql` is applied on live:
   `select public.schedules_valid_code('SP')` returns true.
3. `supabase db push` the new migration, dated after `20261009000100`. It
   runs in one transaction: create and seed the table, RLS and grant, the
   stray-value check, the FK, and the new `schedules_valid_code()`.
4. Deploy the front end.

**Rollback:** in one transaction, drop the FK, restore
`schedules_valid_code()` to its literal 14-code list from `20261008000200`,
and drop `shift_codes`. Then redeploy the previous front end. No roster data
is touched in either direction.

## Open Questions

None blocking. The user decided: inactive codes stay visible on old rosters,
unknown values stop the migration, and the work goes on its own branch.
