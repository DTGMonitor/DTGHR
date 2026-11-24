# vendors Specification

## Purpose
The vendor list used by purchasing: what a vendor record holds, who manages vendors, and the rule that only the approver changes a bank account, after a callback to the number already on file.
## Requirements
### Requirement: Vendor records
A vendor SHALL have:
- a name, unique ignoring case and surrounding spaces;
- an optional NPWP (tax ID), unique where given, ignoring spaces, dots and dashes;
- whether it is PKP (charges PPN);
- a contact person, a phone number and an email;
- a bank name, an account number and an account holder;
- whether it is active.

An inactive vendor SHALL NOT be chosen for a purchase. Its past purchases SHALL still show it.

#### Scenario: Duplicate name
- **WHEN** finance adds "pt sinar " and "PT Sinar" already exists
- **THEN** the request is refused with a validation error

#### Scenario: Deactivated vendor
- **WHEN** finance deactivates PT Sinar and then tries to choose it for a purchase
- **THEN** the choice is refused with a validation error, and PT Sinar's earlier purchases still name it

### Requirement: Who manages vendors
- Finance SHALL add vendors, including their first bank account, and edit everything except the bank account.
- Finance and Peter SHALL deactivate vendors and reactivate them.
- Finance, the director and Peter SHALL read the vendor list, bank accounts included.
- Everyone else SHALL see only a vendor's name, on purchases they can see.

#### Scenario: Staff can't list vendors
- **WHEN** Rina asks for the vendor list
- **THEN** the request is refused as not found

### Requirement: Only Peter changes a bank account, after a callback
After a vendor is added, only Peter (role `executive`) SHALL change its bank name, account number or account holder. Each change SHALL require a callback note: the number Peter called, which SHALL be one already on file, and what was confirmed. The change SHALL be recorded as a vendor event with the old and new account, the note, who made it and when. Vendor events SHALL NOT be edited or deleted.

#### Scenario: Finance can't change the account
- **WHEN** finance tries to change PT Sinar's account number
- **THEN** the request is refused as forbidden

#### Scenario: Peter changes it
- **WHEN** Peter changes PT Sinar's account with the callback note "Called 021-555-0101 on file, Ibu Sari confirmed the new BCA account"
- **THEN** the account is changed, and the vendor's history shows the old and new account and the note

#### Scenario: No callback note
- **WHEN** Peter changes the account with an empty note
- **THEN** the request is refused with a validation error

