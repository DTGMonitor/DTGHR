## ADDED Requirements

### Requirement: Role changes notify the executive and the person
When the director changes an account's role through the app, a `role_changed` notification SHALL be written:
- for every active executive, with tone `reminder`, details naming the person, the old role and the new role, and a link to `/activity`;
- for the person whose role changed, with tone `success` when they gain `finance` or `director` and `reminder` otherwise, saying which role they now hold and that it applies after they refresh or log in again, with a link to `/`.

Neither notification SHALL need action. The director SHALL NOT be notified about their own change. A role changed outside the app (for example in the SQL editor) SHALL be recorded in the activity log but SHALL NOT notify. A call that leaves the role unchanged SHALL NOT notify.

#### Scenario: Someone becomes finance
- **WHEN** the director changes Sari from `employee` to `finance`
- **THEN** Peter gets one `role_changed` notification with tone `reminder` and details "Person: Sari Wulandari", "From: Employee", "To: Finance", with `needs_action = false`
- **AND** Sari gets one `role_changed` notification with tone `success`, saying she now has the Finance role
- **AND** the director gets none

#### Scenario: Someone loses finance
- **WHEN** the director changes Sari from `finance` to `employee`
- **THEN** Sari's `role_changed` notification has tone `reminder`

#### Scenario: Changed in the SQL editor
- **WHEN** a role is changed by an `update` statement in the SQL editor
- **THEN** no `role_changed` notification is written
