# Design: approved leave shows on the roster

## Context

**How a leave request moves through the system today.** It is submitted
(`submit_leave_request`), and `days_requested` is computed by
`leaves_count_days`. It is then approved or rejected, or cancelled while
pending or after approval. Approving changes nothing but the request row,
plus a counter in `leave_balances` for the non-annual types.

**What the roster looks like.**
- Each roster cell is a row in `shift_assignments`, keyed by
  `(schedule_id, employee_id, date)`.
- Schedules are months. A date can have a cell in more than one schedule,
  and readers prefer the published one.
- `save_schedule_assignments` deletes and re-inserts every cell of a draft,
  so cell ids are not stable.

**What writes cells:**

| Writer | What it does |
|---|---|
| `set_schedule_cell`, `save_schedule_assignments`, change approval | Admin edits and approved change proposals |
| `schedules_apply_roster_pattern` | With overwrite on, it replaces any cell it reaches |
| `roster_follows_holidays` | Turns D into PH (and back) for office staff when a national holiday is added or removed |

**What reads cells as attendance:**
- payroll field days (`payroll_roster_shift_days`: DS and NS, published
  schedules only, taken when a payroll month is created);
- the dashboard's on-shift, away and today lists;
- the roster's Total days and PH loading;
- `leaves_count_days`.

**How the annual balance is counted.** It is AL cells, together with every
calendar day of each approved annual request (`generate_series`). This is
done in two places, `leaves_annual_position` and
`schedules_leave_and_loading`.

## Goals / Non-Goals

**Goals:**

- A leave approved after go-live turns the days it charges into leave cells.
  That covers cells that exist now, and cells the generator creates later.
- Cancelling the leave puts back exactly what it replaced, without
  overwriting anyone's edit since.
- The annual balance charges the same days `days_requested` does.
- One rule decides which days count as leave, shared by `days_requested`,
  roster writing and the balance.

**Non-Goals:**

- Backfilling leave approved before go-live.
- Showing pending leave on the roster.
- Refreshing payroll months that already exist.
- A code per leave type.

## Decisions

### 1. One rule for which days count as leave: `leaves_is_leave_day(employee, date)`

The body of `leaves_count_days`, applied to a single day, becomes its own
function:

- **For the rotating crew, on a day with a cell:** the published cell, else
  the most recently updated one, is a working code (DS, NS, C, D, TW, T) or
  a leave code (AL, SL, DL, SP).
- **Otherwise:** the day is Monday to Friday and not a national holiday.

`leaves_count_days` becomes `count(*) filter (where leaves_is_leave_day(…))`
over the range. Its results don't change, and the existing leave tests
check that. Approval, the generator and the balance all call the same
predicate, so the days written, charged and counted can't drift apart.

### 2. Leave type to code: `leaves_roster_code(leave_type)`

An immutable SQL function returns `AL` for annual, `SL` for sick, `ST` for
study, and `SP` for every other type in `leaves_rules()`. Every code it
returns is a `shift_codes` row, so the FK holds.

The alternative was a column on `shift_codes`. Leave types aren't a table,
so the mapping can't be a foreign key. It moves into configuration with the
follow-up change for code rules.

### 3. The go-live cutoff is a flag set on approval: `leave_requests.on_roster`

- `boolean not null default false`. The migration adds it, so every existing
  request is `false`.
- `approve_leave_request` sets it to `true`.
- Only `on_roster` requests are ever written by approval or the generator.

The alternative was comparing `reviewed_at` with a go-live timestamp. That
needs a stored date, and it can't express exceptions later.

**Late approvals.** An approval after go-live for dates already past still
writes those cells. The rule is about when the leave was approved, not its
dates. Existing payroll months are unaffected, because their shift days were
taken when the month was created.

### 4. A remembered code per request and day: `leave_roster_cells`

```
 leave_roster_cells
   leave_request_id uuid → leave_requests(id) on delete cascade
   employee_id      uuid
   date             date
   leave_code       text   -- the code that was written
   previous_code    text   -- the code it replaced (→ shift_codes)
   primary key (leave_request_id, date)
```

- It is keyed by employee and date, not by cell id. A draft save deletes
  and re-inserts cells with new ids, but the record still finds them.
- One `previous_code` per day is enough. The cells for one employee on one
  date normally agree.
- When the generator writes a leave cell, `previous_code` is the pattern
  code it would have written.
- RLS is enabled with no policies. Only the `security definer` functions
  touch the table.

### 5. Writing: `leaves_apply_to_roster(request_id)`

This one function is called on approval and does the same job for every
`on_roster` request. For each date in `start_date..end_date` where
`leaves_is_leave_day` holds, and for each existing cell of that employee on
that date whose code is a working code:

1. Upsert the `leave_roster_cells` row with the current code as
   `previous_code`. If a row exists, keep the earlier `previous_code`.
2. Set the cell to `leaves_roster_code(type)`.

Some cells are left alone:

- Cells already holding a leave code (AL, SL, DL, SP), PH, B, O or ST. They
  aren't leave days, or they're leave already.
- Days with no cell. The generator fills those in later.

### 6. The generator gives way to `on_roster` leave

In `schedules_apply_roster_pattern`, a step is added after the day's code
(`v_code`) is worked out, including the PH and weekend handling. If `v_code`
is a working code, and an approved `on_roster` request of that employee
covers the day:

1. Upsert `leave_roster_cells` with `previous_code = v_code`.
2. Write that request's leave code instead.

Overwrite then keeps leave in place, and a newly generated month includes
it. The written and skipped counts work as before. The continuation offset
already steps over the leave codes.

### 7. Cancelling: `leaves_remove_from_roster(request_id)`

`cancel_leave_request` calls this before setting `status = 'cancelled'`.
For each `leave_roster_cells` row:

- Set `shift_code = previous_code` on that employee's cells for that date
  that still hold `leave_code`.
- Delete the row.

A cell edited since then no longer holds the leave code, so it's left as
the editor set it. Rejecting needs nothing, because only pending requests
can be rejected and they are never on the roster.

### 8. The annual balance counts leave days

In both `leaves_annual_position` and `schedules_leave_and_loading`, the
request side of the union becomes:

```sql
select g::date from leave_requests lr,
       generate_series(lr.start_date, least(lr.end_date, p_through), '1 day') g
 where … and public.leaves_is_leave_day(lr.employee_id, g::date)
```

The union with AL cells stays, so a date is still counted once. After
approval, an `on_roster` request's days are AL cells anyway. The predicate
counts AL as a leave day, so the union agrees. For a request from before
go-live, a DS day counts and a B day doesn't, which matches what
`days_requested` charged.

## Risks / Trade-offs

- **[Balances go up for anyone who took annual leave across a weekend, B
  days or a holiday]** → This is intended; it corrects an over-charge. Tell
  HR before deploying. A test pins a Friday-to-Monday request at 2 days.
- **[Leave approved before go-live, for future dates, stays off the
  roster]** → This is the decision. HR can enter those cells by hand.
- **[A national holiday added after approval]** → `roster_follows_holidays`
  only changes D cells, so the leave cell stays. If the leave is cancelled,
  D comes back on a holiday rather than PH. It's rare, and editing the
  holiday or the cell corrects it. Documented, not handled.
- **[Payroll months created before the approval]** → Their shift days don't
  change, the same as any roster edit today. Out of scope.
- **[Performance of the predicate in the balance]** → It's one lateral
  lookup per day per approved annual request. Those are few and short. It's
  called with year-end through-dates on the dashboard, which is still small.

## Migration Plan

1. New migration in a single transaction:
   - the column;
   - `leave_roster_cells`, with RLS enabled;
   - `leaves_roster_code` and `leaves_is_leave_day`;
   - `leaves_count_days` rewritten over the predicate;
   - `leaves_apply_to_roster` and `leaves_remove_from_roster`;
   - the redefined `approve_leave_request`, `cancel_leave_request`,
     `schedules_apply_roster_pattern`, `leaves_annual_position` and
     `schedules_leave_and_loading`;
   - grants.

   No data is touched: every existing request stays `on_roster = false`.
2. Push it with migrations temporarily enabled in `config.toml`, as for
   shift codes. No front-end deploy is needed.

**Rollback:** re-apply the previous definitions of the redefined functions,
and drop `leave_roster_cells` and the column. Cells already written as leave
stay leave. Cancelling those requests after a rollback would no longer
restore them.

## Open Questions

None. The user decided:
- the code mapping;
- no pending markers on the roster;
- the generator fills in leave for months generated later;
- no backfill, with the cutoff at approval;
- the balance fix goes into this change.
