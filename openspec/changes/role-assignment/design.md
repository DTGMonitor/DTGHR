## Context

- **Roles today** (`20260921000100_user_roles.sql`):
  - `public.users.role` is the `user_role` enum (`director`, `executive`, `finance`, `employee`), defaulting to `employee`;
  - `users_sync_superuser`, a BEFORE trigger, keeps `is_superuser` in step with the role (true for `director` and `executive`);
  - the helpers are `current_user_role()`, `is_admin()` (director or executive), `is_hr_admin()` (director only), `is_executive()` and `is_finance()`.
- **How a role is set today:** only by hand.
  - `handle_new_auth_user()` and `bootstrap_session()` insert the `users` row without a role, so every login starts as `employee`.
  - Nothing in `src/` or in the migrations' functions writes `role`. The only bulk write was the 2026-09-21 backfill of superusers to `director`.
- **Capabilities are a different layer.** `can_manage_people`, `can_write_articles` and the other flags live on `employees`. The director edits them in the Settings matrix ([SettingsPage.tsx](../../../src/pages/SettingsPage.tsx)), which only the director may open.
- **Activity log:**
  - `log_activity(action, description, target_id, target_user_id)` writes `activity_logs` and swallows its own errors;
  - `activity_recent` shows everything to superusers, and to everyone else the entries where they are the actor or the target.
- **Notifications:**
  - `notifications_enqueue(user_ids, exclude, kind, subject, payload, source_table, source_id)` drops ineligible recipients;
  - `needs_action` comes from `notifications_needs_action(kind, payload)`;
  - notifications render from their payload, so a new kind needs no frontend work.
- **Pattern for an area** (tickets, assets, purchasing):
  - RLS is on and every write goes through a `security definer` function;
  - a refusal raises `PT403`, `PT404` or `PT422`;
  - notification calls sit in their own `begin … exception when others → raise warning` blocks.

## Goals / Non-Goals

**Goals:**
- The director can set `employee`, `finance` or `director` on an active, linked account from Settings.
- `executive` can't be granted or removed in the app.
- Every change to `role` or `is_active` is recorded, including ones made outside the app.
- The executives and the affected person hear about app-made role changes.

**Non-Goals:**
- **Logins with no employee record.** They are not shown or assignable here; that is the `employee-login-linking` change.
- **More than one role per person.** The single enum stays, and with it the separation between finance and executive.
- **Forcing a re-login** after a change.
- **Logging account creation.** `ACCOUNT_CREATED` stays where it is today.
- **Moving the capability flags off `employees`.**

## Decisions

### 1. One server function, gated on `is_hr_admin()`

`roles_set_user_role(p_user_id uuid, p_role public.user_role) returns jsonb`, `security definer`. Its steps:
1. Refuse unless `is_hr_admin()` (`PT403`).
2. Lock the target row with `select … for update`. Raise `PT404` if it is missing.
3. Refuse, with the codes in the spec:
   - a change to the caller's own account;
   - an inactive login;
   - a login with no linked employee, or a linked employee that is inactive;
   - `executive` as either the old or the new value.
4. If the new role equals the old one, return the row and stop.
5. `update public.users set role = p_role`. The existing BEFORE trigger fixes `is_superuser`.
6. Notify (decision 4), and return `{user_id, role, is_superuser}`.

*Why `is_hr_admin()` and not `is_admin()`?* Settings is already director-only in the UI. `is_admin()` would also let the executive assign roles, and the executive is the approver whose independence this protects.

*Why no separate "last director" rule?* Only a director can call the function and nobody can change their own role, so at least one director always remains: the caller.

### 2. The audit is a trigger, not a line in the function

`users_audit_role_and_activation` is an AFTER UPDATE OF `role, is_active` trigger on `public.users`, with `WHEN (old.role is distinct from new.role or old.is_active is distinct from new.is_active)`. It calls `log_activity(...)`:
- action `ROLE_CHANGED`, `ACCOUNT_DEACTIVATED` or `ACCOUNT_REACTIVATED`;
- `target_id` and `target_user_id` both the user's id;
- a description built from the display label of each role (Director, Executive, Finance, Employee), e.g. "Sari Wulandari: Employee → Finance". A trailing " (outside the app)" is added when `auth.uid()` is null.

*Alternative considered: log inside `roles_set_user_role`.* It's simpler, but it misses exactly the changes that motivated this work: the SQL editor, the dashboard and migrations. The trigger records every write path. The `WHEN` clause keeps it free on the many other updates to `users`.

`log_activity` already swallows its own errors, so a logging failure can't roll back the role change.

Side effect: `people_deactivate_employee` → `set_login_enabled` will now also write an `ACCOUNT_DEACTIVATED` entry, next to the existing `EMPLOYEE_DEACTIVATED` one. That's accepted: the two record different things, a record and a login.

### 3. Notifications come from the function, not the trigger

`role_changed` is written only when the change came through the app. This avoids two problems:
- a migration backfill would otherwise send a notification to everyone;
- a trigger can't tell an app write from an editor write except by `auth.uid()`, which is fragile.

The payload follows the existing shape:
- **Executives:** tone `reminder`, eyebrow "Roles", headline "Sari Wulandari is now Finance", details `[Person, From, To, Changed by]`, link `{ label: "Open the activity log", path: "/activity" }`.
- **The person:** tone `success` when the new role is `finance` or `director`, `reminder` otherwise. Headline "You now have the Finance role", an intro saying it applies after a refresh or the next sign-in, and link `/`.
- `source_table = 'users'` and `source_id` = the user's id.
- `notifications_needs_action` doesn't list `role_changed`, so `needs_action` is false and nothing needs resolving.

The enqueue sits in a `begin … exception when others → raise warning` block, as in every other area.

### 4. One read for the matrix: `roles_list()`

`roles_list() returns jsonb`, director-only (`PT403` otherwise). It returns one entry per active login with a linked active employee: `{user_id, employee_id, role}`, plus `finance_count`, the number of active `finance` accounts.

The Settings page already loads the active employees. It:
- joins this list by `employee_id`;
- shows "No login" plus Create account for employees whose `has_account` is false;
- uses `finance_count` for the last-holder confirmation.

*Alternative considered: add `role` to `people_get_employee`.* The matrix already makes one call per employee, but that function is read by people admins and by staff reading their own record. Adding the login's role there widens who can see roles. A separate director-only read keeps it contained.

### 5. Executive is locked in both places

The Role cell renders `executive` as a locked label ("Executive", lock icon, tooltip "Set outside the app"). The server refuses it as well, so a forged request gains nothing. Granting the role stays an SQL action, and decision 2 records it.

### 6. No forced re-login

The role arrives with the session in `bootstrap_session()`. Every server function reads `current_user_role()` from the table on every call. So after a change:
- the server enforces the new role immediately;
- only the person's navigation is stale until they refresh.

Ending their sessions would mean touching `auth.sessions` and would log people out mid-task. The notification tells them to refresh.

### 7. Settings UI

- The Role column is the first after the name, before the capability toggles.
- It's a native `<select>` (Employee, Finance, Director). It saves on change, optimistically, and reverts on failure, as the toggles do.
- The director's own row shows their role read-only.
- Picking anything other than Finance for the last finance holder shows a confirm dialog first: "Nobody will hold Finance. Finance requests and purchases will have nobody to prepare them until someone does."
- Routes go in `src/lib/routes/roles.ts` (`GET /roles`, `PUT /roles/:userId`), with matching methods in a `roleService`.

## Risks / Trade-offs

- **[The director can still make a second director, or demote one]** → Accepted. Directors approve nothing on pay or purchases, the change is logged, and the executive is notified.
- **[The director makes an ally `finance`]** → Separation still holds, because the executive approves and releases. The executive is notified of every finance grant.
- **[Duplicate activity entries on deactivation]** → Accepted (decision 2). They describe different things.
- **[A role changed outside the app notifies nobody]** → It is still in the activity log, which the executive can read. Notifying from a trigger would spam on backfills.
- **[Stale navigation after a change]** → The server checks every call. The person is told to refresh.
- **[PGlite's clock has millisecond resolution]** → Tests that check the order of activity entries written in one statement must not rely on `created_at` alone.
- **[A replayed migration could undo a later redefinition]** → This migration defines only new functions and a new trigger, and redefines nothing existing (`bootstrap_session`, `log_activity`, `notifications_needs_action`).

## Migration Plan

1. Add `supabase/migrations/<timestamp>_role_assignment.sql`, holding:
   - the trigger and its function;
   - `roles_set_user_role` and `roles_list`;
   - grants to `authenticated` on the two RPCs only.
2. Run `node supabase/test/run.mjs` locally and add `areas/roles.test.mjs`.
3. Push the migration, then deploy the frontend. Doing it in the other order shows a Role column that fails to load until the push.
4. **Rollback:** drop the two functions and the trigger. No data changes, and every role already set stays as it is.

## Open Questions

- Should Peter later be able to manage `executive` himself, in his own screen with his own confirmation? This design leaves it SQL-only.
- Should the activity log offer a filter for `ROLE_CHANGED` so the executive can review all grants at once? It's easy to add later.
