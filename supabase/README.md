# Supabase backend — migration runbook

The FastAPI backend is gone. The browser now talks to Supabase directly:
reads go through PostgREST behind row-level security, and everything with
business logic behind it goes through a Postgres function.

**Why:** every request used to pay a Python cold start on Vercel *and* a second
network hop before it reached Postgres. The roster page was the worst case —
its single endpoint ran six queries behind that lambda. It is now one RPC call
that returns one document.

---

## What is in here

| File | What it does |
| --- | --- |
| `20260916000100_supabase_auth_migration.sql` | Copies `public.users` into `auth.users`, id for id. Demotes `public.users` to a profile table. Adds the trigger that provisions a profile for every new auth user. |
| `20260916000200_helpers_and_rls.sql` | `is_admin()`, `current_employee_id()` and friends; RLS policies on all ten tables; the indexes those policies need. |
| `20260916000300_views.sql` | `employees_view`, `leave_requests_view`, `activity_logs_view` — the three lists the frontend paginates through PostgREST. |
| `20260916000400_rpc_session_and_employees.sql` | `bootstrap_session()` (replaces `GET /auth/me`), plus the five employee endpoints. |
| `20260916000500_rpc_leaves_and_dashboard.sql` | Leave balances, submit/approve/reject/cancel, `dashboard_stats()`, `leave_summary()`. |
| `20260916000600_rpc_schedules.sql` | The roster: `get_schedule_detail()`, proposals and review, `apply_roster_pattern()`, and the annual-leave accrual maths ported from `schedule_service.py`. |
| `20260919000100_holidays_offboarding_leave_activity.sql` | Upserts the SKB 3 Menteri holiday calendar for 2026 (corrected) and 2027. `deactivate_employee()` now also revokes sign-in (profile inactive, auth user banned, sessions dropped); new `reactivate_employee()`. `leave_activity_view` for the Leaves page feeds. PH loading gains a year-to-date count and the dates behind it. |

They are ordered and must be run in order. Each one is wrapped in a
transaction and is safe to re-run.

---

## Applying them

### Option A — Supabase SQL editor (no tooling needed)

Open the SQL editor in the Supabase dashboard and paste each file in filename
order, running one at a time. Stop at the first error rather than carrying on.

### Option B — Supabase CLI

```bash
npm install -g supabase
supabase link --project-ref mapacifoqcybetzglhow
supabase db push
```

### Checking them first

```bash
npm run test:db
```

This runs every migration against a throwaway Postgres (PGlite — real Postgres
compiled to WebAssembly, no Docker and no network), seeded with a miniature
version of this database, and then exercises the result: 42 assertions
covering the auth copy, the RLS boundaries, the accrual maths, proposal and
review, the rotation generator, and the leave balance rules.

`supabase/test/00_baseline.sql` is the pre-migration schema — Alembic head
`0009` plus the parts of Supabase's `auth` schema the migration touches. Update
it if the real schema moves.

It is not a substitute for a backup: it proves the SQL does what it claims on a
clean database, not that it will land cleanly on yours.

### Before you start

**Take a backup.** This touches `auth.users` and drops a column from
`public.users`, against a database that already holds the seeded roster
(21 published months, ~4,200 shifts). Supabase dashboard →
Database → Backups.

The first migration refuses to run if `auth.users` already holds one of your
addresses under a different id — that would orphan a profile — so a
half-finished attempt fails loudly rather than corrupting anything.

---

## After applying

### 1. Verify the auth migration

```sql
-- every profile should have an auth user with the same id
select count(*) from public.users u join auth.users a on a.id = u.id;
select count(*) from public.users;   -- the same number

-- the local password hash is gone
select column_name from information_schema.columns
 where table_schema='public' and table_name='users' and column_name='hashed_password';
-- (0 rows)
```

Existing passwords still work: GoTrue verifies bcrypt in Go and accepts the
`$2b$` hashes Python's `bcrypt` produced. Nobody has to reset anything.

The one exception is accounts that were auto-provisioned from an Entra token —
their hash was the placeholder string `entra-id-managed`, so they now have a
`NULL` password and can only get in through SSO. That was already true.

### 2. Frontend environment variables

In Vercel → the frontend project → Settings → Environment Variables:

```
VITE_SUPABASE_URL=https://mapacifoqcybetzglhow.supabase.co
VITE_SUPABASE_ANON_KEY=<Project Settings -> API -> anon public>
VITE_AZURE_SSO_ENABLED=       # leave blank for now; see below
```

Delete `VITE_API_BASE_URL` — there is no API to point at any more.

Vite inlines these at **build** time, so redeploy after changing them.

The anon key is safe in the bundle: it grants nothing on its own, because
every table is behind RLS. The **service_role** key must never go near the
frontend.

### 3. Retire the backend deployment

The Vercel config has already been removed from `DTG-HR-HUB-BE`. To stop the
deployment itself:

```bash
vercel remove dtghr-be
```

or delete the `dtghr-be` project in the Vercel dashboard. Its environment
variables (`DATABASE_URL`, `SECRET_KEY`, …) go with it.

### 4. Microsoft SSO, when you want it

It was never switched on — `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` were blank —
so nothing regresses by leaving it off. The application code is already in
place; enabling it is configuration in two dashboards plus a build-time flag.

**[SSO_SETUP.md](SSO_SETUP.md)** is the step-by-step guide, including the three
things that reliably go wrong: registering the Entra app as a single-page
application instead of **Web**, leaving the Azure Tenant URL blank, and letting
Supabase create duplicate accounts instead of linking the Entra identity onto
the existing ones.

The trigger in migration `...000100` provisions a profile on first SSO sign-in
and links the roster row whose email matches, which is what the old backend did
on every request.

### 5. Making someone an admin

`is_superuser` lives on the profile, not in the JWT:

```sql
update public.users set is_superuser = true where email = 'admin@dtgeotech.com';
```

---

## How authorisation works now

Three layers, in order of how much they carry:

1. **RLS policies** scope every read. An employee sees published schedules and
   their own leave; a manager also sees their direct reports'; HR sees
   everything. The policies call `is_admin()` and `current_employee_id()`,
   which are `SECURITY DEFINER` (a policy on `users` that had to read `users`
   would recurse) and `STABLE` (so the planner evaluates them once per
   statement rather than once per row).

2. **`SECURITY DEFINER` functions** do every write. They re-check permission
   themselves — `if not public.is_admin() then raise ... 'PT403'` — because
   running as the owner means RLS does not apply inside them.

3. **Three definer views** back the paginated lists. They bypass RLS
   deliberately and carry their own `WHERE` clause instead, because they have
   to join across rows the caller cannot read directly — `on_leave_today`
   reads `leave_requests`, which RLS narrows to the caller's own. `is_admin()`
   and `auth.uid()` describe the *session*, not the view owner, so the scoping
   still answers correctly. They are granted to `authenticated` only.

Errors use a SQLSTATE of the form `PTnnn`, which PostgREST returns as HTTP
`nnn`; the frontend turns that back into the `err.response.data.detail` shape
the pages were already written against.

---

## Endpoint map

| Was | Is now |
| --- | --- |
| `POST /auth/login` | `supabase.auth.signInWithPassword` |
| `GET /auth/me` | `bootstrap_session()` |
| `POST /auth/change-password` | `supabase.auth.updateUser` + `complete_password_change()` |
| `GET /employees` | `employees_view` (PostgREST) |
| `POST /employees` | `create_employee()` |
| `PUT /employees/{id}` | `update_employee()` |
| `DELETE /employees/{id}` | `deactivate_employee()` |
| `POST /employees/{id}/create-account` | `create_employee_account()` |
| `GET /leaves` | `leave_requests_view` (PostgREST) |
| `GET /leaves/balances` | `get_leave_balances()` |
| `GET /leaves/pending-approvals` | `leave_requests_view`, filtered |
| `GET /leaves/summary` | `leave_summary()` |
| `POST /leaves`, `/{id}/cancel`, `/approve`, `/reject` | `submit_leave_request()`, `cancel_leave_request()`, `approve_leave_request()`, `reject_leave_request()` |
| `GET /dashboard/stats` | `dashboard_stats()` |
| `GET /activity/recent` | `activity_logs_view` (PostgREST) |
| `GET /schedules` | `work_schedules` (PostgREST) |
| `GET /schedules/{id}` | `get_schedule_detail()` |
| `POST /schedules` | `create_schedule()` |
| `PUT /schedules/{id}/cell` | `set_schedule_cell()` |
| `PUT /schedules/{id}/assignments` | `save_schedule_assignments()` |
| `PUT /schedules/{id}/publish` / `unpublish` | `publish_schedule()` / `unpublish_schedule()` |
| `DELETE /schedules/{id}` | `delete_schedule()` |
| `POST /schedules/{id}/change-requests` | `propose_shift_changes()` |
| `GET /schedules/change-requests` | `list_change_requests()` |
| `PUT /schedules/change-requests/{id}/review` | `review_shift_change()` |
| `DELETE /schedules/change-requests/{id}` | `cancel_shift_change()` |
| `POST /schedules/roster-pattern` | `apply_roster_pattern()` |
| `GET /schedules/public-holidays` | `public_holidays` (PostgREST) |

---

## One thing worth knowing

`create_employee_account()` writes `auth.users` and `auth.identities` by hand,
using `pgcrypto` to hash the temporary password. That is the only place in
this codebase that reaches into a schema Supabase owns.

The alternative is GoTrue's admin API, which needs the `service_role` key.
That key cannot go in a browser, so using it would mean standing up an Edge
Function — and paying a cold start on exactly the kind of rare, interactive
action where a cold start is most noticeable. The insert mirrors the one in
the auth migration, so if that worked, this does too.

If a future GoTrue release changes those tables, this is the function to check.
