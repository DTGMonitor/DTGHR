# Design

## How each piece moves

| On the branch (FastAPI) | Here (Supabase) | Note |
| --- | --- | --- |
| `alembic/versions/0010_employee_profile_and_kpi.py` | `supabase/migrations/2026…_profile_and_kpi.sql` | Same DDL, Postgres dialect, wrapped in a transaction |
| `app/services/kpi_service.py` (51 tests) | `kpi_score()`, `kpi_reward()` — `IMMUTABLE` SQL functions | Pure arithmetic; no session state |
| `app/api/routes/kpi.py` | `SECURITY DEFINER` RPCs mirroring the endpoint map in `supabase/README.md` | Re-check permission inside, raise `PT403` |
| `app/services/visibility.py` (9 tests) | RLS policies on `shift_assignments`, `work_schedules`, `employees` | Stronger: enforced by the database |
| `app/services/employee_id.py` (13 tests) | Extend the existing `create_employee()` | `main` already generates `DTG-nnn`; this adds the year segment |
| `EmployeePhoto` table + FastAPI upload | Supabase Storage bucket + `photo_path` column | See "Photos" below |

## Decisions

### Visibility belongs in RLS, not in a function

The Python version filtered three things separately — shift rows, the leave
overlay and the totals column — because each was assembled in application code
and each could leak independently. I got that wrong once during the original
work: filtering only the rows still exposed colleagues' leave as coloured
blocks and their working-day counts down the right-hand side.

As RLS this cannot happen. One policy on `shift_assignments` scopes every read
of that table, whoever reads it and through whatever query. The three separate
filters collapse into one rule.

```sql
-- sketch, not final
create policy shift_assignments_visible on public.shift_assignments
for select using (
  public.is_admin()
  or employee_id in (select id from public.employees
                     where work_pattern = public.current_work_pattern()
                        or (public.is_backup_engineer() and work_pattern = 'roster'))
);
```

`current_work_pattern()` and `is_backup_engineer()` follow the existing
`is_admin()` / `current_employee_id()` pattern in `…000200_helpers_and_rls.sql`:
`SECURITY DEFINER` (a policy on `employees` that reads `employees` recurses) and
`STABLE` (evaluated once per statement, not once per row).

### Photos move to Storage, not a bytea column

The branch stores photo bytes in an `employee_photos` table, which was the right
call against FastAPI — there was no object store and a `Response` could serve
the bytes directly. Under Supabase there is one, and PostgREST returning base64
inside JSON would be worse than either option.

A private Storage bucket with a signed URL, and `employees.photo_path` holding
the object key. The browser-side downscale to 512px JPEG carries over unchanged.

**Open question:** whether to migrate existing photo rows. Currently zero rows
in production, so likely nothing to migrate — confirm before dropping the table.

### Two scales, both kept

The role documents band performance at 70 / 85 / 105 / 115. The 2026 bonus
workbook tiers *money* at 85 / 95 / 105 / 115. They are not the same cut-points
and conflating them would silently change what people are paid.

A score of 90 is "Meets Expectations" **and** earns half a target bonus. Both are
true, both are shown. `kpi_score()` returns the band; `kpi_reward()` returns the
tier. Neither derives from the other — both read the weighted total.

**Awaiting a decision from Nurhuda** on whether the bands are retired now that
the workbook supersedes the August scorecards. Until then, both stay.

### Reward is editable after the ratings lock

Found during the original work: locking the whole reward block on submission
made the workbook's own sequence impossible, because it enters the approved
salary percentage *after* approval.

So: ratings lock when the scorecard is submitted; the reward figures stay
editable by either the assessor or the approver, at any status. Two separate
permission checks, not one.

### Salary figures are admin-only from the first commit

`current_basic_salary`, `target_bonus_amount` and `approved_increase_pct` are
the most sensitive columns in the database. They live on `kpi_reviews`, which
means the RLS policy on that table has to be right before any figure is entered.

Restricted to `is_admin()` — today that is Nurhuda and Peter. Not exposed
through any view. Not readable by the subject of the review.

## Risks

| Risk | Mitigation |
| --- | --- |
| RLS policy admits more than intended | Port the nine visibility tests into `supabase/test/` first, then write the policies against them |
| Reward arithmetic drifts from the Python original | Port the 51 scoring tests as SQL assertions; the numbers are already pinned |
| Theme port silently drops a screen | `main`'s dashboard differs from the branch's — diff screen by screen, do not copy files wholesale |
| Migration lands badly on live | `npm run test:db` proves it on a clean database; a dev project proves it on a populated one |

## Open questions

1. **Bands or tiers?** Keep both scales, or retire the performance bands?
2. ~~**Dev project?**~~ Settled 20 Sep 2026: no dev project. See tasks stage 0.
   Stages 1–6 are additive against live; stage 2 is proved on a clean database
   by `npm run test:db` first.
3. **Who applied migrations 1–6?** Believed unapplied; they are applied. Worth
   knowing whether anything else changed unrecorded.
4. **Bintang's contract end** — "20 January 2026" is in the past. 2027?
