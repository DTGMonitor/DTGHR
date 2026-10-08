# Tasks

Database first: one migration, safe under the current frontend. Then the
pages. The Edge Function doesn't change.

## 1. Migration: needs_action, who resolved, item links

- [x] 1.1 New migration: add `needs_action boolean not null default false`, `resolved_by uuid`, `resolved_by_name text` and `resolved_status text` to `notifications`, plus a partial index `(user_id, created_at desc) where needs_action and resolved_at is null`
- [x] 1.2 `notifications_needs_action(kind, payload)`: tone `action` or one of the five sent-back kinds. Backfill existing rows
- [x] 1.3 `notifications_item_link(source_table, source_id, caller_path)` for leave, tickets, finance, payroll (`?month=`) and salary. Every other source keeps the caller's path
- [x] 1.4 Redefine `notifications_enqueue`: rewrite `payload.link.path` through 1.3, set `needs_action` through 1.2, and write the rewritten path to `email_outbox.link_path`
- [x] 1.5 Replace `notifications_resolve(table, id)` with `(table, id, status default null)`: filter on `needs_action`, set `resolved_by`, `resolved_by_name` and `resolved_status`. Update `notifications_resolve_on_status()` to pass the new status (`status`, or else `response_status`)
- [x] 1.6 `notifications_open_actions` filters on `needs_action`
- [x] 1.7 The site address: the app lives at `https://people.digitaltwingeotechnical.com`, but `app_settings.public_site_url` still holds `https://dtghr-fe.vercel.app`, so every email button points at the old address. The migration updates it, but only where it still holds the old value, so a deliberate setting is never overwritten
- [x] 1.8 The fallbacks used when the setting is missing: `notifications_site_url()` (SQL), `send-notifications/index.ts`, and `preview.ts`. The function fallback only takes effect on its next deploy, which isn't needed for this change because the setting is what's read

## 2. Migration: new sources

- [x] 2.1 `notifications_profile_reviewers()`: director, executives and active `can_manage_people` staff with accounts
- [x] 2.2 `profile_change_requests` triggers: insert `pending` → `profile_request_submitted` to reviewers, except the requester (action, the field and the requested value as details, the reason as the note, link `/settings`). `pending` → `approved`/`rejected` → `profile_request_approved`/`_rejected` to the requester (link to their profile, `review_note` as the note)
- [x] 2.3 `shift_change_requests`: a deferred constraint trigger on insert → `shift_change_proposed` to the director and executives, except the proposer (the roster name, the days and their codes, link `/schedules`). Status → `approved`/`rejected`/`partially_approved` → `shift_change_decided` to the proposer, with the counts and the review note
- [x] 2.4 `payslips` after insert (with an employee who has an account) → `payslip_ready` (success, link `/employees/<id>?tab=payslips`)
- [x] 2.5 Attach `trg_notifications_resolve` to `profile_change_requests` and `shift_change_requests` on status change
- [x] 2.6 Grants and revokes for the new functions, as in 20261007000100

## 3. Migration: leave detail access

- [x] 3.1 `leaves_can_view_as_reviewer(request_id)`: the approval rule without the pending condition. (`assert_can_review_leave` is left as it is: it raises specific errors in a specific order that the approve and reject paths and their tests depend on. The two encode the same rule and sit next to each other in the leaves area.)
- [x] 3.2 `leaves_get` allows the requester or 3.1. `leave_request_json` carries the reviewer's name, decided-at time and note for the timeline (add any that are missing)

## 4. Database tests

- [x] 4.1 Links: leave, ticket, finance, payroll and salary notifications carry the item path, in both the payload and the outbox. An investigation keeps its caller's link
- [x] 4.2 `needs_action`: true for action tone and the five sent-back kinds, false for the director's copy and for outcomes. Backfill applied
- [x] 4.3 Resolve records who and how: approving leave gives `approved` with the approver's id and name. A scheduled change leaves the name null. Resubmitting settles finance's `finance_sent_back`
- [x] 4.4 Profile requests: reviewers notified, requester excluded. Approve and reject notify the requester and settle the other reviewers' items. Cancelling settles them
- [x] 4.5 Shift changes: one proposed notification per approver listing every day (the deferred trigger). Partly approved notifies the proposer with the counts and settles with `partially_approved`
- [x] 4.6 Payslips: notified on first issue, not on regenerate, nobody without a staff record
- [x] 4.7 `leaves_get`: the requester, the named manager and the director can read it, a colleague who can't review gets 403, and decided requests stay readable for reviewers
- [x] 4.8 Every table that gets `needs_action` items carries the resolve trigger (the existing coverage test, extended)
- [x] 4.9 `npm run test:db` passes

## 5. Frontend

- [x] 5.1 `lib/notifications`: the type gains `needs_action`, `resolved_by_name` and `resolved_status`. The action filter uses `needs_action`. Add a settled-label helper (design table)
- [x] 5.2 `NotificationItem`: muted when settled and `needs_action`, labelled by 5.1
- [x] 5.3 Dashboard exclusion lists gain the sent-back kinds (band) and `payroll_returned` / `finance_submitted_cc` (management)
- [x] 5.4 TicketsPage `?open=` ⇄ the ticket panel. FinanceRequestsPage `?open=` ⇄ expanded row and scroll. PayrollPage `?month=` ⇄ the selected month. SalaryPage `?open=` → scroll and highlight. Each shows "could not be found" for an id it can't load, and closing removes the parameter
- [x] 5.5 `LeaveDetailPanel` in a `Drawer` at `/leaves?open=<id>`: request, timeline, approve/reject for reviewers while pending, cancel for the requester. Full width on narrow screens
- [x] 5.6 `npm run build`

## 6. Local check, then live

- [x] 6.1 Skipped (decided 9 Oct: the database tests cover each new path, and the old frontend keeps working on the new schema). Local Docker copy of production (as in the last change): apply the migration, then run the walkthrough below with two accounts
- [x] 6.2 Skipped along with 6.1. The same walkthrough becomes the production smoke test in 6.4. Walkthrough:
  - an email link opens the leave panel on the request;
  - approve from the panel: the other account sees "Approved by …";
  - finance sent back: it appears under Needs action and settles on resubmit;
  - a profile request notifies reviewers;
  - a shift proposal lists its days;
  - a payslip notifies once
- [x] 6.3 Apply the migration to production (SQL editor, after checking for a backup) and run the check query
- [x] 6.4 Push to `main` (Vercel deploys) and smoke test in production
- [x] 6.5 Outside the code, check the new address everywhere a link is made:
  - Supabase → Authentication → URL Configuration: Site URL and the redirect allow-list (invite, password reset and SSO return links);
  - `supabase/SSO_SETUP.md`;
  - keep `dtghr-fe.vercel.app` serving or redirecting, so links in emails already sent still work
