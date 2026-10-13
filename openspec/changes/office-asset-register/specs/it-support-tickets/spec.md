## ADDED Requirements

### Requirement: A ticket can name the asset it concerns
IT support SHALL be able to link a ticket to one registered asset, change the link, or remove it. Linking or unlinking SHALL record a public event on the ticket naming the asset's tag, and a `ticket_linked` or `ticket_unlinked` event on the asset naming the ticket's reference. A ticket SHALL show its linked asset's tag and name to everyone who may see the ticket. The reporter SHALL NOT be able to link or unlink an asset. Retiring an asset SHALL NOT remove existing links.

#### Scenario: Link a laptop
- **WHEN** IT links ticket HW-0012 to `DTG-LAP-0007`
- **THEN** HW-0012 shows `DTG-LAP-0007` and its name, the ticket trail has a public event "Linked to DTG-LAP-0007", and the asset's history has `ticket_linked` with HW-0012

#### Scenario: Repair history
- **WHEN** `DTG-LAP-0007` has been linked to three tickets over a year
- **THEN** its history shows all three ticket references in the order they were linked

#### Scenario: Reporter tries to link
- **WHEN** the reporter of HW-0012 tries to link it to an asset
- **THEN** the request is refused

#### Scenario: Unlink
- **WHEN** IT removes the asset from HW-0012
- **THEN** HW-0012 shows no asset, and the asset's history has `ticket_unlinked` with HW-0012
