# IT tickets: closing the loop with the reporter

## Why

The ticketing system only talks in one direction. When a ticket is raised,
IT gets a notification. After that, the person who raised it hears nothing:
not when IT replies, not when the ticket is set to "Waiting on you", and not
when it is resolved. They only find out by opening `/support` again.
Tickets also never finish on their own. A resolved ticket stays resolved
forever, and a ticket waiting on a reporter who went quiet sits in the queue
indefinitely.

Bintang is the only IT support person, and the company is trying to move
staff off WhatsApp and onto the platform. That only works if the platform
keeps people informed. Requests that still arrive by chat should land in the
same record, so the move can be measured.

## What Changes

- **The reporter is notified** when IT replies publicly, sets the ticket to
  waiting, resolves it, or closes it, when IT logs a ticket on their behalf,
  the day before an auto-close, and when the auto-close happens.
  Internal notes never notify the reporter.
- **IT is notified** when the reporter replies, and when the reporter
  reopens a ticket.
- **A reporter's reply to a waiting ticket moves it back to in progress.**
- **A resolved ticket asks the reporter to confirm.** "Confirm" closes it.
  "Still broken" reopens it with a reason.
- **Auto-close.** A waiting or resolved ticket closes automatically after
  5 days with no update. Any public reply restarts the 5 days. The reporter
  gets a reminder the day before. Either the reporter or IT can extend the
  deadline by 5 days, by 10 days, or to a chosen date up to 30 days ahead,
  with an optional reason. Open and in-progress tickets never auto-close.
- **Reopen or raise it again.**
  - The reporter can reopen a closed ticket within 14 days of it closing.
  - At any time, they can raise a new ticket linked to the old one.
  - IT can link or unlink a ticket to an earlier one.
  - Both tickets show the link.
  - The history counts recurrences.
- **IT can change a ticket's priority and category.** The reference stays
  the same, and the change is recorded in the trail.
- **The queue has sort modes:** Needs me (the default), Priority, Oldest,
  Newest, and Recently updated.
- **IT can raise a ticket on someone's behalf** and record how it arrived:
  WhatsApp, in person, phone or email. Tickets raised by staff themselves
  are recorded as portal. The history shows the portal share month by month.
- **Fix: closing a resolved ticket keeps its fix.**
  - **BREAKING (data semantics):** today, moving a ticket from resolved to
    closed clears `resolution` and `resolved_at`, and the resolver stats
    look only at tickets whose status is `resolved`.
  - After this change, a ticket counts as *fixed* when it has a
    `resolved_at`, whatever its current status.
  - Existing closed tickets get their fix back from the trail.

### Non-goals

- Attachments or screenshots.
- An assignment interface. There is one IT person, and `tickets_assign`
  stays as it is.
- Service-level targets or escalation.
- Using tickets for anything other than IT.
- Choosing which notification kinds send email. Every ticket notification
  emails anyone who has email turned on, as all other notifications do.

## Capabilities

### New Capabilities

- `it-support-tickets`: the ticket lifecycle as it involves the reporter
  (reply hand-back, confirm or still broken, auto-close and extensions,
  reopen within 14 days, linked recurrences), triage edits, raising on
  someone's behalf with a channel, the queue's sort fields, and what the
  history counts as fixed.

### Modified Capabilities

- `notifications`:
  - Stale ticket action items are now settled per kind and per side, so a
    reporter's item and IT's item for the same ticket clear independently.
  - New requirement: ticket events notify both the reporter and IT.

## Impact

- **Database:** one migration, dated after `20261013000100`.
  - New columns on `support_tickets`: `channel`, `related_ticket_id`,
    `closed_at`, `auto_close_at`, `auto_close_reminded_at`.
  - Backfill `closed_at`, and restore `resolution` and `resolved_at` on
    closed tickets from the trail.
  - Redefined: `tickets_raise` (new signature), `tickets_comment`,
    `tickets_set_status`, `tickets_serialise`, `tickets_resolver` and
    `tickets_history`.
  - New functions: `tickets_triage`, `tickets_reopen`, `tickets_extend`,
    `tickets_link`, `tickets_auto_close_run` (scheduled hourly where
    `pg_cron` exists), and `notifications_resolve_kinds`.
- **Front end:**
  - [TicketsPage.tsx](../../../src/pages/TicketsPage.tsx):
    - a sort menu;
    - an auto-close chip with an extend dialog;
    - Confirm / Still broken / Reopen / Raise it again;
    - triage controls and an on-behalf section in the form;
    - link display;
    - the channel and recurrence panels in the history.
  - [ticketService.ts](../../../src/services/ticketService.ts) and
    [routes/tickets.ts](../../../src/lib/routes/tickets.ts) gain the new
    calls.
- **Tests:** `supabase/test/areas/tickets.test.mjs` and
  `notifications.test.mjs` gain steps for each behaviour above.
- **People:**
  - Tell staff that they will now get ticket updates by notification and
    email, and that waiting and resolved tickets close after 5 quiet days.
  - Bintang starts logging WhatsApp requests on staff's behalf.
