# performance-reviews

## ADDED Requirements

### Requirement: Scorecards are scored out of 130 using the documented factors

The system SHALL score a review by multiplying each KPI's weight by the
achievement factor for its 0–5 rating, where the factors are 0 %, 50 %, 75 %,
100 %, 115 % and 130 %. A template's weights SHALL sum to 100, so a scorecard
rated 3 throughout totals 100 and one rated 5 throughout totals 130.

#### Scenario: Every line meets target

- **WHEN** all ten KPIs are rated 3
- **THEN** the weighted total is 100.0
- **AND** the band is "2M — Meets Expectations"

#### Scenario: The worked example from the role documents

- **WHEN** a KPI weighted 20 % is rated 4 on an otherwise complete scorecard
- **THEN** that line contributes 23.0 points

### Requirement: A not-applicable KPI redistributes its weight

The system SHALL exclude a KPI marked not applicable and renormalise the
remaining weights to 100, rather than scoring it zero.

The role documents call for this where a KPI cannot be scored in a period — a
period with no qualifying events for post-event analysis, for instance. Scoring
the absence zero would penalise a quiet period.

#### Scenario: A quiet period does not cost the employee

- **GIVEN** a Monitoring scorecard with every line rated 3
- **WHEN** KPI 08, weighted 5 %, is marked not applicable
- **THEN** the total is 100.0, not 95.0
- **AND** the remaining effective weights sum to 100

### Requirement: An unfinished scorecard is not banded

The system SHALL withhold the band until every applicable KPI is rated, because
a partly-filled scorecard totals low and would otherwise read as a verdict on
the person rather than an unfinished form.

#### Scenario: Three of ten rated

- **WHEN** three KPIs are rated and seven are not
- **THEN** no band is returned
- **AND** the review reports 3 of 10 rated

### Requirement: Bonus tiers are distinct from performance bands

The system SHALL calculate the bonus multiplier from the weighted total using
the 2026 bonus workbook's tiers — below 85 → 0, 85–94 → 0.5, 95–104 → 1.0,
105–114 → 1.25, 115 and above → 1.5 — which are NOT the performance band
thresholds. Both SHALL be reported.

#### Scenario: Meets Expectations earning half a bonus

- **WHEN** the weighted total is 90
- **THEN** the band is "2M — Meets Expectations"
- **AND** the bonus multiplier is 0.5, "Half of target bonus"

### Requirement: A failed gate blocks any KPI-linked reward

The system SHALL recommend no KPI-linked reward, regardless of the score, where
the critical/integrity gate is not cleared or the role documents' hard gate has
been raised, and SHALL state which gate blocked it.

#### Scenario: Perfect score, failed gate

- **GIVEN** a scorecard totalling 130
- **WHEN** the critical/integrity gate is not cleared
- **THEN** no recommended bonus is returned
- **AND** the reason names the gate

### Requirement: Ratings lock on submission; reward figures do not

The system SHALL prevent changes to ratings once a review is submitted, and
SHALL continue to accept reward figures from either the assessor or the
approver at any status — the bonus workbook enters the approved salary
percentage after approval.

#### Scenario: Setting the bonus after submission

- **GIVEN** a submitted review
- **WHEN** the assessor changes a rating
- **THEN** the change is refused
- **WHEN** the assessor sets the target bonus amount
- **THEN** the change is accepted

### Requirement: The review chain is assessor then approver

Each review SHALL carry an assessor and an approver. The Acting Director
assesses the engineers and the CEO approves; for the Acting Director's own
review the two swap. Only the named approver may approve or return, and only a
submitted review may be approved. Returning SHALL require a reason.

#### Scenario: An assessor cannot approve their own assessment

- **GIVEN** a review the Acting Director assessed and submitted
- **WHEN** they attempt to approve it
- **THEN** the attempt is refused

### Requirement: Not everyone is assessed

The system SHALL allow an employee to be marked as not requiring review, with a
reason, and SHALL refuse to open a scorecard for them while it stands — the
founders are not assessed, and staff with under a year's service have nothing
meaningful to score.

#### Scenario: Opening a scorecard for a founder

- **GIVEN** an employee exempt with reason "Founder / Komisaris — not assessed"
- **WHEN** a reviewer opens a scorecard for them
- **THEN** the attempt is refused and the reason is returned

### Requirement: Salary and bonus figures are restricted to those who set or pay them

The system SHALL expose `current_basic_salary`, `target_bonus_amount` and
`approved_increase_pct` to the administrator, the executive and the finance
role only, and SHALL withhold them from everyone else including the subject of
the review. Finance SHALL receive these figures without the ratings and
comments that produced them — see `access-roles`.

#### Scenario: An employee reads their own review

- **WHEN** an employee reads a review
- **THEN** no salary or bonus figure is returned

#### Scenario: Finance reads the figure but not the appraisal

- **WHEN** a finance account reads a review
- **THEN** the salary and bonus figures are returned
- **AND** no per-KPI rating and no assessor comment is returned
