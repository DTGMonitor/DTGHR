## ADDED Requirements

### Requirement: Purchases notify the people who act next
Purchase events SHALL notify as follows, always excluding the person who acted, and linking to `/purchasing?open=<id>` (except IT's, which links to `/equipment?tab=awaiting`, since IT does not see the purchase itself):
- finance, when a request is submitted (`purchase_submitted`, tone `action`);
- the requester, when their request is returned (`purchase_returned`, tone `action`);
- Peter, when a purchase is sent for approval (`purchase_approval_needed`, tone `action`), and when finance asks him to approve a higher amount (`purchase_amount_review`, tone `action`);
- Peter, when an urgent purchase is registered and waits for his confirmation (`purchase_urgent_confirm`, tone `action`);
- finance, when Peter approves, sends back or rejects a purchase (`purchase_decided`);
- the checker, when they are named on an order (`purchase_check_needed`, tone `action`);
- Peter and finance, when a delivery is rejected (`purchase_delivery_rejected`);
- finance, when a GRN is accepted (`purchase_match_needed`, tone `action`);
- IT support, when a GRN is accepted with asset lines (`purchase_assets_to_register`, tone `action`);
- the requester, at each milestone the purchase reaches: approved, ordered and delivered (`purchase_progress`), and done, meaning paid (`purchase_closed`);
- the requester, when the purchase leaves the path: not approved, cancelled, or closed as petty cash (`purchase_closed`).

The requester SHALL NOT be notified of the steps in between: registration, sending for approval, a send-back, a rejected delivery, an amount review, or the match. A notification to the requester SHALL NOT name the vendor, any amount, the checker or the approver.

An action item SHALL be settled when its step is done or the purchase leaves the state that needed it:
- registering, returning, cancelling or closing as petty cash settles `purchase_submitted`;
- Peter's decision settles `purchase_approval_needed`;
- his confirmation settles `purchase_urgent_confirm`;
- his decision on the amount settles `purchase_amount_review`;
- the GRN, cancelling, or naming another checker settles `purchase_check_needed`;
- the match settles `purchase_match_needed`;
- registering the last asset from the purchase settles `purchase_assets_to_register`.

#### Scenario: Waiting on Peter
- **WHEN** finance sends `PR-0001` for approval
- **THEN** Peter gets one `purchase_approval_needed` with `needs_action = true`, and it is settled when he approves

#### Scenario: Requester hears milestones only
- **WHEN** Rina's purchase is registered, sent for approval, approved, ordered, received, matched and paid
- **THEN** Rina gets `purchase_progress` for approved, ordered and delivered and `purchase_closed` for paid, and none of them mentions the vendor or an amount

#### Scenario: Checker replaced
- **WHEN** finance names Ana instead of Budi as checker
- **THEN** Budi's `purchase_check_needed` is settled and Ana gets a new one

#### Scenario: Assets for IT
- **WHEN** the GRN for a purchase with two asset lines is accepted
- **THEN** IT support gets one `purchase_assets_to_register`, which is settled once both lines are fully registered
