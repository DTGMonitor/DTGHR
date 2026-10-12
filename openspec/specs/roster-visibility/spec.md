# roster-visibility Specification

## Purpose
Who sees which rows of the roster, and which personal data it carries to whom: every member of staff sees the whole published roster, while former staff, leave reasons and colleagues' leave balances stay with administrators (and each person's own balance with them).
## Requirements
### Requirement: Every signed-in user sees all active staff on the roster

The system SHALL let every signed-in user see the published roster rows, totals
and cells of every active staff member, whatever their own work pattern. The
grid's name list and direct reads of roster cells SHALL follow the same rule.

#### Scenario: An office worker sees the crew
- **WHEN** an office-day employee opens a published month
- **THEN** the rotating crew's rows and cells are shown alongside the office-day
  staff

#### Scenario: A crew member sees the office
- **WHEN** a rotating crew member opens a published month
- **THEN** the office-day staff's rows and cells are shown

#### Scenario: Reading the cells directly
- **WHEN** a signed-in non-administrator reads `shift_assignments` through the API
- **THEN** cells of every active staff member in published months are returned

### Requirement: Former staff are visible to administrators only

The system SHALL show rows and cells of inactive employees only to
administrators, except that a person SHALL always see their own row.

#### Scenario: A leaver on the roster
- **WHEN** a non-administrator opens a month that holds cells of an inactive
  employee
- **THEN** that employee's row is not shown

#### Scenario: An administrator sees the leaver
- **WHEN** an administrator opens the same month
- **THEN** the inactive employee's row is shown

### Requirement: Leave reasons are visible to administrators only

The system SHALL return the list of approved leave requests, with their leave
types, in the schedule detail only to administrators. Other viewers SHALL receive
an empty list.

#### Scenario: A colleague's leave type
- **WHEN** a non-administrator loads a month in which a colleague has approved
  maternity leave
- **THEN** the response carries no leave list entry for that colleague, and the
  roster shows only the leave code on the cells

### Requirement: Leave balances are visible to their owner and administrators only

The system SHALL fill in the annual leave balance in the roster totals only on
the viewer's own row, unless the viewer is an administrator, who SHALL see every
balance. Other rows SHALL carry no balance, and the grid SHALL show a dash there
rather than a number.

#### Scenario: Own balance
- **WHEN** an employee opens a month
- **THEN** their own row shows their remaining annual leave

#### Scenario: A colleague's balance
- **WHEN** an employee opens a month
- **THEN** every colleague's row shows a dash where the balance would be

#### Scenario: An administrator
- **WHEN** an administrator opens a month
- **THEN** every row shows that person's balance

