## ADDED Requirements

### Requirement: The director assigns roles
The system SHALL let the director change another account's role between `employee`, `finance` and `director`. The change SHALL go through a single server function. Every other caller SHALL be refused with `PT403`: the executive, finance, employees, and staff with the manage-people flag. The change SHALL take effect for the server's checks at once. The affected person's screens SHALL update on their next session refresh.

#### Scenario: Director makes someone finance
- **WHEN** the director sets Sari's role to `finance`
- **THEN** Sari's `users.role` is `finance`, her `is_superuser` is false, and the function returns her updated row

#### Scenario: Director makes someone director
- **WHEN** the director sets Budi's role to `director`
- **THEN** Budi's role is `director` and his `is_superuser` is true

#### Scenario: Someone other than the director tries
- **WHEN** the executive, a finance account, or an employee with the manage-people flag calls the function
- **THEN** it is refused with `PT403` and no role changes

#### Scenario: Setting the role it already has
- **WHEN** the director sets an account to the role it already holds
- **THEN** the function succeeds, nothing is logged and nobody is notified

### Requirement: The executive role is not assigned in the app
The system SHALL refuse any change that would grant `executive` to an account or take it away, with `PT403`, whoever the caller is. The executive is the final signature on pay and purchases, so a second executive SHALL NOT be creatable by the person whose work the executive approves.

#### Scenario: Granting executive
- **WHEN** the director sets an employee's role to `executive`
- **THEN** it is refused with `PT403`

#### Scenario: Removing executive
- **WHEN** the director sets Peter's role to `director`
- **THEN** it is refused with `PT403` and Peter remains `executive`

### Requirement: Guards on the target account
The system SHALL refuse a role change when any of these holds:
- the target is the caller's own account (`PT403`, "You cannot change your own role.");
- the target login is inactive (`PT422`);
- the target login has no linked employee record, or the linked employee record is inactive (`PT422`);
- the target does not exist (`PT404`).

A refused change SHALL leave the account untouched.

#### Scenario: Own role
- **WHEN** the director sets their own role to `employee`
- **THEN** it is refused with `PT403` and the message "You cannot change your own role."

#### Scenario: Login without a staff record
- **WHEN** the director sets the role of a login that no employee record is linked to
- **THEN** it is refused with `PT422`

#### Scenario: Deactivated employee
- **WHEN** the director sets the role of an account whose employee record is inactive
- **THEN** it is refused with `PT422`

### Requirement: The director sees everyone's role
The system SHALL provide the director with the role of every active login and the employee record each is linked to, so the Settings matrix can show one role per employee. An employee record with no login SHALL be shown as having no login and SHALL offer the existing Create account action instead of a role. Any caller other than the director SHALL be refused with `PT403`.

#### Scenario: Matrix row for a linked employee
- **WHEN** the director opens Settings
- **THEN** each active employee with a login shows their current role
- **AND** a row whose role is `executive` shows it locked, with no way to change it

#### Scenario: Employee without a login
- **WHEN** an active employee record has no `user_id`
- **THEN** its Role cell reads "No login" and offers Create account

#### Scenario: Not the director
- **WHEN** the executive calls the role list
- **THEN** it is refused with `PT403`

### Requirement: Confirm before removing the last finance holder
When the director changes the role of the only active account holding `finance` to something else, the Settings screen SHALL ask for confirmation before saving. The confirmation SHALL explain that finance requests and purchases will have nobody to prepare them. The server SHALL NOT refuse the change.

#### Scenario: Last finance holder
- **WHEN** Sari is the only active `finance` account and the director picks Employee for her
- **THEN** a confirmation explains that nobody will hold Finance, and the role changes only if the director confirms

#### Scenario: Another holder remains
- **WHEN** two active accounts hold `finance` and the director changes one of them
- **THEN** no confirmation is asked

### Requirement: Every role and activation change is recorded
The system SHALL write an `activity_logs` entry for every change to `public.users.role` and every change to `public.users.is_active`, however the change was made: the app, the SQL editor, the dashboard or a migration. The entry SHALL carry:
- the action `ROLE_CHANGED`, `ACCOUNT_DEACTIVATED` or `ACCOUNT_REACTIVATED`;
- the account as `target_user_id`;
- the actor (`auth.uid()`, null when no app user made the change);
- a description naming the account and, for a role, the old and new role.

The record SHALL be written by a trigger on the table, not by the app's function. A failure to write the log SHALL NOT undo the change.

#### Scenario: Change in the app
- **WHEN** the director changes Sari from `employee` to `finance`
- **THEN** one `ROLE_CHANGED` entry is written with the director as actor and a description "Sari Wulandari: Employee → Finance"

#### Scenario: Change in the SQL editor
- **WHEN** someone runs `update public.users set role = 'executive' where id = …` in the SQL editor
- **THEN** a `ROLE_CHANGED` entry is written with no actor and the old and new role in its description

#### Scenario: Deactivation
- **WHEN** an employee record is deactivated and its login is switched off
- **THEN** an `ACCOUNT_DEACTIVATED` entry is written for that login

#### Scenario: Who can read it
- **WHEN** the director or the executive opens the Activity log
- **THEN** the role change entries are listed
- **AND** the affected person sees the entries about their own account
