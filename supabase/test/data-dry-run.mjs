// Dry run of scripts/migrate_local_data.py against a throwaway database.
//
//   node supabase/test/data-dry-run.mjs
//
// Builds PGlite exactly as run.mjs does (baseline + every migration), makes it
// look like the live project -- the same staff under different UUIDs, signed
// up through auth.users, with Lintang-style employee rows and some roster,
// leave, holiday and KPI data of its own -- then applies the generated SQL and
// checks it: row counts, foreign keys, payroll totals and KPI scores through
// the port's own functions against what the FastAPI code computed, the
// overlap rules, and that a second run changes nothing.
//
// The generated SQL and expected.json hold salaries and personal data, so
// they are written outside the repository: $MIGRATION_OUT, default
// <os tmpdir>/hr-hub-data-migration. Source: $HR_HUB_SQLITE, default
// ../backend/hr_hub_local.db next to this repository.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "..", "..");
const MIGRATIONS = join(HERE, "..", "migrations");
const OUT = process.env.MIGRATION_OUT ?? join(tmpdir(), "hr-hub-data-migration");
const SQLITE = process.env.HR_HUB_SQLITE ?? resolve(REPO, "..", "backend", "hr_hub_local.db");
const PY = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

if (resolve(OUT).toLowerCase().startsWith(REPO.toLowerCase())) {
    console.error(`MIGRATION_OUT must be outside the repository (${OUT})`);
    process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// --- generate ---------------------------------------------------------------
function py(args) {
    const r = spawnSync(PY, [join(REPO, "scripts", "migrate_local_data.py"), "--sqlite", SQLITE, ...args],
        { encoding: "utf8" });
    if (r.status !== 0) {
        console.error(r.stdout, r.stderr);
        process.exit(1);
    }
}
const SQL_FILE = join(OUT, "migrate.sql");
const SQL_CREATE_FILE = join(OUT, "migrate-create-users.sql");
const EXPECTED_FILE = join(OUT, "expected.json");
py(["--emit-sql", SQL_FILE, "--emit-expected", EXPECTED_FILE]);
py(["--emit-sql", SQL_CREATE_FILE, "--sql-create-missing-users"]);
const SQL = readFileSync(SQL_FILE, "utf8");
const SQL_CREATE = readFileSync(SQL_CREATE_FILE, "utf8");
const exp = JSON.parse(readFileSync(EXPECTED_FILE, "utf8"));
console.log(`generated ${SQL_FILE} (${(SQL.length / 1e6).toFixed(1)} MB)`);

// --- harness ----------------------------------------------------------------
const fail = [];
const summary = [];
async function step(name, fn) {
    try {
        const note = await fn();
        console.log(`  ok   ${name}${note ? ` -- ${note}` : ""}`);
    } catch (e) {
        fail.push(name);
        console.log(`  FAIL ${name}\n       ${e.message ?? e}`);
    }
}
const eq = (a, b) => {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    const na = Number(a), nb = Number(b);
    if (typeof a !== "boolean" && typeof b !== "boolean" && a !== "" && b !== "" &&
        !Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) < 1e-9;
    return String(a).replace("T", " ") === String(b).replace("T", " ");
};

let pgcrypto = null;
try {
    ({ pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto"));
} catch { /* stubbed below */ }

async function buildDb() {
    const db = new PGlite(pgcrypto ? { extensions: { pgcrypto } } : {});
    await db.waitReady;
    await db.exec(readFileSync(join(HERE, "00_baseline.sql"), "utf8"));
    if (!pgcrypto) {
        await db.exec(`
            create or replace function extensions.gen_salt(text) returns text
                language sql as $$ select '$2a$06$stubstubstubstubstubst' $$;
            create or replace function extensions.crypt(text, text) returns text
                language sql as $$ select $2 || md5($1) $$;
            create or replace function extensions.gen_random_bytes(int) returns bytea
                language sql as $$ select decode(repeat('ab', $1), 'hex') $$;`);
    }
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
        await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
    return db;
}

const tx = async (db, uid, sql, params) => {
    await db.exec("begin");
    try {
        await db.exec("set local role authenticated");
        await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
        const r = await db.query(sql, params);
        await db.exec("commit");
        return r;
    } catch (e) {
        await db.exec("rollback");
        throw e;
    }
};

// --- the live project, as Lintang's version left it --------------------------
// Different UUIDs everywhere; employee codes in his DTG-NNN style; roles all
// 'employee' except the director the superuser backfill produced.
const emails = Object.keys(exp.users).sort();
const FALLBACK = "aris.regiansyah@dtgeotech.com";        // live row has an old e-mail
const MIXED_CASE = "nessy.salsabilita@dtgeotech.com";    // live row has capitals

async function simulateLive(db, { omit = [] } = {}) {
    let n = 0;
    for (const email of emails) {
        n += 1;
        if (omit.includes(email)) continue;
        const e = exp.employees[email];
        const liveEmail = email === FALLBACK ? "aris@dtgeotech.com"
            : email === MIXED_CASE ? "Nessy.Salsabilita@DTGeotech.com" : email;
        await db.query(
            `insert into public.employees (id, employee_id, first_name, last_name, email, department,
                     position, date_of_joining, annual_leave_opening_balance)
             values (gen_random_uuid(), $1, $2, $3, $4, 'Operations', 'Staff', $5, 0)`,
            [email === FALLBACK ? e.employee_id : `DTG-${String(n).padStart(3, "0")}`,
             e.first_name, e.last_name, liveEmail, e.date_of_joining]);
        await db.query(
            `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                     raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                     confirmation_token, recovery_token, email_change_token_new, email_change)
             values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
                     'authenticated', $1, null, now(), '{"provider":"azure","providers":["azure"]}'::jsonb,
                     jsonb_build_object('full_name', $2::text), now(), now(), '', '', '', '')`,
            [email, `${e.first_name} ${e.last_name}`]);
    }
    await db.exec(`update public.users set role = 'director' where email = 'nurhuda.santoso@dtgeotech.com'`);

    const lintang = `(select id from public.employees where lower(email) = 'lintang.sadewa@dtgeotech.com')`;
    const maulana = `(select id from public.employees where lower(email) = 'maulana.muhammad@dtgeotech.com')`;
    const nessy = `(select id from public.employees where lower(email) = 'nessy.salsabilita@dtgeotech.com')`;
    if (!omit.length) {
        await db.exec(`
            -- His September roster: same period, own id, own codes.
            insert into public.work_schedules (id, name, start_date, end_date, status)
            values ('5ee00000-0000-0000-0000-000000000009', 'Sept 2026 (live)', '2026-09-01', '2026-09-30', 'published');
            insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
            select gen_random_uuid(), '5ee00000-0000-0000-0000-000000000009', ${lintang}, d::date, 'O'
              from generate_series('2026-09-01'::date, '2026-09-30'::date, interval '1 day') d;
            -- A period the local data does not have at all.
            insert into public.work_schedules (id, name, start_date, end_date, status)
            values ('5ee00000-0000-0000-0000-000000000099', 'July 2027', '2027-07-01', '2027-07-31', 'draft');
            insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
            values (gen_random_uuid(), '5ee00000-0000-0000-0000-000000000099', ${lintang}, '2027-07-01', 'DS');

            insert into public.leave_balances (id, employee_id, leave_type, year, total_days, used_days)
            values (gen_random_uuid(), ${lintang}, 'annual', 2026, 10, 3);
            -- The same request as a local one, still pending on live; and one of his own.
            insert into public.leave_requests (id, employee_id, leave_type, start_date, end_date, days_requested, reason, status)
            values (gen_random_uuid(), ${maulana}, 'marriage', '2026-09-26', '2026-09-28', 3, 'live copy', 'pending'),
                   ('1ea00000-0000-0000-0000-000000000001', ${nessy}, 'sick', '2026-08-03', '2026-08-03', 1, 'live only', 'approved');
            -- A holiday only live has.
            insert into public.public_holidays (id, date, name, is_national)
            values (gen_random_uuid(), '2028-01-01', 'New Year 2028 (live only)', true);
            -- A KPI review on live for the same person and period, with a stray line.
            insert into public.kpi_reviews (id, employee_id, template_id, period_label, period_start, period_end)
            values ('4b100000-0000-0000-0000-000000000001', ${lintang},
                    (select id from public.kpi_role_templates where code = 'monitoring_engineer'),
                    '2026', '2026-01-01', '2026-12-31');
            insert into public.kpi_review_items (review_id, number, name, weight, rating)
            values ('4b100000-0000-0000-0000-000000000001', '99', 'Live-only line', 10, 5);
        `);
    }
}

async function snapshot(db) {
    const tables = (await db.query(
        `select table_schema || '.' || table_name t from information_schema.tables
          where table_type = 'BASE TABLE' and (table_schema = 'public' or (table_schema = 'auth' and table_name = 'users'))
          order by 1`)).rows.map((r) => r.t);
    const out = {};
    for (const t of tables) {
        const r = await db.query(`select count(*)::int n, md5(coalesce(string_agg(x::text, E'\\n' order by x::text), '')) h from ${t} x`);
        out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];

// =============================================================================
console.log("\n--- scenario A: every person already on live ---");
const db = await buildDb();
await simulateLive(db);
const before = await one(db, `select (select id from public.kpi_role_templates where code='monitoring_engineer') tpl,
    (select id from public.public_holidays where date='2026-03-20') hol,
    (select is_national from public.public_holidays where date='2026-03-20') hol_nat,
    (select count(*)::int from public.public_holidays) holidays,
    (select id from public.employees where email = 'aris@dtgeotech.com') aris`);

const notices = [];
await step("the generated SQL applies", async () => {
    await db.exec(SQL, { onNotice: (n) => notices.push(n.message) });
});

const TABLES = Object.keys(exp.counts).filter((t) => t !== "employee_photos");
await step("row counts per table match the source", async () => {
    const lines = [];
    for (const t of TABLES) {
        const want = exp.counts[t];
        const m = await one(db, `select count(*)::int n, count(distinct live_id)::int d from _map_${t}`);
        const present = await one(db, `select count(*)::int n from public.${t} where id in (select live_id from _map_${t})`);
        if (m.n !== want || m.d !== want || present.n !== want)
            throw new Error(`${t}: source ${want}, mapped ${m.n}/${m.d} distinct, present ${present.n}`);
        if (want) lines.push(`${t} ${want}`);
    }
    summary.push(`rows: ${lines.join(", ")}`);
    return `${TABLES.length} tables`;
});

await step("every person matched by e-mail; roles and names from local", async () => {
    const r = await db.query(`select u.email, u.role::text role, u.full_name, u.is_active, u.is_superuser,
                                     m.local_id <> m.live_id changed
                                from _map_users m join public.users u on u.id = m.live_id`);
    if (r.rows.length !== emails.length) throw new Error(`${r.rows.length} users`);
    for (const u of r.rows) {
        const want = exp.users[u.email];
        if (!u.changed) throw new Error(`${u.email} kept a local UUID`);
        if (u.role !== want.role || u.full_name !== want.full_name || u.is_active !== want.is_active)
            throw new Error(`${u.email}: ${u.role}/${u.full_name}/${u.is_active}`);
        if (u.is_superuser !== ["director", "executive"].includes(want.role))
            throw new Error(`${u.email}: is_superuser ${u.is_superuser}`);
    }
});

await step("employees updated in place with the local values", async () => {
    const skip = new Set(["id", "user_id", "manager_id", "kpi_template_id", "created_at", "photo_path"]);
    const r = await db.query(`select to_jsonb(e) j, m.local_id, u.email user_email, t.code tpl_code, mg.email mgr
                                from _map_employees m join public.employees e on e.id = m.live_id
                                left join public.users u on u.id = e.user_id
                                left join public.kpi_role_templates t on t.id = e.kpi_template_id
                                left join public.employees mg on mg.id = e.manager_id`);
    let fields = 0;
    for (const row of r.rows) {
        const want = exp.employees[row.j.email.toLowerCase()];
        if (!want) throw new Error(`unexpected ${row.j.email}`);
        if (row.j.id === row.local_id) throw new Error(`${row.j.email} took the local id instead of the live one`);
        for (const [k, v] of Object.entries(want)) {
            if (skip.has(k)) continue;
            fields += 1;
            if (!eq(row.j[k], v)) throw new Error(`${row.j.email}.${k}: live ${row.j[k]} vs local ${v}`);
        }
        const wantUser = want.user_id ? exp.user_emails[want.user_id] : null;
        if ((row.user_email ?? null) !== wantUser) throw new Error(`${row.j.email}: user ${row.user_email}`);
        const wantMgr = want.manager_id ? exp.employee_emails[want.manager_id] : null;
        if ((row.mgr ?? null) !== wantMgr) throw new Error(`${row.j.email}: manager ${row.mgr}`);
    }
    const aris = await one(db, `select m.live_id from _map_employees m join public.employees e on e.id = m.live_id
                                 where lower(e.email) = $1`, [FALLBACK]);
    if (aris?.live_id !== before.aris) throw new Error("employee_id fallback did not keep the live row");
    return `${r.rows.length} rows, ${fields} fields compared`;
});

await step("no user or employee reference still holds a local UUID", async () => {
    const cols = (await db.query(`select table_name t, column_name c from information_schema.columns
        where table_schema = 'public' and udt_name = 'uuid'
          and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE')`)).rows;
    let hits = [];
    for (const { t, c } of cols) {
        const r = await one(db, `select count(*)::int n from public.${t} where ${c} in (
            select local_id from _map_users where local_id <> live_id
            union select local_id from _map_employees where local_id <> live_id)`);
        if (r.n) hits.push(`${t}.${c}=${r.n}`);
    }
    if (hits.length) throw new Error(hits.join(", "));
    return `${cols.length} uuid columns scanned`;
});

await step("every foreign key resolves, declared or not", async () => {
    const fks = (await db.query(`select conrelid::regclass::text t, pg_get_constraintdef(oid) d from pg_constraint
                                  where contype = 'f' and connamespace = 'public'::regnamespace`)).rows;
    let n = 0;
    for (const { t, d } of fks) {
        const m = d.match(/^FOREIGN KEY \(([^)]+)\) REFERENCES ([\w.]+)\(([^)]+)\)/);
        if (!m || m[1].includes(",")) continue;
        const r = await one(db, `select count(*)::int n from ${t} c where c.${m[1]} is not null
                                  and not exists (select 1 from ${m[2]} p where p.${m[3]} = c.${m[1]})`);
        if (r.n) throw new Error(`${t}.${m[1]} -> ${m[2]}: ${r.n} dangling`);
        n += 1;
    }
    const loose = [
        ["articles", "cover_image_id", "article_images"],
        ["employee_role_changes", "salary_review_id", "salary_reviews"],
        ["kpi_review_items", "template_item_id", "kpi_template_items"],
    ];
    for (const [t, c, p] of loose) {
        const r = await one(db, `select count(*)::int n from public.${t} c where c.${c} is not null
                                  and not exists (select 1 from public.${p} x where x.id = c.${c})`);
        if (r.n) throw new Error(`${t}.${c}: ${r.n} dangling`);
    }
    const act = await one(db, `select count(*)::int total, count(target_id)::int with_target,
            count(*) filter (where target_id in (select id from public.employees union select id from public.users
                union select id from public.leave_requests union select id from public.kpi_reviews
                union select id from public.payroll_lines union select id from public.payroll_months
                union select id from public.work_schedules union select id from public.articles
                union select id from public.contracts union select id from public.compensation_plans
                union select id from public.public_holidays union select id from public.shift_change_requests
                union select id from public.profile_change_requests union select id from public.salary_reviews
                union select id from public.finance_requests))::int resolved
          from public.activity_logs where id in (select live_id from _map_activity_logs)`);
    summary.push(`activity log targets resolving to a live row: ${act.resolved}/${act.with_target}`);
    return `${n} declared FKs + ${loose.length} undeclared; activity targets ${act.resolved}/${act.with_target} resolve`;
});

const HIMAWAN = (await one(db, `select id from public.users where email = 'himawan.praptomo@dtgeotech.com'`)).id;
const NURHUDA = (await one(db, `select id from public.users where email = 'nurhuda.santoso@dtgeotech.com'`)).id;

await step("payroll_get_month (as finance) totals equal the FastAPI totals", async () => {
    let lines = 0;
    const grand = [];
    const cents = [];
    for (const [label, m] of Object.entries(exp.payroll)) {
        const id = (await one(db, `select live_id from _map_payroll_months where local_id = $1`, [m.local_id])).live_id;
        const j = (await tx(db, HIMAWAN, `select public.payroll_get_month($1::uuid) j`, [id])).rows[0].j;
        if (j.status !== m.status) throw new Error(`${label}: status ${j.status}`);
        if (!eq(j.grand_total, m.grand_total)) throw new Error(`${label}: grand ${j.grand_total} vs ${m.grand_total}`);
        for (const want of m.totals) {
            const got = j.totals.find((t) => t.group === want.group);
            for (const [k, v] of Object.entries(want)) {
                if (eq(got[k], v)) continue;
                // payroll_r2 rounds through float8::numeric (15 significant
                // digits), Python's round() the exact binary value: a half-cent
                // can land differently. The data is the same; say so, loudly.
                if (typeof v === "number" && Math.abs(got[k] - v) <= 0.0100001 && k !== "rounded") {
                    cents.push(`${label} ${want.group}.${k}: port ${got[k]} vs FastAPI ${v}`);
                    continue;
                }
                throw new Error(`${label} ${want.group}.${k}: ${got[k]} vs ${v}`);
            }
        }
        for (const [lid, te] of Object.entries(m.lines)) {
            const line = j.lines.find((l) => l.id === lid);
            if (!line) throw new Error(`${label}: line ${lid} missing`);
            if (!eq(line.total_expense, te)) throw new Error(`${label} line ${lid}: ${line.total_expense} vs ${te}`);
            lines += 1;
        }
        grand.push(`${label} ${m.grand_total}`);
    }
    summary.push(`payroll grand totals equal FastAPI: ${grand.join("; ")}`);
    for (const c of cents) summary.push(`WARN one-cent rounding difference in the port (not the data): ${c}`);
    return `${Object.keys(exp.payroll).length} months, ${lines} lines` +
        (cents.length ? `, ${cents.length} one-cent rounding difference(s), see summary` : "");
});

await step("kpi_get_review (as director) scores equal the FastAPI scores", async () => {
    for (const [lid, want] of Object.entries(exp.kpi)) {
        const id = (await one(db, `select live_id from _map_kpi_reviews where local_id = $1`, [lid])).live_id;
        const j = (await tx(db, NURHUDA, `select public.kpi_get_review($1::uuid) j`, [id])).rows[0].j;
        const got = { total: j.total_score, band: j.band, is_complete: j.is_complete,
            rated_count: j.rated_count, applicable_count: j.applicable_count,
            not_applicable_count: j.not_applicable_count, item_count: j.items.length };
        for (const k of Object.keys(got))
            if (!eq(got[k], want[k])) throw new Error(`${want.employee_email} ${want.period_label} ${k}: ${got[k]} vs ${want[k]}`);
    }
    return `${Object.keys(exp.kpi).length} reviews`;
});

await step("files: storage_path follows each route's convention", async () => {
    for (const b of exp.blobs) {
        const r = await one(db, `select storage_path, byte_size from public.${b.table} where id = $1`, [b.id]);
        if (r.storage_path !== b.storage_path || r.byte_size !== b.byte_size)
            throw new Error(`${b.table} ${b.id}: ${r.storage_path} (${r.byte_size})`);
    }
    return `${exp.blobs.length} objects`;
});

await step("overlap rules: live ids kept, local values win, live-only rows kept", async () => {
    const r = await one(db, `select
        (select id from public.kpi_role_templates where code='monitoring_engineer') tpl,
        (select version from public.kpi_role_templates where code='monitoring_engineer') tpl_version,
        (select id from public.public_holidays where date='2026-03-20') hol,
        (select is_national from public.public_holidays where date='2026-03-20') hol_nat,
        (select count(*)::int from public.public_holidays where name like '%live only%') live_hol,
        (select count(*)::int from public.work_schedules where start_date='2026-09-01') sept,
        (select name from public.work_schedules where id='5ee00000-0000-0000-0000-000000000009') sept_name,
        (select count(*)::int from public.shift_assignments where schedule_id='5ee00000-0000-0000-0000-000000000099') july,
        (select count(*)::int from public.shift_assignments a join public.employees e on e.id=a.employee_id
          where a.schedule_id='5ee00000-0000-0000-0000-000000000009' and lower(e.email)='lintang.sadewa@dtgeotech.com'
            and a.shift_code='O') lintang_o,
        (select total_days from public.leave_balances b join public.employees e on e.id=b.employee_id
          where lower(e.email)='lintang.sadewa@dtgeotech.com' and year=2026 and leave_type='annual') bal,
        (select string_agg(status, ',') from public.leave_requests where leave_type='marriage') marriage,
        (select count(*)::int from public.leave_requests where id='1ea00000-0000-0000-0000-000000000001') live_leave,
        (select count(*)::int from public.kpi_review_items where review_id='4b100000-0000-0000-0000-000000000001') lintang_items,
        (select count(*)::int from public.kpi_review_items where number='99') stray`);
    const problems = [];
    if (r.tpl !== before.tpl) problems.push("template id changed");
    if (r.tpl_version !== "1.1") problems.push(`template version ${r.tpl_version}`);
    if (r.hol !== before.hol) problems.push("holiday id changed");
    if (r.hol_nat !== true) problems.push("2026-03-20 not taken from local");
    if (r.live_hol !== 1) problems.push("live-only holiday lost");
    if (r.sept !== 1 || r.sept_name !== "September 2026") problems.push(`September: ${r.sept} ${r.sept_name}`);
    if (r.july !== 1) problems.push("live-only period lost");
    if (r.lintang_o !== 0) problems.push(`${r.lintang_o} of Lintang's live 'O' cells not replaced by local codes`);
    if (r.bal !== 12) problems.push(`balance ${r.bal}`);
    if (r.marriage !== "cancelled") problems.push(`marriage leave ${r.marriage}`);
    if (r.live_leave !== 1) problems.push("live-only leave lost");
    if (r.lintang_items !== 10 || r.stray !== 0) problems.push(`review items ${r.lintang_items}, stray ${r.stray}`);
    if (problems.length) throw new Error(problems.join("; "));
    summary.push(`holidays: live had ${before.holidays}, now ${(await one(db, "select count(*)::int n from public.public_holidays")).n}; ` +
        `2026-03-20 was cuti bersama on live, now national per local`);
});

if (notices.length) summary.push(...notices.map((n) => `notice: ${n}`));

await step("running the SQL a second time changes nothing", async () => {
    const a = await snapshot(db);
    await db.exec(SQL);
    const b = await snapshot(db);
    const diff = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
    if (diff.length) throw new Error(`changed: ${diff.join(", ")}`);
    return `${Object.keys(a).length} tables identical`;
});

// =============================================================================
console.log("\n--- scenario B: one person not on live yet ---");
const MISSING = "isabella.ananta@dtgeotech.com";
const db2 = await buildDb();
await simulateLive(db2, { omit: [MISSING] });

await step("without the people in place, the SQL refuses and names them", async () => {
    try {
        await db2.exec(SQL);
        throw new Error("expected a refusal");
    } catch (e) {
        await db2.exec("rollback").catch(() => {});
        if (!e.message.includes(MISSING)) throw new Error(`wrong error: ${e.message}`);
    }
    const n = await one(db2, `select count(*)::int n from public.payroll_lines`);
    if (n.n !== 0) throw new Error("partial write");
});

await step("--sql-create-missing-users creates and links them", async () => {
    await db2.exec(SQL_CREATE);
    const r = await one(db2, `select u.role::text role, u.is_active, e.user_id = u.id linked, a.encrypted_password pw,
                                     e.id = m.local_id kept_local_id
                                from public.users u join auth.users a on a.id = u.id
                                join public.employees e on lower(e.email) = u.email
                                join _map_employees m on m.live_id = e.id
                               where u.email = $1`, [MISSING]);
    const want = exp.users[MISSING];
    if (!r) throw new Error("not created");
    if (r.role !== want.role || r.is_active !== want.is_active || !r.linked || r.pw !== null || !r.kept_local_id)
        throw new Error(JSON.stringify(r));
    for (const t of TABLES) {
        const m = await one(db2, `select count(*)::int n from public.${t} where id in (select live_id from _map_${t})`);
        if (m.n !== exp.counts[t]) throw new Error(`${t}: ${m.n} vs ${exp.counts[t]}`);
    }
    const a = await snapshot(db2);
    await db2.exec(SQL_CREATE);
    const b = await snapshot(db2);
    const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
    if (diff.length) throw new Error(`second run changed ${diff.join(", ")}`);
    return "counts match, idempotent";
});

console.log("\n--- summary ---");
for (const s of summary) console.log(`  ${s}`);
console.log("\n=====================================");
if (fail.length) {
    console.log(`${fail.length} FAILURE(S): ${fail.join("; ")}`);
    process.exit(1);
}
console.log("data dry run passed");
