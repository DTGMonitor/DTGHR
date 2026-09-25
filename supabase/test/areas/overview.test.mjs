// Overview: the dashboard (GET /overview), the activity log (GET
// /activity/recent) and GET /dashboard/stats (20260926001200).
//
// Ported from the backend's tests/test_overview_approvals.py, plus the rest of
// what overview.py promises: the week strip, the leave figure agreeing with
// the Leave page, finance's desk, who is on duty, and who sees what.
//
// Everything dated happens in June 2090 so no other suite's rows land in the
// same week; queues that are not dated (pending leave, runs awaiting a
// signature, finance requests) are filtered to this suite's own names.
export default async ({ db, step, tx, people }) => {
    const { PETER, HIMAWAN, RINA } = people;
    const DAY = "2090-06-26"; // June has 30 days, so 4 left

    const U = {
        DIR: "0e0e0e0e-1200-0000-0000-000000000001",
        STAFF: "0e0e0e0e-1200-0000-0000-000000000002",
    };
    const E = {
        DIR: "0e0e0e0e-1200-0000-0000-00000000000a",
        OVIDIA: "0e0e0e0e-1200-0000-0000-00000000000b",
        OVAN: "0e0e0e0e-1200-0000-0000-00000000000c",
        OVELIA: "0e0e0e0e-1200-0000-0000-00000000000d",
        OSKAR: "0e0e0e0e-1200-0000-0000-00000000000e",
        FOUNDER: "0e0e0e0e-1200-0000-0000-00000000000f",
    };
    const S = { PUB: "0e0e0e0e-1200-0000-0000-000000000101", DRAFT: "0e0e0e0e-1200-0000-0000-000000000102" };

    // --- helpers ------------------------------------------------------------
    // jsonb keeps its keys sorted; compare values, not key order.
    const canon = (v) =>
        Array.isArray(v) ? v.map(canon)
        : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
        : v;
    const eq = (got, want, what) => {
        const g = JSON.stringify(canon(got)), w = JSON.stringify(canon(want));
        if (g !== w) throw new Error(`${what}: expected ${w}, got ${g}`);
    };
    const refused = async (promise, code, pattern) => {
        try {
            await promise;
        } catch (e) {
            if (e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
            if (pattern && !pattern.test(e.message)) throw new Error(`wrong message: ${e.message}`);
            return;
        }
        throw new Error(`expected ${code}, but it went through`);
    };
    // overview_at() is not granted to clients; run it as the owner with the
    // caller's identity set, so the day can be pinned.
    const at = async (uid, day = DAY) => {
        await db.exec("begin");
        try {
            await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
            const r = await db.query(`select public.overview_at($1::date) j`, [day]);
            await db.exec("commit");
            return r.rows[0].j;
        } catch (e) {
            await db.exec("rollback");
            throw e;
        }
    };
    const call = async (uid, fn, args = [], casts = []) => {
        const ph = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ""}`).join(", ");
        const r = await tx(uid, `select public.${fn}(${ph}) j`, args);
        return r.rows[0].j;
    };
    const mine = (list, key = "name") => list.filter((x) => String(x[key]).startsWith("Ov") || String(x[key]).startsWith("Os") || x[key] === "Nadia");

    // --- fixtures -----------------------------------------------------------
    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
          ('00000000-0000-0000-0000-000000000000','${U.DIR}','authenticated','authenticated',
           'ov.director@dtg.test','x', now(), '{"provider":"email","providers":["email"]}'::jsonb,
           '{"full_name":"Nadia Director"}'::jsonb, now(), now(), '', '', '', ''),
          ('00000000-0000-0000-0000-000000000000','${U.STAFF}','authenticated','authenticated',
           'ov.staff@dtg.test','x', now(), '{"provider":"email","providers":["email"]}'::jsonb,
           '{"full_name":"Ovidia Staff"}'::jsonb, now(), now(), '', '', '', '')
        on conflict (id) do nothing;
        update public.users set role = 'director' where id = '${U.DIR}';

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, user_id,
                                      is_management_role, kpi_review_required)
        values
          ('${E.DIR}','OV-001','Nadia','Director','ov.director@dtg.test','Management','Director','2024-01-01', 0, '${U.DIR}', true, true),
          ('${E.OVIDIA}','OV-002','Ovidia','Staff','ov.staff@dtg.test','Ops','Engineer','2025-02-01', 1.5, '${U.STAFF}', false, true),
          ('${E.OVAN}','OV-003','Ovan','Night','ov.ovan@dtg.test','Ops','Engineer','2025-02-01', 0, null, false, true),
          ('${E.OVELIA}','OV-004','Ovelia','Away','ov.ovelia@dtg.test','Ops','Engineer','2025-02-01', 0, null, false, true),
          ('${E.OSKAR}','OV-005','Oskar','Leave','ov.oskar@dtg.test','Ops','Engineer','2025-02-01', 0, null, false, true)
        on conflict (id) do nothing;

        insert into public.work_schedules (id, name, start_date, end_date, status) values
          ('${S.PUB}','Overview June 2090','2090-06-01','2090-07-31','published'),
          ('${S.DRAFT}','Overview draft 2090','2090-06-01','2090-07-31','draft')
        on conflict (id) do nothing;

        insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code) values
          (gen_random_uuid(),'${S.PUB}','${E.OVIDIA}','2090-06-26','DS'),
          (gen_random_uuid(),'${S.PUB}','${E.OVIDIA}','2090-06-27','NS'),
          (gen_random_uuid(),'${S.PUB}','${E.OVIDIA}','2090-06-28','AL'),
          (gen_random_uuid(),'${S.DRAFT}','${E.OVIDIA}','2090-06-29','DS'),
          (gen_random_uuid(),'${S.PUB}','${E.OVAN}','2090-06-26','NS'),
          (gen_random_uuid(),'${S.PUB}','${E.OVELIA}','2090-06-26','SL'),
          (gen_random_uuid(),'${S.DRAFT}','${E.OSKAR}','2090-06-26','DS');

        insert into public.public_holidays (id, date, name, is_national) values
          (gen_random_uuid(),'2090-06-28','Overview Holiday', true),
          (gen_random_uuid(),'2090-07-03','Overview Next Month', false)
        on conflict (date) do nothing;

        insert into public.leave_requests (id, employee_id, leave_type, start_date, end_date, days_requested, status) values
          (gen_random_uuid(),'${E.OVIDIA}','annual','2090-10-05','2090-10-07', 3, 'pending'),
          (gen_random_uuid(),'${E.DIR}','annual','2090-10-05','2090-10-05', 1, 'pending'),
          (gen_random_uuid(),'${E.OSKAR}','annual','2090-06-25','2090-06-27', 3, 'approved');
    `);

    // --- the approvals sentence (test_overview_approvals.py) ---------------
    await step("overview: pending leave is named, with type, dates and days", async () => {
        const a = (await at(U.DIR)).approvals;
        eq(mine(a.leave).filter((l) => l.name === "Ovidia"),
           [{ name: "Ovidia", leave_type: "annual", start: "2090-10-05", end: "2090-10-07", days: 3 }], "leave");
    });

    await step("overview: nobody's own leave waits on them", async () => {
        const o = await at(U.DIR);
        if (o.approvals.leave.some((l) => l.name === "Nadia")) throw new Error("own leave listed");
        const peter = await at(PETER);
        if (!peter.approvals.leave.some((l) => l.name === "Nadia")) throw new Error("Peter should see Nadia's");
        // The tile agrees with the sentence: the director's count excludes her own.
        const all = (await db.query(`select count(*)::int n from public.leave_requests where status = 'pending'`)).rows[0].n;
        eq(o.pending_approvals, all - 1, "pending_approvals");
    });

    await step("overview: payroll names who sent it and who sent it back", async () => {
        await db.exec(`
            insert into public.payroll_months (year, month, status, submitted_by_id, revision_note, revision_by_id) values
              (2090, 6, 'draft', null, null, null),
              (2090, 7, 'submitted', '${HIMAWAN}', null, null),
              (2090, 8, 'submitted', '${HIMAWAN}', 'Check Aris''s bonus.', '${PETER}'),
              (2090, 9, 'endorsed', '${HIMAWAN}', null, null),
              (2090, 10, 'changes_requested', '${HIMAWAN}', 'Two lines missing.', '${U.DIR}')
            on conflict (year, month) do nothing;
        `);
        const o = await at(U.DIR);
        eq(o.approvals.payroll.filter((p) => p.label.endsWith("2090")), [
            { label: "July 2090", submitted_by: "Himawan", sent_back_note: null, sent_back_by: null },
            { label: "August 2090", submitted_by: "Himawan", sent_back_note: "Check Aris's bonus.", sent_back_by: "Peter Saunders" },
        ], "director's payroll");
        if (o.payroll_awaiting.count < 2) throw new Error(`payroll_awaiting ${JSON.stringify(o.payroll_awaiting)}`);
        // Not the executive's turn for those; September, endorsed, is.
        const p = await at(PETER);
        eq(p.approvals.payroll.filter((x) => x.label.endsWith("2090")).map((x) => x.label), ["September 2090"], "executive's payroll");
    });

    await step("overview: staff get no approvals and no management tiles", async () => {
        const o = await at(U.STAFF);
        eq(o.is_management, false, "is_management");
        for (const k of ["approvals", "pending_approvals", "on_leave_today", "headcount", "salary_awaiting",
                         "payroll_awaiting", "kpi_awaiting", "on_duty", "payroll_desk", "finance_sent_back", "tickets_open"])
            if (o[k] !== null) throw new Error(`${k} should be null, got ${JSON.stringify(o[k])}`);
        eq(o.pending_mine, 1, "pending_mine");
        eq((await at(RINA)).approvals, null, "Rina's approvals");
    });

    // --- the rest of overview.py -------------------------------------------
    await step("overview: the week strip is the published roster, with holidays", async () => {
        const o = await at(U.STAFF);
        eq(o.has_employee_record, true, "has_employee_record");
        eq(o.week.length, 7, "seven days");
        eq(o.week[0], { date: "2090-06-26", code: "DS", label: "Dayshift", holiday: null, is_today: true }, "today");
        eq(o.week[1].label, "Night shift", "tomorrow");
        eq(o.week[2], { date: "2090-06-28", code: "AL", label: "Annual leave", holiday: "Overview Holiday", is_today: false }, "holiday");
        // A draft roster's cell is not shown.
        eq(o.week[3].code, null, "draft cell");
        eq(o.week[3].label, null, "draft label");
    });

    await step("overview: holidays left this month, and the next of any month", async () => {
        const o = await at(U.STAFF);
        eq(o.holidays, [{ date: "2090-06-28", name: "Overview Holiday", is_national: true }], "holidays");
        eq(o.next_holiday, { date: "2090-06-28", name: "Overview Holiday" }, "next_holiday");
        eq((await at(U.STAFF, "2090-06-29")).next_holiday, { date: "2090-07-03", name: "Overview Next Month" }, "next month's");
        eq((await at(U.STAFF, "2090-06-29")).holidays, [], "none left in June");
    });

    await step("overview: the leave figure is the Leave page's figure", async () => {
        const o = await call(U.STAFF, "overview_get");
        const [bal] = await call(U.STAFF, "get_leave_balances");
        eq(o.leave.total, Number(bal.total_days), "total");
        eq(o.leave.remaining, Number(bal.remaining_days), "remaining");
        eq(o.leave.used, Number(bal.used_days), "used");
        // A founder carries none.
        await db.exec(`update public.employees set kpi_review_required = false where id = '${E.DIR}'`);
        try {
            eq((await at(U.DIR)).leave, null, "founder's leave");
        } finally {
            await db.exec(`update public.employees set kpi_review_required = true where id = '${E.DIR}'`);
        }
    });

    await step("overview: the next booked leave rides on the balance", async () => {
        await db.exec(`insert into public.leave_requests (id, employee_id, leave_type, start_date, end_date, days_requested, status)
                       values (gen_random_uuid(), '${E.OVIDIA}', 'annual', '2090-07-10', '2090-07-11', 2, 'approved')`);
        const o = await at(U.STAFF);
        eq([o.leave.next_from, o.leave.next_to], ["2090-07-10", "2090-07-11"], "next booked");
        if (typeof o.leave.total !== "number") throw new Error("total is not a number");
    });

    await step("overview: who is on duty today, and who is away from both sources", async () => {
        const o = await at(U.DIR);
        eq(o.on_duty.dayshift, ["Ovidia"], "dayshift");
        eq(o.on_duty.nightshift, ["Ovan"], "nightshift");
        // Ovelia from the roster's SL cell, Oskar from an approved request.
        eq(o.on_duty.on_leave, ["Oskar", "Ovelia"], "on_leave");
        eq(o.on_leave_today, 2, "on_leave_today");
    });

    await step("overview: headcount leaves the founders out", async () => {
        const before = (await at(U.DIR)).headcount;
        await db.exec(`
            insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                          date_of_joining, is_management_role, kpi_review_required)
            values ('${E.FOUNDER}','OV-006','Ovfounder','F','ov.founder@dtg.test','Management','Founder','2020-01-01', true, false)
            on conflict (id) do nothing`);
        eq((await at(U.DIR)).headcount, before, "founder not counted");
        await db.exec(`update public.employees set kpi_review_required = true where id = '${E.FOUNDER}'`);
        eq((await at(U.DIR)).headcount, before + 1, "reviewed management counted");
        await db.exec(`update public.employees set is_active = false where id = '${E.FOUNDER}'`);
        eq((await at(U.DIR)).headcount, before, "inactive not counted");
    });

    await step("overview: salary waits on the executive only, never on your own", async () => {
        await db.exec(`insert into public.salary_reviews (employee_id, effective_date, current_amount, proposed_amount, status)
                       values ('${E.OVIDIA}', '2090-07-01', 10000000, 11000000, 'submitted')`);
        const p = await at(PETER);
        if (!p.approvals.salary.some((s) => s.name === "Ovidia")) throw new Error("Peter should see Ovidia's");
        if (typeof p.salary_awaiting !== "number" || p.salary_awaiting < 1) throw new Error(`salary_awaiting ${p.salary_awaiting}`);
        const d = await at(U.DIR);
        eq(d.salary_awaiting, null, "director is not in the salary chain");
        eq(d.approvals.salary, [], "director's salary list");
    });

    await step("overview: scorecards on this person's signature", async () => {
        await db.exec(`insert into public.kpi_reviews (employee_id, period_label, period_start, period_end, status, approver_id)
                       values ('${E.OVIDIA}', 'OV-2090', '2090-01-01', '2090-12-31', 'submitted', '${U.DIR}')`);
        const d = await at(U.DIR);
        eq(d.kpi_awaiting, 1, "kpi_awaiting");
        eq(d.approvals.kpi, [{ name: "Ovidia", period: "OV-2090" }], "kpi");
        eq((await at(PETER)).approvals.kpi.filter((k) => k.period === "OV-2090"), [], "not Peter's");
    });

    await step("overview: finance requests on the director's review and the executive's approval", async () => {
        await db.exec(`
            insert into public.finance_requests (id, reference, title, status, requested_by_id, revision_note, revision_by_id, created_at) values
              ('0e0e0e0e-1200-0000-0000-000000000201','OV-0001','Overview petty cash','submitted','${HIMAWAN}', null, null, '2090-01-01'),
              ('0e0e0e0e-1200-0000-0000-000000000202','OV-0002','Overview tax','submitted','${HIMAWAN}', 'Wrong month.', '${PETER}', '2090-01-02'),
              ('0e0e0e0e-1200-0000-0000-000000000203','OV-0003','Overview BPJS','endorsed','${HIMAWAN}', null, null, '2090-01-03'),
              ('0e0e0e0e-1200-0000-0000-000000000204','OV-0004','Overview rent','changes_requested','${HIMAWAN}', 'Attach the invoice.', '${U.DIR}', '2090-01-04')
            on conflict (id) do nothing;
            insert into public.finance_request_items (request_id, category, description, amount) values
              ('0e0e0e0e-1200-0000-0000-000000000201','petty_cash','Cash', 1500000),
              ('0e0e0e0e-1200-0000-0000-000000000201','other','Snacks', 250000.5);
        `);
        const d = await at(U.DIR);
        eq(d.approvals.finance.filter((f) => f.reference.startsWith("OV-")), [
            { reference: "OV-0001", title: "Overview petty cash", total: 1750000.5, requested_by: "Himawan",
              sent_back_note: null, sent_back_by: null },
            { reference: "OV-0002", title: "Overview tax", total: 0, requested_by: "Himawan",
              sent_back_note: "Wrong month.", sent_back_by: "Peter Saunders" },
        ], "director's finance");
        eq((await at(PETER)).approvals.finance.filter((f) => f.reference.startsWith("OV-")).map((f) => f.reference),
           ["OV-0003"], "executive's finance");
    });

    await step("overview: finance's desk -- sent back, and the month running out", async () => {
        const o = await at(HIMAWAN);
        eq(o.is_management, false, "finance is not management");
        eq(o.approvals, null, "no approvals");
        eq(o.finance_sent_back.filter((f) => f.reference.startsWith("OV-")),
           [{ reference: "OV-0004", title: "Overview rent", note: "Attach the invoice." }], "finance_sent_back");
        const desk = o.payroll_desk;
        eq(desk.sent_back.filter((s) => s.label.endsWith("2090")), [{ label: "October 2090", note: "Two lines missing." }], "sent_back");
        eq([desk.this_month, desk.this_month_status, desk.days_left, desk.due_soon, desk.not_started],
           ["June 2090", "draft", 4, true, false], "this month");
        // Early in the month: no warning yet.
        const early = (await at(HIMAWAN, "2090-06-10")).payroll_desk;
        eq([early.days_left, early.due_soon], [20, false], "early");
        // A month with no run and a week to go is the louder problem.
        const none = (await at(HIMAWAN, "2090-11-27")).payroll_desk;
        eq([none.this_month, none.this_month_status, none.due_soon, none.not_started],
           ["November 2090", null, false, true], "not started");
        // Once it is with an approver, it is no longer finance's to finish.
        const july = (await at(HIMAWAN, "2090-07-28")).payroll_desk;
        eq([july.this_month_status, july.due_soon, july.not_started], ["submitted", false, false], "submitted");
    });

    await step("overview: IT support sees the queue; everybody sees their own", async () => {
        await db.exec(`
            insert into public.support_tickets (reference, subject, description, category, status, reporter_id) values
              ('OV-T-1','Overview laptop','x','hardware','open','${E.OVIDIA}'),
              ('OV-T-2','Overview login','x','hardware','closed','${E.OVIDIA}')
            on conflict do nothing`);
        const o = await at(U.STAFF);
        eq(o.my_tickets_open, 1, "my_tickets_open");
        eq(o.tickets_open, null, "not IT support");
        await db.exec(`update public.employees set is_it_support = true where id = '${E.OVIDIA}'`);
        try {
            const it = await at(U.STAFF);
            const open = (await db.query(`select count(*)::int n from public.support_tickets
                                           where status in ('open','in_progress','waiting')`)).rows[0].n;
            eq(it.tickets_open, open, "tickets_open");
        } finally {
            await db.exec(`update public.employees set is_it_support = false where id = '${E.OVIDIA}'`);
        }
    });

    await step("overview: the client calls overview_get, not overview_at", async () => {
        const o = await call(RINA, "overview_get");
        for (const k of ["is_management", "has_employee_record", "week", "holidays", "leave", "tickets_open",
                         "my_tickets_open", "pending_mine", "pending_approvals", "on_leave_today", "headcount",
                         "salary_awaiting", "payroll_awaiting", "finance_sent_back", "payroll_desk", "kpi_awaiting",
                         "approvals", "on_duty", "next_holiday"])
            if (!(k in o)) throw new Error(`missing ${k}`);
        await refused(tx(RINA, `select public.overview_at('2090-06-26'::date)`), "42501");
    });

    // --- the activity log ---------------------------------------------------
    await step("activity: staff see what they did and what was done to them", async () => {
        await db.exec(`
            insert into public.activity_logs (id, action, actor_id, target_user_id, description, created_at) values
              (gen_random_uuid(),'OV_ONE','${U.STAFF}', null, 'Overview: Ovidia did it', '2090-06-01 09:00'),
              (gen_random_uuid(),'OV_TWO','${U.DIR}','${U.STAFF}', 'Overview: done to Ovidia', '2090-06-02 09:00'),
              (gen_random_uuid(),'OV_THREE','${U.DIR}', null, 'Overview: none of hers', '2090-06-03 09:00'),
              (gen_random_uuid(),'OV_FOUR', null,'${U.STAFF}', 'Overview: the system did it', '2090-06-04 09:00')`);
        const r = await call(U.STAFF, "activity_recent", [1, 10], ["int", "int"]);
        eq(r.total, 3, "total");
        eq(r.items.map((i) => i.action), ["OV_FOUR", "OV_TWO", "OV_ONE"], "newest first, scoped");
        eq(r.items[0].actor_name, "System", "no actor");
        eq(r.items[1].actor_name, "Nadia Director", "actor");
        eq(Object.keys(r.items[0]).sort(), ["action", "actor_name", "created_at", "description", "id"], "item keys");
        eq([r.page, r.page_size], [1, 10], "paging echoed");
        const p2 = await call(U.STAFF, "activity_recent", [2, 2], ["int", "int"]);
        eq(p2.items.map((i) => i.action), ["OV_ONE"], "second page");
    });

    await step("activity: a superuser sees everything", async () => {
        const all = (await db.query(`select count(*)::int n from public.activity_logs`)).rows[0].n;
        const r = await call(U.DIR, "activity_recent", [1, 50], ["int", "int"]);
        eq(r.total, all, "total");
        eq(r.items.length, Math.min(all, 50), "page");
    });

    await step("activity: paging is bounded", async () => {
        await refused(call(U.STAFF, "activity_recent", [0, 10], ["int", "int"]), "PT422");
        await refused(call(U.STAFF, "activity_recent", [1, 51], ["int", "int"]), "PT422");
        await refused(call(U.STAFF, "activity_recent", [1, 0], ["int", "int"]), "PT422");
    });

    // --- /dashboard/stats ---------------------------------------------------
    await step("dashboard_stats: the annual figure is the Leave page's", async () => {
        const s = await call(U.STAFF, "dashboard_stats");
        const [bal] = await call(U.STAFF, "get_leave_balances");
        eq(s.role, "employee", "role");
        eq([s.annual_total, s.annual_remaining], [Number(bal.total_days), Number(bal.remaining_days)], "annual");
        eq((await call(U.DIR, "dashboard_stats")).role, "admin", "director");
    });

    // --- leave nothing behind -----------------------------------------------
    // Later suites count queues (runs awaiting a signature, salary reviews
    // waiting on the executive); this suite's rows must not show up in them.
    const emps = Object.values(E).map((id) => `'${id}'`).join(",");
    await db.exec(`
        delete from public.activity_logs where action like 'OV\\_%';
        delete from public.finance_requests where reference like 'OV-%';
        delete from public.support_tickets where reference like 'OV-T-%';
        delete from public.payroll_months where year = 2090;
        delete from public.salary_reviews where employee_id in (${emps});
        delete from public.kpi_reviews where employee_id in (${emps});
        delete from public.leave_requests where employee_id in (${emps});
        delete from public.shift_assignments where schedule_id in ('${S.PUB}', '${S.DRAFT}');
        delete from public.work_schedules where id in ('${S.PUB}', '${S.DRAFT}');
        delete from public.public_holidays where name like 'Overview %';
        delete from public.leave_balances where employee_id in (${emps});
        delete from public.employees where id in (${emps});
    `);
};
