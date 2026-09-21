# access-roles

## ADDED Requirements

### Requirement: Four roles, not an administrator flag

The system SHALL distinguish four roles — administrator, executive, finance and
employee — and SHALL NOT derive authority from a single `is_superuser` boolean.
Every rule below turns on which of the four an account holds.

Today the product knows only "administrator" and "everyone else", which cannot
express a finance role that reads compensation without approving leave, nor an
executive whose authority differs from the administrator's by domain rather
than by degree.

#### Scenario: A role is required

- **WHEN** an account is created without a role
- **THEN** it is treated as an employee
- **AND** no administrative capability is granted by default

### Requirement: Leave is approved by either the administrator or the executive

The system SHALL accept a leave approval from either the administrator or the
executive, and SHALL treat one approval as final — leave does not queue for a
second signature. The executive SHALL additionally be able to overturn a
decision the administrator has already made, and the reversal SHALL be recorded
against the request.

Cover has to be arranged the same day it is asked for. Requiring two signatures
would leave an engineer waiting on a director who is in the field.

#### Scenario: Either signature settles it

- **GIVEN** an employee's pending leave request
- **WHEN** the administrator approves it
- **THEN** the request is approved outright
- **AND** it does not appear in the executive's queue

#### Scenario: The executive overturns an approval

- **GIVEN** a leave request the administrator approved
- **WHEN** the executive rejects it
- **THEN** the request is rejected
- **AND** the activity trail records who reversed what, and when

#### Scenario: Nobody else may approve

- **WHEN** a finance or employee account attempts to approve leave
- **THEN** the attempt is refused

### Requirement: Compensation and performance need both signatures

The system SHALL require two approvals in sequence for a KPI review and for any
salary or bonus figure: the administrator first, then the executive as final
sign-off. A figure SHALL NOT take effect on the administrator's approval alone.

This is the opposite of the leave rule, deliberately. Leave is reversible and
urgent; pay is neither.

#### Scenario: One signature is not enough

- **GIVEN** a KPI review with an approved increase entered
- **WHEN** the administrator approves it
- **THEN** its status is awaiting the executive
- **AND** the increase is not yet in effect

#### Scenario: The executive completes the chain

- **GIVEN** that same review
- **WHEN** the executive approves it
- **THEN** the review is final
- **AND** the effective date is recorded

#### Scenario: The executive's own reviews

- **WHEN** a review is raised for the administrator
- **THEN** the executive assesses and the administrator does not sign off on it

### Requirement: Finance reads compensation and nothing else

The system SHALL grant the finance role the employee directory and the salary
and bonus figures, and SHALL withhold from it leave approval, employee record
editing, account creation, and the KPI ratings and written assessments that sit
behind a bonus.

Finance needs the number in order to pay it. It does not need the appraisal
that produced the number, and a written assessment is the most sensitive text
in the product.

#### Scenario: Finance reads a salary

- **WHEN** a finance account reads an employee's compensation
- **THEN** the basic salary, target bonus and approved increase are returned

#### Scenario: Finance cannot read the assessment

- **WHEN** a finance account reads a KPI review
- **THEN** no per-KPI rating and no assessor comment is returned

#### Scenario: Finance cannot act on people

- **WHEN** a finance account attempts to approve leave, edit an employee or create an account
- **THEN** each attempt is refused
