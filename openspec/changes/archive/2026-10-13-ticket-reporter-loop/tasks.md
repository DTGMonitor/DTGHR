# Tasks

Phase 1 (groups 1–5) is the reporter loop and can ship on its own. Phase 2
(groups 6–8) is triage, on-behalf, sorting and the history panels.

## 1. Migration: data

- [x] 1.1 New migration dated after `20261013000100`, in a single `begin; … commit;`, safe to re-run
- [x] 1.2 Add to `support_tickets`: `channel` (default `portal`, with a check constraint), `related_ticket_id` (FK, on delete set null), `closed_at`, `auto_close_at`, `auto_close_reminded_at`. Add an index on `auto_close_at` where it is not null, and an index on `related_ticket_id`
- [x] 1.3 Backfill `closed_at` from the last event with `to_status = 'closed'`, falling back to `updated_at`
- [x] 1.4 Restore `resolution` and `resolved_at` on closed tickets from their last `resolved` event, only when no later event moved them to a live status
- [x] 1.5 Set `auto_close_at = now() + 5 days` on tickets already `waiting` or `resolved`

## 2. Migration: the fix is kept, and the clock

- [x] 2.1 `tickets_resolver`: answer when `resolved_at is not null`, not when `status = 'resolved'`
- [x] 2.2 `tickets_set_status` (from `20260930000600`):
  - resolved → closed keeps the fix;
  - every move to `closed` sets `closed_at`;
  - leaving `closed` clears it;
  - the reporter may also close from `resolved` (confirm);
  - set or clear the auto-close fields when entering or leaving `waiting` or `resolved`
- [x] 2.3 `tickets_comment`:
  - set `updated_at`;
  - a public event on a `waiting` or `resolved` ticket moves the deadline to `greatest(auto_close_at, now() + 5 days)` and clears `auto_close_reminded_at`;
  - a reporter reply on `waiting` also writes the status event to `in_progress` and clears the auto-close fields
- [x] 2.4 `tickets_reopen(id, reason)`:
  - reporter: from `resolved`, or from `closed` within 14 days of `closed_at`;
  - reason required;
  - clears the fix, `closed_at` and the auto-close fields;
  - writes a `reopened` event
- [x] 2.5 `tickets_extend(id, until, reason)`:
  - reporter or anyone who works the queue;
  - status must be `waiting` or `resolved`;
  - `until` must be later than the current deadline and no more than `now() + 30 days`;
  - writes an `extended` event;
  - clears `auto_close_reminded_at`
- [x] 2.6 `tickets_auto_close_run()`: send the reminder pass, then the close pass, with a `begin … exception` block per ticket. Closing events have `actor_id` null and `actor_name` "Automatic". Use the waiting or resolved wording from the design
- [x] 2.7 Schedule `tickets_auto_close_run` hourly, guarded on `pg_cron` the way the existing jobs are
- [x] 2.8 `tickets_history`: per category, `resolved` counts tickets with a `resolved_at`, and `closed` counts closed tickets without one. Resolver stats include closed tickets that were fixed

## 3. Migration: notifications

- [x] 3.1 `notifications_resolve_kinds(table, id, kinds[], status)`, alongside `notifications_resolve`. Revoke it from `public`, `anon` and `authenticated`
- [x] 3.2 Settle the reporter's items by kind where the design says: leaving `waiting`, leaving `resolved` for a live status, and when a reply or extension moves the clock
- [x] 3.3 Write the reporter kinds from the ticket functions: `ticket_replied`, `ticket_waiting` (with the note), `ticket_resolved` (with the fix), and `ticket_closed`. Wrap each in its own exception block
- [x] 3.4 Write the IT kinds: `ticket_reporter_replied`, `ticket_reopened`, and `ticket_closed_by_reporter`
- [x] 3.5 Write `ticket_closing_soon` and `ticket_auto_closed` from the auto-close run
- [x] 3.6 Grant `execute` on the new client functions (`tickets_reopen`, `tickets_extend`) to `authenticated`. Revoke the job and the helpers from clients

## 4. Tests (phase 1)

- [x] 4.1 Fix kept: resolve → confirm keeps the resolution, `resolved_at` and resolver. Reopening clears them. The backfill restores a cleared fix
- [x] 4.2 Reply hand-back: a reporter reply on `waiting` gives `in_progress` plus two events. An IT reply leaves it `waiting`
- [x] 4.3 Confirm and Still broken, including a blank reason refused, and a stranger refused as not found
- [x] 4.4 Auto-close:
  - set on entry;
  - a public event restarts it;
  - an internal note does not;
  - the reminder is sent once;
  - closing from waiting and from resolved;
  - `in_progress` is untouched;
  - existing tickets get a fresh 5 days (call `tickets_auto_close_run()` directly and move the clocks back by updating `auto_close_at`)
- [x] 4.5 Extend: +10 days is accepted; more than 30 days, shortening, and the wrong status are each refused
- [x] 4.6 Reopen a closed ticket at 6 days (works) and at 20 days (refused). IT can reopen at any age
- [x] 4.7 Notifications:
  - each kind goes to the right side;
  - an internal note and `in_progress` notify nobody;
  - a reply out of `waiting` settles `ticket_waiting` and leaves `ticket_raised` open;
  - an extension settles `ticket_closing_soon`;
  - the actor is excluded
- [x] 4.8 Run the full suite (`npm run test:db`), and note any existing expectation that changed (for example, closing from resolved used to clear the resolution)

## 5. Front end (phase 1)

- [x] 5.1 `ticketService` and `routes/tickets.ts`: `reopen`, `extend`. The `Ticket` type gains `channel`, `closed_at`, `auto_close_at`, `related`, `recurrences`, `last_public_actor` and `last_public_at`
- [x] 5.2 Auto-close chip ("Closes in 3 days") with an Extend dialog: +5 days, +10 days, or a date (capped at 30 days), plus an optional reason
- [x] 5.3 Reporter on a resolved ticket: Confirm (optional note) and Still broken (reason required)
- [x] 5.4 Reporter on a closed ticket: Reopen while within 14 days, and Raise it again (opens the form prefilled and linked) at any time
- [x] 5.5 "Wait on reporter" asks IT for the question, as the note that goes to the reporter
- [x] 5.6 The trail shows `reopened`, `extended` and "Automatic" events. The ticket shows its related ticket and the tickets that name it
- [x] 5.7 `npm run build` passes

## 6. Migration: phase 2

- [x] 6.1 `tickets_raise`:
  - drop the 5-argument version, and create it with `p_reporter_id`, `p_channel` and `p_related_ticket_id` (all with defaults);
  - on-behalf rules and channel rules;
  - link rules (own ticket for a reporter, older ticket always);
  - the raised event body for on-behalf tickets
- [x] 6.2 `tickets_raise`: write `ticket_logged_for_you` to the reporter when the reporter is not the actor (`notifications_on_ticket` is left unchanged; see the design)
- [x] 6.3 `tickets_triage(id, priority, category)`: IT only. Refuse when nothing changes. Write one `triaged` event. The reference doesn't change
- [x] 6.4 `tickets_link(id, related_id)`: IT only. `null` unlinks. The related ticket must be older and not the same ticket. Write an event
- [x] 6.5 `tickets_serialise`:
  - `channel`, `related` and `recurrences`, with the reference-and-status-only rule for viewers who don't work the queue;
  - `last_public_actor` and `last_public_at`
- [x] 6.6 `tickets_history`: `channels` by month for the last 6 months, and `recurrences` in each category row
- [x] 6.7 Grants for `tickets_raise` (new signature), `tickets_triage` and `tickets_link`

## 7. Tests (phase 2)

- [x] 7.1 On behalf: IT logs for Ana from WhatsApp, and the trail and channel are correct. Staff naming a colleague are refused. `portal` together with another reporter is refused
- [x] 7.2 Linking: Raise it again links the new ticket. A reporter linking a colleague's ticket is refused. A newer ticket, or the same ticket, is refused. A non-IT viewer sees only reference and status
- [x] 7.3 Triage: the event text is right, the reference is unchanged, a change of nothing is refused, and the reporter is refused
- [x] 7.4 `last_public_actor` ignores internal notes. The history `channels` and `recurrences` counts are right
- [x] 7.5 `npm run test:db` passes

## 8. Front end (phase 2)

- [x] 8.1 Sort menu: Needs me, Priority, Oldest, Newest, Recently updated. Keep it in `?sort=`. The default is Needs me for IT and Newest for reporters
- [x] 8.2 The form for IT: "Raising for someone else" with a person picker and a channel
- [x] 8.3 Triage controls on an open ticket for IT (priority and category), and a link/unlink control
- [x] 8.4 History: a portal-share panel by month, and recurrences in the category insights
- [x] 8.5 `npm run build` passes

## 9. Ship

- [x] 9.1 Push the migration with migrations temporarily enabled in `config.toml`, after `migration list`. Then merge, so the front end deploys
- [x] 9.2 On live: raise a test ticket from a staff account, set it to waiting from IT, and check the reporter's notification and email. Reply as the reporter, and check that the ticket is in progress and IT is notified. Resolve it and confirm it, and check that the fix is still shown in the history
- [x] 9.3 Check that the hourly job is scheduled (`cron.job`)
- [x] 9.4 Tell staff: they will now get ticket updates by notification and email, waiting and resolved tickets close after 5 quiet days (and can be extended), and WhatsApp requests will be logged on their behalf
