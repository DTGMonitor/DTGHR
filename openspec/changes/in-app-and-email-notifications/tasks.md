# Tasks

The order follows the deploy order in design.md. The Edge Function comes first
because it works with both row shapes. The migration is next and has to pass
`npm run test:db` before it goes near live. The frontend comes last.

## 1. Edge Function: renderer that accepts both row shapes

- [x] 1.1 Add `supabase/functions/send-notifications/render.ts` with `renderEmail(payload, recipientName, siteUrl) → { html, text }`: table-based 600px layout, navy header band with "DTG People" as text, tone accent (green, danger red, gold), eyebrow, headline, greeting, intro, a two-column details table, the quoted note with its author, a button built on a `<td>`, the plain address below it, and the footer. Escape every value and skip missing optional keys
- [x] 1.2 Change the claim path so rows with `notification_id` get their payload (join `notifications`) and the run reads `app_settings.public_site_url` once. Render, send, then store `body_html`/`body_text` on the row. Rows without `notification_id` keep sending their stored `body_html`
- [x] 1.3 A render error marks only that row failed, with the message, and it's retried like a Graph error
- [x] 1.4 Add a small Deno script (not deployed) that renders one sample per tone to HTML files so they can be checked in a browser. Update the function's header comment to describe the new flow
- [ ] 1.5 Deploy `send-notifications --no-verify-jwt`. Check that a legacy-style test row still sends

## 2. Migration: the notifications table and the new enqueue

- [x] 2.1 New migration: `notifications` table, indexes, RLS on with a select-own policy, no write grants for `anon`/`authenticated`
- [x] 2.2 `email_outbox`: add `notification_id` (FK, `on delete set null`). Make `body_html` and `body_text` nullable
- [x] 2.3 `notifications_payload(...)` helper that builds the jsonb, drops empty parts and checks `tone`
- [x] 2.4 `notifications_recipients` returns `email_notifications` as a column and stops filtering on it
- [x] 2.5 New `notifications_enqueue(user_ids, exclude, kind, subject, payload, source_table, source_id)`: insert one notification per eligible recipient and an outbox row for those with email on. It resolves nothing itself. Drop the old 9-argument overload. List the source tables that need the resolve trigger in its header comment
- [x] 2.6 `notifications_resolve_on_status()` trigger function (uses `TG_TABLE_NAME`, `new.id`, and `created_at < now()` so it never touches items from the same transaction). Attach it `after update of status when (old.status is distinct from new.status)` to `support_tickets`, `leave_requests`, `payroll_months`, `finance_requests`, `kpi_reviews`, `salary_reviews` and `investigations`
- [x] 2.7 Redefine `notifications_on_ticket` to build a payload (tone `action`, the ticket description as the note). Its trigger stays insert-only, because closing a ticket is handled by the resolve trigger from 2.6
- [x] 2.8 Redefine `notifications_on_leave`: submitted is `action`, approved is `success`, rejected is `danger` with the reviewer note
- [x] 2.9 Redefine `notifications_on_payroll` and `notifications_on_finance`: submitted and endorsed are `action`, sent back and returned are `danger` with the note
- [x] 2.10 Redefine `notifications_on_kpi` and `notifications_on_salary` (`action`)
- [x] 2.11 Redefine the investigations callers (`investigation_review` is `action`, `investigation_sent_back` and `investigation_disputed` are `danger`), carrying over every other line of the latest definitions unchanged
- [x] 2.12 Redefine `contracts_send_renewal_notices` from its 20260930000200 definition (`contract_renewal` and `po_ending` are `reminder`)
- [x] 2.13 RPCs: `notifications_mark_read(uuid[])`, `notifications_mark_all_read()`, `notifications_open_actions(p_exclude_kinds text[])`, `notifications_get_email()`, `notifications_set_email(boolean)`. Grant execute to `authenticated` only
- [x] 2.14 Guarded blocks: add `notifications` to `supabase_realtime`. Schedule the daily 180-day retention job in pg_cron

## 3. Database tests

- [x] 3.1 Extend `supabase/test/areas/notifications.test.mjs`: one transition per area writes the expected `notifications` rows and payload tone
- [x] 3.2 Opted-out recipient: notification written, no outbox row. Opted-in: one outbox row with `notification_id`
- [x] 3.3 Actor excluded. Inactive employee excluded
- [x] 3.4 Resolution: approving leave resolves the approver's item. The executive approving payroll (no notification) resolves their `payroll_endorsed` item. KPI approval resolves `kpi_submitted`. Closing a ticket and cancelling leave resolve theirs. Send-back then resubmit leaves exactly one open item. `success` items stay unresolved
- [x] 3.4b Every `source_table` written by `notifications_enqueue` for `action` kinds has the resolve trigger attached (query `pg_trigger`)
- [x] 3.4c `notifications_open_actions` returns read-but-unresolved items, honours excluded kinds, and returns only the caller's rows
- [x] 3.5 RLS: a user selects only their own rows, can't update `payload`, and mark-read ignores other users' ids
- [x] 3.6 Retention query deletes old read or resolved rows and keeps old unread action rows
- [x] 3.7 `npm run test:db` passes

## 3b. Local verification (Docker, a copy of production)

A local Supabase stack loaded with production's schema and data, so the
migration is applied to production's real state and the UI, Realtime and the
Edge Function are exercised before anything is deployed. Every email address
is redirected to Bintang's mailbox first, so no colleague is emailed. The dumps
hold HR data: keep them in the scratchpad, never in the repo, and delete them
with the containers at the end.

- [x] 3b.1 `npx supabase init`; in `supabase/config.toml` set `[db.migrations] enabled = false` and `[db.seed] enabled = false` (the repo's migrations start from the Alembic baseline and cannot replay on a fresh stack); `npx supabase start`
- [x] 3b.2 Dump production through the Session pooler connection string (the direct host is IPv6-only): schema of `public`, and data of `auth` and `public`, to files outside the repo
- [x] 3b.3 Load both into the local database (`docker exec -i supabase_db_DTGHR psql -U postgres`), and record whether anything fails to load
- [x] 3b.4 Scrub, so every email lands in bintang.dwitama@dtgeotech.com only: `public.users.email` → `bintang.dwitama+<localpart>@dtgeotech.com` for everyone else (plus-addressing; `users.email` is unique, so they cannot all be the bare address). Check plus-addressing with one test send first; if it bounces, instead turn `email_notifications` off for everyone but Bintang; empty `email_outbox`; `app_settings.public_site_url` → `http://localhost:5173`; set a local password on Bintang's and one other test account in `auth.users`
- [x] 3b.5 Apply `20261007000100_in_app_notifications.sql` to the local copy; it must apply cleanly on production's real schema
- [x] 3b.6 `.env.development.local` with the local URL and anon key (`npx supabase status`); `npm run dev`
- [x] 3b.7 `npx supabase functions serve send-notifications --no-verify-jwt --env-file <scratch>/functions.env` with the MS secrets (a new client secret made for this, with the shortest expiry, kept only in the scratchpad file, and deleted in Entra at 3b.9); trigger it with curl and the local service-role key
- [x] 3b.8 Walk through: two browsers, two accounts. Submit leave → approver's bell updates live → approve → approver's item shows "No action needed", requester gets a success item. Drawer dot and entry at 390px. `/notifications` filters. Dashboard sentence for a non-management manager. Email toggle off → in-app only. One email of each tone opened in Outlook desktop and on the web
- [ ] 3b.9 Clean up: `npx supabase stop --no-backup`, delete the dumps, the connection-string file, `functions.env` and `.env.development.local`; delete the test client secret in Entra

## 4. Apply to live

- [ ] 4.1 Back up, then apply the migration in the SQL editor
- [ ] 4.2 Check that `cron.job` has the retention job and that `notifications` is in the realtime publication
- [ ] 4.3 Send one notification of each tone to a desktop Outlook mailbox and to Outlook on the web, and check the layout

## 5. Frontend: provider and data

- [x] 5.1 `src/lib/notifications.ts`: types for the payload, then fetch page, unread count, mark read, mark all read, get and set email
- [x] 5.2 `NotificationsProvider` in `Layout`: count, recent 10, refresh, a Realtime channel filtered by `user_id`, and a 60-second poll while the tab is visible. Unsubscribe on sign-out

## 6. Frontend: the bell, the page, the toggle

- [x] 6.1 `NotificationItem`: tone accent, eyebrow, headline, relative time through `Intl.RelativeTimeFormat`, a distinct unread style, and resolved items muted with "No action needed"
- [x] 6.2 `NotificationBell` in `Header.tsx`, shown at `lg` and wider only: a badge (9+ cap), an accessible label with the count, and a popover with the 10 recent items. "Mark all read" and "See all" links. Escape or an outside click closes it and focus goes back to the bell. Selecting an item marks it read and navigates there
- [x] 6.2b Below `lg`: a red dot on the drawer toggle while anything is unread (danger colour, `bg-deep` ring, no number), with the count in its `aria-label`. A "Notifications" entry at the top of the `Sidebar` drawer with a count badge that closes the drawer and goes to `/notifications`. Hidden at `lg` and wider
- [x] 6.3 `/notifications` route and `NotificationsPage`: All, Unread and Needs action filters driven by `?filter=all|unread|action`, paged by 20 with "load more", full details and note, "Mark all read", and an empty state
- [x] 6.4 "Email me about notifications" switch on your own My profile, saved immediately with a confirmation and a line explaining that in-app notifications continue either way
- [x] 6.4b Needs-action sentence in `DashboardPage.tsx`, next to the existing live approvals sentence, which stays unchanged. Exclude the live sentence's kinds when `is_management`. Name up to three headlines and count the rest, link to `/notifications?filter=action`, and show nothing when empty
- [ ] 6.5 `npm run build`. Screenshot the bell and popover at 1495px, the dotted toggle and open drawer at 390px, the page at both widths, and the dashboard sentence for a management and an IT support account

## 7. Release

- [ ] 7.1 Deploy the frontend
- [ ] 7.2 Smoke test in production with two accounts: submit leave, check the bell updates live and the email uses the new layout, approve it, check the approver's item shows "No action needed" and the requester gets a `success` item. On a phone, check the red dot and the drawer entry
