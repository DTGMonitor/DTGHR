# Design: IT tickets, closing the loop with the reporter

## Context

Tickets live in `support_tickets` with an append-only trail in
`ticket_events` (`20260926000900_tickets.sql`). Every action goes through a
`security definer` function that decides who the caller is. The page reads
`can_work` from each response and never works out the rule for itself.
`tickets_set_status` was last redefined in `20260930000600` so that the
reporter can close their own live ticket.

Notifications (`20261007000100`, `20261009000100`):

- `notifications_on_ticket` (an after-insert trigger) writes one
  `ticket_raised` item per IT support user, excluding the reporter and the
  actor. It has tone `action`, so `needs_action = true`.
- `trg_notifications_resolve` on `support_tickets` calls
  `notifications_resolve(table, id, status)` when the status moves to
  `resolved` or `closed`. That settles **every** open action item for the
  ticket, whoever it belongs to.
- `notifications_enqueue` writes the in-app row, plus an email for
  recipients who have email turned on, for every kind.

Things found while reading the code that this design has to deal with:

1. **Closing a resolved ticket throws its fix away.** `tickets_set_status`
   sets `resolution` and `resolved_at` to null whenever the previous status
   was `resolved`, and that includes resolved → closed.
   `tickets_resolver()` only answers while `status = 'resolved'`. So once
   auto-close exists, every fix would vanish from the history and the
   resolver stats after 5 days. The trail still holds each fix as the body
   of the `resolved` event.
2. **There is no `closed_at`.** The 14-day reopen window needs one.
3. **`updated_at` only moves on status and assignment changes**, not on
   comments. "Recently updated" would be wrong without fixing this.
4. **The reporter can't move a resolved ticket.** The reporter-close branch
   refuses when the status is `resolved` or `closed`.

## Goals / Non-Goals

**Goals:**

- The reporter hears about every public change to their ticket, and the
  side that needs to act always has an open action item.
- Tickets finish on their own when the reporter goes quiet, without losing
  their fix.
- Each action item clears when its own side has acted, without clearing
  the other side's.
- Requests that arrive by chat land in the same record, with how they
  arrived.

**Non-Goals:**

- Attachments, an assignment interface, service-level targets, using
  tickets for anything other than IT, and choosing which notification kinds
  send email.

## Decisions

### 1. A ticket is *fixed* when it has a `resolved_at`

- Closing from `resolved` **keeps** `resolution`, `resolved_at` and the
  resolver.
- Reopening (to `open`, `in_progress` or `waiting`) clears them, as it does
  today.
- `tickets_resolver(id)` returns the actor of the last `resolved` event
  when `resolved_at is not null`, instead of when `status = 'resolved'`.
- `tickets_history` per category:
  - `resolved` counts tickets with a `resolved_at`;
  - `closed` counts closed tickets with no `resolved_at` (duplicates,
    withdrawn, or timed out while waiting).
  - This matches the page's existing wording: "Closed requests … are
    listed but not counted as resolved."
- **Backfill.** Some closed tickets have no `resolved_at`, but their last
  status event was a `resolved` event with a body, and nothing after it
  moved them back to a live status. For those, restore `resolution` from
  that event's body and `resolved_at` from its `created_at`.

*Alternative:* keep `status = 'resolved'` as the meaning of fixed and never
auto-close resolved tickets. That was rejected because the user wants
resolved tickets to close after 5 quiet days.

### 2. New columns on `support_tickets`

| Column | Type | Meaning |
|---|---|---|
| `channel` | `varchar(20) not null default 'portal'`, check in `portal, whatsapp, in_person, phone, email` | How the request arrived |
| `related_ticket_id` | `uuid null references support_tickets(id) on delete set null` | The earlier ticket this one comes back to |
| `closed_at` | `timestamptz null` | Set on every move to `closed`, cleared on reopen |
| `auto_close_at` | `timestamptz null` | Deadline while the status is `waiting` or `resolved`, null otherwise |
| `auto_close_reminded_at` | `timestamptz null` | Stops the day-before reminder from being sent twice |

Backfill:

- `closed_at` comes from the last event with `to_status = 'closed'`, or
  from `updated_at` when there is none.
- Tickets already `waiting` or `resolved` get `auto_close_at = now() +
  5 days`. **Nothing closes the moment the migration lands.**

`updated_at` is now set by **every** function that writes an event,
including comments, extensions and links. This keeps "Recently updated"
honest.

### 3. The auto-close clock

```
 enter waiting/resolved ─────────────────▶ auto_close_at = now() + 5d,  reminded = null
 public event while waiting/resolved ────▶ auto_close_at = greatest(auto_close_at, now() + 5d), reminded = null
 extend (reporter or IT) ────────────────▶ auto_close_at = chosen deadline,  reminded = null
 leave waiting/resolved ─────────────────▶ auto_close_at = null, reminded = null
 internal note ──────────────────────────▶ no change (the reporter can't see it)
```

- **`greatest`:** an ordinary reply never shortens a deadline that someone
  has extended.
- **`tickets_extend(id, until, reason)`:**
  - The caller must be the reporter or someone who works the queue.
  - The status must be `waiting` or `resolved`.
  - `until` must be later than the current `auto_close_at` and no more than
    30 days from now.
  - The page offers +5 days, +10 days, or a date. The server takes one
    timestamp.
  - It writes a public `extended` event: "Auto-close moved to 24 Oct:
    <reason>".
- **`tickets_auto_close_run()`**, scheduled hourly where `pg_cron` exists,
  following the pattern of the existing jobs:
  1. **Reminder.** For tickets where `auto_close_at - 1 day <= now()` and
     `auto_close_reminded_at is null`, write `ticket_closing_soon` for the
     reporter and set `auto_close_reminded_at`.
  2. **Close.** For tickets where `auto_close_at <= now()`:
     - set `status = 'closed'` and `closed_at = now()`, and keep the fix
       (decision 1);
     - write a `status` event with `actor_id` null and `actor_name`
       "Automatic", whose body depends on where the ticket came from:
       - from waiting: "Closed automatically: no reply before the
         deadline.";
       - from resolved: "Closed automatically: no update before the
         deadline. The fix stands.";
       - (not "after 5 days": an extended deadline may be longer);
     - write `ticket_auto_closed` for the reporter.
     - The existing resolve trigger then settles every open item, with
       `resolved_by` null.
  - Each ticket is handled in its own `begin … exception` block, so one bad
    row doesn't stop the run.

*Alternative:* compute the deadline from the latest event instead of
storing it. That was rejected: extensions would need their own column
anyway, and a stored deadline is one indexed comparison for the job and a
single field for the page's chip.

### 4. Who may do what on a ticket

| Action | Function | Reporter | Works the queue |
|---|---|---|---|
| Public reply | `tickets_comment` | ✓; if `waiting`, also moves the ticket to `in_progress` | ✓ |
| Internal note | `tickets_comment` | ✗ | ✓ |
| Close while live | `tickets_set_status` | ✓, note required by the page (unchanged) | ✓ |
| **Confirm** (resolved → closed) | `tickets_set_status` | ✓ **new**, note optional | ✓ |
| **Still broken** (resolved → open) | `tickets_reopen` | ✓, reason required | (uses `set_status`) |
| **Reopen closed** | `tickets_reopen` | ✓ only while `closed_at > now() - 14 days`, reason required | (uses `set_status`, no window) |
| Extend | `tickets_extend` | ✓ | ✓ |
| Change priority or category | `tickets_triage` | ✗ | ✓ |
| Link or unlink | `tickets_link` | ✗ (only when raising) | ✓ |
| Raise on someone's behalf | `tickets_raise` | ✗ | ✓ |

**A reporter's reply to a waiting ticket** writes two events in one
transaction:

- the `commented` event;
- a `status` event waiting → in progress, with body "Reply received".

Doing it on the server means a reply can never leave a ticket stuck in
`waiting`.

**`tickets_reopen`:**

- sets `status = 'open'`;
- clears `resolution`, `resolved_at`, `closed_at` and the auto-close
  fields;
- writes a `reopened` event whose body is the reason;
- notifies IT with `ticket_reopened` (an action item, since the ticket is
  IT's to work again).

**`tickets_triage(id, priority, category)`:**

- writes one public `triaged` event listing only what changed:
  "Priority: Normal → High · Category: Connectivity → Hardware";
- **does not change the reference**, because NET-0003 is already in emails,
  notifications and people's memory;
- the history groups by the ticket's current category.

*Alternative:* give a recategorised ticket a new reference. That was
rejected because it breaks links and email threads.

### 5. Settling notifications per kind

New helper:

```
notifications_resolve_kinds(p_source_table, p_source_id, p_kinds text[], p_status text)
```

It does the same as `notifications_resolve`, plus `and kind = any(p_kinds)`.
It is a **separate function**, so the existing signature and its callers
stay untouched.

- The table trigger is unchanged. On `resolved` or `closed` it still
  settles everything that is open. That is correct: IT's items are done,
  and the reporter's `ticket_waiting` and `ticket_closing_soon` no longer
  apply.
- The ticket functions call `notifications_resolve_kinds` explicitly:
  - **leaving `waiting`** (by reply or by IT): settles
    `ticket_waiting` and `ticket_closing_soon`;
  - **leaving `resolved` for a live status** (Still broken, or IT reopens):
    settles `ticket_closing_soon`;
  - **the clock restarting** (public reply or extension): settles
    `ticket_closing_soon`.
- IT's `ticket_raised` and `ticket_reopened` items stay open until the
  ticket is resolved or closed, as today.

*Alternative:* give `notifications_resolve` a kinds parameter with a
default. That was rejected because it changes a signature that 8 tables'
triggers and earlier migrations' revoke/grant statements refer to. A new
function is additive.

### 6. The notification kinds

The *reporter* is the reporter's linked user account. *IT* means
`notifications_it_support_users()`. The actor is always excluded, so a
ticket Bintang raises for their own problem notifies nobody about the
raising.

| Kind | To | Tone | Needs action | When |
|---|---|---|---|---|
| `ticket_raised` | IT | action | ✓ | raised (existing) |
| `ticket_logged_for_you` | reporter | reminder | | IT raised it on their behalf |
| `ticket_replied` | reporter | reminder | | IT public reply |
| `ticket_waiting` | reporter | action | ✓ | IT moves it to `waiting`; the note is the question |
| `ticket_resolved` | reporter | success | | resolved; carries the fix and Confirm / Still broken |
| `ticket_closed` | reporter | reminder | | IT closes it (not auto) |
| `ticket_closing_soon` | reporter | action | ✓ | 1 day before auto-close |
| `ticket_auto_closed` | reporter | reminder | | auto-close ran |
| `ticket_reporter_replied` | IT | reminder | | reporter public reply |
| `ticket_reopened` | IT | action | ✓ | reporter reopens or says Still broken |
| `ticket_closed_by_reporter` | IT | reminder | | reporter closes or confirms |

- `ticket_resolved` is **not** an action item. Confirming is optional, and
  the day-before reminder is what asks for a decision.
- Moving the ticket to `in_progress` does not notify the reporter. That
  keeps email low.
- Every payload links to `/support?open=<id>` through
  `notifications_item_link`, as today.

Notifications are written from the ticket functions (and the auto-close
job), not from new triggers. The functions already know the actor and the
reason, and each call sits in its own `begin … exception when others →
raise warning` block, per the "Notifications never undo the change" rule.
`notifications_on_ticket` stays as the insert trigger for `ticket_raised`,
unchanged. `ticket_logged_for_you` is written by `tickets_raise` itself.
The notifications test suite replays `20261007000100` to check it re-runs,
and a change inside `notifications_on_ticket` would be undone by that replay
for every suite that runs after it.

### 7. Raising on someone's behalf

- `tickets_raise` gains `p_reporter_id uuid default null`,
  `p_channel text default 'portal'` and
  `p_related_ticket_id uuid default null`.
- The old 5-argument version is dropped, and the new one is granted.
- **A different reporter** is allowed only for someone who works the
  queue. The reporter must be an active employee.
  - `channel` must then be one of `whatsapp, in_person, phone, email`.
  - Without a different reporter, `channel` must be `portal`.
- The trail's `raised` event has IT as the actor, with body
  "Logged for <name> from WhatsApp: <subject>". The trail therefore shows
  who logged it, and no `raised_by` column is needed.
- **The link on raise:** a reporter may link only to a ticket they reported
  themselves. IT may link to any ticket. In both cases the linked ticket
  must be older.

### 8. What a viewer sees of a linked ticket

The serialiser adds:

- `related`: `{ id, reference, subject, status, resolution, resolved_at }`;
- `recurrences`: a list of `{ id, reference, status, created_at }` for
  tickets that point back at this one.

For a viewer who doesn't work the queue, any linked ticket they didn't
report shows **reference and status only**. IT may have linked a
colleague's ticket, and its subject and fix are that colleague's business.

Linking must point to an older ticket, so links can't form a loop.

### 9. Sorting is done in the browser; the server supplies two fields

The serialiser adds:

- `last_public_actor`: `reporter`, `support` or `system`. This is the actor
  of the latest non-internal event. `reporter` means the event's `actor_id`
  is the reporter's user id; null means `system`; anything else means
  `support`.
- `last_public_kind`, that event's kind, so the page can tell a reporter
  who only raised the ticket from one who has since replied or reopened it;
- `last_public_at`.

The page sorts its list:

- **Needs me:**
  1. reporter spoke last on an `open` or `in_progress` ticket, or it was
     reopened;
  2. `open` and untouched since raised;
  3. `in_progress`;
  4. `waiting`;
  5. `resolved`;
  6. `closed`.

  Within each group: priority (urgent first), then oldest first.
- **Priority**, **Oldest**, **Newest**, **Recently updated** (`updated_at`
  descending).

The choice is kept in the URL (`?sort=`) next to `?open=`. The
reporter-side view uses the same menu, with "Newest" as its default.

*Alternative:* sort on the server. That was rejected: the list is small,
it is already fetched whole, and sorting it adds no extra round trip.

### 10. The history's new panels

`tickets_history` gains:

- `channels`: one row per month for the last 6 months,
  `{ month, total, portal, whatsapp, in_person, phone, email }`. The page
  shows the portal share.
- In each category row, `recurrences`: tickets in that category with a
  `related_ticket_id`.

## Risks / Trade-offs

- **[More email]** Every reply now emails the reporter. → Accepted, so that
  the push towards the platform works. Each reporter is on only a few
  tickets. Emailing only certain kinds can come later.
- **[A ticket closes while the reporter is away]** → They get the
  day-before reminder and the closing notice. They can reopen within
  14 days, and after that raise it again with a link.
- **[The `pg_cron` job is missing on a local stack]** → The function exists
  and the tests call it directly. Only the scheduling is conditional, as
  with the other jobs.
- **[Backfill restores the wrong fix]** → It restores only when the last
  status event is `resolved` and the ticket is now `closed` with no later
  move back to a live status. Otherwise the ticket stays as it is.
- **[`tickets_raise` signature change]** → The old front end calls it with
  named parameters that the new version still accepts (the new ones have
  defaults). Supabase resolves named arguments, so the old page keeps
  working until the new one deploys.
- **[Settling items from several places]** → All settling for tickets
  happens in the ticket functions and the job, plus the existing trigger.
  The tests check each path: reply out of waiting, Still broken, extend,
  and auto-close.

## Migration Plan

1. One migration, dated after `20261013000100`, inside `begin; … commit;`
   and safe to re-run (`add column if not exists`, `create or replace`, and
   a guarded `cron.schedule`). It:
   - adds the columns and their backfill;
   - restores the fix on closed tickets;
   - redefines and adds the functions;
   - schedules the job.
2. Deploy the front end after it. Until then, the old page keeps working.
   It just doesn't show the new controls.
3. Push with migrations temporarily enabled in `config.toml`, after
   `migration list`.

**Rollback:**

- re-apply the ticket functions from `20260926000900` and
  `20260930000600`;
- re-apply `notifications_on_ticket` from `20261007000100`;
- unschedule the job.

The new columns can stay. Nothing old reads them.

## Open Questions

None blocking. The user decided:

- notify the reporter, and email everything;
- 5 days without an update closes `waiting` and `resolved` tickets;
- both sides can extend, by 5 days, 10 days or a date up to 30 days ahead,
  with an optional reason;
- a closed ticket can be reopened within 14 days, or raised again with a
  link at any time;
- the reference stays the same when the category changes;
- sort modes, with Needs me as the default;
- raising on behalf, with a channel;
- one IT person, so no assignment interface.
