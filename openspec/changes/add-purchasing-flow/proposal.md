# Purchasing flow

## Why

Purchases are agreed by WhatsApp and phone, and nothing on the platform
connects the request, the quotes, the approval, the delivery and the
payment. Finance only sees a purchase once it has to be paid. By then
nobody can show who approved the vendor and the price, who checked that
the goods arrived, or whether the invoice matches what was ordered.

The company adopted a purchasing procedure for an 11-person company (the
"Purchasing flowchart for small team" document). It keeps two pairs of
duties apart:

- approving money is kept apart from recording money: Peter approves and
  releases payments, and finance keeps the books;
- buying is kept apart from receiving: a second employee, never the
  requester, checks the goods in.

Doing this by hand depends on everyone remembering the rules. The platform
can enforce them.

## What Changes

The procedure has two routes, chosen by value:

- **Route 1, petty cash:** up to Rp 500,000.
- **Route 2, purchase:** above Rp 500,000.

This change builds **Route 2**. Petty cash comes in the next change.

- **Purchase request.** Any employee raises one:
  - what, why, the date needed, and one or more lines;
  - each line is typed **asset** (kept by the company and registered by IT),
    **inventory** (a product bought to sell) or **expense** (a service or
    something used up).

  Every request follows the same process, whatever the requester's role,
  Peter's own included.
- **Register.** Finance numbers the request (`PR-0001`), ticks that budget
  is available, and records a cost code. A request at or below the
  petty-cash limit is closed as "petty cash". Finance can also return a
  request to the requester for more detail.
- **Route by value.** The tier is worked out from the purchase plus the
  same vendor's other purchases in the same month, so splitting an order
  doesn't lower it. Each tier asks for different evidence:

  | Value | Tier | Evidence |
  |---|---|---|
  | > 500k – 5M | Simple | 1 quote |
  | > 5M – 50M | Quotation | 2 quotes and a comparison sheet |
  | > 50M | Contract | 3 quotes, a comparison sheet, the contract, and shareholders informed |

  The limits are settings that only Peter can change.
- **Before approval.** Finance attaches the quotes, picks the vendor and the
  amount, and answers "is anyone involved related to the vendor?". A
  related party or a sole source needs a written justification.
- **Peter's approval.** Peter approves the vendor and the price in writing,
  on the platform. He can instead send it back for re-quoting or reject it.
  A purchase Peter both requested and approved is marked as such so it
  stays visible.
- **Order.** Finance issues a numbered order (`PO-0001`) and names the
  checker. The checker is any active employee who is neither the requester
  nor finance.
- **Goods received note (GRN).** The checker records what arrived, with a
  photo, and either accepts the delivery or rejects it (returned to the
  vendor). A rejection tells Peter the same day.
- **Three-way match.** Finance enters the invoice and the tax figures (PPN
  and PPh) and checks the PO, the GRN and the invoice against each other.
  - An invoice above the approved amount stops the purchase until the
    invoice is corrected or Peter approves the new amount.
  - A clean match creates and submits a **finance request** for the net
    amount payable, linked to the purchase. The existing chain takes over
    from there: Peter approves, which authorises the bank release, and
    finance marks it paid.
  - A purchase-linked request can only be marked paid once the transfer
    proof is attached.
- **Urgent purchases.** Peter gives approval by WhatsApp or phone first.
  The request is recorded with that evidence (a screenshot or a call note)
  and skips quoting. Peter then confirms the approval on the platform, and
  the purchase can't be matched for payment until he has. A purchase
  recorded more than 24 hours after the approval is marked as a late entry.
- **Where bought items go.**
  - Asset lines that are received appear on an **"awaiting registration"**
    list for IT. IT registers them in the asset register, and each asset
    keeps a link back to its purchase line.
  - Inventory lines are tagged with the item, quantity, unit cost, and an
    optional client PO the product is for. Nothing tracks stock yet; a
    later inventory change picks these lines up.
  - Expense lines end at the GRN.
- **Vendor list.** Each vendor has a name, NPWP, whether it is PKP, contact
  details, and a bank account. Finance adds vendors. Once a vendor exists,
  only Peter can change its bank account, and he must record the callback
  he made to confirm it.
- **One file per purchase.** Every document (request, quotes, comparison,
  contract, approval evidence, delivery photo, invoice, tax document) is
  kept on the purchase. Every step is recorded in an append-only history.
- **The requester asks in general terms.** A request lists generic items
  ("monitor" × 2, "peripherals" × 1) with a quantity and an optional note. It
  has no prices, vendor, specification or line type. Finance turns the items
  into the purchase lines when registering and sourcing: it details, splits
  and prices them and gives each a type and category. Those lines never
  reach the requester.
- **The requester tracks; finance sees the detail.** The requester follows
  their purchase on a five-step progress bar (Submitted, Approved, Ordered,
  Delivered, Done) and is notified at each milestone. Once the request is
  submitted, the requester doesn't see the vendor, any amount, the checker,
  the quotes or invoice, or the detailed steps.
- **Neutral wording.** Screens and messages say "approval" and "the
  approver", never a person's name.
- **Access:**
  - the requester sees their own purchases, as a tracking view;
  - the checker sees the purchases they must check, without prices;
  - IT sees the asset lines awaiting registration;
  - finance, Peter and the director see everything.

### Non-goals

- The petty cash book (Route 1). It is the next change. Until then, petty
  cash stays as it is, and float top-ups use the existing `petty_cash`
  finance-request category.
- Budgets. A tick-box and a cost code stand in for them. Each purchase
  records both so a later budgeting system can plug in.
- Stock and sales for inventory lines.
- Partial deliveries and staged payments. One delivery and one payment per
  purchase. A contract-tier purchase that needs instalments is handled
  outside the flow for now.
- Foreign currency. Amounts and limits are in IDR.
- Generating a PO PDF. The order has a print view.
- The monthly review screen, the shareholder summary, and full vendor
  master controls (vendor approval, quarterly review). They come in later
  changes, and this change records what they will need.
- A different approver for Peter's own purchases. Peter approves them like
  any other, and each one is marked.

## Capabilities

### New Capabilities

- `purchasing`:
  - purchase requests and their lines and line types;
  - the register and its numbering;
  - routing by value, with per-vendor-per-month counting and the tier
    settings;
  - quotes and evidence;
  - related-party and sole-source declarations;
  - Peter's approval;
  - urgent purchases;
  - the order and the checker;
  - the GRN;
  - the three-way match and the hand-off to finance requests;
  - the transfer-proof rule for linked finance requests;
  - documents, history, and who sees what.
- `vendors`: the vendor list, who adds and edits vendors, and the rule
  that only Peter changes a bank account, with a recorded callback.

### Modified Capabilities

- `asset-register`: new requirement. Asset lines that are received wait
  on a list for IT, and an asset registered from one keeps its link to the
  purchase.
- `notifications`: new requirement. Purchases notify the requester,
  finance, Peter, the checker and IT, and their action items are settled
  when the step is done.

## Impact

- **Database:** one migration, dated after `20261016000100`.
  - New tables:
    - `vendors`;
    - `purchase_settings`, a single row;
    - `purchases`;
    - `purchase_lines`;
    - `purchase_documents`;
    - `purchase_events`.
  - New columns `assets.purchase_line_id` and `finance_requests.purchase_id`.
  - A private Storage bucket, `purchase-documents`.
  - New `purchases_*` and `vendors_*` functions.
  - `finance_request_json` and `finance_mark_paid` are redefined from
    `20260930001000` / `20260926000800`. `assets_register` and the asset
    serialiser are redefined from `20261016000100`.
- **Naming:** the existing `purchase_orders` table holds *client* POs (POs
  that clients send to DTG). Outgoing orders live on `purchases` and are
  called "orders" on screen, so the two don't get confused. An inventory
  line can point at a client PO.
- **Front end:**
  - a new `/purchasing` page with tabs: My requests, To check, Register,
    Approvals, Vendors and Settings;
  - a sidebar entry;
  - `purchaseService.ts`, `vendorService.ts` and `routes/purchases.ts`;
  - an "Awaiting registration" panel on `/equipment` for IT;
  - the linked purchase shown on the finance request page.
- **Tests:** a new `supabase/test/areas/purchasing.test.mjs`. The finance,
  assets and notifications suites gain steps for the links.
- **People:**
  - Peter confirms the tier limits.
  - Finance enters the vendors in use, with their bank accounts.
  - Staff are told that purchases above Rp 500,000 start as a request on
    the platform, and that the person who asked for something can't check
    it in.
