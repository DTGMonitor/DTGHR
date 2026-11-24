# Design: purchasing flow

## Context

- **The procedure.** The company adopted the "Purchasing flowchart for small
  team" document. Its central rule is that the person who keeps the books
  never releases the money, and the person who releases the money never
  keeps the books.
  - "The Director" in that document is **Peter**, who has the `executive`
    role.
  - The `director` role reads everything and approves nothing, the same as
    for finance requests today.
- **Finance requests already exist** (`20260926000800`, with the approval
  chain from `20260930001000`):
  - finance drafts a request and submits it;
  - Peter approves it (`finance_approve`), or the director does when
    `finance_settings.director_final_approval` is on;
  - finance marks it paid (`finance_mark_paid`).

  Item categories include `vendor`. Documents live in the
  `finance-documents` bucket, and the upload route in
  `src/lib/routes/finance.ts` stores the object first and then calls
  `finance_document_add`. Because Peter's approval and the bank release are
  the same person's act, and finance only *records* the payment, the
  existing chain already matches the procedure's payment half.
- **`purchase_orders` already exists, and holds client POs:** the orders
  clients send to DTG (`20260929000100`). Outgoing orders must not reuse
  that table or its name on screen.
- **How an area is built** (tickets, assets):
  - RLS is on and there are no client policies;
  - every read and write goes through a `security definer` function;
  - a `_serialise` function returns the record together with the actions
    the caller may take;
  - a refusal that would reveal a record raises "not found" (`PT404`);
  - other refusals raise `PT403` or `PT422`.
- **Notifications.** `notifications_enqueue(...)` and
  `notifications_resolve_kinds(...)` are called from inside the area's
  functions, each in its own `begin … exception when others → raise
  warning` block.
- **Test-harness traps** (from the ticket and asset changes):
  - PGlite's clock ticks per millisecond, so events are ordered by an
    identity `seq`, never by time plus uuid;
  - `assets.test.mjs` replays `20261016000100`, which would undo any later
    redefinition of an asset function for the suites that run after it.

## Goals / Non-Goals

**Goals:**

- The platform enforces the procedure's separations:
  - only Peter approves;
  - finance prepares the evidence but can't approve;
  - the checker is never the requester and never finance;
  - only Peter changes a vendor's bank account.
- One record per purchase holds the whole chain (request → quotes →
  approval → order → GRN → invoice → payment), with an append-only history.
- Splitting an order to stay under a limit doesn't work, because the tier
  counts the vendor's month.
- Payment reuses `finance_requests` rather than adding a second way to pay.
- What later changes need is recorded now:
  - the cost code (budgeting);
  - inventory lines with a client PO (inventory and sales);
  - the self-approved, urgent, late-entry and related-party flags (the
    monthly review).

**Non-Goals:**

- Petty cash, budgets, stock, partial deliveries, staged payments, foreign
  currency, a PO PDF, the monthly review screen, the shareholder summary, and
  full vendor master controls. See the proposal.

## Decisions

### 1. One `purchases` row carries the PR and the order

A request and its order are one record with two numbers, not two tables.
The order number is issued at `ordered`.

*Alternative:* separate PR and PO tables. Rejected: in a company this size
every PR becomes at most one order, and two tables would double the joins
and the access rules for no gain.

`purchases`:

| Column | Notes |
|---|---|
| `id` | uuid |
| `reference` | `PR-0001`, set at registration, unique, null while `draft` / `submitted` |
| `order_number` | `PO-0001`, set at `ordered`, unique |
| `title`, `purpose`, `needed_by` | |
| `cost_code` | free text; the budgeting system will replace it with a key |
| `budget_confirmed` | boolean, required true to register |
| `status` | see 2 |
| `requester_id` | `users.id` |
| `vendor_id` | null until chosen |
| `estimated_total` | the sum of the lines, kept up to date by the line functions |
| `approval_amount` | what finance asks Peter to approve |
| `approved_amount` | what Peter approved (or the new amount after an amount review) |
| `tier` | `simple` / `quotation` / `contract`, stored at send-for-approval |
| `route_value` | the stored month total used for the tier |
| `related_party` | null = not answered, otherwise boolean |
| `related_party_note` | |
| `sole_source` | boolean |
| `sole_source_note` | the justification and the price benchmark |
| `shareholders_informed_on` | date; required for the contract tier |
| `urgent` | boolean |
| `urgent_channel` | `whatsapp` / `phone` |
| `urgent_approved_at` | when Peter said yes outside the platform |
| `urgent_note` | the call note for a phone approval |
| `urgent_confirmed_at`, `urgent_confirmed_by` | |
| `late_entry` | boolean, set at submit |
| `self_approved` | boolean, set at approval |
| `approved_by`, `approved_at` | |
| `checker_id` | `users.id` |
| `grn_at`, `grn_by`, `grn_note` | |
| `invoice_number`, `invoice_date`, `invoice_total` | |
| `ppn_amount`, `pph_amount` | |
| `amount_review_amount` | the new amount Peter is being asked to approve |
| `finance_request_id` | |
| `paid_on` | |
| `cancel_reason` | |
| `created_at`, `updated_at` | |

All amounts are `numeric(18,2)` and ≥ 0.

`purchase_lines`:

| Column | Notes |
|---|---|
| `purchase_id`, `sort_order` | |
| `line_type` | `asset` / `inventory` / `expense` |
| `description` | |
| `quantity` | numeric > 0 |
| `unit` | e.g. "pcs", "m", "lot" |
| `unit_price` | the estimate until approval, then the agreed price |
| `asset_category_id` | required for `asset` |
| `client_po_id` | FK to `purchase_orders`, optional, only for `inventory` |
| `qty_received`, `condition_note` | set by the GRN |

The line total is `quantity × unit_price`. The page shows it, and nothing
stores it.

### 2. Statuses

```
 draft ──submit──▶ submitted ──register──▶ sourcing ──send──▶ awaiting_approval
   ▲                 │  │  └─petty cash─▶ petty_cash (final)       │  │  │
   └────return───────┘  │                                 send back│  │  │reject
                        │ register (urgent)                  ◀─────┘  │  ▼
                        └────────────────────────────▶ approved ◀─────┘ cancelled
                                                          │ issue order   (final)
                                       delivery rejected  ▼
                                          ┌───────── ordered
                                          └────────▶   │ GRN accepted
                                                       ▼
                         amount_review ◀──ask──── received
                               └──decided────────▶   │ match
                                                     ▼
                                                  matched ──finance request paid──▶ paid (final)
```

Cancelling: the requester from `draft` / `submitted`, finance from
`sourcing` through `ordered`. Each move is its own function that checks the
current status under `select … for update`. Any other move raises `PT422`.

### 3. Numbering

`PR-` and `PO-` numbers come from two counters in `purchase_settings`
(`next_pr`, `next_po`), taken with `update … returning`. That takes the row
lock, the same as asset tags, so two finance actions at once never collide.
Numbers have 4 digits and simply grow past 9999. A draft has no reference:
it only becomes part of the register when finance registers it. That keeps
abandoned drafts from leaving gaps in the register.

*Alternative:* `max()+1` under an advisory lock, as finance requests do.
Rejected: the counter row is simpler, and the asset change already uses
that pattern.

### 4. Route value and tier

```
route_value = this purchase's approval_amount
            + sum(approved_amount) of the same vendor's purchases
              where status in (approved, ordered, received, amount_review, matched, paid)
                and approved_at falls in the same calendar month (Asia/Jakarta, via local_today())
```

The value is computed by `_purchases_route(purchase)` whenever the vendor or
the amount changes, so the page can show what evidence is still missing.
It is stored at send-for-approval. Peter sees both the stored value and the
tier. When Peter approves, the value isn't worked out again: what he saw is
what he approved.

*Alternative:* count by invoice date. Rejected: the procedure's rule is
about stopping orders from being split before approval, and the approval
date is what can be checked at that point.

### 5. Evidence checks

`_purchases_missing(purchase)` returns a list of what is still missing for
the tier: quotes by count, a comparison sheet, a contract, the date the
shareholders were informed, the related-party answer, the declaration, and
the sole-source justification. Send-for-approval refuses with that list,
and the serialiser returns it so the page can show a checklist. Quotes are
`purchase_documents` rows of kind `quote`. Counting documents, rather than
storing quote amounts, keeps v1 small. The comparison sheet is the
structured view of the quotes.

### 6. Separation rules live in the functions

| Rule | Where it's enforced |
|---|---|
| Only Peter approves, confirms urgent purchases, decides amount reviews, changes limits, and changes bank accounts | `current_user_role() = 'executive'`, otherwise `PT403` |
| Finance prepares | `current_user_role() = 'finance'` for register, source, send, order, match and cancel |
| Checker ≠ requester, checker not finance | checked when naming the checker; the GRN function also checks that the caller is `checker_id` |
| Self-approval is visible | `self_approved = (approved_by = requester_id)`, set at approval and at urgent confirmation |

The director's `director_final_approval` setting doesn't extend to
purchases. The procedure names one approver, and the user confirmed it is
Peter.

### 7. Hand-off to finance requests

`purchases_match(id, invoice)` runs as finance, in one transaction:

1. Check the status (`received`), the urgent confirmation, the invoice
   fields, the `invoice` document, and the `tax_invoice` document when
   `ppn_amount > 0`.
2. Check `invoice_total ≤ approved_amount`, or raise `PT422` "Invoice is
   above the approved amount".
3. Insert a `finance_requests` row with:
   - the next `FR-` reference, taken with the existing advisory lock;
   - title `"<PR> / <PO> – <vendor>"`;
   - status `submitted` and `submitted_at = now()`;
   - `requested_by_id` = the finance user;
   - `purchase_id`;
   - notes giving the vendor's bank name, account number and holder, the
     invoice number, and the PPN and PPh figures.

   Insert one `finance_request_items` row: category `vendor`, amount =
   `invoice_total − pph_amount`.
4. Set `purchases.finance_request_id` and `status = matched`.
5. Send the notification that the existing `finance_submit` sends to Peter,
   by calling the same helper.

The other way round, from finance requests to purchases:

- `finance_requests.purchase_id` (FK, unique where not null) marks a request
  as linked.
- `finance_apply_body` refuses changes to items or to the title of a linked
  request. Notes are still allowed.
- `finance_delete` never applies, because a linked request is never a draft.
- `finance_mark_paid` is redefined:
  - a linked request needs at least one `finance_request_documents` row,
    otherwise `PT422` "Attach the transfer proof first";
  - after the update, it sets the purchase to `paid` with `paid_on`, and
    writes the purchase event and the `purchase_closed` notification.
- `finance_request_json` gains `purchase: {id, reference, order_number}`, so
  the finance page can link to the purchase.

The purchase's documents stay in their own bucket. The finance page links
to the purchase file instead of copying files across.

*Alternative:* copy the PO, GRN and invoice files into
`finance-documents`. Rejected: it doubles the storage and splits the
purchase file into two places.

### 7a. Redefining finance functions safely

`finance_apply_body`, `finance_mark_paid` and `finance_request_json` are
redefined from their latest definitions (`20260926000800`, and
`20260930001000` for `finance_request_json`). No test replays those files,
and the notification replays (`20261007000100`, `20261008000100`,
`20261009000100`) don't define them. Check this again before writing the
migration.

### 8. The GRN

`purchases_receive(id, lines[{line_id, qty_received, condition}], matches
boolean, note)`:

- the caller must be `checker_id`, otherwise `PT404`;
- each `qty_received` must be between 0 and `quantity`;
- at least one `delivery_photo` document must already be uploaded by the
  checker.

When the delivery matches, the function sets `grn_*` and moves the purchase
to `received`. When it doesn't, it records `delivery_rejected` with the
note, stays at `ordered`, and clears `qty_received` so the redelivery starts
from nothing. Accepting a delivery with received quantities below what was
ordered is allowed. The shortfall shows on the purchase, and finance
matches against the invoice. Partial deliveries are not modelled.

### 9. Assets from purchase lines

- New column: `assets.purchase_line_id` (FK, nullable, indexed).
- `assets_awaiting_registration()` (IT only, otherwise `PT404`) lists the
  asset lines of purchases at `received` or later where
  `count(assets) < qty_received`.
- `assets_register_from_line(line_id, payload)` is a new wrapper:
  - it checks the line and the remaining count under `for update` on the
    line;
  - it fills the payload's defaults from the line (category, name =
    description, purchase date = GRN date, purchase value = unit price);
  - it calls the existing `assets_register`;
  - it then sets `purchase_line_id` and adds the purchase reference to the
    `registered` event's note;
  - when the purchase has nothing left to register, it settles
    `purchase_assets_to_register`.
- `assets_register` itself is **not** redefined.
- `_assets_serialise` is redefined to add
  `purchase: {id, reference, order_number}` for full viewers. Because
  `assets.test.mjs` replays `20261016000100`, the test adds this change's
  migration to that replay, so later suites see the new serialiser.

### 10. Vendors

`vendors`:

| Column | Notes |
|---|---|
| `name` | unique on `lower(btrim(name))` |
| `npwp` | unique on the digits-only form where not null |
| `is_pkp` | |
| `contact_name`, `phone`, `email` | |
| `bank_name`, `bank_account_number`, `bank_account_holder` | |
| `is_active` | |
| `created_by`, `updated_by`, timestamps | |

`vendor_events` is append-only, with a `seq`:

| Column | Notes |
|---|---|
| `kind` | `created`, `edited`, `bank_changed`, `deactivated`, `reactivated` |
| `before`, `after` | jsonb |
| `note` | |
| `actor`, `created_at` | |

`vendors_change_bank(id, bank, callback_note)` is Peter only, and takes the
callback note. The number called isn't free text: the dialog shows the
phone on file, and the function records that number in the event.
Because finance can edit the phone number, the dialog **warns** Peter when
the phone changed in the last 30 days, and the function stores
`phone_changed_recently` in the event. This blocks the obvious attack,
where someone changes the phone number and then the bank account, without
making v1 any stricter than that.

### 11. Documents

`purchase_documents`:

| Column | Notes |
|---|---|
| `purchase_id` | |
| `kind` | see the spec |
| `filename`, `content_type`, `byte_size` | |
| `storage_path` | |
| `uploaded_by`, `created_at` | |

The files are in a private bucket, `purchase-documents`, at
`<purchase_id>/<uuid>/<name>`. Uploads follow the finance route pattern: the
route puts the object in Storage, then calls `purchases_document_add`, and
removes the object again if the call is refused. The same types and size
limit as finance documents apply, so images (photos) and PDFs are accepted.
Reads go through `purchases_document_get`, which applies the visibility
rule. The checker can read only their own `delivery_*` documents.

### 12. Serialising and access

`_purchases_serialise(id, shape)` has three shapes:

- **full:** finance, director, Peter;
- **requester:** the tracking view in decision 15;
- **checker:** lines without prices, the vendor name, the order number, and
  only the checker's own documents.

Each shape includes `can` (the actions the caller may take now) and
`missing` (from 5).

The reads are:

- `purchases_list(filters)`, for full viewers;
- `purchases_mine()`, the requester's purchases;
- `purchases_to_check()`, the checker's;
- `purchases_get(id)`;
- `purchases_settings()`.

### 13. Events

`purchase_events`:

| Column | Notes |
|---|---|
| `purchase_id`, `seq` | `seq` is an identity column |
| `kind` | |
| `from_status`, `to_status` | |
| `note`, `detail` | `detail` is jsonb |
| `actor`, `created_at` | `created_at` uses `clock_timestamp()` |

Events are ordered by `seq`. The asset trail taught this: PGlite timestamps
collide.

### 14. Front end

- **`/purchasing`**, with these tabs:
  - **My requests** (everyone): draft and submit, see the status and the
    history;
  - **To check** (checkers): GRN form with a photo upload;
  - **Register** (finance, director, Peter): filters, the purchase drawer
    with step actions, the missing-evidence checklist, and the order print
    view;
  - **Approvals** (Peter): purchases awaiting approval, urgent purchases to
    confirm, and amount reviews;
  - **Vendors** (finance, director, Peter);
  - **Settings** (Peter edits; finance and the director read).

  `?open=<id>` opens the drawer.
- **`/equipment`** (IT): an "Awaiting registration" panel. "Register" opens
  the existing form, pre-filled from the line.
- **Finance request page:** "From purchase PR-0001 / PO-0001", linking to
  `/purchasing?open=`.

### 15. The requester tracks progress, finance sees the detail

The requester's job is to know roughly where their request is. Finance and the
approver need every detail. The `requester` shape from decision 12 is
therefore cut down to a tracking view, built on the server so that nothing
hidden ever reaches the browser:

| Requester sees | Requester does not see (once submitted) |
|---|---|
| Title, purpose, needed by, their requested items as they wrote them | Finance's purchase lines, specifications and line types |
| PR and PO numbers | The vendor (name or anything else) |
| | Any amount: estimate, approval amount, approved amount, invoice, net payable |
| The milestone and the date each was reached | The checker |
| Notes addressed to them (return, rejection, cancellation) | Quotes, comparison, contract, invoice, faktur, delivery photos, budget exception |
| Documents they attached themselves | The finance request (the "payment link"), the tier, the route value, the flags |
| | The detailed history, and the actor of each event |

- **Requested items, not lines.** The requester never types a price, a
  vendor, a specification or a line type. They list generic items
  ("monitor" × 2, "peripherals" × 1), each with an optional note, in a new
  table, `purchase_request_items`: `purchase_id`, `sort_order`,
  `description` (up to 200 characters), `quantity` (> 0) and `note` (up to
  1,000 characters). The note holds the requester's preference or minimum
  need ("Logitech wireless", "at least 16 GB RAM"). It's guidance for
  finance, not a binding specification. When a line is seeded from an item,
  the note is copied into the line's specification as a starting point,
  which finance then rewrites. Finance's register and sourcing panels show
  the requested items with their notes beside the lines.
  - At registration, `purchases_register` seeds one `purchase_lines` row from
    each item. The row has the description and quantity, `expense` type and
    price 0.
  - From then on, the lines are finance's. A new
    `purchases_write_lines_finance(id, lines)` replaces them wholesale while
    the purchase is `sourcing` (add, split, rewrite, remove; type, category,
    specification, unit, price, client PO). The register call takes the same
    list for an urgent request.
  - The requester's copy carries `items` (their own words) and never `lines`.
    The checker's and finance's copies carry `lines`.
  - The old `purchases_write_lines` (the requester's lines) goes, and
    `purchases_fix_lines` becomes part of the finance writer.
  - Petty cash. With no requester estimate, `purchases_close_petty_cash(id,
    estimate)` takes finance's estimate and checks it against the limit.
  - Urgent. The requester gives only the channel, when the approval was
    given, and the evidence. `urgent_vendor_name` and `urgent_amount` move to
    finance's register call, which already takes `vendor_id` and `amount`.
  - Cost code. Finance sets it at registration. The requester form doesn't
    show it.
- **Milestones.** `purchases_milestone(r)` returns `submitted`, `approved`,
  `ordered`, `delivered` or `done`, or an outcome (`returned`,
  `not_approved`, `cancelled`, `petty_cash`). The date each milestone was
  reached comes from the first event that reached it. The requester's
  `events` are those milestone and outcome entries. Each has a date, but no
  actor name and no `detail`. The only notes they carry are a return note, a
  rejection reason or a cancellation reason.
- **Notifications.** `purchases_notify` gains a requester variant. Its
  details rows are only the purchase title and the PR / PO numbers. The
  requester gets `purchase_progress` at approved, ordered and delivered, and
  `purchase_closed` at done and at each outcome. They are no longer sent
  `purchase_decided`, which goes to finance only.
- **The requester who is also finance or the approver** sees the full copy, as
  before. The role comes first.
- **The "payment link".** The finance-request row in the summary goes away for
  requesters, because the field is not in their copy at all.

*Alternative:* hide these fields in the front end only. Rejected: the copy
would still carry the vendor and the amounts, and anyone could read them in
the browser's network tab.

### 16. Neutral wording

Screens, history lines, notifications and error messages name the role,
"the approver", and the step, "approval", never a person. Examples:

- the status chip reads "Awaiting approval";
- the history reads "Sent for approval";
- finance's button reads "Send for approval";
- the refusal reads "Only the approver approves purchases.";
- the bank-account refusal reads "Only the approver changes a vendor's bank account.".

The approver is still whoever holds the `executive` role. Only the words
change, so that if approval moves to someone else, nothing needs rewording.
The proposal and the specs still say "Peter" when they describe who that is
today.

## Risks / Trade-offs

- **Peter approves his own purchases.** The procedure itself admits that no
  internal control can check the approver. → `self_approved` is stored and
  filterable, and the monthly review change will list these purchases for
  the shareholders.
- **Peter becomes a bottleneck.** Everything above Rp 500k waits for him. →
  Action notifications and the Approvals tab keep the queue short and
  visible. The urgent route covers emergencies.
- **Quotes are counted, not compared.** A "quote" document could be
  anything. → Finance's comparison sheet is still a required document at
  the quotation tier and above, and Peter sees the files before approving.
  Structured quote amounts can come later.
- **The month total depends on approval dates.** Two purchases approved
  across a month boundary aren't added together. → This is accepted: the
  procedure says "per vendor per month", and the monthly review will list
  vendors whose spend is near a limit.
- **Finance request redefinitions could drift** if another change edits the
  same functions. → The migration copies each function from its latest
  definition, and the finance suite gains linked-request steps that would
  fail on a lost redefinition.
- **Accepting short deliveries.** Accepting with less than ordered lets the
  purchase be matched for the invoice amount. → The three-way match is
  finance's job. The shortfall is shown on the purchase and in the match
  form.

## Migration Plan

1. One migration, dated after `20261016000100`, in a single
   `begin; … commit;`, safe to re-run. It contains:
   - the tables;
   - the bucket;
   - the settings row (500,000 / 5,000,000 / 50,000,000);
   - the functions and grants;
   - the finance and asset redefinitions.
2. Push with migrations temporarily enabled in `config.toml`, after
   `migration list`. Then merge, so the front end deploys.
3. Check on live with test accounts. Rollback is forward-only: the new
   tables are unused by anything else, so disabling the sidebar entry is
   enough to pause the feature.

## Open Questions

- Peter has to confirm the three limits. The defaults are taken from the
  document.
- What is the size limit for delivery photos taken on a phone? Reuse the
  finance limit unless it proves too small.
