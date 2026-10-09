## ADDED Requirements

### Requirement: The annual balance takes leave days only

The system SHALL deduct from an employee's annual leave balance each distinct date
that is either a roster cell holding AL or a leave day inside an approved annual
leave request. Weekends, Break days and national holidays inside a request SHALL
NOT be deducted unless the roster holds AL on them. The same count SHALL be used
by the leave balance card, the dashboard and the roster's balance column.

#### Scenario: A request across a weekend
- **WHEN** an office worker's annual leave from Friday to Monday is approved
- **THEN** the balance goes down by 2 days, the same as the days requested

#### Scenario: A rotating crew member's Break days
- **WHEN** an approved annual request for a crew member spans 4 DS days and 4 B days
- **THEN** the balance goes down by 4 days

#### Scenario: A date counted once
- **WHEN** a date is both an AL cell and inside an approved annual request
- **THEN** it is deducted once

#### Scenario: Leave approved before go-live
- **WHEN** an annual request approved before this change spans a weekend
- **THEN** its weekend days stop being deducted, and the balance rises by that many days
