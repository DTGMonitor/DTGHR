# In-app notifications, with email as one way to deliver them

## Why

Email notifications went live on 6 October, once Mail.Send was consented. They
work, but every email is a block of plain paragraphs with a default blue button.
The layout is assembled by string concatenation inside `notifications_enqueue()`
in SQL, and it has already been copied across two migrations. About 18
notification types now go through it: tickets, leave, payroll, finance, KPI,
salary, investigations, and contract and PO reminders. More are coming.

We also want an in-app notification list. Today the email is the only record
that something happened. If we add a bell on top of that, it would either show
email bodies or duplicate the trigger logic. This change makes the notification
itself the record, stores it as structured data, and treats email as one way of
delivering it.

## What Changes

- **New `notifications` table.** One row per recipient per event. Each row
  carries a structured payload (kind, tone, eyebrow, headline, details, note,
  link) plus `read_at` and `resolved_at`. Users can read only their own rows.
- **`notifications_enqueue()` takes a structured payload** instead of free-text
  paragraphs. It always writes the in-app notification, and writes an
  `email_outbox` row only for recipients who still have email turned on.
  **BREAKING** for SQL callers: every trigger and function that calls it moves
  to the new signature in the same migration.
- **Opting out of email no longer silences someone completely.** Turning off
  `users.email_notifications` stops the emails. The person still gets the
  in-app items.
- **Stale approval items are resolved.** Any status change on the source
  record marks its open "waiting for you" items as resolved. That covers a
  leave being approved by someone else, a payroll month being approved,
  a ticket being closed and a leave being cancelled, including final steps
  that notify nobody. The bell shows resolved items as no longer needing
  action.
- **The email layout moves to the `send-notifications` Edge Function.** It
  renders the payload at send time into one Outlook-safe, table-based layout
  in DTG colours: a navy header band, an eyebrow and headline, a details table,
  a quoted note, and a signal-green button. A tone (action, success, danger,
  reminder) sets the accent. There are no images, so Outlook never asks to
  download pictures. The HTML that was sent is still stored on the outbox row.
- **A bell in the header on desktop.** From the `lg` breakpoint up, it shows
  an unread badge that updates live through Supabase Realtime, and a dropdown
  of recent items. Below `lg` there's no bell. Instead the navigation drawer
  gets a "Notifications" entry with the count, and the drawer button shows a
  red dot while anything is unread.
- **A `/notifications` page** with All, Unread and Needs action filters,
  "mark all read", and a link from each item to its area.
- **A needs-action sentence on the dashboard.** It lists open action items that
  the existing live "Awaiting your approval" sentence doesn't already cover:
  tickets and investigations for management, and everything for everyone else.
  The live sentence stays as it is.
- **An email toggle on "My profile"**, so people can switch emails on and off
  themselves.
- **Old notifications are cleaned up.** A daily job deletes notifications that
  are read or resolved and older than 180 days.
- Existing outbox rows are left exactly as they are.

### Non-goals

- Deep links to a single item (`?open=<id>`). Links still go to the area's list
  page.
- Showing who resolved an item ("Approved by …").
- Separate email opt-outs per category, and daily digests.
- Other languages. Payloads hold finished English strings.
- Teams or push delivery.

## Capabilities

### New Capabilities

- `notifications`: the notification record. This covers the payload shape and
  tones, who receives what, excluding the person who made the change, read
  state, resolving stale action items, retention, and row-level access.
- `email-delivery`: turning notifications into emails. This covers the email
  opt-out, the outbox queue and retries, the rendered layout, and Graph
  delivery.
- `notification-inbox`: the in-app experience. This covers the header bell
  (desktop) and the drawer entry with its red dot (mobile), live updates, the
  dropdown, the `/notifications` page and its filters, the dashboard
  needs-action sentence, marking items read, and the email toggle on
  My profile.

### Modified Capabilities

None. There are no baseline specs in `openspec/specs/` yet.

## Impact

- **Database:** one new migration. It adds `notifications`, adds
  `notification_id` to `email_outbox` and makes `body_html`/`body_text`
  nullable, replaces `notifications_enqueue()` and `notifications_recipients()`,
  and redefines every caller: `notifications_on_ticket`, `_on_payroll`,
  `_on_finance`, `_on_leave`, `_on_kpi`, `_on_salary`; the investigations
  submit, send-back and dispute paths; and `contracts_send_renewal_notices`. It
  attaches a status-change resolve trigger to the seven source tables, and
  also adds RPCs for marking items read, the email preference, a Realtime
  publication and a cron job for retention, the last two guarded so they're
  skipped where the extension doesn't exist.
- **Edge Function:** `supabase/functions/send-notifications` gets a renderer and
  reads payloads through the notification.
- **Frontend:** a bell and the drawer-toggle dot in `Header.tsx`, a drawer entry
  in `Sidebar.tsx`, a new `/notifications` route and page, the needs-action
  sentence in `DashboardPage.tsx`, a notifications provider with a Realtime
  subscription, and the toggle on My profile.
- **Tests:** `supabase/test/areas/notifications.test.mjs` is extended to cover
  in-app rows, the email opt-out split, resolution and RLS.
- **Operations:** redeploy `send-notifications` after the migration is applied.
  No new secrets are needed.
