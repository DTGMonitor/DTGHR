# Porting the FastAPI line onto Supabase

Branch `feat/supabase-port` (this worktree) carries every screen from
`ui/dtg-theme-profile-kpi`. The screens still call the old REST paths through
`src/lib/api.ts`, which is now an adapter: each path is answered by a route
registered in `src/lib/routes/<area>.ts`, which calls a Postgres function (or
Supabase Storage). A path with no route fails with a 501 naming it.

**The FastAPI backend is the specification.** It lives at
`C:\Users\LENOVO LOG\Documents\Development\HR_HUB\backend` (branch
`ui/dtg-theme-profile-kpi`): routes in `app/api/routes/`, rules in
`app/services/`, tables in `app/models/`, response shapes in `app/schemas/`,
and its pytest suite in `tests/` records the behaviour that was agreed with
Nurhuda. Port behaviour, messages and response shapes faithfully; the screens
were written against them and must work unchanged.

## What each area delivers

1. **Migration** `supabase/migrations/<number>_<area>.sql`, using the number
   assigned below. Wrapped in `begin; ... commit;`, safe to re-run
   (`if not exists`, `create or replace`). Never edit a migration dated before
   `20260926` -- the ones by Lintang are applied to live.
   - Tables mirror the SQLAlchemy models: same names, columns and types
     (`uuid primary key default gen_random_uuid()`,
     `created_at`/`updated_at timestamp not null default now()`, enums as
     `varchar` like the models store them).
   - `alter table ... enable row level security;` on every new table. Reads
     the screens make go through functions; add `select` policies only where
     a plain table read is genuinely simpler and the rule is expressible.
     No write policies: writes go through functions.
2. **Functions** named `<area>_<action>` (e.g. `payroll_list_months`,
   `finance_submit`), `language plpgsql`, `security definer`,
   `set search_path = public, pg_temp`. Each re-checks permission itself --
   running as the owner, RLS does not apply inside it.
   - Return `jsonb` in **exactly** the FastAPI response schema's shape: the
     same keys, the same nesting, numbers as numbers, dates as ISO strings.
   - Errors: `raise exception '<the FastAPI detail, word for word>' using
     errcode = 'PT403';` -- PTnnn becomes HTTP nnn on the client, and the
     message becomes `err.response.data.detail`. Use PT401, PT403, PT404
     (including "not yours to see" cases the backend answered 404), PT409,
     PT413, PT415, PT422.
   - `revoke all on function ... from public; grant execute on function ...
     to authenticated;`
   - Log what the backend logged: `perform public.log_activity(action,
     description, target_id, target_user_id);`
3. **Routes** in `src/lib/routes/<area>.ts`: one `route(METHOD, "/path/:id",
   handler)` per path the screens call for this area -- find them with
   `grep -rn "api\.\(get\|post\|put\|patch\|delete\)" src` and in the
   services. The handler receives `{ path, query, body, responseType }` and
   returns the response body (what used to be `res.data`). Use `rpc()` from
   `@/lib/supabase`. Convert query strings to the right types.
4. **Tests** `supabase/test/areas/<area>.test.mjs`, exporting
   `default async ({ db, step, asUser, tx, people })`. Port the backend's
   pytest cases that matter: permissions (who may and who may not), state
   transitions, arithmetic. Create your own rows under your own fixed ids.
   `tx(userId, sql, params)` runs as that signed-in user.

## Shared helpers (from `20260926000100_port_core.sql` and earlier)

`auth.uid()`, `current_user_role()` (`director | executive | finance |
employee`), `is_director()`, `is_executive()`, `is_finance()`, `is_admin()`
(director or executive -- the FastAPI `is_superuser`), `is_platform_admin()`
(director), `current_employee()` (the caller's employees row),
`current_employee_id()`, `can_manage_people()`, `can_manage_contracts()`,
`can_write_articles()`, `is_founder()`, `employee_deactivated(user_id)`,
`log_activity(...)`.

`public.users` has `id, email, full_name, is_active, is_superuser, role,
password_change_required, created_at, updated_at` -- no password; sign-in is
Supabase Auth. People in the test seed: `people.DIRECTOR` (Nurhuda's
stand-in, role director), `people.PETER` (executive), `people.HIMAWAN`
(finance), `people.RINA` (employee).

## Files

Uploads (contract documents, finance attachments, article images, employee
photos) go to **Supabase Storage**, private buckets, one per area. Create the
bucket in the migration, guarded so the test database -- which has no
`storage` schema -- still applies it:

```sql
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('finance-documents', 'finance-documents', false)
    on conflict (id) do nothing;
  end if;
end $$;
```

The table keeps the metadata (filename, type, size, storage path). The route
handler uploads with `supabase.storage.from(bucket).upload(...)` and records
it through an RPC; a download route returns the Blob from `.download(...)`
when `responseType === "blob"`. Storage policies on `storage.objects` belong
in the same guarded block.

## External services

Anything that calls out of Postgres -- the BPS CPI and ECB AUD->IDR fetches,
email through Microsoft Graph -- is a Supabase Edge Function under
`supabase/functions/<name>/index.ts` (Deno), with secrets (`BPS_API_KEY`,
`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`) read from the
environment. The route calls it with `supabase.functions.invoke(...)`.
PGlite cannot run these; test the SQL around them.

## Area assignments

| Number | Area | Backend source | Screens |
|---|---|---|---|
| `20260926000200` | people | `employees.py`, `profile_requests.py`, `auth.py` (me, change-password), role history, photos, visibility, Settings capabilities | Employees, profile, Settings |
| `20260926000300` | leaves | `leaves.py`, `leave_service.py`, `annual_leave.py` | Leave |
| `20260926000400` | schedules | `schedules.py`, `schedule_service.py`, `visibility.py` | Roster |
| `20260926000500` | kpi | `kpi.py`, `kpi_service.py` | KPI, My Achievement |
| `20260926000600` | payroll | `payroll.py`, `compensation.py`, `payroll_service.py`, `backup_shifts.py`, `fx.py` | Payroll, Pay forecast |
| `20260926000700` | salary | `salary.py`, `salary_guidance.py` (routes and service) | Salary |
| `20260926000800` | finance | `finance_requests.py` | Finance requests |
| `20260926000900` | tickets | `tickets.py`, `it_support.py` | IT support |
| `20260926001000` | contracts | `contracts.py` | Contracts |
| `20260926001100` | articles | `articles.py` | Bulletin |
| `20260926001200` | overview | `overview.py`, `dashboard.py`, activity | Dashboard, Activity log |

Lintang's migrations already answer parts of people, leaves, schedules and
the dashboard with functions of their own (see `supabase/README.md`'s
endpoint map). Reuse them where they do what the FastAPI line does; where the
FastAPI line has since changed the rule, the FastAPI line wins -- replace the
function in your area's migration rather than editing Lintang's file.

## Done means

`npm run test:db` all green, `npx tsc -b --noEmit` clean, and every path the
area's screens call has a route.
