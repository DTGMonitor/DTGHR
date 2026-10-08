# Design: notifications, phase 3

## Context

Phase 1 and 2 (`archive/2026-10-08-in-app-and-email-notifications`) built
these pieces:

- `public.notifications`: one row per recipient, with a structured payload.
- `notifications_enqueue(user_ids, exclude, kind, subject, payload,
  source_table, source_id)`: writes the in-app row, plus an outbox row for
  recipients who take email.
- `notifications_resolve_on_status()`: attached to each source table, it
  settles unresolved items with **tone `action`** written before the status
  change.
- `notifications_open_actions()`, the Needs action filter and the dashboard
  sentence all key off tone `action`.
- The Edge Function renders `payload.link.path`.

The callers today are 11 trigger functions and RPCs, plus
`20261008000100_finance_cc_in_app.sql` for finance.

What the pages can do with a URL today:

| Page | Opens one item today? | State that holds the item |
|---|---|---|
| Investigations | ✓ `?open=<id>` | — |
| KPI | ✓ `?employee=<id>` | — |
| Profile | ✓ `?tab=` | — |
| IT tickets | ✗ | `openTicket` panel |
| Finance requests | ✗ | `open` expanded row |
| Payroll | ✗ | `monthId` |
| Salary | ✗ | a list |
| Leave | ✗ | no detail view; approvals inline |

`leaves_get(p_id)` exists and the route `GET /leaves/:id` is mapped, but it
only lets the requester or their direct manager read a request.

The new sources work like this:

- **`profile_change_requests`:** one row per field asked for (`field`,
  `current_value`, `requested_value`, `reason`). Statuses are `pending`, then
  `approved`, `rejected` or `cancelled`. Reviewers are
  `people_can_review_profile_requests()`, which is `is_admin()` (director or
  executive) or `can_manage_people()`.
- **`shift_change_requests`:** has `shift_change_items`, one per day. The
  status is recomputed from the items and stays `pending` until every day is
  reviewed, then becomes `approved`, `rejected` or `partially_approved`. The
  proposer can withdraw (`cancelled`). Reviewing requires `is_admin()`. The
  items are inserted after the request row, in the same function.
- **`payslips`:** `payslips_generate_due()` (pg_cron, every 5 minutes) and
  finance's regenerate both write with
  `insert … on conflict (month_id, payroll_line_id) do update`, so AFTER
  INSERT fires only for a slip that didn't exist yet. `employee_id` is
  nullable.

## Goals / Non-Goals

**Goals:**
- A notification takes you to its item, in the app and from email.
- A settled item says how and by whom it was settled.
- "Sent back to you" counts as work and settles when the person acts.
- Profile requests, roster changes and payslips notify like everything else.
- A real detail view for a leave request.

**Non-Goals:**
- Email opt-out per category, and daily digests.
- Changing who receives existing kinds.
- Item links on pages not listed above.
- Changes to the Edge Function.

## Decisions

### 1. Item links are worked out in `enqueue`, from the source

```
 caller ──payload(link.path = '/leaves')──▶ notifications_enqueue(…, source_table, source_id)
                                              │
                                  notifications_item_link(source_table, source_id, link.path)
                                              │  leave_requests    → /leaves?open=<id>
                                              │  support_tickets   → /support?open=<id>
                                              │  finance_requests  → /finance-requests?open=<id>
                                              │  payroll_months    → /payroll?month=<id>
                                              │  salary_reviews    → /salary?open=<id>
                                              │  anything else     → caller's path unchanged
                                              ▼
                       payload.link.path rewritten once ─▶ notifications row + outbox.link_path
```

No caller changes. The Edge Function renders `link.path` as it does now, so
email gets the item link too. The mapping is one `case`, so a new page that
learns `?open=` needs one line here.

*Alternatives considered:*
- (a) Redefine every caller to pass the item URL. That's churn across 11
  functions, and easy to miss one.
- (b) Map `source → URL` in React and again in the renderer. That's two
  copies, and the email and in-app links could drift apart.

### 2. `needs_action` is a column, set by `enqueue`

```
 needs_action := payload->>'tone' = 'action'
              or kind in ('payroll_returned', 'payroll_changes_requested',
                          'finance_sent_back', 'finance_sent_back_director',
                          'investigation_sent_back')
```

The rule lives in one function, `notifications_needs_action(kind, payload)`,
so callers don't change and tone goes back to meaning colour only. A
migration backfills existing rows by the same rule.

- **Index:** a partial index `(user_id, created_at desc) where needs_action
  and resolved_at is null`, for the filter and the dashboard.
- **Left out on purpose:** `investigation_disputed`. A dispute is answered
  with a resolution note that may leave the outcome's `response_status`
  unchanged, so nothing would ever settle it. It stays an FYI.

Where the switch from tone to `needs_action` happens:

- `notifications_resolve()`;
- `notifications_open_actions()`;
- the Needs action filter, which becomes `needs_action = true and
  resolved_at is null`;
- `NotificationItem`'s muted style;
- the dashboard sentence, through `open_actions`.

### 3. Who settled it is recorded at resolve time, name included

`notifications_resolve(p_source_table, p_source_id, p_status text default
null)` replaces the 2-argument version (dropped). It sets:

- `resolved_at = now()`;
- `resolved_by = auth.uid()`;
- `resolved_by_name`, the caller's display name (`notifications_actor_name()`);
- `resolved_status = p_status`.

The trigger passes the new status as
`coalesce(to_jsonb(new)->>'status', to_jsonb(new)->>'response_status')`, so
one function serves every table, including `investigation_outcomes`.
`investigations_notify_subject` keeps calling it with two arguments, which
falls back to a null status.

The name is stored, not looked up, because `users` RLS lets people read only
their own profile. The approver's name isn't readable by the requester.
Storing it also keeps the label stable if a name changes later.

The frontend turns `(resolved_status, resolved_by_name)` into a label:

| `resolved_status` | Label |
|---|---|
| `approved` | Approved by X |
| `rejected` | Rejected by X |
| `changes_requested` | Sent back by X |
| `endorsed` | Endorsed by X |
| `submitted` | Resubmitted by X |
| `in_review` | Submitted by X |
| `issued` | Issued by X |
| `partially_approved` | Partly approved by X |
| `cancelled` | Cancelled |
| `closed` / `resolved` | Closed by X / Resolved by X |
| `acknowledged` / `accepted` / `disputed` | Acknowledged / Accepted / Disputed by X |
| unknown status, or no name | "No action needed" |

### 4. New sources

| Kind | When | To | Tone | `needs_action` |
|---|---|---|---|---|
| `profile_request_submitted` | after insert, `pending` | reviewers: director + executives + `can_manage_people` staff, except the requester | action | ✓ |
| `profile_request_approved` / `_rejected` | `pending` → `approved` / `rejected` | the requester (`requested_by`, else the employee's account) | success / danger (+ `review_note`) | — |
| `shift_change_proposed` | **deferred** after insert | director + executives, except the proposer | action | ✓ |
| `shift_change_decided` | `pending` → `approved` / `rejected` / `partially_approved` | the proposer | success / danger / reminder (partly) | — |
| `payslip_ready` | after insert | the employee's account | success | — |

Notes on each:

- **One profile notification per field.** A request is one row per field, and
  each row is reviewed on its own (`people_approve_profile_request(id)`). So
  one notification per row keeps settling exact. A person asking for three
  fields at once gives a reviewer three items. That's acceptable at this
  volume, and each item names its field.
- **Shift proposals use a deferred constraint trigger** (`create constraint
  trigger … deferrable initially deferred`). The items are inserted after the
  request row, so a plain AFTER INSERT trigger would see no days. Deferred to
  commit, it sees all of them and can list the roster and the count of days.
- **Payslips:** AFTER INSERT fires only for a new slip, never for the `do
  update` branch, so regenerating sends nothing. A slip with no
  `employee_id`, or an employee with no account, notifies nobody. The cron
  runs without a user, so nobody is excluded.
- **Links for the new kinds come from the caller:**
  - profile reviewers → `/settings` (where `ProfileRequests` lists them);
  - the requester → `/employees/<their employee id>`;
  - shift changes → `/schedules`;
  - payslips → `/employees/<employee id>?tab=payslips`.
- **Both request tables get `trg_notifications_resolve`** on status change,
  so a decision or a withdrawal settles the reviewers' items.

### 5. `leaves_get` is readable by anyone who may review the request

Today it allows the requester or their direct manager. It becomes the
requester, **or** anyone the approval rule allows to review this request:
administrators and management, the named manager, and the director or
executive fallbacks, as in `assert_can_review_leave`, but **without** the
"still pending" condition, so decided requests stay readable for history.

That logic is pulled into one non-raising helper,
`leaves_can_view_as_reviewer(p_request_id) returns boolean`, used by
`leaves_get`. `assert_can_review_leave` keeps its own copy, because it
raises specific errors in a specific order that the approve and reject paths
and their tests rely on. The two encode the same rule and sit side by side.
`leave_request_json` gains the decision fields the timeline needs, if any are
missing (reviewer name, decided at, note).

### 6. Frontend

```
 NotificationItem      settled label from resolved_status + resolved_by_name
 lib/notifications     action filter → needs_action; type gains new columns
 DashboardPage         exclusion lists gain the sent-back and cc kinds
 TicketsPage           ?open=<id> ⇄ openTicket
 FinanceRequestsPage   ?open=<id> ⇄ open (expand + scrollIntoView)
 PayrollPage           ?month=<id> ⇄ monthId
 SalaryPage            ?open=<id> → scroll + 2s highlight
 LeavesPage            ?open=<id> ⇄ <LeaveDetailPanel> (ui/Drawer), from GET /leaves/:id
```

**One pattern on every page:** the URL is the source of truth for what's
open. Opening an item calls `setParams({ open: id })` and closing it removes
the parameter, so the back button and shared links both work. If an id fails
to load (403 or 404), the page shows "could not be found" next to the normal
list, never a blank page.

The leave panel uses the existing `Drawer` and the existing approve, reject
and cancel functions, so no new write path is added.

## Risks / Trade-offs

- **[Link mapping points at a page that can't open the item yet]** → The
  mapping covers only the five pages this change teaches `?open=`. It goes in
  the same migration as those pages, and the frontend deploys right after.
  An old frontend with a new link just shows the list, so nothing breaks.
- **[Changing `notifications_resolve`'s signature breaks a caller]** → Its
  only callers are the trigger function and `investigations_notify_subject`.
  Both are covered by tests, and the new parameter has a default.
- **[A deferred shift trigger fires after an error in the same
  transaction]** → It doesn't: deferred triggers run at commit, and a failed
  transaction never commits. The usual warning-and-continue wrapper still
  applies.
- **[Three profile items for one request]** → Accepted. Revisit only if
  people complain. One notification per transaction would break exact
  settling.
- **[`leaves_get` widening exposes too much]** → It uses the same rule that
  already lets those people *approve* the request. Tests cover the
  colleague-who-can't-review case.

## Migration Plan

1. Apply the migration. It adds columns with a backfill, the link mapping in
   `enqueue`, the resolve changes, the new triggers and `leaves_get`. The old
   frontend keeps working: it ignores the new columns, and the item links
   degrade to the list.
2. Deploy the frontend: pages read `?open=`, the leave panel, the labels and
   the Needs action filter.
3. The Edge Function needs no change and no redeploy.
4. Smoke test:
   - submit leave, open the email link: the panel opens on that request;
   - approve it: the approver's other device shows "Approved by …";
   - send a finance request back: it appears under Needs action for finance;
   - raise a profile request: reviewers are notified.

Rollback: revert the frontend. A follow-up migration can restore the previous
`enqueue`, `notifications_resolve` and `open_actions`, and drop the new
triggers. The new columns can stay.

## Open Questions

- Should the leave panel also show the balance after this request, as in the
  sketch? It depends on whether `leave_request_json` can supply it cheaply;
  this gets decided during implementation, and it's left out rather than
  slowing the panel down.
