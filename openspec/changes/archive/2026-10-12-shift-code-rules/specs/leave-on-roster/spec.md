## MODIFIED Requirements

### Requirement: Each leave type has one roster code

The system SHALL map every leave type to a single roster code, held in the
`leave_type_codes` table: annual to AL, sick to SL, study to ST, and every other
type — maternity, miscarriage, paternity, menstrual, marriage, child's marriage,
child's ceremony, bereavement and household bereavement — to SP. Every mapped code
SHALL be an away code. A type with no row SHALL map to SP.

#### Scenario: Sick leave is SL
- **WHEN** an approved sick leave request is put on the roster
- **THEN** its cells hold SL

#### Scenario: A family or special type is SP
- **WHEN** an approved paternity, marriage or bereavement request is put on the roster
- **THEN** its cells hold SP

#### Scenario: A type mapped to a new code
- **WHEN** a migration adds an away code and maps maternity to it
- **THEN** an approved maternity request is put on the roster with that code, with
  no change to any function

### Requirement: Leave days are decided by one rule

The system SHALL decide leave days by a single rule. The days a leave request is
charged, the days written to the roster, and the days taken from the annual balance
SHALL all be decided by the same rule: for a rotating crew member on a rostered day,
the cell holds a code marked working or leave in `shift_codes`; otherwise, the day
is Monday to Friday and not a national holiday.

#### Scenario: Charged days equal written days
- **WHEN** a request is approved for a range covering rostered and unrostered days
- **THEN** the number of days whose cells were written, plus the number of
  unrostered leave days, equals the request's days requested

#### Scenario: A permitted absence is not charged
- **WHEN** a request covers a rostered day that holds ST, which is away but neither
  working nor leave
- **THEN** that day is not charged
