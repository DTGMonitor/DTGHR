## ADDED Requirements

### Requirement: IT starts a check-in round
IT support SHALL be able to start a check-in round with a name and a due date, defaulting to "Check-in <month year>" and 14 days from the start. Only one round SHALL be open at a time. Starting a round SHALL create one pending item for every asset that is `assigned`, `in_store` or `in_repair` at that moment, recording the asset's holder (none for unheld assets). Lost and retired assets SHALL NOT be included.

#### Scenario: Start
- **WHEN** 30 assets are assigned, 8 are in store, 1 is in repair and 2 are retired, and IT starts a round
- **THEN** the round has 39 pending items, 30 of them with a holder

#### Scenario: Second open round
- **WHEN** a round is open and IT tries to start another
- **THEN** the request is refused with a validation error

### Requirement: Holders answer for their items
Each holder SHALL be able to answer each of their pending items in the open round with "I have it" or "Not with me". "I have it" SHALL mark the item `confirmed` and record a `checkin_confirmed` event on the asset; if the asset's handover was still pending, it SHALL also count as confirming the handover. "Not with me" SHALL require a note, mark the item `missing`, record a `checkin_missing` event, and flag the asset to IT as `checkin_missing` without changing its status or holder. Only the item's holder SHALL answer it, and only while the round is open.

#### Scenario: I have it
- **WHEN** Budi answers "I have it" for `DTG-LAP-0007` in the open round
- **THEN** the item is `confirmed` with Budi and the time, and the asset's history ends with `checkin_confirmed`

#### Scenario: Pending handover confirmed by check-in
- **WHEN** Ana's handover of `DTG-MON-0003` is still pending and she answers "I have it" in the round
- **THEN** the item is `confirmed` and the handover is confirmed too

#### Scenario: Not with me
- **WHEN** Budi answers "Not with me" for `DTG-PHN-0002` with the note "Gave it back to IT in August"
- **THEN** the item is `missing`, the asset is still assigned to Budi and flagged `checkin_missing`, and IT is notified

#### Scenario: Not with me without a note
- **WHEN** Budi answers "Not with me" with a blank note
- **THEN** the request is refused with a validation error

#### Scenario: Someone else's item
- **WHEN** Ana tries to answer an item held by Budi
- **THEN** the request is refused as not found

### Requirement: IT marks unheld items as seen
IT support SHALL be able to mark any pending item in the open round as `seen`, with an optional note. This SHALL record a `checkin_seen` event on the asset. When IT moves an asset while its item in the open round is pending, the item SHALL become `seen` by that IT person.

#### Scenario: Store shelf
- **WHEN** IT marks the in-store monitor `DTG-MON-0005` as seen
- **THEN** its item is `seen` by that IT person and its history ends with `checkin_seen`

#### Scenario: Returned during the round
- **WHEN** Budi's laptop has a pending item and IT records its return during the round
- **THEN** the item is `seen` by that IT person

### Requirement: Holders are reminded once
Seven days after a round starts, a scheduled run SHALL notify each holder who still has pending items in it, once per round. Nothing SHALL happen automatically when the due date passes; a round past its due date SHALL be shown as overdue.

#### Scenario: Reminder
- **WHEN** a round started 7 days ago and Budi still has one pending item
- **THEN** Budi gets one `asset_checkin_reminder`, and later runs send no second one

#### Scenario: Nothing pending
- **WHEN** a round started 7 days ago and Ana has answered all her items
- **THEN** Ana gets no reminder

### Requirement: IT closes a round and its summary is kept
IT support SHALL be able to close the open round at any time. Closing SHALL mark every pending item `no_reply`, record who closed it and when, and store the counts of confirmed, missing, seen and no-reply items. Closed rounds and their items, with who answered each and when, SHALL stay readable by everyone who may see the whole register, and SHALL NOT change after closing.

#### Scenario: Close with gaps
- **WHEN** IT closes a round with 35 confirmed, 1 missing, 2 seen and 1 still pending
- **THEN** the pending item is `no_reply` and the round's summary reads 35 confirmed, 1 missing, 2 seen, 1 no reply

#### Scenario: Answer after closing
- **WHEN** a holder tries to answer an item in a closed round
- **THEN** the request is refused with a validation error

#### Scenario: Finance reads an old round
- **WHEN** a finance user opens last year's round
- **THEN** they see every item with its state, who answered and when

### Requirement: IT is reminded when a round is due
A scheduled run SHALL notify IT support when no round is open and either the last round started more than 182 days ago, or there has never been a round and the first asset was registered more than 182 days ago. It SHALL NOT send this reminder more than once in 30 days. Starting a round SHALL settle it.

#### Scenario: Six months on
- **WHEN** the last round started 183 days ago and none is open
- **THEN** IT gets one `asset_checkin_due` notification, and the next day's run sends no second one

#### Scenario: Round open
- **WHEN** a round is open
- **THEN** no `asset_checkin_due` is sent, however long ago the last one started
