## 1. Migration: audit trigger

- [x] 1.1 Create `supabase/migrations/<timestamp>_role_assignment.sql` with a `begin; … commit;` wrapper and a header comment explaining why the role needed an app path and an audit trail
- [x] 1.2 Add a `roles_label(public.user_role)` helper returning Director, Executive, Finance or Employee (immutable, not granted to clients)
- [x] 1.3 Add `users_audit_role_and_activation()` and an AFTER UPDATE OF `role, is_active` trigger with the `WHEN` clause.
  - It writes `ROLE_CHANGED` (description "Name: Old → New", with " (outside the app)" appended when `auth.uid()` is null), `ACCOUNT_DEACTIVATED` or `ACCOUNT_REACTIVATED` through `log_activity`.
  - `target_id` and `target_user_id` are both the user's id.

## 2. Migration: functions

- [x] 2.1 Add `roles_set_user_role(p_user_id uuid, p_role public.user_role)`.
  - Gate: `is_hr_admin()`.
  - Refusals: the row is locked with `for update`; then `PT404` for a missing target, `PT403` for the caller's own account and for executive on either side, and `PT422` for an inactive login or a missing or inactive linked employee.
  - Behaviour: when the role is unchanged, return without writing; otherwise update the role and return `{user_id, role, is_superuser}`.
- [x] 2.2 Inside 2.1, after the update, enqueue `role_changed`, in a `begin … exception when others → raise warning` block.
  - The executives get tone `reminder` with details Person, From, To and Changed by, linking to `/activity`.
  - The person gets tone `success` for finance or director and `reminder` otherwise, linking to `/`.
  - Both use `source_table = 'users'`, and the caller is in `p_exclude`.
- [x] 2.3 Add `roles_list()`. It is director-only (`PT403` otherwise) and returns `{items: [{user_id, employee_id, role}], finance_count}` for active logins with an active linked employee.
- [x] 2.4 Revoke everything from `public` on all the new functions. Grant `execute` to `authenticated` on `roles_set_user_role` and `roles_list` only.
- [x] 2.5 Confirm that no existing function is redefined in this migration, so a replay can't undo later changes.

## 3. Database tests

- [x] 3.1 Create `supabase/test/areas/roles.test.mjs` with fixtures: a director, an executive, two finance accounts, an employee, a people-admin employee, an employee with an inactive record, and a login with no employee
- [x] 3.2 Test the director setting finance and director, including that `is_superuser` follows the role, and that an unchanged role writes no log and sends no notification
- [x] 3.3 Test the refusals: each non-director caller (`PT403`), the caller's own account, granting executive, removing executive, an inactive login, a login with no employee, an inactive employee, and a missing user. Assert the role is unchanged after each.
- [x] 3.4 Test the audit:
  - an app change logs `ROLE_CHANGED` with the director as actor;
  - a direct `update` as the superuser logs it with a null actor and the "(outside the app)" suffix;
  - deactivation logs `ACCOUNT_DEACTIVATED`.

  Order assertions by something other than `created_at` alone, because of PGlite's millisecond clock.
- [x] 3.5 Test the notifications:
  - one `role_changed` for each executive and one for the person, with the expected tones and `needs_action = false`;
  - none for the director;
  - none for a direct SQL `update`.
- [x] 3.6 Test `roles_list`: the director gets the items and `finance_count`, and anyone else gets `PT403`
- [x] 3.7 Run `node supabase/test/run.mjs` and get the whole suite green

## 4. Frontend

- [x] 4.1 Add `src/lib/routes/roles.ts` with `GET /roles` → `roles_list` and `PUT /roles/:userId` → `roles_set_user_role`, and register it the way the other route files are
- [x] 4.2 Add `roleService` (`list()` and `set(userId, role)`) next to `employeeService`, with types
- [x] 4.3 In `SettingsPage.tsx`, load `roleService.list()` alongside the existing load and join it by `employee_id`
- [x] 4.4 Add the Role column, first after the name.
  - A row with a login gets a `<select>` (Employee, Finance, Director).
  - `executive` shows as a locked label with a "Set outside the app" tooltip.
  - The director's own row is read-only.
  - An employee with no login shows "No login" with the existing Create account action.
- [x] 4.5 Save optimistically and revert on failure, showing the server's message, matching the capability toggles
- [x] 4.6 Show a confirmation before moving the last finance holder (`finance_count = 1`) to another role, with the wording from the design
- [x] 4.7 Run the type check and lint

## 5. The finance approval switch tells the executives

- [x] 5.1 In the role-assignment migration, redefine `finance_settings_update` from its only definition (`20260926000800_finance.sql`). Keep everything as it is, and add:
  - read the current value before the update;
  - when the value really changes, enqueue `finance_settings_changed` for the executives, excluding the caller, in a `begin … exception when others → raise warning` block;
  - payload: tone `reminder`, eyebrow "Finance requests", headline "The director can now approve finance requests" or "The director can no longer approve finance requests", details Setting, Now and Changed by, link `/activity`, `source_table = 'finance_settings'`.
- [x] 5.2 Update the migration's header comment: it now redefines one existing function, and names where from
- [x] 5.3 Point the gate in `roles_set_user_role` and `roles_list` at `is_platform_admin()` in place of `is_hr_admin()`
- [x] 5.4 Add tests next to the existing settings checks in `supabase/test/areas/finance.test.mjs`:
  - switching on notifies each executive once, with the "can now approve" headline, tone `reminder` and `needs_action = false`;
  - switching off notifies with the "can no longer approve" headline;
  - the director gets none, and saving the value it already holds notifies nobody;
  - the suite leaves the setting as it found it.
- [x] 5.5 Run `node supabase/test/run.mjs` and get the whole suite green

## 6. Verify and ship

- [ ] 6.1 Manual check in the running app as the director: set someone to Finance; confirm that the activity log shows it, that Peter and the person get notifications, and that after a refresh the person sees the Finance navigation
- [ ] 6.2 Manual check: the executive row is locked, the director's own row is read-only, and the last-finance confirmation appears
- [ ] 6.3 Manual check: switch "The Director can approve finance requests" on and off, confirm the executive gets a notification each time, and leave the setting as it was
- [ ] 6.4 Push the migration to production, then deploy the frontend. Run `migration list` first, and see the memory note on toggling migrations for `db push`.
- [ ] 6.5 After deploying, run a direct role `update` in the SQL editor on a test account and confirm the "(outside the app)" activity entry appears
