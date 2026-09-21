# Tasks

Ordered so that every stage ends with something that runs. When stage 3 breaks,
it is stage 3 — because stage 2 was green.

## 0. Prerequisites

- [x] Apply migration 7 to live so it matches the repo (independent of this change)
      — applied 20 Sep 2026 via the SQL Editor. Verified: `reactivate_employee`
      returns PT403 to an anonymous caller (was PGRST202 404), `annual_leave_state`
      returns 200.

No dev project. The existing one is built, migrations 1–7 are applied, and a
second project would have to be kept in step by hand. Stages 1–6 run against
live from `localhost`, which is safe while the work is read-only or additive:
new tables and new functions, nothing dropped or rewritten.

The exception is stage 2, the first migration that touches `employees`. Prove it
on a clean database with `npm run test:db` before it goes near live, and take a
backup first.

## 1. The DTG screens onto Supabase

Revised 21 Sep 2026: Nurhuda wants his own screens, not Lintang's re-themed —
he intends to replace that frontend wholesale. Lintang's data layer stays.

- [x] Bring across `tailwind.config.js`, `src/index.css`, `public/brand/`, `src/components/brand/`
- [x] Shell: `Layout`, `Header`, `Sidebar`, `AuthShell`
- [x] `LoginPage` and `SetPasswordPage` — main's Supabase auth calls kept verbatim
- [x] Dashboard, Employees, Leave and Roster taken from the branch and rewired
- [x] Roster grid fixes carried over: full-width table, `ON DUTY` cover row, name column sizing
- [x] Shared UI primitives: `Modal`, `Drawer`, `Alert`, `Spinner`, `StatTile`, `icons`
- [x] Salary panel and `dashboardSample.ts` removed — placeholder figures, shown
      to every employee alike; payslips to be done properly later
- [x] Verify: `npm run build`, and all five screens screenshotted at 1495px and 390px
- [ ] Re-add from Lintang's version, onto these screens: leave overview cards,
      leave activity feed, holiday calendar (components kept, now unreferenced)

## 1b. Roles

Four roles replace `is_superuser`. Everything downstream keys off this, so it
lands before the review chain and before the visibility policies.

- [x] `user_role` enum: admin | executive | finance | employee; column on the
      profile, defaulting to employee; existing superusers backfilled to admin
- [x] `is_superuser` mirrored from the role by trigger, both ways, so anything
      still reading it stays consistent mid-deploy
- [x] `is_admin()` keeps its meaning and now covers the executive too;
      `is_hr_admin()`, `is_executive()`, `is_finance()`, `current_user_role()`
- [x] Leave: either admin or executive may approve, one signature settles it,
      the executive may overturn, and the reversal is named in the activity trail
- [x] Balance reconciliation on a reversal — the days only move on an actual
      transition, so re-approving cannot double-count and overturning an
      approval gives the days back
- [x] Finance is excluded from `is_admin()`, so leave approval, employee edits
      and account creation are already refused
- [x] `bootstrap_session` carries the role and its capability flags
- [x] Frontend types carry `role` and the capability flags
- [x] Verify: `npm run test:db` — 42 existing checks still green, 11 new ones
- [ ] Apply to live (needs Nurhuda: it alters `users` and replaces four functions)
- [ ] Set Peter to `executive` and Himawan to `finance` by hand after applying
- [ ] KPI and compensation two-signature chain — lands in stage 4, with the tables
- [ ] Finance reads the compensation columns — lands in stage 2, with the columns

## 2. Schema

- [ ] Write `supabase/migrations/2026…_profile_and_kpi.sql`:
      employee profile columns, `kpi_review_required` + reason, `photo_path`,
      `kpi_role_templates`, `kpi_template_items`, `kpi_reviews`, `kpi_review_items`
- [ ] Extend `create_employee()` for `DTG-YY-NNN` numbering
- [ ] Seed the six role templates from `backend/app/data/kpi_role_templates.json`
- [ ] Verify: extend `supabase/test/` and keep `npm run test:db` green

## 3. Scoring and reward as SQL

- [ ] `kpi_score()` — weights, 0–5 factors, N/A reallocation, out of 130, band
- [ ] `kpi_reward()` — bonus tiers, gates, recommended bonus, proposed salary
- [ ] Port the 51 Python scoring assertions into `supabase/test/`
- [ ] Verify: the worked example from the role documents (a 20% KPI rated 4 contributes 23.0)

## 4. Review chain as RPC

- [ ] `open_kpi_review()`, `set_kpi_rating()`, `set_kpi_reward()`,
      `submit_kpi_review()`, `approve_kpi_review()`, `return_kpi_review()`
- [ ] RLS on `kpi_reviews` and `kpi_review_items`; salary columns admin-only
- [ ] Ratings lock on submit; reward stays editable for assessor and approver
- [ ] Exempt employees (founders, under a year) refused with their reason
- [ ] Verify: port the 18 route tests

## 5. Visibility as RLS

- [ ] `current_work_pattern()`, `is_backup_engineer()` helpers
- [ ] Policies on `shift_assignments`, `work_schedules`, `employees`
- [ ] Port the nine leak tests — office staff see no roster rows, roster crew see
      no office-day rows, back-up sees both, clearing the flag withdraws it,
      former staff visible only to an administrator
- [ ] Verify: sign in as four different people and compare

## 6. Frontend onto the new backend

- [ ] `employeeService` — profile detail, update, photo via Storage
- [ ] `kpiService` — the RPCs from stage 4
- [ ] KPI page and scorecard panel against real data
- [ ] Reward panel — admin-only, hidden for anyone else
- [ ] Verify: the full chain, Nurhuda assesses → Peter approves

## 7. Close out

- [ ] Delete `backend/alembic/versions/0010_employee_profile_and_kpi.py` from the branch
- [ ] Update `supabase/README.md`'s endpoint map with the KPI and profile functions
- [ ] Apply to live, after a backup
- [ ] Archive this change
