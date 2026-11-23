# Office asset register

## Why

Office assets are tracked in an Excel file that IT keeps. The file is often
out of date because every change depends on someone remembering to open it
afterwards: a laptop handed over, a person leaving, a repair. Nobody can say
with confidence who holds what, and nothing records that the holder accepted
responsibility for an item. The old file can't be found reliably anyway, so
the register starts fresh on the platform. IT does a stocktake and retags
everything.

The company already owns sensors that will later be installed on client
sites as a vendor. They sit in storage today. Registering them now as
ordinary assets means the site work later only adds deployment. It doesn't
start a second register.

## What Changes

- **An asset register under IT.** Every item gets a platform-generated tag
  (`DTG-LAP-0001`: company prefix, category code, running number), a
  category, a name/model, an optional serial number, purchase details, an
  optional warranty date, and an optional calibration due date for
  categories that track calibration (sensors).
- **Statuses:** `in_store`, `assigned`, `in_repair`, `retired`, `lost`.
  Each move is an explicit action, and `retired` is final.
- **The holder accepts responsibility.** IT assigns an item. The employee
  gets an action notification and either confirms receipt or says they
  didn't receive it. Until they confirm, the handover shows as pending. A
  decline flags the item to IT.
- **"My equipment"** for every employee: the items they hold, which ones
  still need confirming, and the check-in items waiting on them. Values are
  not shown to employees.
- **An append-only history per asset:** registered, edited, assigned,
  confirmed, declined, returned, repair, lost, found, retired, check-in
  responses, and ticket links. Each entry records who and when.
- **Quick registration for the stocktake.** "Save & add another" keeps the
  category, brand and model filled in, and an item can be assigned while it
  is registered.
- **Ticket link.** IT can link a ticket to the asset it concerns. The
  ticket shows the asset, and the asset's history shows the ticket.
- **Leavers.** IT is told when someone who still holds items is deactivated
  or has a manpower contract ending within 14 days. The register lists
  "leaving with items".
- **Check-in rounds.** IT starts a round. Every holder confirms each item
  ("I have it" / "Not with me"), and IT marks the items in store or in
  repair as seen. Holders are reminded after 7 days. "Not with me" flags the
  item to IT and does not change its status. IT closes the round, and the
  summary (confirmed, missing, no reply, seen) is kept for audit. IT is
  reminded when six months have passed since the last round.
- **Access:**
  - IT support (`is_it_support`) manages the register.
  - Finance and management read all of it, including values.
  - Employees see only their own items, without values.

### Non-goals

- Installing sensors on sites, sites or projects as holders, and the
  `deployed` status. These come in a later change, and the design leaves
  room for them.
- Linking assets to purchase orders. A nullable column can be added later.
- Importing the old Excel file.
- Printable QR or barcode labels.
- Depreciation or book-value calculations. The register stores the purchase
  value only.
- Consumables or stock counts.
- Calibration reminders. The date is stored now, and reminders come with
  the sensor change.

## Capabilities

### New Capabilities

- `asset-register`: assets, categories and tags, statuses and the moves
  between them, handover confirmation, the per-asset history, My equipment,
  leavers with items, and who may see and do what.
- `asset-check-in`: check-in rounds: starting, responding, reminders,
  closing, the kept summary, and the six-month nudge.

### Modified Capabilities

- `notifications`: new requirement. The asset register and check-in
  notify the holder and IT, and their action items are settled when the
  holder or IT acts.
- `it-support-tickets`: new requirement. IT can link a ticket to the
  asset it concerns.

## Impact

- **Database:** one migration, dated after `20261015000100`.
  - New tables:
    - `asset_categories`, seeded with the starting categories;
    - `assets`;
    - `asset_events`;
    - `asset_checkin_rounds`;
    - `asset_checkin_items`;
    - `asset_leaver_notices`.
  - New column `support_tickets.asset_id`.
  - New `assets_*` functions, and `tickets_link_asset`.
  - `tickets_serialise` is redefined to carry the asset.
  - A daily job, `assets_daily_run`, is scheduled where `pg_cron` exists.
- **Front end:**
  - a new `/equipment` page: the register for IT, Finance and management, and
    My equipment for everyone else;
  - a sidebar entry;
  - an asset picker on the ticket for IT;
  - `assetService.ts` and `routes/assets.ts`.
- **Tests:** a new `supabase/test/areas/assets.test.mjs`. Tickets and
  notifications tests gain steps for the ticket link.
- **People:**
  - IT runs the go-live stocktake: register, label and assign every item.
  - Tell staff they will be asked to confirm what they hold, and that a
    check-in comes round every six months.
