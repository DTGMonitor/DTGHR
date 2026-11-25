## Why

An account's role (`employee`, `director`, `executive` or `finance`) decides who approves pay, who prepares purchases and who reads salaries. Yet nothing in the app can set it. Every account is created as `employee`, and every other role so far was set by hand in the SQL editor, which leaves no record of who changed what or when. The purchasing flow now depends on `finance` and `executive`: the procedure's control is that the person who keeps the books never releases the money. A role that can change silently undermines that control.

## What Changes

- **The director assigns roles in Settings.** The permissions matrix gets a Role column, a dropdown with Employee, Finance and Director. The change goes through a new `security definer` function, so the server enforces the rules:
  - only the director may call it;
  - nobody may change their own role;
  - the target must be an active login linked to an active employee record;
  - `executive` can't be granted or removed here.
- **`executive` stays outside the app.** It is the final signature on pay and purchases. A row that holds it shows the role locked. If the director could grant it, the director could create a second approver.
- **Every change to a role or to account activation is recorded.** A trigger on `public.users` writes the old value, the new value and who made the change to `activity_logs`. Because it is a trigger, it also catches edits made in the SQL editor or dashboard, which are recorded as having no app user.
- **The executive and the person are told.** When a role changes in the app, the executives and the person whose role changed each get an in-app notification. Neither needs action.
- **The director is warned before removing the last finance holder.** If nobody would then hold `finance`, the dropdown asks for confirmation first, because purchases and finance requests would have nobody to prepare them.
- **Employees with no login show "No login" in the Role column.** It links to the existing Create account action. Logins with no employee record are out of scope here; they belong to a separate `employee-login-linking` change.

## Capabilities

### New Capabilities
- `role-assignment`: who may change an account's role, from what to what, the guards that refuse a change, and the audit record of every role and activation change however it was made.

### Modified Capabilities
- `notifications`: adds the role-change notifications to the executives and to the person whose role changed.

## Impact

- **Database:** a new migration with:
  - `roles_set_user_role(p_user_id, p_role)` and `roles_list()`;
  - an audit trigger on `public.users`;
  - the notification kind `role_changed`.

  There is no schema change to `users`. The role enum and the `users_sync_superuser` trigger stay as they are.
- **Frontend:**
  - [SettingsPage.tsx](../../../src/pages/SettingsPage.tsx) gets the Role column;
  - a new route file `src/lib/routes/roles.ts` and a service method.

  Notifications render from their payload, so `role_changed` needs no frontend work.
- **Sessions:** a change takes effect on the person's next `bootstrap_session()`, when they refresh or log in again. The server checks the role on every call, so until then only the screens are stale; the server doesn't grant the old powers.
- **Tests:** a new `supabase/test/areas/roles.test.mjs`.
