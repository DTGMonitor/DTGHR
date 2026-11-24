## ADDED Requirements

### Requirement: Assets bought through a purchase
When a purchase's goods received note is accepted, each `asset` line SHALL wait on an "awaiting registration" list for IT support. The list SHALL show the purchase reference, the order number, the line description, its category, the unit price, the quantity received, how many have been registered from it, and the GRN date. A line SHALL leave the list once as many assets have been registered from it as were received. IT SHALL be able to register an asset from a waiting line. The registration SHALL be filled in from the line: category, name, purchase date (the GRN date) and purchase value (the unit price). IT MAY change any of these before saving. The asset SHALL keep the link to its purchase line, and both the asset and its `registered` event SHALL show the purchase reference. Registering more assets from a line than were received SHALL be refused. Assets registered without a purchase SHALL work as before.

#### Scenario: Laptop arrives
- **WHEN** Budi accepts the delivery of `PR-0001`, which has one Laptop line, quantity 1, at 14,800,000
- **THEN** IT sees that line on the awaiting-registration list

#### Scenario: Registered from the line
- **WHEN** IT registers the laptop from that line
- **THEN** it gets the next Laptop tag, its purchase value is 14,800,000, its purchase date is the GRN date, it shows `PR-0001`, and the line leaves the list

#### Scenario: Too many
- **WHEN** IT tries to register a second asset from a line with quantity received 1
- **THEN** the request is refused with a validation error

#### Scenario: Not for staff
- **WHEN** an employee who is not IT support asks for the awaiting-registration list
- **THEN** the request is refused as not found
