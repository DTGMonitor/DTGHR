# leave-on-roster Specification

## Purpose
How approved leave becomes roster cells: each leave type's code, which days are written, approval, cancelling, the roster generator, and the go-live cutoff, under one rule for which days a leave takes.
## Requirements
### Requirement: Each leave type has one roster code

The system SHALL map every leave type to a single roster code: annual to AL, sick
to SL, study to ST, and every other type — maternity, miscarriage, paternity,
menstrual, marriage, child's marriage, child's ceremony, bereavement and
household bereavement — to SP. The mapping SHALL be defined in one place.

#### Scenario: Sick leave is SL
- **WHEN** an approved sick leave request is put on the roster
- **THEN** its cells hold SL

#### Scenario: A family or special type is SP
- **WHEN** an approved paternity, marriage or bereavement request is put on the roster
- **THEN** its cells hold SP

### Requirement: Approving a leave puts it on the roster

When a leave request is approved, the system SHALL mark it as on the roster and,
for each day in its range that is a leave day, SHALL replace every existing roster
cell of that employee on that day which holds a working code (DS, NS, C, D, TW, T)
with the leave type's code, remembering the code it replaced.

#### Scenario: A rostered crew member's sick leave
- **WHEN** a request for sick leave on two days rostered DS is approved
- **THEN** both cells become SL

#### Scenario: Days that are not leave days are left alone
- **WHEN** an approved request spans a day rostered B, O or PH
- **THEN** that cell keeps its code

#### Scenario: Days without a cell
- **WHEN** an approved request covers days for which no roster cell exists yet
- **THEN** no cell is created on approval

#### Scenario: Payroll and the dashboard see the leave
- **WHEN** a crew member's DS days are replaced by an approved leave in a published month
- **THEN** payroll's roster shift days for that month no longer count those days,
  and the dashboard lists the person as away rather than on shift on those days

### Requirement: Months generated later pick up approved leave

The roster generator SHALL write approved leave into the months it builds. When it
writes a working code on a day covered by an approved leave request that is on the
roster, the system SHALL write the leave type's code
instead and remember the pattern code. Overwriting a month SHALL NOT remove such
leave.

#### Scenario: A month generated after the approval
- **WHEN** a leave is approved for days in a month that has no roster yet, and the
  month is then generated
- **THEN** the leave days hold the leave code and the other days follow the pattern

#### Scenario: Regenerating a month keeps the leave
- **WHEN** a month holding leave cells is regenerated with overwrite on
- **THEN** the leave cells still hold the leave code

### Requirement: Cancelling an approved leave restores the roster

Cancelling an approved leave SHALL restore the roster. When an approved leave
request that is on the roster is cancelled, the system SHALL restore the remembered code on each cell that still holds the leave code it
wrote, and SHALL leave any cell that has been changed since untouched.

#### Scenario: Cancel restores the shifts
- **WHEN** an approved sick leave that replaced two DS cells is cancelled
- **THEN** both cells hold DS again

#### Scenario: A cell edited after approval is kept
- **WHEN** an administrator changes one of the leave's cells to NS and the leave is
  then cancelled
- **THEN** that cell stays NS and the other cells are restored

### Requirement: Only leave approved after go-live goes on the roster

The system SHALL put on the roster only leave requests approved after this
feature is deployed. Requests approved before it SHALL NOT be written to the
roster — neither on deployment nor when a month is generated later — and no
roster cell SHALL change when the feature is deployed.

#### Scenario: Leave approved before go-live
- **WHEN** a request approved before deployment covers days in a month generated
  after deployment
- **THEN** those days follow the pattern, not the leave

#### Scenario: Deployment changes no cell
- **WHEN** the migration runs
- **THEN** every roster cell holds the same code as before

### Requirement: Leave days are decided by one rule

The system SHALL decide leave days by a single rule. The days a leave request is
charged, the days written to the roster, and the days taken from the annual balance
SHALL all be decided by the same rule: for a
rotating crew member on a rostered day, the cell holds a working or leave code;
otherwise, the day is Monday to Friday and not a national holiday.

#### Scenario: Charged days equal written days
- **WHEN** a request is approved for a range covering rostered and unrostered days
- **THEN** the number of days whose cells were written, plus the number of
  unrostered leave days, equals the request's days requested

