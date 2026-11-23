## ADDED Requirements

### Requirement: The asset register notifies the holder and IT
Asset events SHALL notify as follows, always excluding the person who acted:
- the new holder when an asset is assigned or transferred to them (`asset_assigned`, tone `action`);
- the previous holder when an asset is returned, transferred away from them, or found after being lost from them (`asset_released`);
- IT support when a holder says they did not receive an asset (`asset_handover_declined`, tone `action`);
- each holder with items when a check-in round starts (`asset_checkin_requested`, tone `action`), once per holder;
- holders still pending seven days into a round (`asset_checkin_reminder`);
- IT support when a holder answers "Not with me" (`asset_checkin_missing`, tone `action`);
- IT support when a check-in round is due (`asset_checkin_due`, tone `action`);
- IT support when a holder of assets is leaving or inactive (`asset_holder_leaving`, tone `action`).

Asset notifications SHALL link to `/equipment?open=<asset id>`, check-in notifications to `/equipment?round=<round id>`, and leaver notifications to `/equipment?holder=<employee id>`. Action items SHALL be settled when acted on: `asset_assigned` when the holder responds or the asset leaves them; `asset_handover_declined` and `asset_checkin_missing` when IT moves the asset or clears its flag; `asset_checkin_requested` when the holder has nothing pending in the round or the round closes; `asset_checkin_due` when a round starts; `asset_holder_leaving` when that employee holds no assets.

#### Scenario: Assigned
- **WHEN** IT assigns `DTG-LAP-0007` to Budi
- **THEN** Budi gets one `asset_assigned` notification with `needs_action = true` linking to `/equipment?open=<id>`, and IT gets nothing

#### Scenario: Confirmed settles the item
- **WHEN** Budi confirms `DTG-LAP-0007`
- **THEN** his `asset_assigned` notification has `resolved_at` set

#### Scenario: Transfer
- **WHEN** Budi's laptop is transferred to Ana
- **THEN** Ana gets `asset_assigned`, Budi gets `asset_released`, and Budi's unsettled `asset_assigned` for that laptop, if any, is settled

#### Scenario: Round requests per holder
- **WHEN** a round starts and Budi holds three items
- **THEN** Budi gets one `asset_checkin_requested` mentioning three items, and it is settled once he has answered all three

#### Scenario: Leaver settled
- **WHEN** IT has an open `asset_holder_leaving` for Rina and records the return of her last item
- **THEN** that notification has `resolved_at` set
