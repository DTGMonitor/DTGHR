## ADDED Requirements

### Requirement: A fixed ticket keeps its fix
A ticket SHALL count as fixed when it has a `resolved_at`, whatever its current status. Moving a ticket from `resolved` to `closed` SHALL keep its `resolution`, its `resolved_at` and its resolver. Moving a ticket back to `open`, `in_progress` or `waiting` SHALL clear them. The history SHALL count a category's resolved tickets as those with a `resolved_at`, and its closed tickets as closed tickets without one, and SHALL attribute each fixed ticket to the actor of its last `resolved` event. Closed tickets whose fix was cleared before this requirement SHALL have it restored from their last `resolved` event, when no later event moved them back to a live status.

#### Scenario: Confirmed ticket keeps its fix
- **WHEN** IT resolves HW-0004 with "Replaced the charger" and the reporter confirms it
- **THEN** HW-0004 is `closed` with `resolution` "Replaced the charger", its `resolved_at` unchanged, and `resolved_by` the IT person who resolved it

#### Scenario: Resolver stats include closed tickets
- **WHEN** the history is read and one of Bintang's fixes has since been closed
- **THEN** that ticket is counted in Bintang's resolved total and in its category's resolved count

#### Scenario: Backfill from the trail
- **WHEN** the change is applied and a closed ticket has no `resolved_at` but its last status event is `resolved` with body "Router firmware updated"
- **THEN** its `resolution` is "Router firmware updated" and its `resolved_at` is that event's time

#### Scenario: Reopened ticket loses its fix
- **WHEN** a resolved ticket is moved back to `open`
- **THEN** its `resolution` and `resolved_at` are null

### Requirement: A reporter's reply hands a waiting ticket back to IT
When the reporter adds a public reply to a ticket in `waiting`, the system SHALL, in the same transaction, move the ticket to `in_progress` and record a status event from `waiting` to `in_progress`. A reply to a ticket in any other status SHALL NOT change its status. Every event written to a ticket SHALL set its `updated_at`.

#### Scenario: Reply while waiting
- **WHEN** a ticket is `waiting` and its reporter replies "Here is the error message"
- **THEN** the ticket is `in_progress`, and the trail has the comment followed by a status event waiting → in progress

#### Scenario: Reply while in progress
- **WHEN** a ticket is `in_progress` and its reporter replies
- **THEN** its status stays `in_progress` and its `updated_at` is the time of the reply

#### Scenario: IT reply does not move it
- **WHEN** a ticket is `waiting` and IT adds a public reply
- **THEN** its status stays `waiting`

### Requirement: The reporter confirms or disputes a fix
The reporter SHALL be able to move their own `resolved` ticket to `closed` (confirm), with an optional note. The reporter SHALL be able to move their own `resolved` ticket back to `open` (still broken), giving a reason that is required. Reopening SHALL record a `reopened` event with the reason as its body.

#### Scenario: Confirm
- **WHEN** the reporter confirms a resolved ticket without a note
- **THEN** the ticket is `closed`, its `closed_at` is set, and its fix is kept

#### Scenario: Still broken
- **WHEN** the reporter says a resolved ticket is still broken with the reason "VPN dropped again this morning"
- **THEN** the ticket is `open`, its fix is cleared, and the trail ends with a `reopened` event "VPN dropped again this morning"

#### Scenario: Still broken without a reason
- **WHEN** the reporter tries to reopen a resolved ticket with a blank reason
- **THEN** the request is refused with a validation error

#### Scenario: Someone else's ticket
- **WHEN** a member of staff who neither reported a ticket nor works the queue tries to confirm or reopen it
- **THEN** the request is refused as not found

### Requirement: Waiting and resolved tickets close themselves
While a ticket is `waiting` or `resolved`, it SHALL carry an auto-close deadline. The deadline SHALL be set to 5 days after the ticket enters either status. A public event on the ticket SHALL move the deadline to the later of its current value and 5 days from the event. An internal note SHALL NOT move it. Leaving both statuses SHALL clear it. Tickets in `open` or `in_progress` SHALL never close automatically. When less than one day remains before the deadline, a scheduled run SHALL notify the reporter, once per deadline. When the deadline has passed, the run SHALL move the ticket to `closed`, record a status event with no user and the actor name "Automatic", and keep any fix. A failure on one ticket SHALL NOT stop the run for the others. When the change is applied, tickets already `waiting` or `resolved` SHALL get a deadline 5 days from that moment.

#### Scenario: Quiet waiting ticket
- **WHEN** a ticket was moved to `waiting` 5 days ago and nothing public has happened since
- **THEN** the run closes it, with the event "Closed automatically: no reply before the deadline." by "Automatic", and the ticket has no `resolved_at`

#### Scenario: Quiet resolved ticket
- **WHEN** a ticket was resolved 5 days ago and nothing public has happened since
- **THEN** the run closes it and its `resolution` and `resolved_at` are unchanged

#### Scenario: Reply restarts the clock
- **WHEN** a ticket is `resolved` with a deadline in 1 day and the reporter replies
- **THEN** its deadline is 5 days from the reply and the reminder may be sent again

#### Scenario: Internal note does not count
- **WHEN** IT adds an internal note to a `waiting` ticket
- **THEN** its deadline is unchanged

#### Scenario: Day-before reminder
- **WHEN** the run executes and a ticket's deadline is less than one day away and no reminder has been sent
- **THEN** the reporter gets one `ticket_closing_soon` notification, and a later run before the deadline sends no second one

#### Scenario: In progress never closes
- **WHEN** a ticket has been `in_progress` for 30 days with no events
- **THEN** the run leaves it `in_progress`

#### Scenario: Existing tickets on deploy
- **WHEN** the change is applied and a ticket has been `waiting` for 20 days
- **THEN** it is not closed by the first run, and its deadline is 5 days after the change was applied

### Requirement: The auto-close deadline can be extended
The reporter, and anyone who works the queue, SHALL be able to extend a `waiting` or `resolved` ticket's deadline to a chosen moment that is later than the current deadline and no more than 30 days from now, with an optional reason. Extending SHALL record a public `extended` event naming the new date and the reason, and SHALL allow the reminder to be sent again before the new deadline. Extending a ticket in any other status SHALL be refused.

#### Scenario: Reporter extends by 10 days
- **WHEN** the reporter extends a resolved ticket by 10 days with the reason "On site until the 20th"
- **THEN** the deadline is 10 days from now and the trail shows the new date and "On site until the 20th"

#### Scenario: Beyond 30 days
- **WHEN** someone extends a deadline to 45 days from now
- **THEN** the request is refused with a validation error

#### Scenario: Shortening refused
- **WHEN** someone sets a deadline earlier than the current one
- **THEN** the request is refused with a validation error

#### Scenario: Not waiting or resolved
- **WHEN** someone tries to extend an `in_progress` ticket
- **THEN** the request is refused as a conflict

### Requirement: Closed tickets can be reopened or raised again
The reporter SHALL be able to reopen their own `closed` ticket within 14 days of it closing, giving a reason that is required. Reopening SHALL move the ticket to `open`, clear its fix and its `closed_at`, and record a `reopened` event. After 14 days, the reporter's reopen SHALL be refused. Anyone who works the queue SHALL be able to reopen a closed ticket at any time. Every move to `closed` SHALL set `closed_at`.

#### Scenario: Reopen within the window
- **WHEN** the reporter reopens a ticket that closed 6 days ago with the reason "It came back"
- **THEN** the ticket is `open` and the trail ends with a `reopened` event "It came back"

#### Scenario: Window passed
- **WHEN** the reporter tries to reopen a ticket that closed 20 days ago
- **THEN** the request is refused, and the page offers to raise it again instead

### Requirement: A ticket can be linked to the earlier one it comes back to
A ticket SHALL be able to name one earlier ticket as related. The reporter SHALL be able to name one when raising, but only a ticket they reported themselves. Anyone who works the queue SHALL be able to name, change or remove it at any time, and each change SHALL be recorded in the trail. A ticket SHALL NOT be linked to itself or to a ticket raised after it. Reading a ticket SHALL return its related ticket and the tickets that name it. For a viewer who does not work the queue, a linked ticket they did not report SHALL show only its reference and status. The history SHALL count, per category, the tickets that name a related ticket.

#### Scenario: Raise it again
- **WHEN** the reporter raises a new ticket from their closed NET-0014
- **THEN** the new ticket's related ticket is NET-0014, and reading NET-0014 lists the new ticket among those that name it

#### Scenario: Reporter links someone else's ticket
- **WHEN** a reporter raises a ticket naming a ticket raised by a colleague
- **THEN** the request is refused

#### Scenario: IT links a colleague's ticket
- **WHEN** IT links Ana's new ticket to Budi's older NET-0009 and Ana reads her ticket
- **THEN** she sees NET-0009 and its status, without its subject or fix

#### Scenario: Newer ticket refused
- **WHEN** IT tries to link a ticket to one raised after it
- **THEN** the request is refused with a validation error

### Requirement: IT can change a ticket's priority and category
Anyone who works the queue SHALL be able to change a ticket's priority and category. The ticket's reference SHALL NOT change. The change SHALL be recorded as one public event listing each field that changed, with its old and new value. A request that changes nothing SHALL be refused. The reporter SHALL NOT be able to change either field.

#### Scenario: Recategorised
- **WHEN** IT changes NET-0003 from Connectivity to Hardware and from Normal to High
- **THEN** the ticket's reference stays NET-0003, its category is `hardware`, and the trail shows "Priority: Normal → High · Category: Connectivity → Hardware"

#### Scenario: Reporter tries
- **WHEN** the reporter tries to change their ticket's priority
- **THEN** the request is refused as forbidden

### Requirement: IT can raise a ticket on someone's behalf
Every ticket SHALL record the channel it arrived by: `portal`, `whatsapp`, `in_person`, `phone` or `email`. A ticket raised by its own reporter SHALL be `portal`. Anyone who works the queue SHALL be able to raise a ticket with another active employee as its reporter, and SHALL then give a channel other than `portal`. The raised event SHALL have the person who logged it as its actor and SHALL name the reporter and the channel. Nobody else SHALL be able to name another reporter. The history SHALL show, for each of the last 6 months, the number of tickets raised by each channel.

#### Scenario: Logged from WhatsApp
- **WHEN** Bintang logs a ticket for Ana with channel `whatsapp`
- **THEN** Ana is its reporter, its channel is `whatsapp`, and the trail's first event is by Bintang and reads "Logged for Ana … from WhatsApp: …"

#### Scenario: Staff can't raise for others
- **WHEN** a member of staff who does not work the queue raises a ticket naming a colleague as reporter
- **THEN** the request is refused as forbidden

#### Scenario: Portal share
- **WHEN** in October 6 tickets were raised through the portal and 4 were logged from WhatsApp
- **THEN** the history's October row has total 10, portal 6 and whatsapp 4

### Requirement: Tickets carry who spoke last
Every ticket returned by the list and by a single read SHALL include `last_public_actor`, one of `reporter`, `support` or `system`, and `last_public_at`, both taken from the latest event that is not an internal note. The queue SHALL offer the orders Needs me, Priority, Oldest, Newest and Recently updated. For those who work the queue, Needs me SHALL be the default. Needs me SHALL rank, in this order: live tickets where the reporter spoke last, then untouched open tickets, then in-progress, then waiting, then resolved, then closed. Within each group it SHALL rank by priority, most urgent first, then oldest first. The chosen order SHALL be kept in the page URL.

#### Scenario: Reporter spoke last
- **WHEN** the reporter's reply moved a ticket back to `in_progress`
- **THEN** the ticket has `last_public_actor = 'reporter'` and appears above every untouched open ticket under Needs me

#### Scenario: Internal note is not "spoke last"
- **WHEN** the reporter replied and IT then added an internal note
- **THEN** `last_public_actor` is still `reporter`

#### Scenario: Order survives a reload
- **WHEN** IT chooses Priority and reloads the page
- **THEN** the queue is still ordered by priority
