# notifications Specification

## Purpose
The notification record: one row per person per event with a structured payload, who receives it, read state, how action items are settled when their source moves on, and retention.
## Requirements
### Requirement: Notification record per recipient
The system SHALL store every notification as one row in `public.notifications` per recipient per event, holding the recipient's user id, `kind`, `source_table`, `source_id`, a structured `payload`, `created_at`, `read_at` and `resolved_at`. The in-app record SHALL be written whether or not the recipient receives an email.

#### Scenario: Leave request notifies the approver
- **WHEN** an employee submits a leave request and their manager is the approver
- **THEN** exactly one `notifications` row is written for the manager, with kind `leave_submitted`, `source_table = 'leave_requests'` and `source_id` the request's id

#### Scenario: Several recipients
- **WHEN** a ticket is raised and three active IT support staff exist
- **THEN** three `notifications` rows are written, one per staff member, with the same payload

### Requirement: Structured payload
The payload SHALL be a JSON object with `tone` (one of `action`, `success`, `danger`, `reminder`), `eyebrow`, `headline`, optional `intro`, `details` as an ordered array of `[label, value]` pairs, optional `note` (`{ by?, text }`) for text a person wrote, and `link` (`{ label, path }`). All strings SHALL be finished, human-readable English. Empty details, an empty note and blank intro SHALL be omitted.

#### Scenario: Rejected leave carries the reviewer's note
- **WHEN** a manager rejects a leave request with the note "Clashes with the site visit"
- **THEN** the requester's notification has tone `danger`, details including the leave type and dates, and `note.text` equal to "Clashes with the site visit"

#### Scenario: No reviewer note
- **WHEN** a leave request is approved without a note
- **THEN** the payload has no `note` key

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
Any status change on a source record that notifications are written for SHALL set `resolved_at` on every unresolved notification with tone `action` for that `source_table` and `source_id`, before any notification for the new status is written. This SHALL apply whether or not the new status itself notifies anyone, and SHALL cover leave requests, payroll months, finance requests, KPI reviews, salary reviews and investigations; tickets when they leave the open, in-progress and waiting statuses; and investigation outcomes when their response status changes.

#### Scenario: Leave approved by someone else
- **WHEN** a leave request notified the manager (action) and the director approves it
- **THEN** the manager's `leave_submitted` notification has `resolved_at` set

#### Scenario: Final approval that notifies nobody
- **WHEN** the executive approves an endorsed payroll month and no notification is written for that transition
- **THEN** the executive's `payroll_endorsed` notification for that month has `resolved_at` set

#### Scenario: KPI scorecard approved
- **WHEN** an approver approves a submitted KPI scorecard
- **THEN** the approver's `kpi_submitted` notification has `resolved_at` set

#### Scenario: Sent back creates a fresh action
- **WHEN** finance submits payroll, the director sends it back, and finance resubmits
- **THEN** the director's first `payroll_submitted` item is resolved and a new unresolved one is written for the resubmission

#### Scenario: Ticket closed
- **WHEN** an open ticket is closed
- **THEN** every IT support `ticket_raised` notification for that ticket has `resolved_at` set

#### Scenario: Leave cancelled
- **WHEN** a pending leave request is cancelled
- **THEN** the approver's `leave_submitted` notification has `resolved_at` set

#### Scenario: Outcome notifications are not resolved
- **WHEN** a later event occurs on a source whose earlier notification has tone `success`
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
The system SHALL provide a function returning the calling user's open action items, meaning their notifications with tone `action` and no `resolved_at`, read or unread, newest first, with an optional list of kinds to exclude.

#### Scenario: Read but unresolved
- **WHEN** a user has read a `ticket_raised` notification and the ticket is still open
- **THEN** it is included in their open action items

#### Scenario: Excluding kinds
- **WHEN** the function is called excluding `leave_submitted`
- **THEN** no `leave_submitted` items are returned

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

