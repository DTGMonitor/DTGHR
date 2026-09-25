#!/usr/bin/env python3
"""One-off migration of the FastAPI line's local SQLite data into Supabase.

Reads ``backend/hr_hub_local.db`` (read-only, never modified) and moves it onto
a Supabase database that already carries Lintang's data for the same staff
under different UUIDs.

Modes (combine as needed; each is independent):

  --emit-sql OUT.sql        One transactional SQL file (begin; ... commit;) doing
                            everything except Storage uploads. People are
                            matched by e-mail inside the SQL, so the file works
                            against any database holding the same staff.
  --upload-files            Upload article figures, contract documents,
                            finance attachments and employee photos to their
                            private Storage buckets, at the storage_path the
                            SQL records.
  --create-missing-users    Create an auth user (e-mail only, no password --
                            they sign in with Microsoft) for every local user
                            not on the live database, via the Admin API.
  --emit-expected OUT.json  What the FastAPI code computed from this data
                            (payroll totals, KPI scores, counts): the dry run
                            (supabase/test/data-dry-run.mjs) checks against it.

--upload-files and --create-missing-users read SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY from the environment. --dry-run prints what they
would do without touching the network.

Outputs contain salaries and personal data. They are refused inside this
repository: write them to a scratch directory outside it.

Real run, in order:

  1. python scripts/migrate_local_data.py --create-missing-users
  2. python scripts/migrate_local_data.py --emit-sql <outside-repo>/migrate.sql
     then run that file (psql "$DB_URL" -v ON_ERROR_STOP=1 -f migrate.sql, or
     paste it into the SQL editor)
  3. python scripts/migrate_local_data.py --upload-files

What happens to each table is described in RULES below and printed with
--rules.
"""

from __future__ import annotations

import argparse
import calendar
import json
import mimetypes
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SQLITE = REPO_ROOT.parent / "backend" / "hr_hub_local.db"

# ---------------------------------------------------------------------------
# Tables, in dependency order.
#
#   key   -- how a local row finds "its" live row: None means by id (the local
#            id is kept), otherwise the natural key columns (after foreign keys
#            are remapped). A match keeps the live id and takes local values.
#   refs  -- foreign keys and which map resolves them. Every user and employee
#            reference goes through the e-mail map, never the local UUID.
#   skip  -- source columns the target does not have.
# ---------------------------------------------------------------------------
TABLES: list[dict] = [
    dict(name="users", special="users"),
    dict(name="kpi_role_templates", key=["code"]),
    dict(name="kpi_template_items", key=["template_id", "number"],
         refs={"template_id": "kpi_role_templates"}),
    dict(name="employees", special="employees",
         refs={"user_id": "users", "kpi_template_id": "kpi_role_templates"}),
    dict(name="work_schedules", key=["start_date", "end_date"]),
    dict(name="shift_assignments", key=["schedule_id", "employee_id", "date"],
         refs={"schedule_id": "work_schedules", "employee_id": "employees"}),
    dict(name="public_holidays", key=["date"]),
    dict(name="leave_balances", key=["employee_id", "leave_type", "year"],
         refs={"employee_id": "employees"}),
    dict(name="leave_requests", key=["employee_id", "leave_type", "start_date", "end_date"],
         refs={"employee_id": "employees", "reviewed_by": "employees"}),
    dict(name="shift_change_requests", key=None,
         refs={"schedule_id": "work_schedules", "requested_by_id": "users",
               "reviewed_by_id": "users"}),
    dict(name="shift_change_items", key=["request_id", "employee_id", "date"],
         refs={"request_id": "shift_change_requests", "employee_id": "employees"}),
    dict(name="kpi_reviews", key=["employee_id", "period_label"],
         refs={"employee_id": "employees", "template_id": "kpi_role_templates",
               "assessor_id": "users", "approver_id": "users"}),
    dict(name="kpi_review_items", key=["review_id", "number"],
         refs={"review_id": "kpi_reviews", "template_item_id": "kpi_template_items"},
         prune_by="review_id"),
    dict(name="payroll_months", key=["year", "month"],
         refs={"submitted_by_id": "users", "endorsed_by_id": "users",
               "approved_by_id": "users", "revision_by_id": "users"},
         # finalised_* predate the approval chain and were never set.
         skip=["finalised_at", "finalised_by_id"]),
    dict(name="payroll_lines", key=None,
         refs={"month_id": "payroll_months", "employee_id": "employees"},
         # Derived (part_days is not null) in both the model and the port.
         skip=["is_part_month"]),
    dict(name="compensation_plans", key=["employee_id", "year"],
         refs={"employee_id": "employees"}),
    dict(name="salary_reviews", key=None,
         refs={"employee_id": "employees", "prepared_by": "users",
               "endorsed_by": "users", "approved_by": "users"}),
    dict(name="employee_role_changes", key=None,
         refs={"employee_id": "employees", "recorded_by": "users",
               "salary_review_id": "salary_reviews"}),
    dict(name="economic_indicators", key=["kind", "month"],
         refs={"entered_by": "users"}),
    dict(name="salary_increase_settings", key="singleton",
         refs={"updated_by": "users"}),
    dict(name="finance_settings", key="singleton",
         refs={"updated_by": "users"}),
    dict(name="contracts", key=None, refs={"employee_id": "employees"}),
    dict(name="contract_reminders", key=None,
         refs={"contract_id": "contracts", "acknowledged_by": "users"}),
    dict(name="contract_documents", key=None,
         refs={"contract_id": "contracts", "uploaded_by": "users"},
         blob=dict(bucket="contract-documents")),
    dict(name="articles", key=None, refs={"author_id": "users"}),
    dict(name="article_images", key=None, refs={"article_id": "articles"},
         blob=dict(bucket="article-images")),
    dict(name="finance_requests", key=None,
         refs={"requested_by_id": "users", "reviewed_by_id": "users",
               "approved_by_id": "users", "revision_by_id": "users",
               "paid_by_id": "users"}),
    dict(name="finance_request_items", key=None, refs={"request_id": "finance_requests"}),
    dict(name="finance_request_documents", key=None,
         refs={"request_id": "finance_requests", "uploaded_by": "users"},
         blob=dict(bucket="finance-documents")),
    dict(name="support_tickets", key=None,
         refs={"reporter_id": "employees", "assignee_id": "employees"}),
    dict(name="ticket_events", key=None,
         refs={"ticket_id": "support_tickets", "actor_id": "users"}, insert_only=True),
    dict(name="profile_change_requests", key=None,
         refs={"employee_id": "employees", "requested_by": "users", "reviewed_by": "users"}),
    dict(name="activity_logs", key=None,
         refs={"actor_id": "users", "target_user_id": "users"}, insert_only=True),
]
BY_NAME = {t["name"]: t for t in TABLES}

# The photo table has no counterpart: its bytes go to Storage and the
# employee row keeps photo_path.
PHOTO_BUCKET = "employee-photos"

RULES = """\
users                    matched by lower(email); never inserted by the SQL (see
                         --create-missing-users). role, full_name, is_active
                         set from local. is_superuser follows role (trigger).
employees                matched by lower(email), else by employee_id; matched
                         rows are UPDATED with every local column (flags,
                         management, PTKP, work pattern, backup engineer, KPI
                         requirement, manager, ...) and keep their live id;
                         unmatched rows are inserted with the local id.
                         user_id -> live user by e-mail; manager_id and
                         kpi_template_id remapped. photo_path is set only
                         when a local photo exists, else the live one stays.
kpi_role_templates       upsert on code (local values win, live id kept).
kpi_template_items       upsert on (template, number), local values win.
work_schedules           upsert on (start_date, end_date): a live period keeps
                         its id and takes the local name/status.
shift_assignments        upsert on (schedule, employee, date): local code wins.
                         Live-only cells are kept (counted in a NOTICE).
public_holidays          upsert on date: local name/is_national win. Live-only
                         dates are kept.
leave_balances           upsert on (employee, leave_type, year), local wins.
leave_requests           upsert on (employee, leave_type, start, end), local
                         wins; live-only requests are kept.
shift_change_requests    by id (local id kept); items upsert on
                         (request, employee, date).
kpi_reviews              upsert on (employee, period_label), local wins; its
                         items upsert on (review, number) and live items of
                         those reviews that the local review lacks are deleted.
payroll_months           upsert on (year, month); lines by id.
compensation_plans       upsert on (employee, year).
economic_indicators      upsert on (kind, month).
salary_increase_settings the single row takes the local values.
finance_settings         the first row takes the local values.
everything else          (contracts, reminders, documents, articles, images,
                         salary reviews, role changes, finance, tickets,
                         profile requests) by id, local id kept, local wins.
activity_logs            insert by id, do nothing on conflict; actor and
                         target user remapped by e-mail, target_id remapped
                         through every map (else kept as is).
"""

UUID_HEX = re.compile(r"^[0-9a-fA-F]{32}$")


# ---------------------------------------------------------------------------
# Reading the source
# ---------------------------------------------------------------------------

class Source:
    def __init__(self, path: Path):
        if not path.exists():
            sys.exit(f"SQLite database not found: {path}")
        # Read-only, so nothing here can touch the source.
        uri = "file:" + urllib.parse.quote(str(path).replace("\\", "/")) + "?mode=ro"
        self.db = sqlite3.connect(uri, uri=True)
        self.db.row_factory = sqlite3.Row
        self._types: dict[str, dict[str, str]] = {}

    def exists(self, table: str) -> bool:
        return self.db.execute(
            "select 1 from sqlite_master where type='table' and name=?", (table,)
        ).fetchone() is not None

    def types(self, table: str) -> dict[str, str]:
        if table not in self._types:
            self._types[table] = {
                r["name"]: (r["type"] or "").upper()
                for r in self.db.execute(f'pragma table_info("{table}")')
            }
        return self._types[table]

    def rows(self, table: str, order: str = "id") -> list[dict]:
        if not self.exists(table):
            return []
        where = SKIP.get(table, "true")
        return [dict(r) for r in self.db.execute(f'select * from "{table}" where {where} order by {order}')]

    def count(self, table: str) -> int:
        if not self.exists(table):
            return 0
        where = SKIP.get(table, "true")
        return self.db.execute(f'select count(*) from "{table}" where {where}').fetchone()[0]


# Local rows left behind on purpose, as a WHERE clause keeping the rest.
# A schedule dated 0027-02-01 is a mistyped year with no cells; left out at
# the owner's request (2026-09-26).
SKIP = {
    "work_schedules": "start_date >= '1900-01-01'",
}


def as_uuid(v):
    if isinstance(v, str) and UUID_HEX.match(v):
        v = v.lower()
        return f"{v[:8]}-{v[8:12]}-{v[12:16]}-{v[16:20]}-{v[20:]}"
    return v


def as_bool(v):
    if v is None:
        return None
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "t", "yes")
    return bool(v)


def normalise(table: str, row: dict, types: dict[str, str]) -> dict:
    out = {}
    for col, val in row.items():
        t = types.get(col, "")
        if val is None:
            out[col] = None
        elif t.startswith("CHAR(32)"):
            out[col] = as_uuid(val)
        elif t.startswith("BOOL"):
            out[col] = as_bool(val)
        else:
            out[col] = val
    return out


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------

def lit(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (bytes, memoryview)):
        raise ValueError("blob reached the SQL")
    return "'" + str(v).replace("'", "''") + "'"


def q(ident: str) -> str:
    return '"' + ident + '"'


def staged_columns(src: Source, spec: dict) -> list[str]:
    cols = list(src.types(spec["name"]).keys())
    drop = set(spec.get("skip", [])) | {"data"}
    if spec["name"] == "users":
        drop.add("hashed_password")
    return [c for c in cols if c not in drop]


def emit_sql(src: Source, create_missing_users: bool) -> str:
    out: list[str] = []
    w = out.append

    w("-- Generated by scripts/migrate_local_data.py. Contains personal data and")
    w("-- salaries: keep it outside the repository and delete it after use.")
    w("-- Re-runnable: a second run changes nothing.")
    w("begin;")
    w("set local timezone = 'UTC';  -- local timestamps were stored in UTC")
    w("set local client_min_messages = warning;  -- quiet 'drop ... does not exist'")
    w("")

    # --- staging -----------------------------------------------------------
    w("-- 1. The local rows, as they are, in temporary staging tables shaped")
    w("--    like their targets.")
    for spec in TABLES:
        name = spec["name"]
        cols = staged_columns(src, spec) if src.exists(name) else []
        w(f"drop table if exists _src_{name};")
        if cols:
            w(f"create temp table _src_{name} as select {', '.join(q(c) for c in cols)} "
              f"from public.{name} where false;")
        else:
            w(f"create temp table _src_{name} as select * from public.{name} where false;")
        rows = src.rows(name) if cols else []
        types = src.types(name) if cols else {}
        for i in range(0, len(rows), 500):
            chunk = rows[i:i + 500]
            w(f"insert into _src_{name} ({', '.join(q(c) for c in cols)}) values")
            vals = []
            for r in chunk:
                r = normalise(name, r, types)
                vals.append("  (" + ", ".join(lit(r[c]) for c in cols) + ")")
            w(",\n".join(vals) + ";")
    # Photos: which employees have one (the bytes go to Storage).
    w("drop table if exists _src_employee_photos;")
    w("create temp table _src_employee_photos (employee_id uuid primary key);")
    photos = [as_uuid(r["employee_id"]) for r in src.rows("employee_photos")]
    if photos:
        w("insert into _src_employee_photos values " + ", ".join(f"({lit(p)})" for p in photos) + ";")
    w("")

    # --- people ------------------------------------------------------------
    w("-- 2. People: a local user is the live user with the same e-mail.")
    if create_missing_users:
        w("--    (--sql-create-missing-users: missing people get an auth user here,")
        w("--     e-mail only. For a real project prefer --create-missing-users.)")
        w("""insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change)
select '00000000-0000-0000-0000-000000000000',
       case when exists (select 1 from auth.users a where a.id = s.id) then gen_random_uuid() else s.id end,
       'authenticated', 'authenticated', lower(s.email), null, now(),
       '{"provider":"azure","providers":["azure"]}'::jsonb,
       jsonb_build_object('full_name', s.full_name), now(), now(), '', '', '', ''
  from _src_users s
 where not exists (select 1 from auth.users a where lower(a.email) = lower(s.email));""")
    w("""drop table if exists _map_users;
create temp table _map_users (local_id uuid primary key, email text, live_id uuid);
insert into _map_users
select s.id, lower(s.email), u.id
  from _src_users s
  left join public.users u on lower(u.email) = lower(s.email);

do $$
declare missing text;
begin
    select string_agg(email, ', ' order by email) into missing from _map_users where live_id is null;
    if missing is not null then
        raise exception 'Not on the live database yet: %. Create them first (--create-missing-users).', missing;
    end if;
end $$;

update public.users u
   set role = s.role, full_name = s.full_name, is_active = s.is_active, updated_at = now()
  from _src_users s
  join _map_users m on m.local_id = s.id
 where u.id = m.live_id
   and (u.role, u.full_name, u.is_active) is distinct from (s.role, s.full_name, s.is_active);
""")

    for spec in TABLES:
        name = spec["name"]
        if name == "users":
            continue
        cols = staged_columns(src, spec) if src.exists(name) else None
        if cols is None:
            # Not in the source at all: an empty map keeps later lookups valid.
            w(f"drop table if exists _map_{name};")
            w(f"create temp table _map_{name} (local_id uuid primary key, live_id uuid not null);")
            continue
        emit_table(w, spec, cols)

    # --- checks and notices -----------------------------------------------
    w("""-- Live-only rows the local data does not cover were left alone; say how many.
set local client_min_messages = notice;
do $$
declare n int;
begin
    select count(*) into n from public.shift_assignments a
     where a.schedule_id in (select live_id from _map_work_schedules)
       and a.id not in (select live_id from _map_shift_assignments);
    raise notice 'roster cells on migrated periods that exist only on live (kept): %', n;
    select count(*) into n from public.public_holidays
     where id not in (select live_id from _map_public_holidays);
    raise notice 'public holidays that exist only on live (kept): %', n;
    select count(*) into n from public.leave_requests
     where id not in (select live_id from _map_leave_requests);
    raise notice 'leave requests that exist only on live (kept): %', n;
    select count(*) into n from public.employees
     where id not in (select live_id from _map_employees);
    raise notice 'employees that exist only on live (kept): %', n;
end $$;
""")
    w("commit;")
    return "\n".join(out) + "\n"


def remap(col: str, kind: str) -> str:
    return f"(select m.live_id from _map_{kind} m where m.local_id = s.{q(col)})"


def emit_table(w, spec: dict, cols: list[str]) -> None:
    name = spec["name"]
    refs = spec.get("refs", {})
    key = spec.get("key")
    w(f"-- {name}")

    # a. The local rows with every foreign key already pointing at live ids.
    #    (employees.manager_id waits for the employee map, below.)
    exprs = []
    for c in cols:
        if c in refs:
            exprs.append(f"{remap(c, refs[c])} as {q(c)}")
        elif name == "activity_logs" and c == "target_id":
            exprs.append(f"coalesce((select m.live_id from _map_all m where m.local_id = s.target_id), "
                         f"s.target_id) as target_id")
        else:
            exprs.append(f"s.{q(c)}")
    if name == "activity_logs":
        # Anything an activity may point at, whichever table it lives in.
        w("drop table if exists _map_all;")
        w("create temp table _map_all as select distinct on (local_id) local_id, live_id from (")
        w("\n  union all ".join(
            f"select local_id, live_id from _map_{t['name']}" for t in TABLES
            if t["name"] not in ("activity_logs",)) + ") x;")
    w(f"drop table if exists _r_{name};")
    w(f"create temp table _r_{name} as select {', '.join(exprs)} from _src_{name} s;")

    # b. Which live row each local row is.
    w(f"drop table if exists _map_{name};")
    w(f"create temp table _map_{name} (local_id uuid primary key, live_id uuid not null);")
    if spec.get("special") == "employees":
        w("""insert into _map_employees
select r.id, coalesce(
         (select e.id from public.employees e where lower(e.email) = lower(r.email) order by e.created_at, e.id limit 1),
         (select e.id from public.employees e where e.employee_id = r.employee_id order by e.created_at, e.id limit 1),
         r.id)
  from _r_employees r;""")
    elif key == "singleton":
        w(f"insert into _map_{name} select r.id, coalesce("
          f"(select t.id from public.{name} t order by t.created_at, t.id limit 1), r.id) "
          f"from _r_{name} r;")
    elif key:
        match = " and ".join(f"t.{q(k)} = r.{q(k)}" for k in key)
        w(f"insert into _map_{name} select r.id, coalesce("
          f"(select t.id from public.{name} t where {match} order by t.created_at, t.id limit 1), r.id) "
          f"from _r_{name} r;")
    else:
        w(f"insert into _map_{name} select r.id, r.id from _r_{name} r;")

    # c. Upsert under the live id.
    target_cols = [c for c in cols if not (name == "employees" and c == "manager_id")]
    select = []
    for c in target_cols:
        select.append("m.live_id" if c == "id" else f"r.{q(c)}")
    extra_cols: list[str] = []
    blob = spec.get("blob")
    if blob:
        extra_cols.append("storage_path")
        select.append(storage_path_sql(name))
    if name == "employees":
        extra_cols.append("photo_path")
        select.append("case when exists (select 1 from _src_employee_photos p where p.employee_id = r.id) "
                      "then m.live_id::text || '/photo' end")
    all_cols = target_cols + extra_cols
    w(f"insert into public.{name} ({', '.join(q(c) for c in all_cols)})")
    w(f"select {', '.join(select)}")
    w(f"  from _r_{name} r join _map_{name} m on m.local_id = r.id")
    if spec.get("insert_only"):
        w("on conflict (id) do nothing;")
    else:
        upd = [c for c in all_cols if c not in ("id", "created_at")]
        sets = []
        for c in upd:
            if name == "employees" and c == "photo_path":
                sets.append(f"photo_path = coalesce(excluded.photo_path, {name}.photo_path)")
            else:
                sets.append(f"{q(c)} = excluded.{q(c)}")
        lhs = ", ".join(f"{name}.{q(c)}" for c in upd)
        rhs = ", ".join(
            f"coalesce(excluded.photo_path, {name}.photo_path)" if (name == "employees" and c == "photo_path")
            else f"excluded.{q(c)}" for c in upd)
        w("on conflict (id) do update set " + ", ".join(sets))
        w(f" where ({lhs}) is distinct from ({rhs});")

    if name == "employees":
        w("""update public.employees e
   set manager_id = x.manager_id, updated_at = x.updated_at
  from (select m.live_id, (select mm.live_id from _map_employees mm where mm.local_id = s.manager_id) as manager_id,
               s.updated_at
          from _src_employees s join _map_employees m on m.local_id = s.id) x
 where e.id = x.live_id and e.manager_id is distinct from x.manager_id;""")

    if spec.get("prune_by"):
        p = spec["prune_by"]
        w(f"-- The local {BY_NAME[refs[p]]['name']} is the whole record: drop live lines it does not have.")
        w(f"delete from public.{name} t where t.{p} in (select distinct {p} from _r_{name}) "
          f"and t.id not in (select live_id from _map_{name});")
    w("")


def storage_path_sql(name: str) -> str:
    # The same keys the port's routes use (src/lib/routes/*.ts), built from
    # ids the migration keeps, so the uploader can compute them offline.
    if name == "article_images":        # articles_add_image: <article>/<image>
        return "coalesce(r.article_id::text, 'unattached') || '/' || m.live_id::text"
    if name == "contract_documents":    # contracts.ts: <contract>/<document>
        return "r.contract_id::text || '/' || m.live_id::text"
    if name == "finance_request_documents":  # finance.ts: <request>/<uuid>/<safe name>
        return ("r.request_id::text || '/' || m.live_id::text || '/' || "
                "coalesce(nullif(regexp_replace(r.filename, '[^A-Za-z0-9._-]+', '_', 'g'), ''), 'document')")
    raise ValueError(name)


def storage_path_py(name: str, row: dict) -> str:
    rid = as_uuid(row["id"])
    if name == "article_images":
        return f"{as_uuid(row['article_id']) or 'unattached'}/{rid}"
    if name == "contract_documents":
        return f"{as_uuid(row['contract_id'])}/{rid}"
    if name == "finance_request_documents":
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", row["filename"] or "") or "document"
        return f"{as_uuid(row['request_id'])}/{rid}/{safe}"
    raise ValueError(name)


# ---------------------------------------------------------------------------
# What the FastAPI code computed (for the dry run)
# ---------------------------------------------------------------------------

PH_FACTOR = 1.333333
RATING_FACTORS = {5: 1.30, 4: 1.15, 3: 1.00, 2: 0.75, 1: 0.50, 0: 0.00}
BANDS = ((115.0, "band_3"), (105.0, "band_2h"), (85.0, "band_2m"), (70.0, "band_2l"), (0.0, "band_1"))


def payroll_line(line: dict, year: int, month: int) -> dict:
    """app/models/payroll.py PayrollLine's properties, verbatim."""
    f = {k: (line[k] or 0.0) for k in (
        "base", "health_allowance", "responsibility_allowance", "shift_allowance_rate",
        "shift_days", "overtime_allowance", "public_holiday_days", "bonus_other",
        "bpjs_employment", "bpjs_health", "income_tax")}
    part_days, part_div = line["part_days"], line["part_divisor"]
    divisor = part_div if part_div else float(calendar.monthrange(year, month)[1])
    if part_days is None or not divisor:
        base_paid = round(f["base"], 2)
    else:
        base_paid = round(f["base"] * part_days / divisor, 2)
    shift_total = round(f["shift_allowance_rate"] * f["shift_days"], 2)
    if line["public_holiday_rate_override"] is not None:
        ph_rate = round(line["public_holiday_rate_override"], 2)
    elif not f["shift_days"]:
        ph_rate = 0.0
    else:
        ph_rate = round(base_paid / f["shift_days"] * PH_FACTOR, 2)
    ph = round(f["public_holiday_days"] * ph_rate, 2)
    btb = round(base_paid + f["health_allowance"] + f["responsibility_allowance"] + shift_total
                + f["overtime_allowance"] + ph + f["bonus_other"], 2)
    bt = round(btb + f["bpjs_employment"] + f["bpjs_health"], 2)
    return dict(base_paid=base_paid, total_shift_allowance=shift_total, public_holiday_rate=ph_rate,
                public_holiday_allowance=ph, before_tax_and_bpjs=btb, before_tax=bt,
                total_expense=round(bt + f["income_tax"], 2),
                _allowances=f["health_allowance"] + f["responsibility_allowance"] + shift_total
                + f["overtime_allowance"] + ph, **f)


def roundup_10k(v: float) -> float:
    import math
    return 0.0 if v == 0 else float(math.ceil(v / 10000) * 10000)


def payroll_expected(src: Source) -> dict:
    """app/services/payroll_service.py group_totals, per month."""
    months = {}
    lines = src.rows("payroll_lines")
    for m in src.rows("payroll_months"):
        mid = m["id"]
        figs = {as_uuid(l["id"]): (l["labour_group"], payroll_line(l, m["year"], m["month"]))
                for l in lines if l["month_id"] == mid}
        totals = []
        grand = 0.0
        for grp in ("service", "admin"):
            rows = [f for g, f in figs.values() if g == grp]
            s = lambda k: round(sum(r[k] for r in rows), 2)  # noqa: E731
            te = s("total_expense")
            markup = invoiced = None
            if grp == "service":
                markup = round(te * (m["service_markup_pct"] / 100), 2)
                invoiced = round(te + markup, 2)
            totals.append(dict(group=grp, people=len(rows), base=s("base"),
                               allowances=s("_allowances"), bonus_other=s("bonus_other"),
                               before_tax_and_bpjs=s("before_tax_and_bpjs"),
                               bpjs_employment=s("bpjs_employment"), bpjs_health=s("bpjs_health"),
                               before_tax=s("before_tax"), income_tax=s("income_tax"),
                               total_expense=te, markup=markup, invoiced=invoiced,
                               rounded=roundup_10k(invoiced if invoiced is not None else te)))
            grand += te
        months[f"{m['year']}-{m['month']:02d}"] = dict(
            local_id=as_uuid(mid), status=m["status"], totals=totals, grand_total=round(grand, 2),
            lines={k: v[1]["total_expense"] for k, v in figs.items()})
    return months


def kpi_expected(src: Source) -> dict:
    """app/services/kpi_service.py score_review, per review."""
    items = src.rows("kpi_review_items", order="sort_order, number")
    out = {}
    for r in src.rows("kpi_reviews"):
        its = [i for i in items if i["review_id"] == r["id"]]
        na = lambda i: as_bool(i["is_not_applicable"])  # noqa: E731
        applicable = [i for i in its if not na(i)]
        weight = sum(i["weight"] for i in applicable)
        emp = src.db.execute("select email from employees where id=?", (r["employee_id"],)).fetchone()
        base = dict(employee_email=emp[0].lower(), period_label=r["period_label"],
                    item_count=len(its), not_applicable_count=len(its) - len(applicable))
        if not applicable or weight <= 0:
            out[as_uuid(r["id"])] = dict(base, total=0.0, band=None, is_complete=False,
                                         rated_count=0, applicable_count=0)
            continue
        scale = 100.0 / weight
        total, rated = 0.0, 0
        for i in applicable:
            if i["rating"] is None:
                continue
            total += i["weight"] * scale * RATING_FACTORS[i["rating"]]
            rated += 1
        total = round(total, 2)
        complete = rated == len(applicable)
        band = next(b for t, b in BANDS if total >= t) if complete else None
        out[as_uuid(r["id"])] = dict(base, total=total, band=band, is_complete=complete,
                                     rated_count=rated, applicable_count=len(applicable))
    return out


def emit_expected(src: Source) -> dict:
    counts = {t["name"]: src.count(t["name"]) for t in TABLES}
    counts["employee_photos"] = src.count("employee_photos")
    users = {r["email"].lower(): dict(role=r["role"], full_name=r["full_name"],
                                      is_active=as_bool(r["is_active"]))
             for r in src.rows("users")}
    emp_types = src.types("employees")
    employees = {}
    for r in src.rows("employees"):
        r = normalise("employees", r, emp_types)
        employees[r["email"].lower()] = r
    local_emails = {as_uuid(r["id"]): r["email"].lower() for r in src.rows("users")}
    emp_emails = {as_uuid(r["id"]): r["email"].lower() for r in src.rows("employees")}
    blobs = []
    for name in ("article_images", "contract_documents", "finance_request_documents"):
        for r in src.rows(name):
            blobs.append(dict(table=name, id=as_uuid(r["id"]), storage_path=storage_path_py(name, r),
                              byte_size=len(r["data"])))
    return dict(counts=counts, users=users, employees=employees,
                user_emails=local_emails, employee_emails=emp_emails,
                payroll=payroll_expected(src), kpi=kpi_expected(src), blobs=blobs)


# ---------------------------------------------------------------------------
# Supabase REST (Storage, Admin API, PostgREST) -- stdlib only
# ---------------------------------------------------------------------------

class Supabase:
    def __init__(self, dry_run: bool):
        self.dry_run = dry_run
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not dry_run and (not self.url or not self.key):
            sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.")

    def call(self, method: str, path: str, body=None, headers=None, raw: bytes | None = None):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        h.update(headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                txt = res.read()
                return json.loads(txt) if txt else None
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method} {path}: HTTP {e.code} {e.read().decode(errors='replace')}") from None

    def auth_emails(self) -> set[str]:
        emails, page = set(), 1
        while True:
            res = self.call("GET", f"/auth/v1/admin/users?page={page}&per_page=200")
            users = res.get("users", []) if isinstance(res, dict) else []
            emails |= {(u.get("email") or "").lower() for u in users}
            if len(users) < 200:
                return emails
            page += 1


def create_missing_users(src: Source, dry_run: bool) -> None:
    sb = Supabase(dry_run)
    existing = set() if dry_run else sb.auth_emails()
    for u in src.rows("users"):
        email = u["email"].lower()
        if email in existing:
            print(f"  exists   {email}")
            continue
        body = {"email": email, "email_confirm": True,
                "user_metadata": {"full_name": u["full_name"]}}
        if dry_run:
            print(f"  would create {email} (if missing)")
            continue
        sb.call("POST", "/auth/v1/admin/users", body)
        print(f"  created  {email}")
    # The on_auth_user_created trigger provisions public.users and links the
    # employees row with the same e-mail; the SQL then sets the role.


def upload_files(src: Source, dry_run: bool) -> None:
    sb = Supabase(dry_run)
    jobs = []
    for spec in TABLES:
        if not spec.get("blob"):
            continue
        for r in src.rows(spec["name"]):
            jobs.append((spec["blob"]["bucket"], storage_path_py(spec["name"], r),
                         r["content_type"], r["data"]))
    photos = src.rows("employee_photos")
    if photos:
        # Photo keys are <live employee id>/photo, so ask who is who -- by
        # e-mail, then employee code, then the local id (inserted as is).
        live = [] if dry_run else sb.call(
            "GET", "/rest/v1/employees?select=id,email,employee_id", headers={"Accept": "application/json"})
        by_email = {(e["email"] or "").lower(): e["id"] for e in live}
        by_code = {e["employee_id"]: e["id"] for e in live}
        for p in photos:
            emp = src.db.execute("select id, email, employee_id from employees where id=?",
                                 (p["employee_id"],)).fetchone()
            live_id = by_email.get(emp["email"].lower()) or by_code.get(emp["employee_id"]) or as_uuid(emp["id"])
            jobs.append((PHOTO_BUCKET, f"{live_id}/photo", p["content_type"], p["data"]))
    for bucket, path, ctype, data in jobs:
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        if dry_run:
            print(f"  would upload {bucket}/{path} ({len(data)} bytes, {ctype})")
            continue
        sb.call("POST", f"/storage/v1/object/{bucket}/{urllib.parse.quote(path)}", raw=bytes(data),
                headers={"Content-Type": ctype, "x-upsert": "true", "cache-control": "300"})
        print(f"  uploaded {bucket}/{path} ({len(data)} bytes)")
    print(f"{len(jobs)} file(s)")


# ---------------------------------------------------------------------------

def outside_repo(path: str) -> Path:
    p = Path(path).resolve()
    try:
        p.relative_to(REPO_ROOT)
    except ValueError:
        return p
    sys.exit(f"Refusing to write {p}: it is inside the repository and holds personal data. "
             "Write it to a scratch directory outside the repo.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sqlite", default=os.environ.get("HR_HUB_SQLITE", str(DEFAULT_SQLITE)))
    ap.add_argument("--emit-sql", metavar="OUT.sql")
    ap.add_argument("--emit-expected", metavar="OUT.json")
    ap.add_argument("--sql-create-missing-users", action="store_true",
                    help="have the SQL insert auth.users rows for missing people "
                         "(test databases; on Supabase use --create-missing-users)")
    ap.add_argument("--upload-files", action="store_true")
    ap.add_argument("--create-missing-users", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="network modes: print, do not call")
    ap.add_argument("--rules", action="store_true", help="print the per-table rules")
    a = ap.parse_args()

    if a.rules:
        print(RULES)
    if not (a.emit_sql or a.emit_expected or a.upload_files or a.create_missing_users):
        if not a.rules:
            ap.print_help()
        return
    src = Source(Path(a.sqlite))

    if a.create_missing_users:
        print("Creating missing auth users")
        create_missing_users(src, a.dry_run)
    if a.emit_sql:
        out = outside_repo(a.emit_sql)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(emit_sql(src, a.sql_create_missing_users), encoding="utf-8")
        print(f"wrote {out}")
    if a.emit_expected:
        out = outside_repo(a.emit_expected)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(emit_expected(src), indent=1, default=str), encoding="utf-8")
        print(f"wrote {out}")
    if a.upload_files:
        print("Uploading files to Storage")
        upload_files(src, a.dry_run)


if __name__ == "__main__":
    main()
