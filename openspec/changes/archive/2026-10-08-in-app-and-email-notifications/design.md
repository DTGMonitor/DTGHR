# Design: in-app notifications, with email as one way to deliver them

## Context

`supabase/migrations/20260926001300_notifications.sql` introduced email
notifications. Triggers and functions in each area call
`notifications_enqueue(user_ids, exclude, kind, subject, paragraphs[],
link_path, link_label, source_table, source_id)`. It filters recipients
(including the `email_notifications` opt-out), builds HTML and text by string
concatenation, and inserts `email_outbox` rows. pg_cron calls the
`send-notifications` Edge Function every minute. The function claims up to 25
rows, gets a client-credentials token, and posts each row's stored `body_html`
to Graph `sendMail` as `no-reply@dtgeotech.com`. Delivery has worked since
6 October.

These are the callers today. Each has to move to the new signature:

| Caller (latest definition) | Kinds |
|---|---|
| `notifications_on_ticket` (20260926001300) | `ticket_raised` |
| `notifications_on_payroll` (20260926001300) | `payroll_submitted`, `payroll_endorsed`, `payroll_returned`, `payroll_changes_requested` |
| `notifications_on_finance` (20260926001300) | `finance_submitted`, `finance_sent_back`, `finance_sent_back_director` |
| `notifications_on_leave` (20260926001300) | `leave_submitted`, `leave_approved`, `leave_rejected` |
| `notifications_on_kpi` (20260926001300) | `kpi_submitted` |
| `notifications_on_salary` (20260926001300) | `salary_submitted` |
| investigations (20260928001400 / 001500) | `investigation_disputed`, `investigation_review`, `investigation_sent_back` |
| `contracts_send_renewal_notices` (20260930000200) | `contract_renewal`, `po_ending` |

The live database tests run on PGlite (`npm run test:db`). PGlite has no
`pg_cron`, `pg_net` or Realtime publication, so anything that depends on them is
already guarded with `if exists (select 1 from pg_available_extensions …)`.

The frontend is React with Vite and Tailwind, uses the DTG tokens in
`tailwind.config.js`, and talks to Supabase directly through `src/lib/supabase.ts`.
`Header.tsx` has a right-hand cluster where the bell goes. Of the area pages,
only `/employees/:employeeId` takes an id in its route.

## Goals / Non-Goals

**Goals:**
- One structured record per notification that both the bell and email read.
- Adding a new notification type means one `enqueue` call with a payload,
  with no template work.
- Emails that look like DTG People and render well in desktop Outlook.
- Approval items that stop saying "waiting for you" once they're handled.

**Non-Goals:** links to a single item, showing who handled an item, email
opt-outs per category, digests, other languages, Teams or push. See the
proposal.

## Decisions

### 1. `notifications` is the record, `email_outbox` is the email queue

```
 trigger ─▶ notifications_enqueue(recipients, exclude, kind, source, payload)
               │
               ├─▶ INSERT notifications           (every eligible recipient)
               └─▶ INSERT email_outbox            (the subset with email on)
                       notification_id, to_email, to_name, subject, kind
                                  │
              pg_cron ─▶ send-notifications ─▶ join payload ─▶ render ─▶ Graph
                                                    └─▶ store body_html/text

 status change on a source table ─▶ notifications_resolve_on_status()
                                     resolves its open action items (decision 4)
```

The `notifications` table has these columns: `id uuid pk`, `user_id uuid → users`,
`kind varchar(40)`, `source_table varchar(64)`, `source_id uuid`, `payload jsonb`,
`created_at`, `read_at`, `resolved_at`. It has two indexes:
`(user_id, created_at desc)` and a partial `(source_table, source_id) where
resolved_at is null`.

On `email_outbox`, `notification_id` is added as a nullable FK with `on delete
set null`, so retention never breaks the email log. `body_html` and `body_text`
become nullable. New rows leave them empty until the email is sent. Legacy rows
keep theirs. `subject` stays on the outbox row because Outlook threads by
subject and we want it fixed at queue time.

*Alternative considered:* a single table with email status columns. That's
simpler, but it mixes per-person inbox state with delivery retries, and it
would mean migrating the existing outbox history. Two tables keep the old log
untouched.

### 2. Payload holds finished strings

```json
{
  "tone": "action",
  "eyebrow": "Leave request",
  "headline": "Bintang Dwitama has requested sick leave",
  "intro": "This is waiting for your approval.",
  "details": [["Type", "Sick leave"], ["Dates", "29 September 2026"], ["Days", "1"]],
  "note": { "by": "Bintang Dwitama", "text": "Fever since last night" },
  "link": { "label": "Review the request", "path": "/leaves" }
}
```

The triggers already put together these strings today, so this is
reorganising, not new logic. The React and Deno renderers only do layout and
share no wording. *Alternative considered:* message keys with parameters,
rendered on the client. That's only worth it for bilingual support, which is a
non-goal. If it ever comes, a migration can add `key`/`params` next to the
strings.

A SQL helper `notifications_payload(tone, eyebrow, headline, intro, details
text[][], note_text, note_by, link_path, link_label) returns jsonb` builds the
object. It drops empty parts so callers never assemble JSON by hand. It's
validated with a `check` on `tone`.

### 3. New `notifications_enqueue` signature, old one dropped

```
notifications_enqueue(p_user_ids uuid[], p_exclude uuid[], p_kind text,
                      p_subject text, p_payload jsonb,
                      p_source_table text, p_source_id uuid) returns int
```

Every caller is redefined in the same migration, and the old 9-argument
overload is dropped, so a missed caller fails loudly in `test:db` instead of
quietly writing nothing. `notifications_recipients` loses the
`email_notifications` filter and returns that flag as a column, so `enqueue`
can decide on email per row.

### 4. Resolving stale items: any status change resolves

The first draft resolved earlier items only when a *new notification* was
written for the same source. Checking the triggers showed that many final steps
notify nobody: the executive approving payroll, the executive endorsing a
finance request, KPI and salary approval, and investigation approval. Under
that rule, those "waiting for you" items would stay open forever.

The rule is now: **any status change on a source resolves its open action
items.** It's one generic trigger function, `notifications_resolve_on_status()`,
attached as `trg_notifications_resolve` to `leave_requests`, `payroll_months`,
`finance_requests`, `kpi_reviews`, `salary_reviews` and `investigations` with
`when (old.status is distinct from new.status)`; to `support_tickets` only
when the new status leaves `open`/`in_progress`/`waiting` (a ticket being
worked is still IT's to do); and to `investigation_outcomes` on
`response_status`, so an engineer's "respond to this decision" item settles
when they respond. `investigations_notify_subject` also settles the earlier
item explicitly before writing a revised one. It uses `TG_TABLE_NAME` as
`source_table` and `new.id` as `source_id`:

```sql
update notifications set resolved_at = now()
 where source_table = TG_TABLE_NAME and source_id = new.id
   and resolved_at is null and payload->>'tone' = 'action'
   and created_at < now();   -- never items written in this same transaction
```

The `created_at < now()` guard is the important part. `now()` is the start time
of the transaction, and items written for the *new* status in the same
transaction get exactly that timestamp. So the result doesn't depend on whether
an area's notify trigger, or an investigations RPC that calls `enqueue`
directly, runs before or after the resolve trigger. The rule needs no
per-area code, covers cancellation and closing with no extra work, and keeps
working when a new status is added.

`enqueue` doesn't resolve anything itself. A send-back followed by a
resubmission works out correctly: the send-back resolves the director's item,
and the resubmission writes a fresh one.

*Alternatives considered:* (a) resolve inside `enqueue`, which was the first
draft and misses transitions that notify nobody; (b) ask each area "is this
still pending?" at read time, which is exact, but every list query would join
into every area's tables.

### 5. Rendering in the Edge Function, as one layout

`supabase/functions/send-notifications/render.ts` exports `renderEmail(payload,
recipientName, siteUrl) → { html, text }`. The layout uses nested
`<table role="presentation">` elements with inline styles only, 600px wide,
and a VML-free "bulletproof" button (padding on a `<td>` with a background
colour, so desktop Outlook still shows a block). The header band uses
`#0B1A22` with "DTG People" as text in `#F4F8F9`. The tone accent is a 4px top
border on the content card plus the eyebrow colour: `action`/`success` use
`#63B75D`, `danger` uses `#A63A2B`, `reminder` uses `#D6A73A`. Body text is
`#10202A` on white, because the email body reads better light even though the
app is dark. All values are escaped. Plain text is rendered too and stored.
Graph only takes one body, so the text version is kept for the log and isn't
sent.

The site URL is read once per run from `app_settings.public_site_url` (the same
source the SQL used) through the service client.

*Alternative considered:* rendering in SQL as today. That was rejected because
every design change would need a migration, and SQL concatenation can't be
tested by rendering a sample.

### 6. The browser reads the table directly, writes through RPCs

- `select` policy on `notifications`: `user_id = auth.uid()`. No insert, update
  or delete grants for `authenticated`.
- `notifications_mark_read(p_ids uuid[])` and `notifications_mark_all_read()`
  are `security definer` and only touch the caller's rows where `read_at is
  null`.
- `notifications_set_email(p_enabled boolean)` and the read of the flag work on
  `users` where `id = auth.uid()`, and change that column only.
- Unread count: `select count(*) … where read_at is null` with `head: true`.

### 7. Realtime for the badge

The migration adds `notifications` to the `supabase_realtime` publication,
guarded so it's skipped where the publication doesn't exist (PGlite). The
client opens one channel per session from a `NotificationsProvider` in
`Layout`, with `postgres_changes` on `public.notifications` filtered by
`user_id=eq.<id>`, for INSERT and UPDATE. Realtime applies RLS to
`postgres_changes`, and the filter keeps traffic down. On any event the
provider refetches the count and the first page. It doesn't patch rows in
place, which is simpler and correct after reconnects. As a fallback it polls
every 60 seconds while the tab is visible, in case Realtime is down.

### 8. Frontend structure

```
Layout
 └─ NotificationsProvider      count, recent[], markRead, markAllRead, refresh
     ├─ Header
     │   ├─ drawer toggle      red dot when count > 0            (< lg only)
     │   └─ NotificationBell   button + badge + popover (10)     (≥ lg only)
     ├─ Sidebar (drawer)       "Notifications" entry + badge     (< lg only)
     ├─ /notifications         NotificationsPage (All | Unread | Needs action, paged by 20)
     └─ DashboardPage          needs-action sentence
 NotificationItem              shared row: accent, eyebrow, headline, time, muted if resolved
 EmployeeProfilePage (own)     "Email me about notifications" switch
```

```
 ≥ lg (desktop)                         < lg (phone / tablet)
 ┌────────────────────────────────┐     ┌──────────────────────┐
 │ DTG People          🔔3  (BD) │     │ ☰•  DTG People  (BD)│
 ├────────┬───────────────────────┤     └──────────────────────┘
 │Sidebar │  popover from bell    │     drawer: 🔔 Notifications 3
 └────────┴───────────────────────┘             → /notifications
```

There's one place to find notifications at each width. The bell and the
drawer entry are never shown together, so desktop never shows two badges with
the same number. The drawer entry goes to the page rather than listing items
inside the drawer, because the drawer is for navigation and 280px is too
narrow for a list. The dot on the drawer toggle uses `danger` (`#E08373`),
ringed in the header background (`bg-deep`) so it stays visible on top of the
icon. It has no number. The toggle's `aria-label` carries the count.

Relative times use `Intl.RelativeTimeFormat`, so no new dependency is needed.
The popover is a button-triggered panel with `aria-expanded` and focus that
returns to the bell. Escape and outside clicks close it.

### 8b. The dashboard summary sits next to the live sentence, not in its place

[DashboardPage.tsx](../../../src/pages/DashboardPage.tsx) already writes
"Awaiting your approval: Lintang's annual leave (5–7 Oct), the October
payroll from Him, …" for management. It's built live from each area's queue.
It stays as it is, because it's exact and names items, and Nurhuda asked for
it in that form. It also reflects that anyone in management *can* approve
leave, while only the named approver is *notified*.

The new sentence comes from `notifications_open_actions(p_exclude_kinds
text[])`, which returns unresolved `action` items, read or not.

Building it showed the band says more than the approvals sentence: for
everybody it already says IT's open tickets ("3 IT tickets need looking at")
and the investigation reviews and responses waiting on you, by reference. So
those kinds (`ticket_raised`, `investigation_review`, `investigation_issued`,
`investigation_revised`) are excluded for everyone, and for management the
approval kinds as well (`leave_submitted`, `payroll_submitted`,
`payroll_endorsed`, `salary_submitted`, `kpi_submitted`, `finance_submitted`,
`finance_sent_back_director`). What is left today is chiefly a named manager
outside management with leave to approve -- and any kind added later until
the band learns to say it. It names up to three headlines, counts the rest,
links to `/notifications?filter=action`, and isn't shown when empty.

*Alternative considered:* replacing the live sentence with the notification
summary for everyone. That's more consistent, but it would drop the "anyone in
management can approve" view, and the list would only be as accurate as
resolution is.

### 9. Retention

pg_cron runs a daily job at 02:00 UTC that deletes notifications where
`created_at < now() - interval '180 days'` and (`read_at` or `resolved_at` is
set). It's guarded like the existing job.

## Risks / Trade-offs

- **[A caller left on the old signature]** → Drop the old overload, so
  `test:db` fails, and the test suite covers one transition per area.
- **[A status change that doesn't end the action resolves it anyway]** For
  example, a status that only marks an item as "seen". → Today every status
  change on these tables moves the item to someone else or ends it. If a
  status is added that doesn't, the trigger's `when` clause excludes it. This
  is written down in the trigger function's header comment.
- **[A new source table is added without the resolve trigger]** → Its action
  items would never resolve. The `enqueue` header comment and the test suite
  list the tables. A test fails if any `source_table` written by `enqueue`
  lacks the trigger.
- **[The live sentence and the summary disagree]** → They can't overlap,
  because management's summary leaves out the kinds the live sentence covers.
- **[Realtime not enabled or rate-limited on the project]** → The 60-second
  poll fallback means the badge is at most a minute late.
- **[Outlook rendering surprises]** → Before deploying, send one test of each
  tone to a desktop Outlook mailbox. The layout uses only tables and inline
  styles.
- **[Rendering fails for a bad payload]** → The renderer treats every optional
  key as optional. A throw marks only that row failed, with the error, and is
  retried like a Graph failure.
- **[Stuck rows during the deploy window]** If the migration lands before the
  function deploys, the old function sends new rows with null `body_html`. →
  Deploy the function first. The new function handles both legacy rows and
  `notification_id` rows, so it's safe before the migration.

## Migration Plan

1. Deploy `send-notifications` with the renderer. It sends legacy rows as
   before.
2. Apply the migration. It creates the table, RPCs, publication and cron job,
   and redefines `enqueue` and its callers.
3. Deploy the frontend: bell, page and profile toggle.
4. Smoke test: submit a leave request in production between two test
   accounts. Check the bell updates live, the email arrives in the new layout,
   and approving resolves the approver's item.

Rollback: revert the frontend. The function stays compatible with both row
shapes. If the migration has to go, a follow-up migration restores the
previous `notifications_enqueue` and callers from `20260928001000` and the
other migrations listed above. `notifications` can stay, because nothing reads
it once the frontend is reverted.

## Open Questions

- Sent-back items (`payroll_returned`, `finance_sent_back`,
  `investigation_sent_back`) use the `danger` tone, so they don't count as
  "Needs action" even though the recipient has to fix something. If people
  expect to see them there, the filter could become `tone = 'action' or kind
  like '%sent_back%' or kind = 'payroll_returned'`, at the cost of a less
  uniform rule.

Resolved on 7 October: below `lg`, notifications live in the drawer, with a red
dot on the toggle (decision 8). The dashboard summary is in scope, next to the
live sentence (decision 8b).
