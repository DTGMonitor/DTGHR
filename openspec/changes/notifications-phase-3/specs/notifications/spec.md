## MODIFIED Requirements

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

### Requirement: Stale action items are resolved
Any status change on a source record that notifications are written for SHALL set `resolved_at` on every unresolved notification with `needs_action = true` for that `source_table` and `source_id`, written before that change, and SHALL record the user who made the change in `resolved_by` and their display name in `resolved_by_name` (both null when no user did, such as a scheduled job), and the source's new status in `resolved_status`. The name SHALL be stored because recipients cannot read other users' profiles. This SHALL apply whether or not the new status itself notifies anyone, and SHALL cover leave requests, payroll months, finance requests, KPI reviews, salary reviews, investigations, profile change requests and roster shift change requests; tickets when they leave the open, in-progress and waiting statuses; and investigation outcomes when their response status changes.

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

#### Scenario: Leave cancelled
- **WHEN** a pending leave request is cancelled
- **THEN** the approver's `leave_submitted` notification has `resolved_at` set and `resolved_status = 'cancelled'`

#### Scenario: Outcome notifications are not resolved
- **WHEN** a later event occurs on a source whose earlier notification has `needs_action = false`
- **THEN** that notification's `resolved_at` stays null

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

## ADDED Requirements

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
