# employee-profile

## ADDED Requirements

### Requirement: An employee record carries a full profile

The system SHALL hold personal details, emergency contact, Indonesian statutory
identifiers (NIK, NPWP, BPJS Kesehatan, BPJS Ketenagakerjaan), a payroll bank
account, and employment details including type, contract end date, level and
work location.

Every one of these fields SHALL be optional, so a record stays creatable from a
name, an email and a role, and is completed over time.

#### Scenario: Creating a record with the minimum

- **WHEN** an administrator creates an employee with name, email, department and position
- **THEN** the record is created and every profile field is empty

### Requirement: The profile is read by the directory, edited by administrators

The system SHALL allow any signed-in user to read an employee's profile, and
SHALL restrict editing to administrators.

#### Scenario: An employee edits their own record

- **WHEN** a non-administrator submits a change to any profile field
- **THEN** the change is refused

### Requirement: Salary figures are not held on the employee record

The profile SHALL carry the bank account a salary is paid into, and SHALL NOT
carry the salary itself. Compensation lives on the performance review, where it
is restricted to administrators.

#### Scenario: Reading a profile

- **WHEN** any user reads an employee profile
- **THEN** no salary amount is present in the response

### Requirement: Employee numbers encode the joining year only

The system SHALL generate employee numbers as `DTG-YY-NNN`, where `YY` is the
last two digits of the joining year and `NNN` is a sequence within that year.

Joining year is the only fact encoded, because it never changes. A department
would go stale on transfer; a date of birth would print personal data onto
every report that carries the number.

#### Scenario: The first hire of a year

- **WHEN** an employee joining in 2027 is created and no 2027 number exists
- **THEN** their number is `DTG-27-001`

#### Scenario: A deleted number is not reused

- **GIVEN** `DTG-27-001` and `DTG-27-003` exist and `DTG-27-002` was removed
- **WHEN** a further 2027 employee is created
- **THEN** their number is `DTG-27-004`

### Requirement: Administrators may set an employee number by hand

The system SHALL allow an administrator to overwrite an employee number with
any value, and generation SHALL tolerate values that do not match the scheme
rather than failing or reusing a number.

#### Scenario: A hand-written number is skipped by the generator

- **GIVEN** `DTG-27-001` and a hand-entered `DTG-27-INTERN`
- **WHEN** a further 2027 employee is created
- **THEN** their number is `DTG-27-002`

### Requirement: An employee may have a photo

The system SHALL store one photo per employee in private object storage, served
by signed URL, with the employee record holding only the object key. Uploads
SHALL be restricted to administrators and limited to JPEG, PNG or WebP.

Images SHALL be downscaled in the browser before upload, so a camera photo does
not become the stored object.

#### Scenario: No photo set

- **WHEN** an employee has no photo
- **THEN** the profile reports that, and the interface shows their initials

#### Scenario: An unsupported file

- **WHEN** an administrator uploads a file that is not JPEG, PNG or WebP
- **THEN** the upload is refused and the supported formats are named
