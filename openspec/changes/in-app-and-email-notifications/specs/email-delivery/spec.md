## ADDED Requirements

### Requirement: Email follows the notification
For every new notification whose recipient has `email_notifications = true`, the system SHALL queue exactly one `email_outbox` row referencing that notification by `notification_id`, with the recipient's address and name, the subject, and the kind.

#### Scenario: Opted-in recipient
- **WHEN** a notification is written for a user with email turned on
- **THEN** one outbox row exists with `notification_id` set to that notification

#### Scenario: Opted-out recipient
- **WHEN** a notification is written for a user with email turned off
- **THEN** no outbox row is queued for it

### Requirement: Rendering at send time
The `send-notifications` Edge Function SHALL render the email from the notification's payload when it sends a row that has a `notification_id`, and SHALL store the HTML and plain text it rendered on the outbox row. Rows without a `notification_id` (written before this change) SHALL be sent with their stored `body_html`, unchanged.

#### Scenario: New-style row
- **WHEN** the function claims a row with a `notification_id`
- **THEN** it sends HTML rendered from that notification's payload and records it in `body_html`

#### Scenario: Legacy row
- **WHEN** the function claims a row with no `notification_id` and a stored `body_html`
- **THEN** it sends that stored HTML

### Requirement: Email layout
The rendered email SHALL use a single table-based layout that renders in desktop Outlook: a dark navy header band with the "DTG People" wordmark as text, the eyebrow, the headline, the greeting to the recipient by name, the optional intro, the details as a two-column table, the optional note as a quoted block attributed to its author when known, one button linking to the public site URL plus the payload's `link.path`, the same address as plain text below the button, and a footer stating that it is an automatic notification. The tone SHALL set the accent colour: signal green for `action` and `success`, danger red for `danger`, gold for `reminder`. The email SHALL contain no images. Every value from the payload SHALL be HTML-escaped.

#### Scenario: Danger tone
- **WHEN** a `leave_rejected` notification is rendered
- **THEN** the accent bar and eyebrow use the danger colour and the reviewer's note appears as a quoted block

#### Scenario: Escaping
- **WHEN** a ticket subject contains `<script>`
- **THEN** the rendered email shows it as text and contains no `<script>` element

#### Scenario: Link
- **WHEN** a payload's link path is `/leaves` and the public site URL is `https://dtghr-fe.vercel.app`
- **THEN** the button and the plain-text address both point to `https://dtghr-fe.vercel.app/leaves`

### Requirement: Delivery and retries
The function SHALL send through Microsoft Graph `sendMail` as the configured sender, take at most 25 unsent rows per run oldest first, retry a failed row on later runs up to five attempts in all, and keep the last error on the row. A row SHALL never be sent twice.

#### Scenario: Transient failure
- **WHEN** Graph returns an error for a row on its first attempt
- **THEN** the row stays unsent with `attempts = 1` and the error in `last_error`, and is retried on the next run

#### Scenario: Exhausted
- **WHEN** a row has failed five times
- **THEN** it is no longer claimed

### Requirement: Email preference is the user's to change
A user SHALL be able to read and change their own `email_notifications` preference through a function that changes only that column for the calling user.

#### Scenario: Turning email off
- **WHEN** a user turns email off
- **THEN** their `email_notifications` is false and later notifications for them queue no email
