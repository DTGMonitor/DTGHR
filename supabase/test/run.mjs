import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

let pgcrypto = null;
try {
    ({ pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto"));
} catch {
    console.log("! pgcrypto contrib unavailable - stubbing crypt/gen_salt/gen_random_bytes");
}

const db = new PGlite(pgcrypto ? { extensions: { pgcrypto } } : {});
await db.waitReady;

const fail = [];
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m, e) => { fail.push(`${m}: ${e}`); console.log(`  FAIL ${m}\n       ${e}`); };

async function step(name, fn) {
    try { await fn(); ok(name); } catch (e) { bad(name, e.message ?? String(e)); }
}

// --- baseline -------------------------------------------------------------
await db.exec(readFileSync(join(import.meta.dirname, "00_baseline.sql"), "utf8"));
if (!pgcrypto) {
    await db.exec(`
        create or replace function extensions.gen_salt(text) returns text
            language sql as $$ select '$2a$06$stubstubstubstubstubst' $$;
        create or replace function extensions.crypt(text, text) returns text
            language sql as $$ select $2 || md5($1) $$;
        create or replace function extensions.gen_random_bytes(int) returns bytea
            language sql as $$ select decode(repeat('ab', $1), 'hex') $$;
    `);
}
console.log("baseline applied");

// --- seed -----------------------------------------------------------------
await db.exec(`
insert into public.users (id, email, hashed_password, full_name, is_superuser) values
  ('11111111-1111-1111-1111-111111111111','admin@dtgeotech.com','$2b$12$adminhash','HR Admin', true),
  ('22222222-2222-2222-2222-222222222222','rina@dtgeotech.com','$2b$12$rinahash','Rina Sari', false),
  ('33333333-3333-3333-3333-333333333333','budi@dtgeotech.com','entra-id-managed','Budi Santoso', false);

insert into public.employees (id, employee_id, first_name, last_name, email, department, position, date_of_joining, annual_leave_opening_balance, user_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001','DTG-001','Rina','Sari','rina@dtgeotech.com','Ops','Geologist','2024-03-02', 2.5, '22222222-2222-2222-2222-222222222222'),
  ('aaaaaaaa-0000-0000-0000-000000000002','DTG-002','Budi','Santoso','budi@dtgeotech.com','Ops','Technician','2025-01-15', 0, null);

insert into public.work_schedules (id, name, start_date, end_date, status) values
  ('bbbbbbbb-0000-0000-0000-000000000001','September 2026','2026-09-01','2026-09-30','published'),
  ('bbbbbbbb-0000-0000-0000-000000000002','October 2026','2026-10-01','2026-10-31','draft');

insert into public.public_holidays (id, date, name, is_national) values
  ('cccccccc-0000-0000-0000-000000000001','2026-09-07','Test National Holiday', true),
  ('cccccccc-0000-0000-0000-000000000002','2026-09-08','Cuti Bersama', false);

insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
select gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001', d::date,
       case when extract(day from d) <= 4 then 'DS'
            when extract(day from d) <= 8 then 'NS'
            when extract(day from d) = 10 then 'AL'
            else 'B' end
from generate_series('2026-09-01'::date,'2026-09-12'::date, interval '1 day') d;
`);
console.log("seed applied");

// --- migrations -----------------------------------------------------------
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
    try {
        await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
        console.log(`applied ${f}`);
    } catch (e) {
        console.log(`FAILED  ${f}\n        ${e.message}`);
        fail.push(`${f}: ${e.message}`);
        process.exit(1);
    }
}

// --- helpers --------------------------------------------------------------
const asUser = async (uid, sql, params) => {
    await db.exec(`set local role authenticated;`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    const r = await db.query(sql, params);
    return r;
};
const tx = async (uid, sql, params) => {
    await db.exec("begin");
    try {
        const r = await asUser(uid, sql, params);
        await db.exec("commit");
        return r;
    } catch (e) {
        await db.exec("rollback");
        throw e;
    }
};

const ADMIN = "11111111-1111-1111-1111-111111111111";
const RINA = "22222222-2222-2222-2222-222222222222";

console.log("\n--- assertions ---");

await step("auth.users received every profile, id for id", async () => {
    const r = await db.query(`select count(*)::int n from auth.users a join public.users u on u.id = a.id`);
    if (r.rows[0].n !== 3) throw new Error(`expected 3, got ${r.rows[0].n}`);
});

await step("entra-managed account got a NULL password", async () => {
    const r = await db.query(`select encrypted_password from auth.users where email='budi@dtgeotech.com'`);
    if (r.rows[0].encrypted_password !== null) throw new Error(`got ${r.rows[0].encrypted_password}`);
});

await step("bcrypt hash carried over untouched", async () => {
    const r = await db.query(`select encrypted_password p from auth.users where email='rina@dtgeotech.com'`);
    if (r.rows[0].p !== "$2b$12$rinahash") throw new Error(`got ${r.rows[0].p}`);
});

await step("hashed_password column is gone", async () => {
    const r = await db.query(`select count(*)::int n from information_schema.columns
        where table_schema='public' and table_name='users' and column_name='hashed_password'`);
    if (r.rows[0].n !== 0) throw new Error("still present");
});

await step("unclaimed employee row linked by email", async () => {
    const r = await db.query(`select user_id from public.employees where employee_id='DTG-002'`);
    if (r.rows[0].user_id !== "33333333-3333-3333-3333-333333333333") throw new Error(`got ${r.rows[0].user_id}`);
});

await step("bootstrap_session returns the profile and employee id", async () => {
    const r = await tx(RINA, `select public.bootstrap_session() j`);
    const j = r.rows[0].j;
    if (j.is_superuser !== false) throw new Error("wrong is_superuser");
    if (j.employee_id !== "aaaaaaaa-0000-0000-0000-000000000001") throw new Error(`employee_id ${j.employee_id}`);
});

await step("is_admin() distinguishes the two", async () => {
    const a = await tx(ADMIN, `select public.is_admin() b`);
    const r = await tx(RINA, `select public.is_admin() b`);
    if (a.rows[0].b !== true || r.rows[0].b !== false) throw new Error(`admin=${a.rows[0].b} rina=${r.rows[0].b}`);
});

await step("RLS hides the draft schedule from an employee", async () => {
    const a = await tx(ADMIN, `select count(*)::int n from public.work_schedules`);
    const r = await tx(RINA, `select count(*)::int n from public.work_schedules`);
    if (a.rows[0].n !== 2) throw new Error(`admin sees ${a.rows[0].n}, expected 2`);
    if (r.rows[0].n !== 1) throw new Error(`employee sees ${r.rows[0].n}, expected 1`);
});

await step("employee cannot read another profile row", async () => {
    const r = await tx(RINA, `select count(*)::int n from public.users`);
    if (r.rows[0].n !== 1) throw new Error(`saw ${r.rows[0].n} rows, expected 1`);
});

await step("get_schedule_detail assembles the document", async () => {
    const r = await tx(ADMIN, `select public.get_schedule_detail('bbbbbbbb-0000-0000-0000-000000000001') j`);
    const j = r.rows[0].j;
    for (const k of ["assignments", "leaves", "pending_changes", "holidays", "working_days"])
        if (!Array.isArray(j[k])) throw new Error(`${k} is not an array`);
    if (j.assignments.length !== 12) throw new Error(`assignments ${j.assignments.length}`);
    if (j.holidays.length !== 2) throw new Error(`holidays ${j.holidays.length}`);
    const w = j.working_days[0];
    // 4x DS + 4x NS = 8 working days; day 10 is AL; the rest B.
    if (w.working_days !== 8) throw new Error(`working_days ${w.working_days}`);
    if (w.annual_leave_taken !== 1) throw new Error(`annual_leave_taken ${w.annual_leave_taken}`);
    // 7 Sep is a national holiday and Rina is rostered NS that day.
    if (w.public_holiday_loading !== 1) throw new Error(`ph_loading ${w.public_holiday_loading}`);
    if (w.by_code.DS !== 4 || w.by_code.NS !== 4 || w.by_code.AL !== 1 || w.by_code.B !== 3)
        throw new Error(`by_code ${JSON.stringify(w.by_code)}`);
});

await step("employee gets 404 on a draft schedule", async () => {
    try {
        await tx(RINA, `select public.get_schedule_detail('bbbbbbbb-0000-0000-0000-000000000002')`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/Schedule not found/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("accrued_annual_leave matches the workbook pro-ration", async () => {
    // Joined 2 March 2024 (31-day month): 30/31 for the joining month.
    const r = await db.query(`select public.accrued_annual_leave('2024-03-02','2024-03-31') a,
                                     public.accrued_annual_leave('2024-03-02','2024-05-31') b,
                                     public.accrued_annual_leave('2024-03-02','2024-02-01') c`);
    const { a, b, c } = r.rows[0];
    const near = (x, y) => Math.abs(Number(x) - y) < 1e-9;
    if (!near(a, 30 / 31)) throw new Error(`same-month: ${a}`);
    if (!near(b, 30 / 31 + 2)) throw new Error(`two months on: ${b}`);
    if (!near(c, 0)) throw new Error(`before joining: ${c}`);
});

await step("annual_leave_state nets opening balance, accrual and AL taken", async () => {
    const r = await db.query(
        `select * from public.annual_leave_state(array['aaaaaaaa-0000-0000-0000-000000000001'::uuid],
                                                 '2026-09-01','2026-09-30')`);
    const row = r.rows[0];
    // opening 2.5 + accrual(2024-03-02 -> 2026-09-30) - 1 AL day taken
    const accrual = 30 / 31 + 30;
    const expected = Math.round((2.5 + accrual - 1) * 10000) / 10000;
    if (Math.abs(Number(row.balance) - expected) > 1e-4)
        throw new Error(`balance ${row.balance}, expected ${expected}`);
    if (row.ph_loading !== 1) throw new Error(`ph_loading ${row.ph_loading}`);
});

await step("employee proposes a roster change on their own row", async () => {
    const r = await tx(RINA, `select public.propose_shift_changes(
        'bbbbbbbb-0000-0000-0000-000000000001',
        '[{"employee_id":"aaaaaaaa-0000-0000-0000-000000000001","date":"2026-09-02","requested_code":"AL"}]'::jsonb,
        'dentist') j`);
    const j = r.rows[0].j;
    if (j.status !== "pending") throw new Error(`status ${j.status}`);
    if (j.items.length !== 1) throw new Error(`items ${j.items.length}`);
    if (j.items[0].current_code !== "DS") throw new Error(`current_code ${j.items[0].current_code}`);
    if (j.requested_by_name !== "Rina Sari") throw new Error(`requested_by_name ${j.requested_by_name}`);
});

await step("a no-op proposal is refused", async () => {
    try {
        await tx(RINA, `select public.propose_shift_changes(
            'bbbbbbbb-0000-0000-0000-000000000001',
            '[{"employee_id":"aaaaaaaa-0000-0000-0000-000000000001","date":"2026-09-03","requested_code":"DS"}]'::jsonb,
            null)`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/Nothing to change/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("proposing against someone else's row is refused", async () => {
    try {
        await tx(RINA, `select public.propose_shift_changes(
            'bbbbbbbb-0000-0000-0000-000000000001',
            '[{"employee_id":"aaaaaaaa-0000-0000-0000-000000000002","date":"2026-09-03","requested_code":"AL"}]'::jsonb,
            null)`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/only propose changes to your own/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("a second proposal on the same cell clashes", async () => {
    try {
        await tx(RINA, `select public.propose_shift_changes(
            'bbbbbbbb-0000-0000-0000-000000000001',
            '[{"employee_id":"aaaaaaaa-0000-0000-0000-000000000001","date":"2026-09-02","requested_code":"SL"}]'::jsonb,
            null)`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/already awaiting approval/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("admin approving writes the code onto the roster", async () => {
    const list = await tx(ADMIN, `select public.list_change_requests('pending', null) j`);
    const req = list.rows[0].j[0];
    const r = await tx(ADMIN, `select public.review_shift_change($1::uuid, null, null, 'fine') j`, [req.id]);
    if (r.rows[0].j.status !== "approved") throw new Error(`status ${r.rows[0].j.status}`);
    const cell = await db.query(
        `select shift_code from public.shift_assignments
          where employee_id='aaaaaaaa-0000-0000-0000-000000000001' and date='2026-09-02'`);
    if (cell.rows[0].shift_code !== "AL") throw new Error(`cell is ${cell.rows[0].shift_code}`);
});

await step("an employee cannot review", async () => {
    await tx(RINA, `select public.propose_shift_changes(
        'bbbbbbbb-0000-0000-0000-000000000001',
        '[{"employee_id":"aaaaaaaa-0000-0000-0000-000000000001","date":"2026-09-04","requested_code":"SL"}]'::jsonb,
        null)`);
    const list = await tx(RINA, `select public.list_change_requests('pending', null) j`);
    const req = list.rows[0].j[0];
    try {
        await tx(RINA, `select public.review_shift_change($1::uuid, null, null, null)`, [req.id]);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/Admin only/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("partial review lands as partially_approved", async () => {
    const r0 = await tx(ADMIN, `select public.propose_shift_changes(
        'bbbbbbbb-0000-0000-0000-000000000001',
        '[{"employee_id":"aaaaaaaa-0000-0000-0000-000000000002","date":"2026-09-05","requested_code":"DS"},
          {"employee_id":"aaaaaaaa-0000-0000-0000-000000000002","date":"2026-09-06","requested_code":"NS"}]'::jsonb,
        null) j`);
    const req = r0.rows[0].j;
    const r = await tx(ADMIN, `select public.review_shift_change($1::uuid, array[$2::uuid], array[$3::uuid], null) j`,
        [req.id, req.items[0].id, req.items[1].id]);
    if (r.rows[0].j.status !== "partially_approved") throw new Error(`status ${r.rows[0].j.status}`);
});

await step("apply_roster_pattern lays a 4/4/4 rotation down", async () => {
    const r = await tx(ADMIN, `select public.apply_roster_pattern(
        array['aaaaaaaa-0000-0000-0000-000000000002'::uuid],
        '[{"shift_code":"DS","days":4},{"shift_code":"NS","days":4},{"shift_code":"B","days":4}]'::jsonb,
        '2026-11-01','2026-11-12', 0, true, true) j`);
    const j = r.rows[0].j;
    if (j.cells_written !== 12) throw new Error(`cells_written ${j.cells_written}`);
    if (j.cells_skipped !== 0) throw new Error(`cells_skipped ${j.cells_skipped}`);
    if (j.schedules_touched !== 1) throw new Error(`schedules_touched ${j.schedules_touched}`);
    const cells = await db.query(
        `select date, shift_code from public.shift_assignments
          where employee_id='aaaaaaaa-0000-0000-0000-000000000002' and date between '2026-11-01' and '2026-11-12'
          order by date`);
    const got = cells.rows.map((c) => c.shift_code).join(",");
    if (got !== "DS,DS,DS,DS,NS,NS,NS,NS,B,B,B,B") throw new Error(`pattern: ${got}`);
});

await step("the November period was created on the fly", async () => {
    const r = await db.query(`select name, status from public.work_schedules where start_date='2026-11-01'`);
    if (r.rows.length !== 1) throw new Error("not created");
    if (r.rows[0].name !== "November 2026") throw new Error(`name ${r.rows[0].name}`);
    if (r.rows[0].status !== "draft") throw new Error(`status ${r.rows[0].status}`);
});

await step("overwrite=false skips cells that already hold a code", async () => {
    const r = await tx(ADMIN, `select public.apply_roster_pattern(
        array['aaaaaaaa-0000-0000-0000-000000000002'::uuid],
        '[{"shift_code":"D","days":1}]'::jsonb,
        '2026-11-01','2026-11-12', 0, false, false) j`);
    const j = r.rows[0].j;
    if (j.cells_skipped !== 12) throw new Error(`cells_skipped ${j.cells_skipped}`);
    if (j.cells_written !== 0) throw new Error(`cells_written ${j.cells_written}`);
    const cells = await db.query(
        `select shift_code from public.shift_assignments
          where employee_id='aaaaaaaa-0000-0000-0000-000000000002' and date='2026-11-01'`);
    if (cells.rows[0].shift_code !== "DS") throw new Error(`overwritten to ${cells.rows[0].shift_code}`);
});

await step("public holidays are stamped as PH", async () => {
    await tx(ADMIN, `select public.apply_roster_pattern(
        array['aaaaaaaa-0000-0000-0000-000000000002'::uuid],
        '[{"shift_code":"DS","days":2}]'::jsonb,
        '2026-09-06','2026-09-09', 0, true, true)`);
    const r = await db.query(
        `select to_char(date,'YYYY-MM-DD') d, shift_code from public.shift_assignments
          where employee_id='aaaaaaaa-0000-0000-0000-000000000002' and date between '2026-09-06' and '2026-09-09'
          order by date`);
    if (r.rows.length !== 4) throw new Error(`expected 4 cells, got ${r.rows.length}`);
    const byDate = Object.fromEntries(r.rows.map((x) => [x.d, x.shift_code]));
    if (byDate["2026-09-07"] !== "PH") throw new Error(`7 Sep is ${byDate["2026-09-07"]}`);
    if (byDate["2026-09-08"] === "PH") throw new Error("cuti bersama should not be stamped PH");
});

await step("offset_days staggers a second crew", async () => {
    const r = await tx(ADMIN, `select public.apply_roster_pattern(
        array['aaaaaaaa-0000-0000-0000-000000000001'::uuid,'aaaaaaaa-0000-0000-0000-000000000002'::uuid],
        '[{"shift_code":"DS","days":4},{"shift_code":"NS","days":4},{"shift_code":"B","days":4}]'::jsonb,
        '2026-12-01','2026-12-12', 4, true, false) j`);
    if (r.rows[0].j.cells_written !== 24) throw new Error(`written ${r.rows[0].j.cells_written}`);
    const a = await db.query(`select shift_code from public.shift_assignments
        where employee_id='aaaaaaaa-0000-0000-0000-000000000001' and date='2026-12-01'`);
    const b = await db.query(`select shift_code from public.shift_assignments
        where employee_id='aaaaaaaa-0000-0000-0000-000000000002' and date='2026-12-01'`);
    if (a.rows[0].shift_code !== "DS") throw new Error(`crew 1 ${a.rows[0].shift_code}`);
    if (b.rows[0].shift_code !== "NS") throw new Error(`crew 2 ${b.rows[0].shift_code}`);
});

await step("leave balances seed on first read", async () => {
    const r = await tx(RINA, `select public.get_leave_balances(null, 2026) j`);
    const j = r.rows[0].j;
    if (j.length !== 4) throw new Error(`got ${j.length} balances`);
    const annual = j.find((b) => b.leave_type === "annual");
    if (annual.total_days !== 12 || annual.remaining_days !== 12) throw new Error(JSON.stringify(annual));
});

await step("submitting leave checks the balance", async () => {
    const r = await tx(RINA, `select public.submit_leave_request(
        '{"leave_type":"annual","start_date":"2026-09-20","end_date":"2026-09-22","days_requested":3,"reason":"trip"}'::jsonb) j`);
    if (r.rows[0].j.status !== "pending") throw new Error(`status ${r.rows[0].j.status}`);
    if (r.rows[0].j.employee_name !== "Rina Sari") throw new Error("employee_name missing");
});

await step("an overlapping request is refused", async () => {
    try {
        await tx(RINA, `select public.submit_leave_request(
            '{"leave_type":"sick","start_date":"2026-09-21","end_date":"2026-09-23","days_requested":3}'::jsonb)`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/Overlapping/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("over-drawing the balance is refused", async () => {
    try {
        await tx(RINA, `select public.submit_leave_request(
            '{"leave_type":"annual","start_date":"2026-11-20","end_date":"2026-11-30","days_requested":40}'::jsonb)`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/Insufficient annual leave/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("approving deducts, cancelling restores", async () => {
    const pend = await tx(ADMIN, `select id from public.leave_requests_view where status='pending' limit 1`);
    const id = pend.rows[0].id;
    await tx(ADMIN, `select public.approve_leave_request($1::uuid, 'ok')`, [id]);
    let bal = await tx(RINA, `select public.get_leave_balances(null, 2026) j`);
    let annual = bal.rows[0].j.find((b) => b.leave_type === "annual");
    if (annual.used_days !== 3) throw new Error(`used after approve ${annual.used_days}`);

    await tx(RINA, `select public.cancel_leave_request($1::uuid)`, [id]);
    bal = await tx(RINA, `select public.get_leave_balances(null, 2026) j`);
    annual = bal.rows[0].j.find((b) => b.leave_type === "annual");
    if (annual.used_days !== 0) throw new Error(`used after cancel ${annual.used_days}`);
});

await step("leave_requests_view scopes rows to the viewer", async () => {
    const a = await tx(ADMIN, `select count(*)::int n from public.leave_requests_view`);
    const r = await tx(RINA, `select count(*)::int n from public.leave_requests_view`);
    if (a.rows[0].n < 1) throw new Error("admin sees nothing");
    if (r.rows[0].n !== a.rows[0].n) throw new Error("own rows missing");
});

await step("employees_view exposes has_account and on_leave_today", async () => {
    const r = await tx(RINA, `select employee_id, has_account, on_leave_today
                                from public.employees_view order by employee_id`);
    if (r.rows.length !== 2) throw new Error(`rows ${r.rows.length}`);
    if (r.rows[0].has_account !== true) throw new Error("DTG-001 should have an account");
});

await step("create_employee generates the next DTG code", async () => {
    const r = await tx(ADMIN, `select public.create_employee(
        '{"first_name":"Sari","last_name":"Dewi","email":"sari@dtgeotech.com","department":"Ops",
          "position":"Analyst","date_of_joining":"2026-09-01"}'::jsonb) j`);
    if (r.rows[0].j.employee_id !== "DTG-003") throw new Error(`got ${r.rows[0].j.employee_id}`);
    if (r.rows[0].j.has_account !== false) throw new Error("should have no account");
});

await step("a non-admin cannot create an employee", async () => {
    try {
        await tx(RINA, `select public.create_employee(
            '{"first_name":"X","last_name":"Y","email":"x@dtgeotech.com","department":"Ops",
              "position":"A","date_of_joining":"2026-09-01"}'::jsonb)`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/Only admin\/HR/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("create_employee_account provisions an auth user", async () => {
    const emp = await db.query(`select id from public.employees where employee_id='DTG-003'`);
    const r = await tx(ADMIN, `select public.create_employee_account($1::uuid) j`, [emp.rows[0].id]);
    const j = r.rows[0].j;
    if (!j.temp_password || j.temp_password.length < 8) throw new Error("no temp password");
    if (/[+/=]/.test(j.temp_password)) throw new Error(`not url-safe: ${j.temp_password}`);
    const prof = await db.query(`select password_change_required, full_name from public.users where id=$1`, [j.user_id]);
    if (prof.rows[0].password_change_required !== true) throw new Error("flag not set");
    if (prof.rows[0].full_name !== "Sari Dewi") throw new Error(`full_name ${prof.rows[0].full_name}`);
    const linked = await db.query(`select user_id from public.employees where employee_id='DTG-003'`);
    if (linked.rows[0].user_id !== j.user_id) throw new Error("employee not linked");
});

await step("dashboard_stats branches on role", async () => {
    const a = await tx(ADMIN, `select public.dashboard_stats() j`);
    const r = await tx(RINA, `select public.dashboard_stats() j`);
    if (a.rows[0].j.role !== "admin") throw new Error("admin branch");
    if (r.rows[0].j.role !== "employee") throw new Error("employee branch");
    if (typeof a.rows[0].j.total_employees !== "number") throw new Error("total_employees missing");
    if (typeof r.rows[0].j.annual_remaining !== "number") throw new Error("annual_remaining missing");
});

await step("leave_summary is admin-only", async () => {
    const a = await tx(ADMIN, `select public.leave_summary() j`);
    if (typeof a.rows[0].j !== "object") throw new Error("not an object");
    try {
        await tx(RINA, `select public.leave_summary()`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/Admin only/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("activity_logs_view scopes and names the actor", async () => {
    const a = await tx(ADMIN, `select action, actor_name from public.activity_logs_view order by created_at desc limit 5`);
    if (a.rows.length === 0) throw new Error("nothing logged");
    if (!a.rows.some((x) => x.actor_name === "HR Admin")) throw new Error("actor_name not resolved");
});

await step("save_schedule_assignments refuses a published period", async () => {
    try {
        await tx(ADMIN, `select public.save_schedule_assignments('bbbbbbbb-0000-0000-0000-000000000001','[]'::jsonb)`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/published schedule/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("set_schedule_cell writes then clears", async () => {
    await tx(ADMIN, `select public.set_schedule_cell('bbbbbbbb-0000-0000-0000-000000000002',
        'aaaaaaaa-0000-0000-0000-000000000001'::uuid, '2026-10-05', 'DS')`);
    let c = await db.query(`select shift_code from public.shift_assignments
        where schedule_id='bbbbbbbb-0000-0000-0000-000000000002' and date='2026-10-05'`);
    if (c.rows[0].shift_code !== "DS") throw new Error("not written");

    const r = await tx(ADMIN, `select public.set_schedule_cell('bbbbbbbb-0000-0000-0000-000000000002',
        'aaaaaaaa-0000-0000-0000-000000000001'::uuid, '2026-10-05', null) j`);
    if (r.rows[0].j !== null) throw new Error("should return null when cleared");
    c = await db.query(`select count(*)::int n from public.shift_assignments
        where schedule_id='bbbbbbbb-0000-0000-0000-000000000002' and date='2026-10-05'`);
    if (c.rows[0].n !== 0) throw new Error("not cleared");
});

await step("publish / unpublish round-trips", async () => {
    const p = await tx(ADMIN, `select public.publish_schedule('bbbbbbbb-0000-0000-0000-000000000002') j`);
    if (p.rows[0].j.status !== "published") throw new Error("not published");
    try {
        await tx(ADMIN, `select public.publish_schedule('bbbbbbbb-0000-0000-0000-000000000002')`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/already published/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
    const u = await tx(ADMIN, `select public.unpublish_schedule('bbbbbbbb-0000-0000-0000-000000000002') j`);
    if (u.rows[0].j.status !== "draft") throw new Error("not reverted");
});

await step("complete_password_change clears the flag", async () => {
    const emp = await db.query(`select user_id from public.employees where employee_id='DTG-003'`);
    const uid = emp.rows[0].user_id;
    const r = await tx(uid, `select public.complete_password_change() j`);
    if (r.rows[0].j.password_change_required !== false) throw new Error("flag still set");
});

// --- 20260919000100: holidays, off-boarding, leave activity ---------------

await step("2026 holidays match the SKB, 2027 is loaded", async () => {
    const r = await db.query(`select extract(year from date)::int y, is_national, count(*)::int n
                                from public.public_holidays
                               where date between '2026-01-01' and '2027-12-31'
                                 and name <> 'Test National Holiday' and name <> 'Cuti Bersama'
                               group by 1, 2 order by 1, 2`);
    const got = r.rows.map((x) => `${x.y}:${x.is_national}:${x.n}`).join(" ");
    if (got !== "2026:false:8 2026:true:17 2027:false:8 2027:true:18") throw new Error(got);
    const idul = await db.query(`select is_national from public.public_holidays where date = '2026-03-20'`);
    if (idul.rows[0].is_national !== false) throw new Error("20 Mar 2026 should be cuti bersama");
});

await step("PH loading carries a year-to-date figure and the dates", async () => {
    const r = await db.query(
        `select * from public.annual_leave_state(array['aaaaaaaa-0000-0000-0000-000000000001'::uuid],
                                                 '2026-09-01','2026-09-30')`);
    const row = r.rows[0];
    if (row.ph_loading !== 1 || row.ph_loading_ytd < 1) throw new Error(`${row.ph_loading}/${row.ph_loading_ytd}`);
    const d = await tx(RINA, `select public.get_schedule_detail('bbbbbbbb-0000-0000-0000-000000000001') j`);
    const w = d.rows[0].j.working_days.find((x) => x.employee_id === "aaaaaaaa-0000-0000-0000-000000000001");
    if (w.public_holiday_loading_ytd !== row.ph_loading_ytd) throw new Error("detail ytd mismatch");
    if (JSON.stringify(w.public_holiday_dates) !== '["2026-09-07"]') throw new Error(JSON.stringify(w.public_holiday_dates));
});

await step("leave_activity_view joins the request and scopes it", async () => {
    const a = await tx(ADMIN, `select action, employee_id, leave_type, status from public.leave_activity_view`);
    if (!a.rows.some((x) => x.action === "LEAVE_APPROVED")) throw new Error("approval missing");
    if (!a.rows.every((x) => x.leave_type)) throw new Error("request not joined");
    const sari = await db.query(`select user_id from public.employees where employee_id='DTG-003'`);
    const s = await tx(sari.rows[0].user_id, `select count(*)::int n from public.leave_activity_view`);
    if (s.rows[0].n !== 0) throw new Error(`Sari sees ${s.rows[0].n} rows of Rina's leave`);
});

await step("deactivating an employee revokes their sign-in; reactivating restores it", async () => {
    const emp = await db.query(`select id, user_id from public.employees where employee_id='DTG-003'`);
    const { id, user_id } = emp.rows[0];
    await tx(ADMIN, `select public.deactivate_employee($1::uuid)`, [id]);
    let u = await db.query(`select p.is_active, a.banned_until from public.users p join auth.users a using (id) where id=$1`, [user_id]);
    if (u.rows[0].is_active !== false || u.rows[0].banned_until === null) throw new Error("login still open");
    try {
        await tx(user_id, `select public.bootstrap_session()`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/inactive/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
    const r = await tx(ADMIN, `select public.reactivate_employee($1::uuid) j`, [id]);
    if (r.rows[0].j.is_active !== true) throw new Error("employee not active");
    u = await db.query(`select p.is_active, a.banned_until from public.users p join auth.users a using (id) where id=$1`, [user_id]);
    if (u.rows[0].is_active !== true || u.rows[0].banned_until !== null) throw new Error("login not restored");
});

await step("an employee cannot reactivate, and HR cannot deactivate themselves", async () => {
    const emp = await db.query(`select id from public.employees where employee_id='DTG-003'`);
    try {
        await tx(RINA, `select public.reactivate_employee($1::uuid)`, [emp.rows[0].id]);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/Only admin\/HR/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
    await db.query(`update public.users set is_superuser = true where id = $1`, [RINA]);
    try {
        await tx(RINA, `select public.deactivate_employee('aaaaaaaa-0000-0000-0000-000000000001')`);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/your own account/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    } finally {
        await db.query(`update public.users set is_superuser = false where id = $1`, [RINA]);
    }
});

// ---------------------------------------------------------------------------
// Roles (20260921000100)
// ---------------------------------------------------------------------------
console.log("\n--- roles ---");

// Peter is the executive; Himawan is finance. Both get a profile and a roster
// row so current_employee_id() resolves for them.
const PETER = "44444444-4444-4444-4444-444444444444";
const HIMAWAN = "55555555-5555-5555-5555-555555555555";

await db.exec(`
    -- public.users hangs off auth.users, so the auth row comes first and the
    -- on_auth_user_created trigger provisions the profile.
    insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change
    ) values
      ('00000000-0000-0000-0000-000000000000','44444444-4444-4444-4444-444444444444',
       'authenticated','authenticated','peter@dtgeotech.com','x', now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"full_name":"Peter Saunders"}'::jsonb, now(), now(), '', '', '', ''),
      ('00000000-0000-0000-0000-000000000000','55555555-5555-5555-5555-555555555555',
       'authenticated','authenticated','himawan@dtgeotech.com','x', now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"full_name":"Himawan"}'::jsonb, now(), now(), '', '', '', '');

    update public.users set role = 'executive' where id = '44444444-4444-4444-4444-444444444444';
    update public.users set role = 'finance'   where id = '55555555-5555-5555-5555-555555555555';

    insert into public.employees (id, employee_id, first_name, last_name, email, department, position, date_of_joining, annual_leave_opening_balance, user_id) values
      ('aaaaaaaa-0000-0000-0000-00000000000e','DTG-900','Peter','Saunders','peter@dtgeotech.com','Management','President Director','2024-01-02', 0, '44444444-4444-4444-4444-444444444444'),
      ('aaaaaaaa-0000-0000-0000-00000000000f','DTG-901','Himawan','F','himawan@dtgeotech.com','Finance','Finance Assistant','2024-01-02', 0, '55555555-5555-5555-5555-555555555555');
`);

await step("existing superusers were backfilled to admin", async () => {
    const r = await db.query(`select role::text as role from public.users where id = $1`, [ADMIN]);
    if (r.rows[0].role !== "admin") throw new Error(`got ${r.rows[0].role}`);
});

await step("is_superuser is mirrored from the role", async () => {
    const exec = await db.query(`select is_superuser from public.users where id=$1`, [PETER]);
    const fin = await db.query(`select is_superuser from public.users where id=$1`, [HIMAWAN]);
    if (exec.rows[0].is_superuser !== true) throw new Error("executive should be superuser");
    if (fin.rows[0].is_superuser !== false) throw new Error("finance must not be superuser");
});

await step("finance is not an administrator", async () => {
    const r = await tx(HIMAWAN, `select public.is_admin() a, public.is_finance() f`);
    if (r.rows[0].a !== false) throw new Error("finance must not be admin");
    if (r.rows[0].f !== true) throw new Error("is_finance() false for finance");
});

await step("the executive is an administrator but not the HR admin", async () => {
    const r = await tx(PETER, `select public.is_admin() a, public.is_hr_admin() h, public.is_executive() e`);
    if (r.rows[0].a !== true) throw new Error("executive should be admin-like");
    if (r.rows[0].h !== false) throw new Error("executive is not the HR admin");
    if (r.rows[0].e !== true) throw new Error("is_executive() false for executive");
});

await step("bootstrap_session carries the role and its capabilities", async () => {
    const r = await tx(HIMAWAN, `select public.bootstrap_session() j`);
    const j = r.rows[0].j;
    if (j.role !== "finance") throw new Error(`role ${j.role}`);
    if (j.can_approve_leave !== false) throw new Error("finance must not approve leave");
    if (j.can_read_compensation !== true) throw new Error("finance must read compensation");
    const p = await tx(PETER, `select public.bootstrap_session() j`);
    if (p.rows[0].j.can_overturn_leave !== true) throw new Error("executive must overturn");
});

// --- leave: one signature, executive may overturn --------------------------

const leaveId = "dddddddd-0000-0000-0000-0000000000a1";

async function freshRequest() {
    await db.exec(`delete from public.leave_requests where id = 'dddddddd-0000-0000-0000-0000000000a1'`);
    await db.exec(`
        insert into public.leave_balances (id, employee_id, leave_type, year, total_days, used_days)
        values ('eeeeeeee-0000-0000-0000-0000000000a1','aaaaaaaa-0000-0000-0000-000000000001','annual',2026,12,0)
        on conflict (employee_id, leave_type, year) do update set used_days = 0;

        insert into public.leave_requests
            (id, employee_id, leave_type, start_date, end_date, days_requested, reason, status)
        values ('dddddddd-0000-0000-0000-0000000000a1','aaaaaaaa-0000-0000-0000-000000000001','annual',
                '2026-05-04','2026-05-06', 3, 'test', 'pending');
    `);
}

const usedDays = async () => Number((await db.query(
    `select used_days from public.leave_balances
      where employee_id='aaaaaaaa-0000-0000-0000-000000000001'
        and leave_type='annual' and year=2026`)).rows[0].used_days);

await step("finance cannot approve leave", async () => {
    await freshRequest();
    try {
        await tx(HIMAWAN, `select public.approve_leave_request($1::uuid, null)`, [leaveId]);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/Not authorised|No employee profile/.test(e.message)) {
            throw new Error(`wrong error: ${e.message}`);
        }
    }
});

await step("one signature settles it - the admin alone approves", async () => {
    await freshRequest();
    await tx(ADMIN, `select public.approve_leave_request($1::uuid, null)`, [leaveId]);
    const r = await db.query(`select status from public.leave_requests where id=$1`, [leaveId]);
    if (r.rows[0].status !== "approved") throw new Error(`status ${r.rows[0].status}`);
    const used = await usedDays();
    if (used !== 3) throw new Error(`used ${used}, expected 3`);
});

await step("the admin cannot revisit a settled request", async () => {
    try {
        await tx(ADMIN, `select public.reject_leave_request($1::uuid, 'changed my mind')`, [leaveId]);
        throw new Error("expected a raise");
    } catch (e) {
        if (!/already/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("the executive overturns the approval, and the days come back", async () => {
    await tx(PETER, `select public.reject_leave_request($1::uuid, 'cover needed')`, [leaveId]);
    const r = await db.query(`select status from public.leave_requests where id=$1`, [leaveId]);
    if (r.rows[0].status !== "rejected") throw new Error(`status ${r.rows[0].status}`);
    const used = await usedDays();
    if (used !== 0) throw new Error(`used ${used}, expected the 3 days returned`);
});

await step("overturning the other way spends them again, exactly once", async () => {
    await tx(PETER, `select public.approve_leave_request($1::uuid, null)`, [leaveId]);
    let used = await usedDays();
    if (used !== 3) throw new Error(`used ${used}, expected 3`);
    // Re-approving an already-approved request must not double-count.
    await tx(PETER, `select public.approve_leave_request($1::uuid, null)`, [leaveId]);
    used = await usedDays();
    if (used !== 3) throw new Error(`double counted: used ${used}`);
});

await step("the reversal is recorded in the activity trail", async () => {
    const r = await db.query(
        `select description from public.activity_logs
          where description ilike '%Overturned%' order by created_at desc limit 1`);
    if (!r.rows.length) throw new Error("no overturn logged");
});


// ---------------------------------------------------------------------------
// Profile + KPI schema (20260921000200, 20260921000300)
// ---------------------------------------------------------------------------
console.log("\n--- profile and kpi schema ---");

await step("the six role templates are seeded", async () => {
    const r = await db.query(`select count(*)::int n from public.kpi_role_templates`);
    if (r.rows[0].n !== 6) throw new Error(`got ${r.rows[0].n} templates`);
});

await step("every template has ten KPIs weighted to exactly 100", async () => {
    const r = await db.query(`
        select t.code, count(i.*)::int items, sum(i.weight)::float total
          from public.kpi_role_templates t
          join public.kpi_template_items i on i.template_id = t.id
         group by t.code order by t.code`);
    const bad = r.rows.filter((x) => x.items !== 10 || Math.abs(x.total - 100) > 0.001);
    if (bad.length) {
        throw new Error(bad.map((b) => `${b.code}: ${b.items} items, ${b.total}`).join("; "));
    }
    // A scorecard rated 3 throughout must come to 100; that only holds if the
    // weights do. Every band downstream depends on it.
});

await step("re-running the seed does not duplicate items", async () => {
    const before = await db.query(`select count(*)::int n from public.kpi_template_items`);
    await db.exec(readFileSync(join(MIGRATIONS, "20260921000300_seed_kpi_templates.sql"), "utf8"));
    const after = await db.query(`select count(*)::int n from public.kpi_template_items`);
    if (after.rows[0].n !== before.rows[0].n) {
        throw new Error(`${before.rows[0].n} -> ${after.rows[0].n}`);
    }
});

await step("the profile columns exist and are all optional", async () => {
    const cols = [
        "date_of_birth", "place_of_birth", "gender", "marital_status", "religion",
        "address", "personal_email", "emergency_contact_name",
        "emergency_contact_relationship", "emergency_contact_phone",
        "national_id", "tax_id", "bpjs_health_no", "bpjs_employment_no",
        "bank_name", "bank_account_number", "bank_account_holder",
        "employment_type", "contract_end_date", "job_level", "work_location",
        "kpi_exemption_reason", "photo_path",
    ];
    const r = await db.query(`
        select column_name, is_nullable from information_schema.columns
         where table_schema='public' and table_name='employees'
           and column_name = any($1)`, [cols]);
    const found = new Set(r.rows.map((x) => x.column_name));
    const missing = cols.filter((c) => !found.has(c));
    if (missing.length) throw new Error("missing: " + missing.join(", "));
    const required = r.rows.filter((x) => x.is_nullable === "NO").map((x) => x.column_name);
    if (required.length) throw new Error("should be optional: " + required.join(", "));
});

await step("a new employee defaults to office_day and needs a review", async () => {
    const r = await db.query(`
        select work_pattern::text wp, is_backup_engineer bk, kpi_review_required req
          from public.employees where employee_id = 'DTG-001'`);
    const row = r.rows[0];
    if (row.wp !== "office_day") throw new Error(`work_pattern ${row.wp}`);
    if (row.bk !== false) throw new Error("backup engineer should default false");
    if (row.req !== true) throw new Error("kpi_review_required should default true");
});

await step("salary lives on the review, never on the employee", async () => {
    const r = await db.query(`
        select column_name from information_schema.columns
         where table_schema='public' and table_name='employees'
           and column_name ~ 'salary|bonus'`);
    if (r.rows.length) throw new Error("found on employees: " + r.rows.map((x) => x.column_name).join(", "));
    const onReview = await db.query(`
        select column_name from information_schema.columns
         where table_schema='public' and table_name='kpi_reviews'
           and column_name in ('current_basic_salary','target_bonus_amount','approved_increase_pct')`);
    if (onReview.rows.length !== 3) throw new Error("compensation columns missing from kpi_reviews");
});

await step("a rating outside 0..5 is refused", async () => {
    const t = await db.query(`select id from public.kpi_role_templates where code='monitoring_engineer'`);
    await db.exec(`
        insert into public.kpi_reviews (id, employee_id, template_id, period_label, period_start, period_end)
        values ('99999999-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
                '${t.rows[0].id}', '2026', '2026-01-01', '2026-12-31')
        on conflict (employee_id, period_label) do nothing;`);
    try {
        await db.exec(`
            insert into public.kpi_review_items (review_id, number, name, weight, rating)
            values ('99999999-0000-0000-0000-000000000001','KPI-99','Out of range', 10, 7)`);
        throw new Error("expected the check constraint to fire");
    } catch (e) {
        if (!/check constraint|violates/i.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

await step("one review per employee per period", async () => {
    try {
        await db.exec(`
            insert into public.kpi_reviews (employee_id, period_label, period_start, period_end)
            values ('aaaaaaaa-0000-0000-0000-000000000001','2026','2026-01-01','2026-12-31')`);
        throw new Error("expected a unique violation");
    } catch (e) {
        if (!/duplicate key|unique/i.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});


console.log("\n=====================================");
if (fail.length) {
    console.log(`${fail.length} FAILURE(S)`);
    process.exit(1);
}
console.log("all checks passed");
