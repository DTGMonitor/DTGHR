## ADDED Requirements

### Requirement: Shift codes are defined in one table

The system SHALL keep the roster shift codes in a single `public.shift_codes` table.
Each row SHALL hold the code, a label, a fill colour, a text colour, a legend
order, whether the cell is drawn blank in the grid, whether the code is active,
and whether it is a system code. That table SHALL be the only definition of which
codes exist; the database and the screens SHALL both read it.

#### Scenario: The fourteen current codes are seeded
- **WHEN** the migration has run
- **THEN** `shift_codes` holds exactly DS, NS, C, B, D, O, AL, SL, DL, SP, PH, TW,
  ST and T, all active, with the labels, colours, legend order and blank-in-grid
  flag the roster shows today

#### Scenario: Colours and codes are well-formed
- **WHEN** a row is written whose code is not 1–5 capital letters, or whose fill
  or text colour is not a `#RRGGBB` hex value
- **THEN** the write is refused

### Requirement: A code is never renamed or deleted

The system MUST NOT allow a shift code that any roster cell uses to be renamed
or deleted. A code that is no longer wanted SHALL be deactivated instead.

#### Scenario: Deleting a code in use is refused
- **WHEN** a code that appears on any roster cell is deleted or its code changed
- **THEN** the database refuses the change and the cells are unchanged

### Requirement: System codes stay active

The codes the system refers to by name — DS, NS, D, B, AL and PH — SHALL be
marked as system codes, and a system code MUST NOT be deactivated.

#### Scenario: Deactivating a system code is refused
- **WHEN** a write sets `active = false` on DS, NS, D, B, AL or PH
- **THEN** the write is refused

### Requirement: Roster cells hold only known codes

Every roster cell's code SHALL reference a row in `shift_codes`, whichever path
writes it — the roster RPCs, change approval, the holiday trigger, or a direct
write.

#### Scenario: Direct write of an unknown code
- **WHEN** a row is inserted into `shift_assignments` with a code that is not in
  `shift_codes`
- **THEN** the insert is refused

#### Scenario: Existing data with an unknown code stops the migration
- **WHEN** the migration runs against a database whose roster holds a code that
  is not one of the fourteen
- **THEN** the migration raises an error listing the unknown codes and applies
  none of its changes

### Requirement: Only active codes can be set on a cell

The roster RPCs SHALL accept a code only when it is in `shift_codes` and active,
and SHALL otherwise refuse with the 422 each already raises for a code off the
legend. This covers setting a cell, saving a roster, proposing a change, and
applying a roster pattern.

#### Scenario: Setting an unknown code
- **WHEN** an admin sets a cell to a code that is not in `shift_codes`
- **THEN** the request is refused with "shift_code: '<code>' is not a shift code"

#### Scenario: Setting an inactive code
- **WHEN** an admin sets a cell, saves a roster, proposes a change or applies a
  pattern using a code that exists but is inactive
- **THEN** the request is refused with that RPC's 422 and nothing is written

#### Scenario: Setting SP
- **WHEN** an admin sets a cell to SP
- **THEN** the cell is saved as SP

### Requirement: Inactive codes still display on existing cells

A cell that already holds a code which is later deactivated SHALL keep that code
and SHALL still be shown with the code's label and colours.

#### Scenario: Viewing a roster with an inactive code
- **WHEN** a roster containing a cell with an inactive code is opened
- **THEN** the cell shows that code in its own colours, and the legend still
  explains it

### Requirement: Shift codes are readable by signed-in users only, and written only by migrations

Any signed-in user SHALL be able to read `shift_codes`. Anonymous users SHALL
NOT be able to read it, and no signed-in user, including an admin, SHALL be able
to insert, update or delete rows through the API.

#### Scenario: A signed-in employee reads the codes
- **WHEN** any signed-in user reads `shift_codes`
- **THEN** all rows are returned

#### Scenario: An admin tries to edit a code through the API
- **WHEN** an admin inserts, updates or deletes a `shift_codes` row through the API
- **THEN** no row changes

### Requirement: Roster screens take the codes from the database

The roster and dashboard screens SHALL take each code's display from the database.
The legend, roster grid, cell editor, roster pattern modal, dashboard week strip
and dashboard today tile SHALL take each code's label, colours, order and
blank-in-grid flag from `shift_codes`. The cell editor and the roster pattern
modal SHALL offer active codes only, in legend order. A code the screen has not
loaded or does not know SHALL be shown in a neutral style with its code as text,
never as a blank or broken cell.

#### Scenario: Picker offers active codes only
- **WHEN** an admin opens the cell editor
- **THEN** it lists every active code in legend order and no inactive code

#### Scenario: A code changes colour in the table
- **WHEN** a migration changes a code's colours and a user reloads the roster
- **THEN** the grid, legend and dashboard show the new colours without a front-end
  change

#### Scenario: Codes not yet loaded
- **WHEN** the roster renders before the codes have arrived
- **THEN** each cell shows its code in the neutral style until the codes load
