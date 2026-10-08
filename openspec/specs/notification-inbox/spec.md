# notification-inbox Specification

## Purpose
The in-app experience: the header bell on desktop, the drawer entry and dot on smaller screens, live updates, the notifications page, the dashboard's needs-action sentence and the email preference.
## Requirements
### Requirement: Header bell with unread badge
At the `lg` breakpoint and wider, where the sidebar is permanent, every signed-in page SHALL show a bell in the header. When the user has unread notifications, the bell SHALL show a badge with the unread count, displayed as "9+" above nine. The bell SHALL have an accessible label that includes the unread count. The bell SHALL NOT be shown below `lg`, and the sidebar SHALL NOT carry a notifications entry at `lg` and wider.

#### Scenario: Unread items
- **WHEN** a user on a desktop-width screen has three unread notifications
- **THEN** the bell shows a badge reading "3" and its label reads "Notifications, 3 unread"

#### Scenario: Nothing unread
- **WHEN** a user has no unread notifications
- **THEN** the bell shows no badge

### Requirement: Notifications in the drawer below lg
Below the `lg` breakpoint, the navigation drawer SHALL show a "Notifications" entry at its top with the unread count as a badge (capped at "9+"), linking to `/notifications`. While the user has unread notifications, the drawer toggle button in the header SHALL show a red dot (the danger colour, ringed in the header background) without a number, and its accessible label SHALL include the unread count.

#### Scenario: Unread on a phone
- **WHEN** a user on a 390px-wide screen has three unread notifications
- **THEN** the drawer toggle shows a red dot, its label reads "Open navigation, 3 unread notifications", and opening the drawer shows "Notifications" with a badge reading "3"

#### Scenario: Opening from the drawer
- **WHEN** the user taps the Notifications entry in the drawer
- **THEN** the drawer closes and the app navigates to `/notifications`

#### Scenario: Nothing unread on a phone
- **WHEN** the user has no unread notifications
- **THEN** the drawer toggle shows no dot and the entry shows no badge

### Requirement: Live updates
The unread badge and any open list SHALL update without a page reload when a notification for the user is created, read or resolved, using a Supabase Realtime subscription limited to the user's own rows.

#### Scenario: New notification arrives
- **WHEN** a leave request is submitted for the user's approval while they have the app open
- **THEN** the badge count increases within a few seconds without reloading

#### Scenario: Read in another tab
- **WHEN** the user marks all read in another tab
- **THEN** the badge clears in this tab

### Requirement: Bell dropdown
Activating the bell SHALL open a panel listing the ten most recent notifications, newest first. Each item SHALL show the tone accent, the eyebrow, the headline, and the time it arrived as a relative time. Unread items SHALL be visually distinct. Resolved action items SHALL appear muted, labelled "No action needed". The panel SHALL offer "Mark all read" and a link to the full notifications page, close on Escape or an outside click, and be operable by keyboard.

#### Scenario: Opening an item
- **WHEN** the user selects an unread item whose link path is `/leaves`
- **THEN** the item is marked read, the panel closes, and the app navigates to `/leaves`

#### Scenario: Resolved item
- **WHEN** an item's `resolved_at` is set
- **THEN** it is shown muted with the label "No action needed"

#### Scenario: Empty
- **WHEN** the user has no notifications
- **THEN** the panel says "You're all caught up"

### Requirement: Notifications page
The app SHALL provide a `/notifications` page listing all of the user's notifications newest first, loading more on demand. It SHALL offer filters for "All", "Unread" and "Needs action" (open action items, read or not), selectable by the URL query `?filter=all|unread|action`, and "Mark all read". Each item SHALL show its headline, details and note in full, and the link.

#### Scenario: Unread filter
- **WHEN** the user selects "Unread"
- **THEN** only notifications with no `read_at` are listed

#### Scenario: Needs action filter
- **WHEN** the user opens `/notifications?filter=action`
- **THEN** the "Needs action" filter is selected and only unresolved `action` notifications are listed, including ones already read

#### Scenario: Paging
- **WHEN** the user has more than one page of notifications and scrolls to the end
- **THEN** the next page loads

### Requirement: Needs-action summary on the dashboard
The dashboard SHALL add one sentence summarising the user's open action items that its existing live lines do not already cover. Kinds the band already states for everyone (`ticket_raised`, `investigation_review`, `investigation_issued`, `investigation_revised`) SHALL be excluded for all users; for users who see the live approvals sentence (management), the kinds it covers (`leave_submitted`, `payroll_submitted`, `payroll_endorsed`, `salary_submitted`, `kpi_submitted`, `finance_submitted`, `finance_sent_back_director`) SHALL also be excluded. The sentence SHALL name up to three items by their headline and count the rest, link to `/notifications?filter=action`, and SHALL NOT appear when there are no such items. The existing live approvals sentence SHALL remain unchanged.

#### Scenario: Named manager outside management
- **WHEN** a manager who is not in management has two open `leave_submitted` items
- **THEN** the dashboard shows a sentence naming both, linking to `/notifications?filter=action`

#### Scenario: No duplicates of the live lines
- **WHEN** a director has an open `leave_submitted` item and an open `investigation_review` item
- **THEN** the leave appears only in the live approvals sentence, the investigation only in the band's investigation line, and no summary sentence is shown

#### Scenario: Nothing open
- **WHEN** the user has no open action items outside the live sentence's kinds
- **THEN** no summary sentence is shown

### Requirement: Email toggle on My profile
My profile SHALL show an "Email me about notifications" switch reflecting the user's `email_notifications` preference, explaining that in-app notifications continue either way. Changing it SHALL save immediately and confirm the change.

#### Scenario: Switching off
- **WHEN** the user switches email off
- **THEN** the preference is saved and the switch stays off after reload

