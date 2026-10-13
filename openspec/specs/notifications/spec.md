# notifications Specification

## Purpose
The notification record: one row per person per event with a structured payload, who receives it, read state, how action items are settled when their source moves on, and retention.
## Requirements
### Requirement: Notification record per recipient
The system SHALL store every notification as one row in `public.notifications` per recipient per event, holding the recipient's user id, `kind`, `source_table`, `source_id`, a structured `payload`, `needs_action`, `created_at`, `read_at`, `resolved_at`, `resolved_by`, `resolved_by_name` and `resolved_status`. The in-app record SHALL be written whether or not the recipient receives an email.

#### Scenario: Leave request notifies the approver
- **WHEN** an employee submits a leave request and their manager is the approver
- **THEN** exactly one `notifications` row is written for the manager, with kind `leave_submitted`, `source_table = 'leave_requests'`, `source_id` the request's id and `needs_action = true`

#### Scenario: Several recipients
- **WHEN** a ticket is raised and three active IT support staff exist
- **THEN** three `notifications` rows are written, one per staff member, with the same payload

### Requirement: Structured payload
The payload SHALL be a JSON object with `tone` (one of `action`, `success`, `danger`, `reminder`), `eyebrow`, `headline`, optional `intro`, `details` as an ordered array of `[label, value]` pairs, optional `note` (`{ by?, text }`) for text a person wrote, and `link` (`{ label, path }`). All strings SHALL be finished, human-readable English. Empty details, an empty note and blank intro SHALL be omitted. The tone SHALL decide only how the notification looks; whether it asks something of the recipient SHALL be recorded in `needs_action`, not in the tone.

#### Scenario: Rejected leave carries the reviewer's note
- **WHEN** a manager rejects a leave request with the note "Clashes with the site visit"
- **THEN** the requester's notification has tone `danger`, details including the leave type and dates, and `note.text` equal to "Clashes with the site visit"

#### Scenario: No reviewer note
- **WHEN** a leave request is approved without a note
- **THEN** the payload has no `note` key

#### Scenario: Red but actionable
- **WHEN** the executive sends a payroll month back to the director
- **THEN** the director's `payroll_returned` notification has tone `danger` and `needs_action = true`

### Requirement: Recipient eligibility
A notification SHALL be written only for accounts that are active, have a non-empty email, and whose linked employee record (if any) is active. The person who made the change SHALL NOT be notified about their own action. The `email_notifications` preference SHALL NOT affect whether the in-app record is written.

#### Scenario: Actor is excluded
- **WHEN** a director endorses payroll and is also an executive
- **THEN** no notification about that endorsement is written for the director

#### Scenario: Email opt-out still gets in-app
- **WHEN** a recipient has `email_notifications = false`
- **THEN** their `notifications` row is written and no `email_outbox` row is written for them

#### Scenario: Inactive employee
- **WHEN** the approver's employee record is inactive
- **THEN** no notification is written for them

### Requirement: Stale action items are resolved
Any status change on a source record that notifications are written for SHALL set `resolved_at` on every unresolved notification with `needs_action = true` for that `source_table` and `source_id`, written before that change, and SHALL record the user who made the change in `resolved_by` and their display name in `resolved_by_name` (both null when no user did, such as a scheduled job), and the source's new status in `resolved_status`. The name SHALL be stored because recipients cannot read other users' profiles. This SHALL apply whether or not the new status itself notifies anyone, and SHALL cover leave requests, payroll months, finance requests, KPI reviews, salary reviews, investigations, profile change requests and roster shift change requests; tickets when they leave the open, in-progress and waiting statuses; and investigation outcomes when their response status changes. For tickets, the reporter's items SHALL additionally be settled by kind, leaving IT's items open: `ticket_waiting` and `ticket_closing_soon` when the ticket leaves `waiting`, and `ticket_closing_soon` when the ticket leaves `resolved` for a live status or its auto-close deadline is moved by a reply or an extension.

#### Scenario: Leave approved by someone else
- **WHEN** a leave request notified the manager (action) and the director approves it
- **THEN** the manager's `leave_submitted` notification has `resolved_at` set, `resolved_by` the director's user id and `resolved_status = 'approved'`

#### Scenario: Final approval that notifies nobody
- **WHEN** the executive approves an endorsed payroll month and no notification is written for that transition
- **THEN** the executive's `payroll_endorsed` notification for that month has `resolved_at` set and `resolved_status = 'approved'`

#### Scenario: KPI scorecard approved
- **WHEN** an approver approves a submitted KPI scorecard
- **THEN** the approver's `kpi_submitted` notification has `resolved_at` set

#### Scenario: Sent back creates a fresh action
- **WHEN** finance submits payroll, the director sends it back, and finance resubmits
- **THEN** the director's first `payroll_submitted` item is resolved, finance's `payroll_changes_requested` item is resolved on the resubmission, and a new unresolved `payroll_submitted` item is written for the director

#### Scenario: Ticket closed
- **WHEN** an open ticket is closed
- **THEN** every IT support `ticket_raised` notification for that ticket has `resolved_at` set and `resolved_status = 'closed'`

#### Scenario: Reporter answers a waiting ticket
- **WHEN** a ticket is `waiting`, its reporter has an unresolved `ticket_waiting` item, IT has an unresolved `ticket_raised` item, and the reporter replies
- **THEN** the reporter's `ticket_waiting` item is resolved and IT's `ticket_raised` item stays unresolved

#### Scenario: Extension settles the reminder
- **WHEN** the reporter has an unresolved `ticket_closing_soon` item and extends the deadline
- **THEN** that item is resolved

#### Scenario: Leave cancelled
- **WHEN** a pending leave request is cancelled
- **THEN** the approver's `leave_submitted` notification has `resolved_at` set and `resolved_status = 'cancelled'`

#### Scenario: Outcome notifications are not resolved
- **WHEN** a later event occurs on a source whose earlier notification has `needs_action = false`
- **THEN** that notification's `resolved_at` stays null

### Requirement: Recipients see only their own notifications
Row-level security SHALL allow an authenticated user to select only notifications addressed to them. Browser clients SHALL NOT insert or delete notifications, and SHALL change only `read_at`, and only through the mark-read functions.

#### Scenario: Reading another user's row
- **WHEN** an authenticated user selects from `notifications`
- **THEN** only rows with their own user id are returned

#### Scenario: Direct update is refused
- **WHEN** an authenticated user attempts to update `payload` on their own notification
- **THEN** the update is refused

### Requirement: Marking as read
The system SHALL provide functions to mark one of the caller's notifications read and to mark all of the caller's notifications read. Marking SHALL set `read_at` only where it is null and SHALL ignore ids that do not belong to the caller.

#### Scenario: Mark all read
- **WHEN** a user with five unread notifications marks all read
- **THEN** all five have `read_at` set and the user's unread count is zero

#### Scenario: Someone else's id
- **WHEN** a user marks read a notification id addressed to another user
- **THEN** nothing changes

### Requirement: Open action items
The system SHALL provide a function returning the calling user's open action items, meaning their notifications with `needs_action = true` and no `resolved_at`, read or unread, newest first, with an optional list of kinds to exclude.

#### Scenario: Read but unresolved
- **WHEN** a user has read a `ticket_raised` notification and the ticket is still open
- **THEN** it is included in their open action items

#### Scenario: Excluding kinds
- **WHEN** the function is called excluding `leave_submitted`
- **THEN** no `leave_submitted` items are returned

#### Scenario: Sent back to you is open work
- **WHEN** finance has a `finance_sent_back` notification and has not resubmitted the request
- **THEN** it is included in finance's open action items

### Requirement: Retention
A daily scheduled job SHALL delete notifications older than 180 days that are read or resolved. Unread, unresolved notifications SHALL be kept. The job SHALL only be scheduled where `pg_cron` is available.

#### Scenario: Old read notification
- **WHEN** the job runs and a notification was created 200 days ago and read
- **THEN** it is deleted

#### Scenario: Old unread action
- **WHEN** the job runs and a notification was created 200 days ago and is unread and unresolved
- **THEN** it is kept

### Requirement: Notifications never undo the change they report
A failure while writing notifications SHALL be logged as a warning and SHALL NOT roll back or block the business change that triggered it.

#### Scenario: Payload builder errors
- **WHEN** building a leave notification raises an error
- **THEN** the leave status change still commits

### Requirement: Which notifications need action
A notification SHALL have `needs_action = true` when it asks the recipient to do something: every notification with tone `action`, and the "sent back to you" kinds `payroll_returned`, `payroll_changes_requested`, `finance_sent_back`, `finance_sent_back_director` and `investigation_sent_back`. All others SHALL have `needs_action = false`. Notifications written before this requirement SHALL be backfilled by the same rule.

#### Scenario: Copy for information
- **WHEN** the director is copied in on a finance request and may not approve it
- **THEN** their `finance_submitted_cc` notification has `needs_action = false`

#### Scenario: Backfill
- **WHEN** the change is applied and an unresolved `investigation_sent_back` notification exists
- **THEN** it has `needs_action = true` afterwards

### Requirement: Links open the item
The link path of a notification SHALL point at the single item it concerns where the app can open one, derived from the notification's source when it is written: `leave_requests` → `/leaves?open=<id>`, `support_tickets` → `/support?open=<id>`, `finance_requests` → `/finance-requests?open=<id>`, `payroll_months` → `/payroll?month=<id>`, `salary_reviews` → `/salary?open=<id>`. For every other source the link SHALL be the one its caller gives: investigations, KPI reviews and investigation outcomes already link to the item; profile change requests link reviewers to the requests on Settings and the requester to their own profile; roster shift changes link to the roster; payslips link to the Payslips tab of the employee's profile. The same path SHALL serve the in-app item and the email.

#### Scenario: Leave link
- **WHEN** a leave request notifies its approver
- **THEN** the payload's `link.path` is `/leaves?open=<the request's id>`

#### Scenario: Caller's link kept
- **WHEN** an investigation is submitted for review
- **THEN** the link path stays `/investigations?open=<the investigation's id>`

#### Scenario: Email carries the same link
- **WHEN** the email for a leave request is rendered
- **THEN** its button points at the public site URL followed by `/leaves?open=<id>`

### Requirement: Profile change requests notify
When a profile change request is raised, a notification with tone `action` SHALL be written for everyone who may review profile requests (the director and the executives, and staff with the manage-people flag), excluding the requester. When it is approved or rejected, a notification SHALL be written for the requester: tone `success` when approved, `danger` when rejected, carrying the reviewer's note. Cancelling SHALL notify nobody and SHALL settle the reviewers' items.

#### Scenario: Raised
- **WHEN** an employee asks to change their bank account
- **THEN** each reviewer gets a `profile_request_submitted` notification naming the employee and the fields asked for

#### Scenario: Rejected with a note
- **WHEN** a reviewer rejects the request with the note "Attach the bank letter"
- **THEN** the requester gets a `profile_request_rejected` notification with tone `danger` and `note.text` "Attach the bank letter", and the other reviewers' items are resolved

### Requirement: Roster shift changes notify
When a roster shift change proposal is raised, a notification with tone `action` SHALL be written for the roster approvers (the director and the executives), excluding the proposer, once the proposal's days have been recorded. When every day has been reviewed and the proposal becomes approved, rejected or partially approved, a notification SHALL be written for the proposer saying which, with the counts of days approved and rejected and the review note. Withdrawing SHALL notify nobody and SHALL settle the approvers' items.

#### Scenario: Proposed
- **WHEN** a crew member proposes changes to three days of the October roster
- **THEN** each approver gets one `shift_change_proposed` notification listing the roster and three days

#### Scenario: Partly approved
- **WHEN** an approver approves two of the three days and rejects one
- **THEN** the proposer gets one `shift_change_decided` notification saying 2 approved and 1 rejected, and the approvers' items are resolved with `resolved_status = 'partially_approved'`

### Requirement: Payslips notify
When a payslip is issued for an employee with a staff record, a notification with tone `success` SHALL be written for that employee's account, linking to the Payslips tab of their profile. Regenerating an existing payslip SHALL NOT notify again. A payslip with no staff record SHALL notify nobody.

#### Scenario: Issued
- **WHEN** the scheduled release issues the October payslips
- **THEN** each employee with an account gets one `payslip_ready` notification "Your October 2026 payslip is ready"

#### Scenario: Regenerated
- **WHEN** finance regenerates an employee's October payslip after a correction
- **THEN** no further notification is written

### Requirement: IT tickets notify the reporter and IT
Ticket events SHALL notify the side that did not act. The reporter SHALL be notified when:
- IT logs a ticket on their behalf (`ticket_logged_for_you`);
- IT adds a public reply (`ticket_replied`);
- IT moves the ticket to `waiting` (`ticket_waiting`, tone `action`, carrying IT's note);
- the ticket is resolved (`ticket_resolved`, tone `success`, carrying the fix);
- IT closes it (`ticket_closed`);
- its auto-close is a day away (`ticket_closing_soon`, tone `action`);
- it closes automatically (`ticket_auto_closed`).

IT support SHALL be notified when:
- the reporter adds a public reply (`ticket_reporter_replied`);
- the reporter reopens the ticket or says it is still broken (`ticket_reopened`, tone `action`);
- the reporter closes or confirms it (`ticket_closed_by_reporter`).

Internal notes and moves to `in_progress` SHALL notify nobody. Every ticket notification SHALL link to `/support?open=<id>`.

#### Scenario: IT asks a question
- **WHEN** IT moves a ticket to `waiting` with the note "Which site are you at?"
- **THEN** the reporter gets one `ticket_waiting` notification with `needs_action = true` and `note.text` "Which site are you at?"

#### Scenario: Internal note
- **WHEN** IT adds an internal note
- **THEN** no notification is written

#### Scenario: Resolved carries the fix
- **WHEN** IT resolves a ticket with "Replaced the charger"
- **THEN** the reporter gets a `ticket_resolved` notification with tone `success`, `needs_action = false`, and the fix in its note

#### Scenario: Reporter says it is still broken
- **WHEN** the reporter reopens a resolved ticket
- **THEN** each IT support user other than the reporter gets a `ticket_reopened` notification with `needs_action = true`

#### Scenario: IT raises their own ticket
- **WHEN** Bintang, who works the queue, raises a ticket with themselves as the reporter
- **THEN** Bintang receives no notification about it

#### Scenario: Logged for someone
- **WHEN** Bintang logs a ticket for Ana from WhatsApp
- **THEN** Ana gets a `ticket_logged_for_you` notification linking to `/support?open=<the ticket's id>`

### Requirement: The asset register notifies the holder and IT
Asset events SHALL notify as follows, always excluding the person who acted:
- the new holder when an asset is assigned or transferred to them (`asset_assigned`, tone `action`);
- the previous holder when an asset is returned, transferred away from them, or found after being lost from them (`asset_released`);
- IT support when a holder says they did not receive an asset (`asset_handover_declined`, tone `action`);
- each holder with items when a check-in round starts (`asset_checkin_requested`, tone `action`), once per holder;
- holders still pending seven days into a round (`asset_checkin_reminder`);
- IT support when a holder answers "Not with me" (`asset_checkin_missing`, tone `action`);
- IT support when a check-in round is due (`asset_checkin_due`, tone `action`);
- IT support when a holder of assets is leaving or inactive (`asset_holder_leaving`, tone `action`).

Asset notifications SHALL link to `/equipment?open=<asset id>`, check-in notifications to `/equipment?round=<round id>`, and leaver notifications to `/equipment?holder=<employee id>`. Action items SHALL be settled when acted on: `asset_assigned` when the holder responds or the asset leaves them; `asset_handover_declined` and `asset_checkin_missing` when IT moves the asset or clears its flag; `asset_checkin_requested` when the holder has nothing pending in the round or the round closes; `asset_checkin_due` when a round starts; `asset_holder_leaving` when that employee holds no assets.

#### Scenario: Assigned
- **WHEN** IT assigns `DTG-LAP-0007` to Budi
- **THEN** Budi gets one `asset_assigned` notification with `needs_action = true` linking to `/equipment?open=<id>`, and IT gets nothing

#### Scenario: Confirmed settles the item
- **WHEN** Budi confirms `DTG-LAP-0007`
- **THEN** his `asset_assigned` notification has `resolved_at` set

#### Scenario: Transfer
- **WHEN** Budi's laptop is transferred to Ana
- **THEN** Ana gets `asset_assigned`, Budi gets `asset_released`, and Budi's unsettled `asset_assigned` for that laptop, if any, is settled

#### Scenario: Round requests per holder
- **WHEN** a round starts and Budi holds three items
- **THEN** Budi gets one `asset_checkin_requested` mentioning three items, and it is settled once he has answered all three

#### Scenario: Leaver settled
- **WHEN** IT has an open `asset_holder_leaving` for Rina and records the return of her last item
- **THEN** that notification has `resolved_at` set

