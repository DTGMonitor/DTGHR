# Port the DTG theme, employee profile and KPI scorecards onto Supabase

## Why

Two lines of work landed on the same files from different directions.

On 19 September the backend was replaced: `feat: move the backend into Supabase`
on the frontend, `chore: retire the FastAPI service` on the backend. The browser
now talks to Supabase directly — PostgREST behind row-level security for reads,
`SECURITY DEFINER` Postgres functions for anything with logic behind it. That
change is sound: its seven migrations pass 42 assertions against real Postgres
(PGlite), and migrations 1–6 are already applied to the live project.

In parallel, branch `ui/dtg-theme-profile-kpi` carries two days of work that was
built against the FastAPI backend: the DTG brand theme, the employee profile
with photos, the KPI scorecards for six roles, the reward model from the 2026
bonus workbook, and schedule visibility split by work pattern.

Neither branch knows about the other. Six frontend files import `@/lib/api`,
which the Supabase commit deleted. Both branches contain a migration numbered
`0010` with parent `0009`, so they cannot coexist in one Alembic history.

The logic on the branch is tested and correct. It is on the wrong foundation.
This change moves it across.

## What Changes

- **Theme** — the DTG design system (navy/teal surfaces, signal green, Inter and
  IBM Plex Mono, 4/8/12px radii, the wordmark) applied to the screens as they
  exist on `main`, not as they existed on the branch. `main`'s dashboard is
  richer than the branch's and is the one to theme.
- **Employee profile** — extended fields, photo storage and `DTG-YY-NNN`
  numbering become a Supabase migration plus RPC functions.
- **KPI scorecards** — six role templates, 0–5 ratings mapped to achievement
  factors, the review chain (assessor → approver), and the reward tiers from
  `DTG_KPI_Bonus_Scorecards_2026` become tables, functions and RLS policies.
- **Schedule visibility** — office-day vs roster, the back-up engineer, and
  hiding former staff move from a Python service into RLS policies, where they
  are enforced by the database rather than by application code.
- **Alembic** — the branch's `0010_employee_profile_and_kpi.py` is superseded by
  the SQL migration and is removed rather than renumbered. Alembic is retired.

## Impact

- Affected specs: `performance-reviews` (new), `employee-profile` (new),
  `schedule-visibility` (new)
- Affected code: `frontend/src/**` (theme, services, KPI and profile screens),
  `frontend/supabase/migrations/**` (new migration), branch
  `ui/dtg-theme-profile-kpi` (source material, then retired)
- **Not affected:** the seven existing Supabase migrations. This change adds a
  new one; it does not edit any that have been applied.

## Out of scope

- The `Salary_Forecast` sheet (BPJS, tax bearer, income tax, monthly and annual
  expense against revenue). A separate screen and a separate decision about who
  may see it.
- Admin-editable absence codes. Proposed, not yet designed; needs a
  `shift_codes` table before the thirteen hardcoded codes can move.
- Applying migration 7 to live. Independent of this change and should happen
  first, on its own.
