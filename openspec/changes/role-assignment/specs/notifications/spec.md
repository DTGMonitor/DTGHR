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

### Requirement: The finance approval setting notifies the executives
When the director turns the "Director can approve finance requests" setting on or off, a `finance_settings_changed` notification SHALL be written for every active executive, with tone `reminder`, a headline saying whether the director can now approve finance requests or no longer can, details naming who changed it and what the setting now is, and a link to `/activity`. The notification SHALL NOT need action, and the director SHALL NOT be notified about their own change. Saving the value the setting already holds SHALL NOT notify.

#### Scenario: Switched on
- **WHEN** the director turns the setting on
- **THEN** Peter gets one `finance_settings_changed` notification with tone `reminder`, the headline "The director can now approve finance requests" and `needs_action = false`
- **AND** the director gets none

#### Scenario: Switched off
- **WHEN** the director turns the setting off
- **THEN** Peter gets one `finance_settings_changed` notification with the headline "The director can no longer approve finance requests"

#### Scenario: Saved unchanged
- **WHEN** the director saves the setting with the value it already holds
- **THEN** no `finance_settings_changed` notification is written
