# asset-register Specification

## Purpose
The office asset register: generated tags and categories, the statuses an asset moves between and who may move it, the holder's confirmation of a handover, editing, the append-only history, who sees what (IT manages; finance and management read everything; staff see what they hold), and telling IT about leavers who still hold items.
## Requirements
### Requirement: Assets are registered with a generated tag
IT support SHALL register an asset by giving at least a category and a name. The system SHALL give it a tag of the form `DTG-<category code>-<number>`, where the number is the category's next number, zero-padded to four digits. Tags SHALL be unique, SHALL never change after registration (not even when the category is corrected), and SHALL never be reused. A serial number, when given, SHALL be unique across assets, ignoring case and surrounding spaces; a blank serial number SHALL be stored as none. An asset SHALL be registered `in_store` unless an employee to assign it to is given at registration, in which case it SHALL be registered and then assigned as one action. Registration SHALL record a `registered` event.

#### Scenario: First laptop
- **WHEN** IT registers "ThinkPad T14 Gen 4" in category Laptop (code LAP) and no laptop has been registered before
- **THEN** the asset's tag is `DTG-LAP-0001`, its status is `in_store`, and its history has one `registered` event by that IT person

#### Scenario: Numbers continue per category
- **WHEN** `DTG-LAP-0001` and `DTG-LAP-0002` exist and IT registers a monitor and then a laptop
- **THEN** the monitor is `DTG-MON-0001` and the laptop is `DTG-LAP-0003`

#### Scenario: Duplicate serial
- **WHEN** an asset with serial `PF3X9K2` exists and IT registers another with serial ` pf3x9k2 `
- **THEN** the registration is refused with a validation error

#### Scenario: Register and assign
- **WHEN** IT registers a laptop and names Budi as the person to assign it to
- **THEN** the asset is `assigned` to Budi with the handover pending, and its history is `registered` followed by `assigned`

#### Scenario: Category corrected later
- **WHEN** IT changes the category of `DTG-ACC-0004` to Monitor
- **THEN** its tag stays `DTG-ACC-0004`

### Requirement: Categories
Each category SHALL have a code of two to four capital letters, a name, whether it tracks calibration, and whether it is active. The system SHALL start with the categories Laptop (LAP), Desktop (DSK), Monitor (MON), Phone / tablet (PHN), Printer / scanner (PRN), Network (NET), Accessory (ACC), Furniture (FUR), Sensor (SEN, tracks calibration) and Other (OTH). IT support SHALL be able to add categories and rename or deactivate them. A category's code SHALL NOT change once an asset uses it. An inactive category SHALL NOT take new assets, and its existing assets SHALL still display it.

#### Scenario: New category
- **WHEN** IT adds the category "Camera" with code CAM
- **THEN** the next camera registered is tagged `DTG-CAM-0001`

#### Scenario: Code in use
- **WHEN** IT tries to change the code of Laptop while laptops are registered
- **THEN** the change is refused with a validation error

### Requirement: Asset statuses and the moves between them
An asset SHALL be in exactly one of `in_store`, `assigned`, `in_repair`, `retired` or `lost`. Only IT support SHALL move an asset, and only by these moves:
- **assign:** from `in_store`, to `assigned` with a holder;
- **transfer:** from `assigned`, to `assigned` with a different holder;
- **return:** from `assigned`, to `in_store`, clearing the holder;
- **send to repair:** from `in_store` or `assigned`, to `in_repair`, keeping any holder;
- **back from repair:** from `in_repair`, to `assigned` when it has a holder (keeping its handover state), otherwise to `in_store`;
- **mark lost:** from any status except `retired`, to `lost`, keeping any holder, with a required note;
- **mark found:** from `lost`, to `in_store`, clearing the holder;
- **retire:** from `in_store`, `in_repair` or `lost`, to `retired`, clearing any holder (the event records whom it was with), with a required reason. An `assigned` asset SHALL be returned first.

`retired` SHALL be final. Any other move SHALL be refused with a validation error. Every move SHALL record one event with the statuses and holders before and after, the actor and the note. Every move SHALL clear a flag on the asset, and the event SHALL say so.

#### Scenario: Repair and back to the same person
- **WHEN** Budi's confirmed laptop is sent to repair and later brought back from repair
- **THEN** it is `assigned` to Budi again, still confirmed, and its history shows `repair_out` and `repair_back`

#### Scenario: Retiring a held item
- **WHEN** IT tries to retire a laptop that is `assigned` to Budi
- **THEN** the request is refused with a validation error, and the laptop must be returned first

#### Scenario: Retired is final
- **WHEN** IT tries to assign a retired monitor
- **THEN** the request is refused with a validation error

#### Scenario: Lost without a note
- **WHEN** IT marks a laptop lost with a blank note
- **THEN** the request is refused with a validation error

#### Scenario: Staff cannot move assets
- **WHEN** an employee who is not IT support tries to return the laptop they hold
- **THEN** the request is refused

### Requirement: The holder confirms the handover
When an asset is assigned or transferred to an employee, the handover SHALL be pending until that employee responds. The holder SHALL be able to confirm receipt, which SHALL record a `confirmed` event and the time of confirmation. The holder SHALL be able to say they did not receive it, giving a required note, which SHALL record a `declined` event and flag the asset to IT as `handover_declined` without changing its status or holder. Only the current holder SHALL respond, and only while the handover is pending. IT SHALL be able to clear a flag with a note, which SHALL record a `flag_cleared` event.

#### Scenario: Confirm
- **WHEN** IT assigns `DTG-LAP-0007` to Budi and Budi confirms
- **THEN** the asset is `assigned` to Budi with a confirmation time, and its history ends with `confirmed` by Budi

#### Scenario: Didn't receive it
- **WHEN** Budi says he did not receive `DTG-LAP-0007` with the note "Still with Rina"
- **THEN** the asset is still `assigned` to Budi, it is flagged `handover_declined` with that note, and its history ends with `declined`

#### Scenario: Someone else responds
- **WHEN** Ana tries to confirm an asset assigned to Budi
- **THEN** the request is refused as not found

#### Scenario: Transfer needs a new confirmation
- **WHEN** Budi's confirmed laptop is transferred to Ana
- **THEN** the handover is pending until Ana responds

### Requirement: Asset details can be edited
IT support SHALL be able to edit an asset's category, name, brand, model, serial number, location, purchase date, purchase value, currency, warranty date, calibration due date and notes, but never its tag, status or holder. Each edit that changes something SHALL record one `edited` event listing the changed fields with their old and new values, except that a change to the purchase value or currency SHALL be listed only as "Purchase value changed", without figures. An edit that changes nothing SHALL be refused.

#### Scenario: Serial corrected
- **WHEN** IT changes the serial of `DTG-LAP-0002` from empty to `PF3X9K2`
- **THEN** the history ends with an `edited` event naming the serial change

#### Scenario: Value change hides the figures
- **WHEN** IT changes the purchase value of `DTG-LAP-0002` from 18,000,000 to 18,500,000
- **THEN** the `edited` event's text says "Purchase value changed" and contains neither figure

### Requirement: Every asset has an append-only history
Every event on an asset SHALL be kept with its kind, actor (or none for a scheduled job), the actor's name, the statuses and holders before and after, the holder's name at the time, any linked ticket, the note and the time. Events SHALL never be changed or deleted. The history SHALL be shown in the order the events were written, even when two events share a timestamp.

#### Scenario: Two events in one action
- **WHEN** IT registers an asset and assigns it in the same action
- **THEN** the history shows `registered` before `assigned`, even if both have the same timestamp

#### Scenario: Holder name kept
- **WHEN** a former employee held an asset and their record is later renamed or deactivated
- **THEN** the asset's history still shows the name they had at the time of each event

### Requirement: Who may see and manage the register
IT support (whoever works the IT ticket queue: staff with the IT support flag and the manager of IT support) SHALL manage the register. IT support, finance and management (the director, executives and staff with the management flag) SHALL see every asset, including purchase values, its full history and its flags. Every other employee SHALL see only the assets they currently hold, including pending handovers, with tag, category, name, brand, model, serial number, the date they became the holder and the handover state, and only the events since they became the holder; they SHALL NOT see purchase values, location, or earlier holders. Asking for an asset the caller may not see SHALL be refused as not found.

#### Scenario: Finance reads values
- **WHEN** a finance user opens `DTG-LAP-0002`
- **THEN** they see its purchase value and full history, and no move buttons are offered

#### Scenario: My equipment
- **WHEN** Budi, who holds two laptops and one pending monitor, opens My equipment
- **THEN** he sees three items, the monitor marked as waiting for his confirmation, and no purchase value on any of them

#### Scenario: Earlier holders hidden
- **WHEN** Ana holds a laptop that Budi held before her
- **THEN** Ana's view of its history starts at her assignment and does not name Budi

#### Scenario: Someone else's asset
- **WHEN** an employee asks for an asset held by a colleague
- **THEN** the request is refused as not found

### Requirement: IT is told about leavers who still hold items
Once a day, the system SHALL find every employee who holds at least one asset (`assigned`, or `in_repair` with them as holder; a lost asset does not count) and who is either inactive or has a contract ending within the next 14 days: the end date on their employee record or on an active manpower contract, whichever is earlier. For each, it SHALL notify IT support once per employee, reason and end date, naming the person, the reason and the items they hold. A changed end date SHALL be notified afresh. The register SHALL list "Leaving with items" by the same rule, worked out when it is read.

#### Scenario: Contract ending
- **WHEN** Rina's manpower contract ends in 10 days and she holds a laptop and a phone
- **THEN** IT gets one `asset_holder_leaving` notification naming Rina, "Contract ends" with the date, and both items, and the next day's run sends no second one

#### Scenario: Contract extended
- **WHEN** Rina's contract end date is moved and the new date is again within 14 days
- **THEN** IT is notified again for the new date

#### Scenario: Leaver with nothing
- **WHEN** an employee is deactivated and holds no assets
- **THEN** no notification is written

