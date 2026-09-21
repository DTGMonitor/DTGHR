# schedule-visibility

## ADDED Requirements

### Requirement: Each crew sees only its own schedule

The system SHALL scope every read of shift data so that office staff see
office-day rows and the rotating crew see roster rows, and neither sees the
other. Scoping SHALL be enforced at the database rather than in application
code, so it holds for every query against the table and not only the ones that
remember to filter.

The team runs both schedules from one workbook: office staff carry a flat day
code, the rotating crew carry day, night and cross shifts.

#### Scenario: An office-day engineer opens the schedule

- **WHEN** an office-day employee reads a published schedule
- **THEN** no roster rows are returned
- **AND** their own row is returned

#### Scenario: A roster engineer opens the schedule

- **WHEN** a rotating-crew employee reads a published schedule
- **THEN** no office-day rows are returned

### Requirement: Leave and totals are scoped with the rows

Scoping SHALL cover the approved-leave overlay and the working-day totals as
well as the shift rows. Filtering the rows alone still discloses a colleague's
leave as a marked day and their working-day count.

#### Scenario: A colleague's leave is not disclosed

- **GIVEN** a roster engineer with approved leave in the period
- **WHEN** an office-day employee reads that schedule
- **THEN** no leave overlay for that engineer is returned
- **AND** no working-day total for that engineer is returned

### Requirement: The back-up engineer sees the roster as well

The system SHALL additionally return roster rows to an office-day employee
while they are designated the back-up engineer, and SHALL withdraw that
visibility when the designation is cleared.

The designation is a property of the employee rather than a named person, so
the access moves with the role.

#### Scenario: Back-up sees both schedules

- **GIVEN** an office-day employee designated as back-up
- **WHEN** they read a published schedule
- **THEN** both office-day and roster rows are returned

#### Scenario: Withdrawing the designation withdraws the access

- **GIVEN** the same employee
- **WHEN** the back-up designation is cleared
- **THEN** a subsequent read returns no roster rows

### Requirement: Administrators see every schedule

Administrators — those who arrange cover and receive leave requests — SHALL see
both schedules in full, and SHALL be the only accounts able to edit them.
Everyone else is read-only and proposes changes for review.

#### Scenario: Only administrators may edit

- **WHEN** a non-administrator attempts to write a shift assignment
- **THEN** the attempt is refused
- **AND** they may still submit a change proposal for their own row

### Requirement: Former staff are visible only to administrators

A record for someone who has left SHALL be retained for leave and roster
history, and SHALL be hidden from every account except an administrator's —
including from the employee directory, where any request to include inactive
records SHALL be ignored for non-administrators.

#### Scenario: A colleague cannot see a leaver

- **GIVEN** a deactivated employee with roster history
- **WHEN** any non-administrator reads the schedule or the directory
- **THEN** that employee does not appear

#### Scenario: An administrator retains the history

- **WHEN** an administrator opts to include inactive records
- **THEN** the deactivated employee appears
