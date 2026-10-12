## ADDED Requirements

### Requirement: Each code's meaning is held in the table

The system SHALL hold, for each shift code, whether it is a working day, leave,
away, a field day, part of a rotation, and an off day, as columns of
`shift_codes`. Every function and screen that applies one of these rules SHALL
read the column rather than keep its own list of codes. A code with none of them
set SHALL count as none of them.

#### Scenario: The fourteen codes' meanings
- **WHEN** the migration has run
- **THEN** working is DS, NS, C, D, TW and T; leave is AL, SL, DL and SP; away is
  AL, SL, DL, SP and ST; field day is DS and NS; in rotation is DS, NS, C, D and B;
  and off is O and B

#### Scenario: A new code means nothing until marked
- **WHEN** a code is added without any meaning set
- **THEN** it is not counted as worked, not charged as leave, not shown as away,
  not paid as a field day and not continued in a rotation

### Requirement: Worked days include travel work and training

The system SHALL count every working code, including TW and T, as a worked day:
in the roster's Total days, its public-holiday loading, and the number of people
on duty each day.

#### Scenario: Travel work counts in Total days
- **WHEN** an employee's month holds 10 DS days and 2 TW days
- **THEN** their Total days is 12

#### Scenario: Training on a national holiday earns loading
- **WHEN** an employee is rostered T on a national holiday
- **THEN** that day counts towards their public-holiday loading

### Requirement: Study leave shows as away

The dashboard SHALL list as away anyone whose published roster holds an away
code that day, including ST. ST SHALL NOT be charged as leave: a leave request
covering an ST day is not charged for it.

#### Scenario: Someone on study leave
- **WHEN** an employee's published roster holds ST today
- **THEN** the dashboard lists them as away

#### Scenario: Annual leave over a study day
- **WHEN** an annual leave request spans a day the roster already holds as ST
- **THEN** that day is not counted in the request's days or deducted from the balance

### Requirement: Field days are the shift codes only

Payroll's roster shift days and a back-up engineer's access to the roster SHALL
count only field-day codes, DS and NS.

#### Scenario: Travel work earns no shift day
- **WHEN** a back-up engineer's published month holds 4 DS days and 2 TW days
- **THEN** payroll's roster shift days for that month are 4

### Requirement: Dashboard labels come from the table

Every label the dashboard shows for a code SHALL be that code's label in
`shift_codes`.

#### Scenario: Special leave in the week strip
- **WHEN** an employee's week includes an SP day
- **THEN** the week strip labels it "Special leave"
