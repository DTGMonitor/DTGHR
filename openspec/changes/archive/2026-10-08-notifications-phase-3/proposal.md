# Notifications, phase 3: open the thing, see who handled it, cover the rest

## Why

In-app and email notifications went live on 8 October
(`in-app-and-email-notifications`). In use, four gaps show:

- **A notification opens a list, not the item.** "Leave request from
  Bintang" goes to `/leaves`, and the approver looks for it. Only
  investigations, KPI and the conduct tab open a single item today.
- **"No action needed" doesn't say what happened.** An approver whose item
  was settled by someone else can't tell whether it was approved or
  rejected, or by whom.
- **"Sent back to you" isn't treated as work.** These items are red, but they
  aren't counted under Needs action and they never settle, even though the
  person has to fix something and resubmit. The cause is that the payload's
  tone sets both the colour and whether the item counts as an action.
- **Three workflows notify nobody:** profile change requests (HR never hears
  that someone asked to correct a bank account), roster shift changes, and
  payslips ("your payslip is ready").

Leave requests also have no detail view, so a link has nothing to open.

## What Changes

- **Links open the exact item.** `notifications_enqueue()` works out the link
  from the notification's source (`leave_requests` → `/leaves?open=<id>`,
  `payroll_months` → `/payroll?month=<id>`, and so on). Both the bell and the
  email get it, and no existing caller changes. The email-delivery spec is
  unchanged, because the email already renders `link.path`.
  - The IT tickets, finance requests, payroll, salary and leave pages open the
    item named in the URL.
  - Pages that already do this keep their current links: investigations, KPI
    and the conduct tab.
- **A leave detail panel** at `/leaves?open=<id>`, opening over the list as the
  ticket panel does. It shows the request, its timeline (submitted; decided by
  whom, with the note), and the actions the viewer is allowed (approve or
  reject, cancel).
  - `leaves_get()` is widened from "yours or your direct report's" to "yours
    or one you may review", using the same rule as approving.
- **Who handled it.** When a status change settles an item, the system records
  who made the change and the new status. Settled items read "Approved by
  Nurhuda Teguh Santoso" instead of "No action needed", in the bell, on the
  page and on the dashboard.
- **Needs action is separate from tone.** Notifications carry
  `needs_action`, set for "waiting for you" items and for "sent back to you"
  items.
  - The Needs action filter, the dashboard sentence and resolving all use
    `needs_action` instead of tone.
  - Sent-back items show red, count as work, and settle when the person
    resubmits.
  - Existing rows are backfilled.
- **New notification sources:**
  - **Profile change requests.** A new request goes to the people who may
    review it (action). The decision goes to the requester (success or
    danger, with the reviewer's note).
  - **Roster shift changes.** A proposal goes to the roster approvers
    (action). The decision goes to the requester (approved, rejected, or
    partly approved).
  - **Payslips.** When a slip is issued, the employee gets "Your <month>
    payslip is ready" (success), linking to the Payslips tab on their profile.
    Regenerating a slip doesn't notify again.
  - Both request tables get the resolve trigger.

### Non-goals

- Email opt-out per category, and daily digests. Volume doesn't call for them
  yet.
- Links into pages not named above.
- Changing who receives the existing notification kinds.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `notifications`:
  - the payload gains the item link and `needs_action`;
  - resolving uses `needs_action` and records who resolved the item and the
    new status;
  - open action items use `needs_action`;
  - three new sources and two more tables with the resolve trigger.
- `notification-inbox`:
  - settled items say how and by whom;
  - Needs action and the dashboard sentence follow `needs_action`;
  - selecting an item opens it on its page.
  - New requirements: pages open the item named in the URL, and the leave
    detail panel.

## Impact

- **Database:** one migration.
  - New columns on `notifications`: `needs_action`, `resolved_by` and
    `resolved_status`, with a backfill.
  - A link-mapping function used by `notifications_enqueue()`.
  - `notifications_resolve()` and its trigger record who resolved the item and
    the new status.
  - `notifications_open_actions()` changes.
  - Triggers on `profile_change_requests`, `shift_change_requests` and
    `payslips`, plus resolve triggers on the two request tables.
  - `leaves_get()` is widened.
- **Edge Function:** no change. It renders `payload.link.path`, which now
  holds the item link.
- **Frontend:**
  - URL handling on the leave, tickets, finance requests, payroll and salary
    pages.
  - A new leave detail panel.
  - Changes to `NotificationItem`, the Needs action filter and the dashboard
    sentence.
- **Tests:** `supabase/test/areas/notifications.test.mjs` grows with the
  links, `needs_action`, who resolved items, and the three new sources;
  `leaves.test.mjs` covers the widened `leaves_get()`.
