## MODIFIED Requirements

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

## ADDED Requirements

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
