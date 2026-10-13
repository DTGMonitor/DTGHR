# Tasks

Groups 1–5 are the register with handover and the ticket link, and can
ship on their own. Groups 6–8 are check-in rounds and leavers.

## 1. Migration: data

- [x] 1.1 New migration dated after `20261015000100`, in a single `begin; … commit;`, safe to re-run
- [x] 1.2 `asset_categories` (code unique, `tracks_calibration`, `next_number`, `is_active`), seeded with LAP, DSK, MON, PHN, PRN, NET, ACC, FUR, SEN (tracks calibration) and OTH, `on conflict do nothing`
- [x] 1.3 `assets` with the columns from the design:
  - status check;
  - tag unique;
  - unique index on `lower(btrim(serial_number))` where not null;
  - indexes on `status`, `holder_employee_id` and `category_id`;
  - checks: value ≥ 0, a holder required when `assigned`, no holder when `in_store` or `retired`, `flag_kind` in the allowed set
- [x] 1.4 `asset_events` with `seq bigint generated always as identity`, and an index on (`asset_id`, `created_at`, `seq`)
- [x] 1.5 `support_tickets.asset_id` (FK to `assets`, on delete set null) with an index
- [x] 1.6 RLS turned on for every new table, with no client policies

## 2. Migration: register functions

- [x] 2.1 Helpers:
  - `assets_can_manage()` (`is_it_support`);
  - `assets_can_view_all()` (manage, `is_finance()`, `is_admin()`, `is_management_role`);
  - `_assets_event(...)`, which writes an event with the holder-name snapshot and `clock_timestamp()`
- [x] 2.2 `_assets_serialise(id, full boolean)`:
  - the full shape for viewers who see everything;
  - the holder shape for My equipment: no value, no location, events since `holder_since` only;
  - carries `can_manage` and the moves allowed from the current status
- [x] 2.3 Reads:
  - `assets_list(filters)` and `assets_get(id)`; employees asking for a colleague's asset get "not found";
  - `assets_mine()`;
  - `assets_categories()`
- [x] 2.4 `assets_register(payload)`:
  - takes the tag under the category row lock;
  - normalises the serial;
  - takes an optional `assign_to`, which writes `registered` then `assigned`
- [x] 2.5 `assets_update(id, payload)`:
  - refuses when nothing changes;
  - writes one `edited` event listing the fields;
  - value and currency appear only as "Purchase value changed"
- [x] 2.6 Moves, each validating the current status and clearing any flag:
  - `assets_assign` (from `in_store`, or transfer from `assigned`);
  - `assets_return`;
  - `assets_send_to_repair`;
  - `assets_back_from_repair`;
  - `assets_mark_lost` (note required);
  - `assets_mark_found`;
  - `assets_retire` (reason required, no holder)
- [x] 2.7 `assets_respond_handover(id, accept, note)`: the current holder only, while the handover is pending; a decline needs a note and sets `handover_declined`. Also `assets_clear_flag(id, note)` (IT)
- [x] 2.8 Category management for IT: `assets_category_save(payload)` (add, rename, deactivate; the code is fixed once in use)
- [x] 2.9 Grants: client functions to `authenticated`; `_`-prefixed helpers revoked from `public`, `anon` and `authenticated`

## 3. Migration: ticket link and notifications

- [x] 3.1 `tickets_link_asset(ticket_id, asset_id)`:
  - IT only;
  - `null` unlinks;
  - writes a public ticket event and the asset's `ticket_linked` / `ticket_unlinked`;
  - sets the ticket's `updated_at`
- [x] 3.2 Redefine `tickets_serialise` from `20261015000100`, adding only `asset: { id, tag, name }`
- [x] 3.3 Notifications from the move functions, each in its own exception block:
  - `asset_assigned` and `asset_released`;
  - `asset_handover_declined` to IT;
  - links to `/equipment?open=<id>`
- [x] 3.4 Settling with `notifications_resolve_kinds`:
  - `asset_assigned` on response or when the asset leaves the holder;
  - `asset_handover_declined` / `asset_checkin_missing` on any IT move or clear-flag

## 4. Tests (register)

- [x] 4.1 New `supabase/test/areas/assets.test.mjs`. Tags:
  - first and following numbers per category;
  - unchanged after a category change;
  - concurrent-safe numbering, by registering in a loop;
  - duplicate serial refused, regardless of case and spaces
- [x] 4.2 Every allowed move, and a refused move for each status. Repair keeps the holder and the confirmation. Retiring a held item is refused. Retired is final
- [x] 4.3 Handover:
  - confirm;
  - decline with a note (flag set, status unchanged), and decline without a note refused;
  - a non-holder gets "not found";
  - a transfer needs a new confirmation
- [x] 4.4 Access:
  - finance and management read values and the full history, and are refused moves;
  - staff see only their own items, with no value, location or earlier holders;
  - a colleague's asset gives "not found"
- [x] 4.5 History: register-and-assign is in written order; edit text hides the value figures; the holder name snapshot survives a rename
- [x] 4.6 Ticket link: IT links and unlinks, with events on both sides; the reporter is refused; the serialised ticket carries the asset
- [x] 4.7 Notifications: assigned, released, declined; actor excluded; settling on confirm, on transfer, and on an IT move after a decline
- [x] 4.8 `npm run test:db` passes in full (tickets and notifications suites included)

## 5. Front end (register)

- [x] 5.1 `assetService.ts` and `routes/assets.ts` for every function above; an `Asset` type with both shapes
- [x] 5.2 `/equipment` page, route in `App.tsx`, and an "Assets" sidebar entry for everyone
- [x] 5.3 Register tab (IT / Finance / management):
  - filters (status, category, holder, flagged, pending handover) and search (tag, serial, name);
  - "Pending handovers" and "Flagged" panels
- [x] 5.4 Asset drawer: details, history, and the allowed move buttons for IT, with a dialog for each move that needs a note
- [x] 5.5 Register form: "Save & add another" keeps category, brand, model, purchase date and location; optional "Assign to"; edit mode; calibration date shown for categories that track it
- [x] 5.6 My equipment: held items, Confirm / Didn't receive it (note required)
- [x] 5.7 Category management for IT, in a settings section of the page
- [x] 5.8 Ticket page for IT: an asset picker (the reporter's items first, then search) and unlink; everyone sees the linked tag and name
- [x] 5.9 `?open=` opens the drawer; `npm run build` passes

## 6. Migration: check-in rounds and leavers

- [x] 6.1 `asset_checkin_rounds` (a unique partial index so only one round is open), `asset_checkin_items` (unique per round and asset), and `asset_leaver_notices` (unique on employee, reason and `coalesce(end_date, '1970-01-01')`), all with RLS and no client policies
- [x] 6.2 `assets_round_start(name, due_date)`:
  - snapshots assigned, in-store and in-repair assets;
  - writes one `asset_checkin_requested` per holder;
  - settles `asset_checkin_due`
- [x] 6.3 `assets_round_answer(item_id, have_it, note)`:
  - the holder only, while the round is open;
  - "I have it" also confirms a pending handover (two events, in written order);
  - "Not with me" needs a note, flags the asset and notifies IT;
  - settles the holder's request once nothing is pending
- [x] 6.4 `assets_round_mark_seen(item_id, note)` (IT). Every move function marks a pending item in the open round as `seen` by the actor
- [x] 6.5 `assets_round_close(id)`: pending items become `no_reply`, the summary counts are stored, and remaining requests are settled. Closed rounds can't be changed
- [x] 6.6 Reads: `assets_rounds()` and `assets_round_get(id)` for viewers who see everything; the holder's open items appear in `assets_mine()`
- [x] 6.7 `assets_leavers()`, the live "Leaving with items" list: inactive holders, and holders with an active manpower contract ending within 14 days
- [x] 6.8 `assets_daily_run()`, one exception block per unit of work:
  - the day-7 round reminder (stored as `reminded_at`, once);
  - the 182-day `asset_checkin_due` (no more than once in 30 days);
  - leaver notices through `asset_leaver_notices`
- [x] 6.9 Settle `asset_holder_leaving` from every move that leaves an employee holding nothing
- [x] 6.10 Schedule `assets_daily_run` daily at 00:00 UTC with a guarded `cron.schedule`; grants

## 7. Tests (check-in and leavers)

- [x] 7.1 Starting a round: the right assets are included, lost and retired are excluded, and a second open round is refused
- [x] 7.2 Answers:
  - "I have it", including on a pending handover;
  - "Not with me" with a note (flag and IT notification), and without a note refused;
  - a non-holder gets "not found";
  - answering after the round closes is refused
- [x] 7.3 An IT move during the round marks the item `seen`; mark seen directly
- [x] 7.4 Close: `no_reply`, summary counts, settling, and the round is unchanged afterwards
- [x] 7.5 Daily run:
  - the reminder goes on day 7 and only once;
  - the 182-day nudge, not while a round is open, at most once in 30 days;
  - leaver notice for a contract ending and for an inactive holder, once per end date and again after an extension;
  - nothing for a leaver with no items
- [x] 7.6 `npm run test:db` passes in full

## 8. Front end (check-in and leavers)

- [x] 8.1 Check-ins tab:
  - start a round (name and due date);
  - progress of the open round;
  - IT's "seen" list for unheld items;
  - close with a summary;
  - list of closed rounds, with read-only detail
- [x] 8.2 My equipment: a banner for the open round, and "I have it" / "Not with me" (note required) for each item
- [x] 8.3 "Leaving with items" panel on the register; `?round=` and `?holder=` open the right view
- [x] 8.4 `npm run build` passes

## 9. Ship

- [x] 9.1 Push the migration with migrations temporarily enabled in `config.toml`, after `migration list`. Then merge, so the front end deploys
- [x] 9.2 On live, with a test item: register and assign it to a staff account, confirm from that account, link it to a ticket, return it, and retire it. Check the history and the notifications
- [x] 9.3 Check that the daily job is scheduled (`cron.job`)
- [ ] 9.4 Hand over to IT for the stocktake: register, label and assign every item, sensors included. Tell staff to confirm their handovers
- [ ] 9.5 Remind IT to start the first check-in round about a month after the stocktake
