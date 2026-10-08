## MODIFIED Requirements

### Requirement: Bell dropdown
Activating the bell SHALL open a panel listing the ten most recent notifications, newest first. Each item SHALL show the tone accent, the eyebrow, the headline, and the time it arrived as a relative time. Unread items SHALL be visually distinct. Resolved items that needed action SHALL appear muted, labelled with how and by whom they were settled — "Approved by <name>", "Rejected by <name>", "Sent back by <name>", "Cancelled", "Closed by <name>" and so on, from `resolved_status` and `resolved_by_name` — falling back to "No action needed" when neither is known. The panel SHALL offer "Mark all read" and a link to the full notifications page, close on Escape or an outside click, and be operable by keyboard.

#### Scenario: Opening an item
- **WHEN** the user selects an unread item whose link path is `/leaves?open=<id>`
- **THEN** the item is marked read, the panel closes, and the app navigates to `/leaves?open=<id>`, where that request is shown

#### Scenario: Resolved by someone
- **WHEN** an item was settled by Nurhuda Teguh Santoso approving the request
- **THEN** it is shown muted with the label "Approved by Nurhuda Teguh Santoso"

#### Scenario: Resolved without a known actor
- **WHEN** an item's `resolved_at` is set and `resolved_by_name` and `resolved_status` are null
- **THEN** it is shown muted with the label "No action needed"

#### Scenario: Empty
- **WHEN** the user has no notifications
- **THEN** the panel says "You're all caught up"

### Requirement: Notifications page
The app SHALL provide a `/notifications` page listing all of the user's notifications newest first, loading more on demand. It SHALL offer filters for "All", "Unread" and "Needs action" (unresolved notifications with `needs_action = true`, read or not), selectable by the URL query `?filter=all|unread|action`, and "Mark all read". Each item SHALL show its headline, details and note in full, how and by whom it was settled when it was, and the link.

#### Scenario: Unread filter
- **WHEN** the user selects "Unread"
- **THEN** only notifications with no `read_at` are listed

#### Scenario: Needs action filter
- **WHEN** the user opens `/notifications?filter=action`
- **THEN** the "Needs action" filter is selected and only unresolved notifications with `needs_action = true` are listed, including ones already read and red "sent back to you" items

#### Scenario: Paging
- **WHEN** the user has more than one page of notifications and scrolls to the end
- **THEN** the next page loads

### Requirement: Needs-action summary on the dashboard
The dashboard SHALL add one sentence summarising the user's open action items that its existing live lines do not already cover. Kinds the band already states for everyone (`ticket_raised`, `investigation_review`, `investigation_issued`, `investigation_revised`, `investigation_sent_back`, `payroll_changes_requested`, `finance_sent_back`) SHALL be excluded for all users; for users who see the live approvals sentence (management), the kinds it covers (`leave_submitted`, `payroll_submitted`, `payroll_endorsed`, `payroll_returned`, `salary_submitted`, `kpi_submitted`, `finance_submitted`, `finance_submitted_cc`, `finance_sent_back_director`) SHALL also be excluded. The sentence SHALL name up to three items by their headline and count the rest, link to `/notifications?filter=action`, and SHALL NOT appear when there are no such items. The existing live approvals sentence SHALL remain unchanged.

#### Scenario: Named manager outside management
- **WHEN** a manager who is not in management has two open `leave_submitted` items
- **THEN** the dashboard shows a sentence naming both, linking to `/notifications?filter=action`

#### Scenario: Requests the band does not say
- **WHEN** a director has an open `profile_request_submitted` item and an open `shift_change_proposed` item
- **THEN** the dashboard sentence names both

#### Scenario: No duplicates of the live lines
- **WHEN** a director has an open `leave_submitted` item and an open `investigation_review` item
- **THEN** the leave appears only in the live approvals sentence, the investigation only in the band's investigation line, and no summary sentence is shown

#### Scenario: Nothing open
- **WHEN** the user has no open action items outside the live lines' kinds
- **THEN** no summary sentence is shown

## ADDED Requirements

### Requirement: Pages open the item named in the URL
The IT support, finance requests, payroll and salary pages SHALL open the item named in their URL when they load and whenever the URL changes: `/support?open=<ticket id>` opens that ticket's panel, `/finance-requests?open=<id>` expands that request and scrolls it into view, `/payroll?month=<id>` selects that month, and `/salary?open=<id>` scrolls to that review and highlights it briefly. An id the viewer cannot see, or that no longer exists, SHALL leave the page as it would be without it and say the item could not be found. Closing the opened item SHALL remove the parameter from the URL.

#### Scenario: Ticket from a notification
- **WHEN** IT support opens `/support?open=<id>` from a notification
- **THEN** the tickets list loads with that ticket's panel open

#### Scenario: Unknown id
- **WHEN** a user opens `/finance-requests?open=<id>` for a request they cannot see
- **THEN** the page shows its usual list and a message that the request could not be found

#### Scenario: Back closes it
- **WHEN** the user closes the opened ticket panel
- **THEN** the URL returns to `/support` and the browser's back button returns to where they came from

### Requirement: Leave request detail panel
`/leaves?open=<id>` SHALL open a panel over the leave page showing that request: who asked, the leave type, dates, days, reason, status, and a timeline of when it was submitted and when and by whom it was decided, with the reviewer's note. The panel SHALL offer approve and reject to someone who may review it while it is pending, and cancel to the requester while it can be cancelled, using the existing leave functions. It SHALL be readable by the requester and by anyone who may review the request; for anyone else it SHALL say the request could not be found. On narrow screens it SHALL take the full width. Closing it SHALL remove the parameter from the URL.

#### Scenario: Approver opens it
- **WHEN** the director opens `/leaves?open=<id>` for a pending request they may review
- **THEN** the panel shows the request and offers Approve and Reject

#### Scenario: Approving from the panel
- **WHEN** the director approves from the panel with a note
- **THEN** the request is approved, the panel shows the decision in its timeline, and the list behind it updates

#### Scenario: Requester sees their own
- **WHEN** the requester opens their own pending request
- **THEN** the panel shows it with Cancel and without Approve or Reject

#### Scenario: Not theirs to see
- **WHEN** an employee opens `/leaves?open=<id>` for a colleague's request they may not review
- **THEN** the panel says the request could not be found
