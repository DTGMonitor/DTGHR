# purchasing Specification

## Purpose
Purchases above the petty-cash limit (Route 2 of the small-team purchasing procedure), and who sees what:
- requests in general terms;
- finance turning the items into priced lines;
- routing by value per vendor per month, and the evidence each tier needs;
- the approver's written approval, and urgent approvals given outside the platform;
- the order and the checker, who is never the requester or finance;
- the goods received note;
- the three-way match and payment through a linked finance request;
- the purchase file and history.

The requester tracks their request by milestone, and finance sees the detail.
## Requirements
### Requirement: Any employee raises a purchase request
Any active employee with an account SHALL be able to raise a purchase request in general terms:
- a title;
- what it is for;
- the date needed;
- an urgent flag;
- one or more requested items, each a short generic description (for example "monitor" or "peripherals") with a quantity greater than zero and an optional note of up to 1,000 characters. The note is where the requester states a preference or a minimum need, for example "Logitech wireless mouse" or "laptop with at least 16 GB RAM".

Finance SHALL see each requested item with its note beside the purchase lines while registering and sourcing. A note SHALL be a preference: finance MAY choose otherwise when sourcing. The requested item and its note SHALL stay as the requester wrote them.

The requester SHALL NOT be asked for prices, a vendor, specifications, a line type or a category. A request SHALL start as `draft`. Only its requester SHALL edit, delete or submit it, and only while it is `draft`. Submitting SHALL need at least one requested item. The same process SHALL apply whatever the requester's role, finance, IT and Peter included.

#### Scenario: Field engineer asks for a laptop and accessories
- **WHEN** Rina drafts "Site kit" with the items "laptop" × 1 (note: "at least 16 GB RAM, for running the monitoring software") and "peripherals" × 1 (note: "Logitech wireless mouse and keyboard"), and submits it
- **THEN** the request is `submitted`, Rina is its requester, it carries no prices and no purchase lines yet, and finance sees both items with their notes when registering it

#### Scenario: Somebody else's draft
- **WHEN** Budi tries to edit Rina's draft
- **THEN** the request is refused as not found

### Requirement: Finance details the purchase lines
The purchase lines SHALL be finance's. When finance registers a request, a purchase line SHALL be created from each requested item, with its description and quantity. From registration until the purchase is sent for approval, finance SHALL be able to:
- add, split, rewrite and remove lines;
- give each line a specification, a unit, a unit price of zero or more, and a type (`asset`, `inventory` or `expense`).

An `asset` line SHALL name an active asset category. An `inventory` line MAY name a client purchase order. The purchase's estimated total SHALL be the sum of its lines. The requested items SHALL stay as the requester wrote them.

#### Scenario: Peripherals split into what is bought
- **WHEN** finance turns Rina's "peripherals" × 1 into "Logitech MK270 keyboard and mouse" × 1 at 350,000 and "USB-C hub" × 1 at 450,000
- **THEN** the purchase has those two lines and an estimated total of 800,000, and Rina's requested item still reads "peripherals" × 1

#### Scenario: Asset line without a category
- **WHEN** finance makes a line an `asset` with no category
- **THEN** the change is refused with a validation error

### Requirement: Finance registers the request
Finance SHALL act on a `submitted` request in one of these ways:
- **register it:** the request gets the next reference `PR-<number>`, zero-padded to four digits. References SHALL never repeat or change. Finance SHALL record that budget is available (a required yes), MAY set the cost code, and the purchase lines are created from the requested items. The request moves to `sourcing`;
- **return it to the requester with a note:** it goes back to `draft`;
- **close it as petty cash:** finance gives its estimate of the cost, which SHALL be at or below the petty-cash limit. The request moves to `petty_cash`, which is final.

A request whose budget is not available SHALL NOT be registered. Finance SHALL either return it, or record Peter's written exception as a note and a document before registering it.

#### Scenario: Registered
- **WHEN** finance registers Rina's request, which is the first one, ticking budget available with cost code `OPS-2026`
- **THEN** it is `PR-0001` in `sourcing`, and its history shows `submitted` and `registered`

#### Scenario: Too small for a purchase
- **WHEN** finance closes a submitted request as petty cash with an estimate of 350,000
- **THEN** it is `petty_cash` and can't be changed again

#### Scenario: Petty cash refused above the limit
- **WHEN** finance tries to close a request as petty cash with an estimate of 2,000,000
- **THEN** the change is refused with a validation error

### Requirement: The route is set by value per vendor per month
The settings SHALL hold three limits in IDR: the petty-cash limit (default 500,000), the simple limit (default 5,000,000) and the quotation limit (default 50,000,000). Only Peter (role `executive`) SHALL change them, and each change SHALL be recorded with who and when. The route value SHALL be the purchase's amount plus the approved amounts of the same vendor's other purchases in the same calendar month (Asia/Jakarta), counting purchases from `approved` onwards and leaving out cancelled ones. The tier SHALL be:
- `simple` when the route value is at or below the simple limit;
- `quotation` when it is at or below the quotation limit;
- `contract` above that.

The tier SHALL be worked out again whenever the vendor or the amount changes, and stored when the purchase is sent for approval.

#### Scenario: Split order caught
- **WHEN** PT Sinar has a 4,000,000 purchase approved this month, and finance sends a second 3,000,000 purchase from PT Sinar for approval
- **THEN** its route value is 7,000,000 and its tier is `quotation`

#### Scenario: Next month starts again
- **WHEN** the same 3,000,000 purchase from PT Sinar is sent for approval in the following month, with no other PT Sinar purchases that month
- **THEN** its tier is `simple`

#### Scenario: Only Peter changes the limits
- **WHEN** finance tries to raise the simple limit to 10,000,000
- **THEN** the change is refused as forbidden

### Requirement: Evidence before approval
While a purchase is in `sourcing`, finance SHALL attach quotes, choose the vendor (an active vendor), set the amount to be approved, and answer whether anyone involved is related to the vendor. Before the purchase can be sent for approval, its tier SHALL have:
- `simple`: at least 1 quote;
- `quotation`: at least 2 quotes and a comparison sheet;
- `contract`: at least 3 quotes, a comparison sheet, the draft contract, and the date the shareholders were informed.

When the related-party answer is yes, a declaration SHALL be required: who is related and how. When a purchase is marked sole source, a written justification and a price benchmark note SHALL be required, and it MAY then go with a single quote at any tier. Sending for approval SHALL move the purchase to `awaiting_approval`.

#### Scenario: Not enough quotes
- **WHEN** finance sends a `quotation`-tier purchase for approval with one quote attached
- **THEN** the request is refused with a validation error naming what is missing

#### Scenario: Related party declared
- **WHEN** finance answers that the requester's brother owns the vendor, with no declaration text
- **THEN** sending for approval is refused, and once the declaration is written it goes through

#### Scenario: Sole source
- **WHEN** a 12,000,000 calibration service is marked sole source with a justification and a benchmark note, and one quote
- **THEN** it can be sent for approval

### Requirement: Peter approves the vendor and price in writing
Only Peter (role `executive`) SHALL act on a purchase in `awaiting_approval`:
- **approve:** records the approver, the time, the approved vendor and the approved amount, and moves the purchase to `approved`;
- **send back with a note:** returns it to `sourcing` for re-quoting or a revised specification;
- **reject with a reason:** moves it to `cancelled`.

The approval SHALL be the only way a non-urgent purchase reaches `approved`. When the approver is also the requester, the purchase SHALL be marked `self_approved`, shown on the purchase, and filterable in the register.

#### Scenario: Approved
- **WHEN** Peter approves `PR-0001` from PT Sinar for 14,800,000
- **THEN** it is `approved` with approved amount 14,800,000, and the history shows Peter's approval

#### Scenario: Finance can't approve
- **WHEN** finance tries to approve `PR-0001`
- **THEN** the request is refused as forbidden

#### Scenario: Peter's own purchase
- **WHEN** Peter raises a request, finance takes it through sourcing, and Peter approves it
- **THEN** it is `approved` and marked `self_approved`

### Requirement: Urgent purchases
A request marked urgent SHALL carry, from the requester, the approval Peter gave outside the platform:
- the channel (`whatsapp` or `phone`);
- when it was given;
- evidence: a screenshot document for WhatsApp, or a written call note for phone.

When finance registers an urgent request, finance SHALL enter the vendor and amount Peter approved and the purchase lines. The purchase SHALL go straight to `approved` with that vendor and amount, without quotes. The approval SHALL stay unconfirmed until Peter confirms it on the platform. An unconfirmed urgent purchase SHALL NOT be matched for payment. A request submitted more than 24 hours after the approval was given SHALL be marked `late_entry`, and nothing SHALL be refused because of it.

#### Scenario: Site emergency
- **WHEN** Peter approves a pump repair for 3,000,000 by WhatsApp at 08:00, and Rina submits it as urgent at 10:00 with the screenshot
- **THEN** once finance registers it, it is `approved`, not confirmed, and not marked as a late entry

#### Scenario: Match waits for Peter
- **WHEN** finance tries to match that purchase before Peter confirms
- **THEN** the request is refused with a validation error, and after Peter confirms, the match goes through

#### Scenario: Late entry
- **WHEN** an urgent request is submitted 30 hours after the approval
- **THEN** it is marked `late_entry`

### Requirement: Finance issues the order and names the checker
From `approved`, finance SHALL issue the order. The purchase gets the next order number `PO-<number>`, zero-padded to four digits, never repeated or changed. Finance SHALL name a checker, and the purchase moves to `ordered`. The checker SHALL be an active employee who is not the requester and whose role is not `finance`. Finance MAY change the checker while the purchase is `ordered`, under the same rule. The order SHALL have a print view showing the order number, vendor, lines, approved amount, and who approved it and when.

#### Scenario: Checker is the requester
- **WHEN** finance names Rina as the checker of Rina's purchase
- **THEN** the request is refused with a validation error

#### Scenario: Finance can't check
- **WHEN** finance names a user with the `finance` role as the checker
- **THEN** the request is refused with a validation error

#### Scenario: Ordered
- **WHEN** finance issues the order for `PR-0001` and names Budi
- **THEN** it is `ordered` with `PO-0001` and Budi as checker

### Requirement: The checker records the goods received
Only the named checker SHALL record the goods received note (GRN) of an `ordered` purchase. They SHALL record the quantity received and the condition for each line, attach at least one photo, and say whether the delivery matches the order and specification.
- **It matches:** the purchase moves to `received`, with the GRN date and the checker recorded.
- **It doesn't match:** a note is required, the purchase stays `ordered` for redelivery, and a `delivery_rejected` event is recorded.

A GRN SHALL NOT record more than the ordered quantity on any line.

#### Scenario: Accepted
- **WHEN** Budi records `PO-0001` as received in full and in good condition, with a photo, and says it matches
- **THEN** the purchase is `received`

#### Scenario: Rejected
- **WHEN** Budi records that the laptop came with the wrong RAM, with a note and a photo
- **THEN** the purchase stays `ordered`, and its history shows `delivery_rejected` with Budi's note

#### Scenario: No photo
- **WHEN** Budi records a GRN without a photo
- **THEN** the request is refused with a validation error

#### Scenario: Not the checker
- **WHEN** Rina tries to record the GRN for her own purchase
- **THEN** the request is refused as not found

### Requirement: Three-way match and hand-off to payment
For a `received` purchase, finance SHALL enter:
- the invoice number, invoice date and invoice total (including PPN);
- the PPN amount;
- the PPh withheld, if any;
- the invoice as a document;
- the tax invoice (faktur pajak) as a document whenever PPN is above zero.

The net payable SHALL be the invoice total minus the PPh withheld.

- **The invoice total is at or below the approved amount:** matching SHALL move the purchase to `matched`. In the same action it SHALL create a finance request linked to the purchase and submit it. That request has one `vendor` item for the net payable, a title naming the PR and PO numbers and the vendor, and notes with the vendor's bank account on file.
- **The invoice total is above the approved amount:** matching SHALL be refused. Finance SHALL either enter a corrected invoice, or ask Peter to approve the new amount. Asking moves the purchase to `amount_review`. Peter approving the new amount returns it to `received` with the new approved amount. Peter declining returns it to `received` unchanged.

A purchase SHALL NOT be matched while its urgent approval is unconfirmed.

#### Scenario: Clean match
- **WHEN** the invoice for `PR-0001` is 14,800,000 including 1,466,667 PPN, with no PPh, and both documents are attached
- **THEN** the purchase is `matched`, and a submitted finance request for 14,800,000 linked to `PR-0001` exists

#### Scenario: Service with PPh 23
- **WHEN** a service invoice is 11,100,000 with 200,000 PPh withheld
- **THEN** the linked finance request is for 10,900,000

#### Scenario: Invoice above approval
- **WHEN** the invoice is 15,500,000 against an approved 14,800,000
- **THEN** matching is refused, and after finance asks and Peter approves 15,500,000, the purchase is `received` and can be matched

#### Scenario: Missing tax invoice
- **WHEN** PPN is above zero and no faktur pajak is attached
- **THEN** matching is refused with a validation error

### Requirement: Payment of a linked finance request
A finance request linked to a purchase SHALL follow the existing finance-request chain: Peter approves (which authorises the bank release), and finance marks it paid. Its amount and items SHALL NOT be edited. When Peter sends it back, finance MAY add notes and documents and submit it again. It SHALL NOT be marked paid until at least one document (the transfer proof) is attached to it. Marking it paid SHALL move the purchase to `paid`, which is final, and record the payment date.

#### Scenario: No transfer proof
- **WHEN** finance tries to mark the linked request paid with no document attached
- **THEN** the request is refused with a validation error

#### Scenario: Paid
- **WHEN** Peter approves the linked request, finance attaches the transfer proof and marks it paid on 2026-12-03
- **THEN** the request is `paid`, and `PR-0001` is `paid` with payment date 2026-12-03

#### Scenario: Amount locked
- **WHEN** finance tries to change the item amount on the linked request
- **THEN** the request is refused with a validation error

### Requirement: Cancelling a purchase
The requester SHALL be able to cancel their request while it is `draft` or `submitted`. Finance SHALL be able to cancel a purchase in `sourcing`, `awaiting_approval`, `approved` or `ordered`, with a required reason. A cancellation SHALL be final. A purchase that is `received` or later SHALL NOT be cancelled.

#### Scenario: Cancelled after ordering
- **WHEN** finance cancels an `ordered` purchase with the reason "vendor can't deliver"
- **THEN** it is `cancelled`, and the reason is in its history

#### Scenario: Too late
- **WHEN** finance tries to cancel a `received` purchase
- **THEN** the request is refused with a validation error

### Requirement: One file per purchase
Each purchase SHALL keep its documents, each with a kind: `request`, `quote`, `comparison`, `contract`, `approval_evidence`, `budget_exception`, `delivery_photo`, `delivery_note`, `invoice`, `tax_invoice` or `other`.
- The requester SHALL add documents while the request is `draft` or `submitted`.
- Finance SHALL add documents at any stage up to `paid`.
- The checker SHALL add `delivery_photo` and `delivery_note` while recording the GRN.

A document SHALL be removable only by the person who added it, and only while the purchase is `draft`, `submitted` or `sourcing`. Files SHALL be stored privately and read only by people who can see the purchase.

#### Scenario: Quotes are kept
- **WHEN** finance tries to remove a quote after the purchase was sent for approval
- **THEN** the request is refused with a validation error

### Requirement: Append-only purchase history
Every action on a purchase SHALL record an event with the actor, the time, the status before and after, and a note where one was given. The events cover: created, submitted, returned, registered, closed as petty cash, quote added, vendor chosen, sent for approval, approved, sent back, rejected, urgent confirmed, ordered, checker changed, GRN accepted, delivery rejected, amount review asked, amount approved, amount declined, matched, paid and cancelled. Events SHALL NOT be edited or deleted. They SHALL be listed in the order they were written.

#### Scenario: Full trail
- **WHEN** `PR-0001` has gone from request to payment
- **THEN** its history reads, in order: created, submitted, registered, quote added, vendor chosen, sent for approval, approved, ordered, GRN accepted, matched, paid

### Requirement: Who sees what
- Finance, the director and Peter SHALL see every purchase in full.
- The requester SHALL follow their purchase in general terms only (see "The requester tracks progress by milestone"). They SHALL see their requested items as they wrote them, and SHALL NOT see:
  - finance's purchase lines or specifications;
  - the vendor;
  - any amount;
  - the checker;
  - the quotes, comparison, contract, invoice or tax documents;
  - the finance request;
  - the detailed history.
- The checker SHALL see each purchase they are named on, with its lines, quantities, vendor and order number, without prices.
- Everyone else SHALL get "not found".
- The register SHALL let full viewers filter by status, tier, vendor, requester, urgent, late entry, self-approved and related party, and search by PR number, PO number and title.

Each purchase SHALL carry the actions the caller may take next.

#### Scenario: Checker sees no prices
- **WHEN** Budi opens `PO-0001` as its checker
- **THEN** he sees the lines and quantities and no unit prices, amounts or quotes

#### Scenario: Requester sees no vendor, amounts or checker
- **WHEN** Rina opens her purchase `PR-0001`, which is ordered from PT Sinar for 14,800,000 with Budi as checker
- **THEN** she sees its milestone "Ordered", her requested items ("laptop" × 1, "peripherals" × 1) and the order number, and her copy contains no purchase lines, no vendor, no amount, no checker, and only the documents she attached herself

#### Scenario: Colleague
- **WHEN** Ana, who is neither requester nor checker, opens `PR-0001`
- **THEN** the request is refused as not found

### Requirement: The requester tracks progress by milestone
The requester's copy SHALL show a progress bar with five milestones, and the date each was reached:

| Milestone | Statuses |
|---|---|
| Submitted | `submitted`, `sourcing`, `awaiting_approval` |
| Approved | `approved` |
| Ordered | `ordered` |
| Delivered | `received`, `amount_review`, `matched` |
| Done | `paid` |

A purchase that has left the path SHALL show its outcome instead: "Returned to you" (`draft` after a return, with finance's note), "Not approved" (rejected, with the reason), "Cancelled" (with the reason), or "Petty cash". A rejected delivery SHALL keep the purchase at "Ordered". The requester's history SHALL list only the milestones and the outcomes, each with its date. The notes it shows SHALL be only those addressed to the requester: a return, a rejection or a cancellation.

#### Scenario: Waiting on approval looks like review
- **WHEN** Rina's purchase is in `sourcing` or `awaiting_approval`
- **THEN** her progress bar shows "Submitted" reached and "Approved" not yet reached, and nothing about quotes or the approver

#### Scenario: In payment looks delivered
- **WHEN** Rina's purchase is `matched`
- **THEN** her progress bar shows "Delivered" as the latest milestone, and nothing about the payment

#### Scenario: Redelivery
- **WHEN** the checker rejects the delivery of Rina's purchase
- **THEN** her progress bar still shows "Ordered"

### Requirement: Neutral wording
Every screen, history line, notification and error message SHALL name the approval step and the approver by role ("approval", "the approver") and not by a person's name. The status `awaiting_approval` SHALL read "Awaiting approval".

#### Scenario: Status label
- **WHEN** finance views a purchase in `awaiting_approval`
- **THEN** its status reads "Awaiting approval"

#### Scenario: Refusal message
- **WHEN** finance tries to approve a purchase
- **THEN** the refusal says that only the approver approves purchases, without naming anyone

