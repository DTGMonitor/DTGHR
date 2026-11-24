# Tasks

Groups 1–6 are the database side and its tests. Groups 7–8 are the front
end. Group 9 ships it.

## 1. Migration: data

- [x] 1.1 New migration dated after `20261016000100`, in a single `begin; … commit;`, safe to re-run
- [x] 1.2 `purchase_settings`, a single row: the three limits (500,000 / 5,000,000 / 50,000,000), `next_pr`, `next_po`, `updated_by`, `updated_at`
- [x] 1.3 `vendors`:
  - unique on `lower(btrim(name))`;
  - unique on digits-only `npwp` where not null;
  - `vendor_events` with `seq` identity
- [x] 1.4 `purchases` with the columns from design 1:
  - status check;
  - unique `reference` and `order_number` where not null;
  - amount checks ≥ 0;
  - `urgent_channel` check;
  - indexes on `status`, `vendor_id`, `requester_id`, `checker_id` and `approved_at`
- [x] 1.5 `purchase_lines`:
  - `line_type` check;
  - quantity > 0;
  - `asset_category_id` required for `asset`;
  - `client_po_id` only for `inventory`;
  - `qty_received` between 0 and quantity
- [x] 1.6 `purchase_documents` (kind check) and `purchase_events` (`seq` identity, index on `purchase_id, seq`)
- [x] 1.7 New columns:
  - `finance_requests.purchase_id` (FK, unique where not null);
  - `assets.purchase_line_id` (FK, indexed)
- [x] 1.8 Private bucket `purchase-documents`, created the same way as `finance-documents`
- [x] 1.9 RLS turned on for every new table, with no client policies

## 2. Migration: vendors and settings

- [x] 2.1 Helpers:
  - `_purchases_is_full_viewer()` (finance, director, executive);
  - `_purchases_require_role(role, action)`;
  - `_purchases_event(...)` using `clock_timestamp()`
- [x] 2.2 `vendors_list(filters)` and `vendors_get(id)`, for full viewers only (`PT404` otherwise), with the events
- [x] 2.3 `vendors_create(payload)` (finance) and `vendors_update(id, payload)`:
  - finance edits anything but the bank fields;
  - edits write `edited` events;
  - a phone change is recorded in the event `detail`
- [x] 2.4 `vendors_set_active(id, active)` (finance or executive)
- [x] 2.5 `vendors_change_bank(id, bank, callback_note)`:
  - executive only, note required;
  - records the phone on file and `phone_changed_recently` (30 days);
  - writes a `bank_changed` event with `before` and `after`
- [x] 2.6 `purchases_settings()` (full viewers) and `purchases_settings_update(limits)`:
  - executive only;
  - checks that petty < simple < quotation;
  - records who and when

## 3. Migration: request to approval

- [x] 3.1 `_purchases_serialise(id, shape)` with the full, requester and checker shapes, including `can`, `missing`, lines, documents (filtered by shape) and events
- [x] 3.2 `_purchases_route(purchase)` and `_purchases_missing(purchase)`, as in design 4 and 5
- [x] 3.3 Requester functions:
  - `purchases_create(payload)`;
  - `purchases_update(id, payload)`, which replaces the lines and recomputes `estimated_total`;
  - `purchases_delete(id)` (draft only; returns the storage paths);
  - `purchases_submit(id)`, which sets `late_entry` for an urgent request and checks the urgent evidence;
  - `purchases_cancel(id, reason)`
- [x] 3.4 Finance intake:
  - `purchases_register(id, budget_confirmed, cost_code, line_types)`, which takes `next_pr` and, for an urgent request, goes straight to `approved` with the named vendor and amount;
  - `purchases_return(id, note)`;
  - `purchases_close_petty_cash(id)`, with the limit check
- [x] 3.5 Sourcing (finance, while `sourcing`):
  - `purchases_source(id, payload)`: vendor, `approval_amount`, line prices, related-party answer and note, sole source and note, `shareholders_informed_on`;
  - `purchases_send_for_approval(id)`, which refuses with the missing list and stores the tier and `route_value`
- [x] 3.6 Peter's actions:
  - `purchases_approve(id)`, which sets `approved_*`, `approved_amount` and `self_approved`;
  - `purchases_send_back(id, note)`;
  - `purchases_reject(id, reason)`;
  - `purchases_confirm_urgent(id)`
- [x] 3.7 Reads:
  - `purchases_list(filters)`, for full viewers: status, tier, vendor, requester, urgent, late entry, self-approved, related party, and search on PR, PO and title;
  - `purchases_mine()`;
  - `purchases_to_check()`;
  - `purchases_get(id)`, which picks the shape and returns `PT404` to anyone else
- [x] 3.8 Documents:
  - `purchases_document_add(...)`, applying the rules per role and stage;
  - `purchases_document_get(...)`;
  - `purchases_document_delete(...)`, by the uploader only, while `draft` / `submitted` / `sourcing`

## 4. Migration: order to payment

- [x] 4.1 `purchases_issue_order(id, checker_id)`:
  - takes `next_po`;
  - checks that the checker is not the requester, not finance, and active.

  Also `purchases_change_checker(id, checker_id)`.
- [x] 4.2 `purchases_receive(id, lines, matches, note)`:
  - the checker only;
  - quantity bounds;
  - a `delivery_photo` by the checker is required;
  - accept moves to `received`; reject records `delivery_rejected` and resets the quantities
- [x] 4.3 Amount review:
  - `purchases_ask_amount(id, amount, note)` (finance, while `received`);
  - `purchases_decide_amount(id, approve, note)` (executive)
- [x] 4.4 `purchases_match(id, invoice)`, as in design 7:
  - the checks;
  - the finance request with one `vendor` item for the net amount;
  - the link;
  - `matched`;
  - Peter's finance-request notification, sent the same way `finance_submit` sends it
- [x] 4.5 Redefine `finance_apply_body` from its latest definition: refuse item and title changes on a linked request
- [x] 4.6 Redefine `finance_mark_paid` from its latest definition:
  - a linked request needs a document;
  - then the purchase moves to `paid`, with the event and the notification
- [x] 4.7 Redefine `finance_request_json` from `20260930001000`, adding `purchase`
- [x] 4.8 Before writing 4.5–4.7, check that no later migration or test replay defines these functions

## 5. Migration: assets and notifications

- [x] 5.1 `assets_awaiting_registration()` (IT only)
- [x] 5.2 `assets_register_from_line(line_id, payload)`, as in design 9, calling the existing `assets_register`
- [x] 5.3 Redefine `assets_serialise` (as the asset migration names it) from `20261016000100`, adding `purchase` for full viewers
- [x] 5.4 Notifications from the purchase functions, each in its own exception block, with the kinds, recipients and settling from the notifications delta; links to `/purchasing?open=<id>` (IT's to `/equipment?tab=awaiting`, since IT does not see purchases)
- [x] 5.5 Grants:
  - client functions to `authenticated`;
  - helpers (named `purchases_*` / `vendors_*`, as the asset migration names its own) revoked from `public`, `anon` and `authenticated`

## 6. Tests

- [x] 6.1 New `supabase/test/areas/purchasing.test.mjs`, covering:
  - drafting and submitting;
  - refusals on someone else's draft;
  - an asset line without a category;
  - estimated totals
- [x] 6.2 Register: the PR numbering, the budget tick required, return, petty cash at and above the limit
- [x] 6.3 Routing:
  - the tier at each boundary;
  - the vendor-month total catches a split order;
  - the next month starts again;
  - only Peter changes the limits
- [x] 6.4 Evidence:
  - the missing list per tier;
  - the related-party declaration;
  - sole source with one quote;
  - the contract tier needs the shareholders date
- [x] 6.5 Approval:
  - Peter approves, sends back, rejects;
  - finance and the director are refused;
  - `self_approved` on Peter's own request
- [x] 6.6 Urgent:
  - the evidence is required;
  - registering goes straight to `approved`;
  - the match is blocked until confirmed;
  - `late_entry` after 24 hours
- [x] 6.7 Order and GRN:
  - the checker rules (requester and finance refused);
  - only the checker records;
  - a photo is required;
  - reject and redeliver;
  - quantity bounds;
  - the checker shape has no prices
- [x] 6.8 Match:
  - a clean match creates a submitted, linked finance request;
  - the net amount with PPh;
  - above the approved amount is refused, then the amount review;
  - the faktur pajak is required when there is PPN
- [x] 6.9 Payment:
  - linked items are locked;
  - marking paid without a document is refused;
  - paid moves the purchase to `paid`
- [x] 6.10 Cancel rules, document delete windows, and the event order by `seq` for a full trail
- [x] 6.11 Vendors:
  - duplicates;
  - an inactive vendor can't be chosen;
  - finance can't change the bank;
  - Peter changes it with a note and without one is refused;
  - the recent-phone flag;
  - staff get not found
- [x] 6.12 Assets:
  - the awaiting list after the GRN;
  - registering from a line fills the defaults and the link;
  - over-registering is refused;
  - non-IT gets not found.

  Add this migration to the replay in `assets.test.mjs`.
- [x] 6.13 Notifications: each kind, recipient, actor exclusion and settling in the delta spec
- [x] 6.14 Linked-request steps (locked amount, transfer proof, paying the purchase) live in `purchasing.test.mjs`, next to the flow that creates them. `npm run test:db` passes in full

## 7. Front end: purchasing

- [x] 7.1 `purchaseService.ts`, `vendorService.ts` and `routes/purchases.ts`, with the upload and download routes following `routes/finance.ts`; `Purchase` and `Vendor` types with all three shapes
- [x] 7.2 `/purchasing` page, the route in `App.tsx`, and a "Purchasing" sidebar entry for everyone; tabs shown by role
- [x] 7.3 My requests:
  - the form, with lines, line types, the category for asset lines, and a customer/order reference for inventory lines (finance links the client PO while sourcing, since staff can't list client POs);
  - the urgent section (channel, time, screenshot or call note);
  - attachments, submit, cancel, status and history
- [x] 7.4 Register:
  - filters and search;
  - the purchase drawer with step actions from `can`;
  - the missing-evidence checklist;
  - the route value and tier;
  - flags (urgent, late, self-approved, related party)
- [x] 7.5 Sourcing form:
  - vendor picker;
  - quotes upload;
  - comparison and contract uploads;
  - related-party question;
  - sole-source fields;
  - shareholders date
- [x] 7.6 Approvals tab for Peter: approve, send back and reject (both with a note); confirm urgent; decide the amount
- [x] 7.7 Order:
  - issue it with the checker picker, which leaves out the requester and finance;
  - change the checker;
  - print view
- [x] 7.8 To check tab: the GRN form (quantity and condition per line, photo upload from a phone camera, matches yes/no, a note required on no)
- [x] 7.9 Match form: invoice fields, PPN and PPh, the net payable shown, invoice and faktur uploads, ask for an amount review
- [x] 7.10 Vendors tab: list, add and edit; bank change for Peter only, with the phone on file and the recent-change warning; history
- [x] 7.11 Settings tab: Peter edits the limits, everyone else reads
- [x] 7.12 `?open=` opens the drawer. `npm run build` passes

## 8. Front end: links

- [x] 8.1 Finance request page: "From purchase PR-… / PO-…" linking to the purchase; "Attach the transfer proof" shown before Mark paid on linked requests
- [x] 8.2 `/equipment` for IT: an "Awaiting registration" panel; "Register" opens the existing form pre-filled from the line
- [x] 8.3 The asset drawer shows the purchase reference with a link. `npm run build` passes

## 9. Requester tracking view and neutral wording

- [x] 9.1 Migration (a new one, dated after `20261017000100`, or this one if it has not gone live yet): `purchase_request_items`, as in design 15. The requester's create and update write items; submit needs at least one item.
- [x] 9.2 Lines become finance's:
  - `purchases_register` seeds lines from the items, and takes the full line list for an urgent request;
  - `purchases_write_lines_finance(id, lines)` while `sourcing`;
  - `purchases_close_petty_cash(id, estimate)`;
  - drop the requester's price, line-type, cost-code and urgent vendor/amount fields
- [x] 9.3 `purchases_milestone(r)` and milestone dates from the events, as in design 15
- [x] 9.4 Cut the `requester` shape in `purchases_serialise` down to the tracking view:
  - no vendor, amounts, checker, finance request, tier, route or flags;
  - only their own documents;
  - milestone events only, with no actor or detail;
  - their requested items in place of lines.

  `purchases_document_get` and `purchases_storage_can_read` follow the same rule.
- [x] 9.5 Notifications:
  - a requester variant of `purchases_notify` with no vendor, amount, checker or approver;
  - `purchase_progress` at approved, ordered and delivered;
  - `purchase_closed` at paid, not approved, cancelled and petty cash;
  - `purchase_decided` to finance only
- [x] 9.6 Neutral wording in every server message and notification text ("the approver", "approval"), including the vendor bank-change refusal
- [x] 9.7 Tests:
  - items seed the lines at registration, each note copied into the line's specification;
  - finance splits and prices lines while the requested items stay unchanged;
  - petty cash takes finance's estimate;
  - the requester's copy has items and no lines, vendor, amount, checker or others' documents;
  - the milestone mapping for every status, and a rejected delivery stays "Ordered";
  - the requester's notifications are milestones only, with no vendor or amount;
  - the refusal messages don't name a person.

  `npm run test:db` passes in full.
- [x] 9.8 Front end:
  - the request form shrinks to title, purpose, needed by, urgent (channel, time, evidence) and generic items (description, quantity, and a note for a preference or minimum need, e.g. "Logitech wireless", "at least 16 GB RAM");
  - the requested items and their notes shown beside the lines in finance's register and sourcing panels;
  - finance's line editor in the sourcing panel (add, split, rewrite, remove; type, category, specification, unit, price, client PO), and the estimate in the petty-cash action;
  - a progress bar (Submitted · Approved · Ordered · Delivered · Done) with dates, and an outcome banner for returned, not approved, cancelled and petty cash;
  - the requester's drawer and My requests list show no vendor, amounts, checker or payment row;
  - the history is milestones only
- [x] 9.9 Neutral wording on every screen: "Awaiting approval", "Sent for approval", "Send for approval", "the approver" in finance's panels, the settings, the page intro and the urgent notice. Rename the "Approvals" tab only if it names a person. `npm run build` passes

## 10. Ship
- [x] 10.1 Peter confirms the three limits, and they are set on live
- [x] 10.2 Push the migration with migrations temporarily enabled in `config.toml`, after `migration list`. Then merge, so the front end deploys
- [x] 10.3 On live, with test accounts, run the full chain:
  - a request through approval, order, GRN by a second account, match, payment with transfer proof, and asset registration from the line;
  - an urgent request;
  - a split order caught by the month total.

  Check the history and the notifications.
- [x] 10.4 Finance enters the vendors in use, with their bank accounts
- [x] 10.5 Tell staff: purchases above Rp 500,000 start as a request on the platform, and the requester never checks in their own goods
