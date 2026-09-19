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

console.log("\n=====================================");
if (fail.length) {
    console.log(`${fail.length} FAILURE(S)`);
    process.exit(1);
}
console.log("all checks passed");
