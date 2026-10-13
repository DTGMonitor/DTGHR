# Design: office asset register

## Context

- **Who IT is.** `employees.is_it_support` already marks the people who
  work the IT queue, and `notifications_it_support_users()` returns their
  accounts. The register uses the same flag. It doesn't add a new role.
- **Who else reads.** `is_finance()` and `is_admin()` (director and
  executive) exist, and so does the `employees.is_management_role` flag.
- **How a feature is built.** Every area follows the same pattern as
  tickets (`20260926000900`, last redefined in `20261014000100`):
  - the tables have RLS turned on and no client policies;
  - every read and write goes through a `security definer` function that
    decides who the caller is;
  - a `*_serialise` function shapes each record and includes the flags the
    page reads (`can_manage`, …), so the page never works out a rule for
    itself;
  - refusals that would reveal a record raise "not found".
- **Notifications.** Asset notifications are written with
  `notifications_enqueue(user_ids, exclude, kind, subject, payload,
  source_table, source_id)`. Action items are settled with
  `notifications_resolve` / `notifications_resolve_kinds`. Writes happen
  inside the area's functions, each wrapped in its own
  `begin … exception when others → raise warning` block. Asset functions
  write their own notifications and add no triggers inside earlier
  notification migrations, because the notifications suite replays
  `20261007000100`.
- **Leavers.** Employees have `is_active`. Manpower contracts
  (`contracts.kind = 'manpower'`, `employee_id`, `end_date`, `status`)
  carry contract end dates. `renewal_notices` shows the "once per item per
  date" pattern for scheduled notices.
- **Scheduled jobs.** These are guarded `cron.schedule` calls, as in
  `20260929000100` and `20261014000100`.

## Goals / Non-Goals

**Goals:**

- Anyone with access can see who holds each item and whether they have
  accepted it.
- The register stays current because recording a change is part of the
  handover itself, and a regular check-in catches anything that slips.
- Everything that happens to an asset is in an append-only history.
- Sensors can be registered now. Deploying them to sites later adds a
  holder kind and a status, without redoing this design.

**Non-Goals:**

- Sites, deployment, PO links, labels, depreciation, consumables,
  calibration reminders, and importing the old file.

## Decisions

### 1. Categories own the tag sequence

`asset_categories`:

| Column | Notes |
|---|---|
| `code` | `varchar(4)`, upper case, unique, and never changed once an asset uses it |
| `name` | |
| `tracks_calibration` | boolean; when true, the page shows the calibration date |
| `next_number` | int, default 1 |
| `is_active` | inactive categories can't take new assets but still display |

Seeded categories:

| Code | Name |
|---|---|
| LAP | Laptop |
| DSK | Desktop |
| MON | Monitor |
| PHN | Phone / tablet |
| PRN | Printer / scanner |
| NET | Network |
| ACC | Accessory |
| FUR | Furniture |
| SEN | Sensor (calibration) |
| OTH | Other |

IT can add a category and rename it. The code is fixed once an asset uses
it.

**Tags.** A tag is `DTG-<code>-<number>`, with the number zero-padded to 4
digits; it simply grows past 9999. `assets_register` takes the next number
with `update asset_categories set next_number = next_number + 1 … returning`,
which locks the category row, so two people registering at once never get
the same tag.

- A tag never changes, not even when the category is corrected later. This
  follows the ticket reference rule: the label is already stuck on the item.
- Numbers are never reused.

*Alternative:* one global sequence (`DTG-0001`). Rejected because a
category code in the tag tells someone holding the item what kind of thing
it is, and the user asked for retagging anyway.

### 2. The asset row

`assets`:

| Column | Notes |
|---|---|
| `id` | uuid |
| `tag` | unique |
| `category_id` | |
| `name` | e.g. "ThinkPad T14 Gen 4" |
| `brand`, `model` | |
| `serial_number` | unique case-insensitive where not null |
| `status` | `in_store, assigned, in_repair, retired, lost` |
| `holder_employee_id` | null unless `assigned`, or `in_repair` / `lost` with a holder kept (see 3) |
| `holder_since` | when the current holder was assigned |
| `holder_confirmed_at` | null = handover pending |
| `location` | free text for where an unheld item is ("Jakarta office, store room") |
| `purchase_date` | |
| `purchase_value` | numeric ≥ 0 |
| `currency` | default `IDR` |
| `warranty_until` | |
| `calibration_due` | |
| `flag_kind` | null, `handover_declined` or `checkin_missing` |
| `flag_note`, `flagged_at` | |
| `notes` | |
| `retired_at` | |
| `created_by`, `updated_by`, `created_at`, `updated_at` | |

**Room for phase 2.** The holder is a nullable employee, not a required
one. The sensor change adds `holder_site_id` and a `deployed` status, with
a check that at most one holder is set. Nothing in this design assumes the
holder is a person whenever the status is not `in_store`, except the
`assigned` status itself.

### 3. Status moves

```
                 assign (pending until confirmed)
     ┌──────────┐ ─────────────────────────────▶ ┌──────────┐
     │ in_store │                                │ assigned │──┐ transfer
     └──────────┘ ◀───────────────────────────── └──────────┘◀─┘ (new holder,
        │   ▲ ▲              return                 │   ▲         pending again)
 repair │   │ │ back from repair                    │   │ back from repair
        ▼   │ │ (no holder)               repair    ▼   │ (holder kept)
     ┌──────────┐ ◀──────────────────────────────────────┘
     │in_repair │
     └──────────┘
   any non-retired ──lost──▶ lost ──found──▶ in_store
   in_store / in_repair / lost ──retire──▶ retired   (final)
```

- **Repair keeps the holder.** The common case is "Budi's laptop goes for
  repair and comes back to Budi". Coming back from repair returns the item
  to `assigned` with the same holder and the same confirmation. With no
  holder, it returns to `in_store`.
- **Lost keeps the holder** for the record, as the person it was lost
  from. "Found" clears the holder and puts the item in store, and IT
  reassigns it from there.
- **Retiring** needs a reason, and is allowed from `in_store`,
  `in_repair` or `lost`. An `assigned` item must be returned first, so
  nothing in someone's hands is written off behind their back. A lost or
  beyond-repair item can be written off directly; it clears any holder, and
  the `retired` event records whom it was with.
- **Transfer** (assigned → assigned to someone else) is one action with one
  event. The new holder confirms again, and the old holder is notified
  that the item left their name.
- Moves that need a note: declined, lost, retired. All other notes are
  optional.

Each move is its own function, so the rules read plainly and the tests
name them:

- `assets_assign(id, employee_id, note)`, which also handles transfer;
- `assets_return(id, location, note)`;
- `assets_send_to_repair(id, note)`;
- `assets_back_from_repair(id, note)`;
- `assets_mark_lost(id, note)`;
- `assets_mark_found(id, location, note)`;
- `assets_retire(id, reason)`.

Every move writes one `asset_events` row. A move that doesn't fit the
current status is refused with a validation error. Every IT move also
clears any flag on the asset; the event says so.

### 4. The handover

```
 IT assigns ──▶ holder_confirmed_at = null ──▶ asset_assigned (action) to holder
                       │
       ┌───────────────┴────────────────┐
       ▼                                ▼
 holder confirms                  holder declines (note required)
 holder_confirmed_at = now()      status stays assigned, flag_kind = handover_declined
 event `confirmed`                event `declined`, asset_handover_declined (action) to IT
 settles asset_assigned           settles asset_assigned
```

- `assets_respond_handover(id, accept boolean, note)`. Only the current
  holder may call it, and only while the handover is pending.
- **A decline doesn't move the item.** IT knows whether the item was
  actually handed over, so IT resolves the flag by returning, reassigning
  or marking lost. IT can also clear the flag with a note through
  `assets_clear_flag(id, note)`.
- There is no reminder for pending handovers. The holder's item stays
  open, and IT's list shows pending handovers with their age.

*Alternative:* the item only moves to `assigned` on confirmation. Rejected:
the item has physically left the store, and the register would claim it is
still there.

### 5. The history

`asset_events`:

| Column | Notes |
|---|---|
| `id` | |
| `seq` | `bigint generated always as identity`, the order the events were written |
| `asset_id` | |
| `kind` | see the list below |
| `actor_id` | null for the scheduled job |
| `actor_name` | |
| `from_status`, `to_status` | |
| `from_holder_id`, `to_holder_id` | |
| `from_holder_name`, `to_holder_name` | snapshots, so the history reads right after a name change or after the person leaves |
| `ticket_id` | |
| `body` | |
| `created_at` | |

Kinds:

- registered, edited, assigned, transferred, confirmed, declined, returned;
- repair_out, repair_back, lost, found, retired, flag_cleared;
- checkin_confirmed, checkin_missing, checkin_seen;
- ticket_linked, ticket_unlinked.

- **Append-only.** There are no client grants, and no function updates or
  deletes an event.
- **Ordering.** The history is read ordered by `(created_at, seq)`, as the
  ticket trail is since `20261015000100_ticket_trail_order.sql`. Some calls
  write two events: register-and-assign writes `registered` then
  `assigned`, and a check-in "I have it" on a pending handover writes
  `checkin_confirmed` then `confirmed`. Where the clock ticks only once a
  millisecond (PGlite), both events can share a timestamp. `seq` keeps
  them in the order they were written.
- **`edited` events** list the changed fields as "Serial: — → PF3X…".
  - Changes to the value fields (`purchase_value`, `currency`) show as
    "Purchase value changed", without the figures.
  - This is because the employee view never shows values, and the event
    body is the same text for every reader.

### 6. Who sees what

| | Register (all assets) | Values | History | Manage | My equipment |
|---|---|---|---|---|---|
| IT (`tickets_works_queue`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Finance (`is_finance()`) | ✓ | ✓ | ✓ | | ✓ |
| Management (`is_admin()` or `is_management_role`) | ✓ | ✓ | ✓ | | ✓ |
| Everyone else | | | own items only, events while they held it | | ✓ |

- `assets_can_manage()` = `tickets_works_queue(current_employee_id())`:
  the IT support flag, and the manager of IT support, exactly as for the
  ticket queue. One definition of "IT" across both pages.
- **Event bodies never name the previous holder.** A transfer reads
  "Transferred to Ana"; the earlier holder is only in `from_holder_name`,
  which a holder's copy blanks unless it is them.
- `assets_can_view_all()` = can manage, or finance, or `is_admin()`, or
  `is_management_role`.
- **What My equipment shows.** `assets_mine()` returns the caller's held
  items, including pending ones. For each item:
  - tag, category, name, brand, model, serial, `holder_since` and the
    confirmation state;
  - the events written since `holder_since` (their own period);
  - no values, no location notes, and no earlier holders.
- **Value fields** are left out of the serialised object for anyone who
  can't view everything. The `edited` event text never includes figures
  (decision 5).
- **Refusals.** An employee asking for someone else's asset gets "not
  found".

### 7. Linking a ticket to an asset

- `support_tickets.asset_id`: `uuid null references assets(id) on delete
  set null`.
- `tickets_link_asset(ticket_id, asset_id)`: IT only, and `null` unlinks.
  It writes:
  - a public `asset_linked` event on the ticket ("Linked to DTG-LAP-0007");
  - a `ticket_linked` / `ticket_unlinked` event on the asset, with the
    ticket's reference.
- `tickets_serialise` gains `asset: { id, tag, name }` and nothing more.
  The reporter sees the tag of the item their ticket concerns. For them
  it's normally their own laptop.
- **Not in this change:** the reporter choosing an asset while raising.
  That would change the signature of `tickets_raise`, which was only just
  redefined. IT links the asset during triage, which is when they look at
  the ticket anyway. A "Report a problem" button on My equipment can come
  later, by adding a defaulted `p_asset_id`.

### 8. Check-in rounds

Tables:

- `asset_checkin_rounds`:
  - `id`, `name` (default "Check-in <Mon YYYY>"), `started_at`,
    `started_by`, `due_date` (default start + 14 days);
  - `closed_at`, `closed_by`, `reminded_at`;
  - only one round may be open: a unique partial index where
    `closed_at is null`.
- `asset_checkin_items`:
  - `round_id`, `asset_id`, `holder_employee_id` (a snapshot; null for
    unheld items);
  - `state`: `pending, confirmed, missing, seen, no_reply`;
  - `responded_at`, `responded_by`, `note`;
  - unique on (`round_id`, `asset_id`).

```
 IT starts round
   ├─ one item per asset that is assigned, in_store or in_repair
   │    (lost and retired items are not included)
   ├─ assigned items → their holder's queue
   │    one asset_checkin_requested (action) per holder, with the count of items
   └─ in_store / in_repair items → IT's queue, marked "seen" by IT

 holder: "I have it" → confirmed, event checkin_confirmed
         "Not with me" (note required) → missing, flag_kind = checkin_missing,
                     event checkin_missing, asset_checkin_missing (action) to IT

 IT moves an asset during the round (return / transfer / repair / lost / found)
   → its pending item becomes `seen` by that IT person (IT handled the item)

 day 7 after start (daily job) → asset_checkin_reminder to holders still pending, once
 IT closes round → pending items become no_reply; holders' items are settled;
                   summary counts are stored on the round
```

- **Pending handovers.** A pending handover is included in the round. If
  the holder confirms the check-in item, the handover counts as confirmed
  too. Both are the same statement: "I have it".
- **The holder's request** is settled when the holder has no pending items
  left in the round, or when the round closes.
- **Closing.**
  - Only IT can close a round, and closing is allowed before the due date.
  - The due date is a target shown to staff. Nothing happens automatically
    when it passes.
  - The page shows rounds past their due date as overdue.
- **The six-month nudge.** The daily job sends `asset_checkin_due`
  (action) to IT when all of these hold:
  - no round is open;
  - the last round started more than 182 days ago, or there has never been
    a round and the first asset was registered more than 182 days ago;
  - no `asset_checkin_due` was sent in the last 30 days.

  Starting a round settles it.
- **History.** Closed rounds stay readable by everyone who can view the
  register: the per-item states, who answered and when. This is the audit
  record.

*Alternative:* rolling check-ins (each item due 180 days after it was last
confirmed). Rejected: there is no point in time where Finance can say
"everything was confirmed on this date", and that statement is the reason
for doing check-ins at all.

### 9. Leavers with items

The daily job looks at every employee who holds at least one item
(`assigned`, or `in_repair` with a holder) and who either:

- is inactive (`is_active = false`), or
- has a contract ending between today and 14 days from today: the
  employee record's `contract_end_date`, or an active manpower contract's
  `end_date`, whichever comes first. Both exist and either may be the one
  kept up to date.

- **The notice.** For each one, it writes `asset_holder_leaving` (action)
  to IT. The notice lists the person, the reason ("Contract ends 31 Oct" /
  "No longer active") and their items.
- **Dedup.** `asset_leaver_notices` makes the notice go once per employee
  per reason per end date. Its unique key is (`employee_id`, `reason`,
  `coalesce(end_date, '1970-01-01')`). An extended contract therefore warns
  again.
- **Settling.** IT's item is settled when that employee holds nothing.
  Every move that clears a holder runs that check.
- **The register's "Leaving with items" panel** computes the same list
  live. It doesn't depend on the notices.

*Alternative:* a trigger on `employees` when `is_active` turns false.
Rejected because a contract ending is the earlier and more useful signal,
and one daily job covers both.

### 10. Notifications

Notifications are written from the asset functions and the daily job. IT
means `notifications_it_support_users()`. The actor is always excluded.

| Kind | To | Tone | Needs action | When |
|---|---|---|---|---|
| `asset_assigned` | holder | action | ✓ | assigned or transferred to them |
| `asset_released` | old holder | reminder | | returned, transferred away, or found after being lost from them |
| `asset_handover_declined` | IT | action | ✓ | the holder declined |
| `asset_checkin_requested` | holder | action | ✓ | a round starts |
| `asset_checkin_reminder` | holder | reminder | | day 7 of a round, still pending |
| `asset_checkin_missing` | IT | action | ✓ | the holder answers "Not with me" |
| `asset_checkin_due` | IT | action | ✓ | six months since the last round |
| `asset_holder_leaving` | IT | action | ✓ | a holder is leaving or inactive |

Source and link:

- asset kinds: `source_table = 'assets'`, link `/equipment?open=<id>`;
- check-in kinds: `asset_checkin_rounds`, link `/equipment?round=<id>`;
- leaver kinds: `employees`, link `/equipment?holder=<employee id>`.

Settling, by kind (`notifications_resolve_kinds`):

| Kind | Settled when |
|---|---|
| `asset_assigned` | the holder responds, or the asset leaves them |
| `asset_handover_declined`, `asset_checkin_missing` | any IT move on the asset, or a clear-flag |
| `asset_checkin_requested` | the holder has nothing pending in the round, or the round closes |
| `asset_checkin_due` | a round starts |
| `asset_holder_leaving` | the employee holds nothing |

### 11. The page

`/equipment` (not `/assets`, which is Vite's build directory and carries an immutable cache header on Vercel) reads the caller's capabilities from the serialised responses.

- **IT, Finance, management:**
  - tabs: Register, Check-ins, My equipment;
  - the Register has filters (status, category, holder, flagged,
    pending handover) and search (tag, serial, name);
  - panels: "Pending handovers", "Flagged", "Leaving with items";
  - an asset drawer with the details and history, and the move buttons for
    IT.
- **Everyone else:** only My equipment, with Confirm / Didn't receive it,
  and the open check-in.
- **Register for IT:** a form with "Save & add another", which keeps
  category, brand, model, purchase date and location, and an optional
  "Assign to" field.
- **URL parameters:** `?open=`, `?round=` and `?holder=` open the item a
  notification points at.
- **Sidebar:** an "Assets" entry for everyone. Staff land on My equipment.
- **On a ticket, for IT:** an asset picker. By default it searches the
  reporter's items first, then all assets.

## Risks / Trade-offs

- **[IT doesn't do the stocktake properly, and the register starts
  wrong]**
  - The first check-in round, run soon after go-live, shows the gaps:
    holders answer "Not with me", or hold items that were never
    registered.
  - The proposal asks for a round about a month after the stocktake.
- **[Staff ignore the confirmation]** → The action item stays in their
  inbox and on the dashboard summary. IT sees how old each pending
  handover is. No automatic escalation in this change.
- **[Values leak to employees through the history]** → The event text for
  value changes is fixed and leaves out the figures. The tests check that
  `assets_mine()` returns no value keys.
- **[Serial numbers typed differently]** → Uniqueness is case-insensitive
  on the trimmed value. Blank values are stored as null, so items without
  a serial don't collide.
- **[Two IT people register at the same time]** → Locking the category row
  hands out tags one at a time. The cost is negligible at this volume.
- **[`tickets_serialise` redefined again]** → It is copied from
  `20261015000100` with only `asset` added. The tickets suite runs in
  full.
- **[`pg_cron` is missing locally]** → The tests call `assets_daily_run()`
  directly. Only the scheduling is conditional.

## Migration Plan

1. One migration, dated after `20261015000100`, inside `begin; … commit;`
   and safe to re-run. It:
   - creates the tables and the category seed (`on conflict do nothing`);
   - adds `support_tickets.asset_id`;
   - creates the functions and redefines `tickets_serialise`;
   - sets the grants;
   - schedules `assets_daily_run` daily at 07:00 Jakarta time (00:00 UTC)
     with a guarded `cron.schedule`.
2. Deploy the front end after it.
3. Push with migrations temporarily enabled in `config.toml`, after
   `migration list`.
4. Go-live:
   - IT registers and labels the items;
   - staff confirm their handovers;
   - IT starts the first check-in round about a month later.

**Rollback:**

- unschedule the job;
- re-apply `tickets_serialise` from `20261015000100`;
- drop the asset functions.

The tables and the column can stay. Nothing old reads them.

## Open Questions

None blocking. The user decided:

- no import; start fresh and retag;
- IT maintains the register;
- holders are responsible and confirm;
- Finance and management read everything, including values;
- employees see their own items;
- check-in rounds every six months, started by IT;
- sensors are registered now, and site deployment comes later;
- the PO link comes later.

Defaults chosen here that the user may want to change:

- the tag format `DTG-LAP-0001`;
- the 14-day window before a contract ends;
- the day-7 reminder;
- the 14-day round target;
- 182 days for the nudge.
