// Leaves: the FastAPI line's rules (app/services/leave_service.py,
// app/services/annual_leave.py, app/api/routes/leaves.py).
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER } = people;

    // Own people, own ids. Nur is a director with a roster row (management,
    // reviewed -- not a founder); Mark is a founder; Lead manages Staff.
    const U = {
        NUR: "66000000-0000-0000-0000-000000000001",
        MARK: "66000000-0000-0000-0000-000000000002",
        LEAD: "66000000-0000-0000-0000-000000000003",
        STAFF: "66000000-0000-0000-0000-000000000004",
        STUDENT: "66000000-0000-0000-0000-000000000005",
    };
    const E = {
        NUR: "67000000-0000-0000-0000-000000000001",
        MARK: "67000000-0000-0000-0000-000000000002",
        LEAD: "67000000-0000-0000-0000-000000000003",
        STAFF: "67000000-0000-0000-0000-000000000004",
        STUDENT: "67000000-0000-0000-0000-000000000005",
    };

    const authRow = (id, email, name) => `('00000000-0000-0000-0000-000000000000','${id}',
        'authenticated','authenticated','${email}','x', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"full_name":"${name}"}'::jsonb, now(), now(), '', '', '', '')`;

    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
          ${authRow(U.NUR, "lv-nur@dtgeotech.com", "Lv Nur")},
          ${authRow(U.MARK, "lv-mark@dtgeotech.com", "Lv Mark")},
          ${authRow(U.LEAD, "lv-lead@dtgeotech.com", "Lv Lead")},
          ${authRow(U.STAFF, "lv-staff@dtgeotech.com", "Lv Staff")},
          ${authRow(U.STUDENT, "lv-student@dtgeotech.com", "Lv Student")};

        update public.users set role = 'director' where id = '${U.NUR}';

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, user_id, manager_id,
                                      is_management_role, kpi_review_required, gender, study_leave_eligible) values
          ('${E.NUR}','LV-001','Lv','Nur','lv-nur@dtgeotech.com','HR','Director','2024-01-01',0,'${U.NUR}',null,true,true,'female',true),
          ('${E.MARK}','LV-002','Lv','Mark','lv-mark@dtgeotech.com','Management','Founder','2024-01-01',0,'${U.MARK}',null,true,false,'male',false),
          ('${E.LEAD}','LV-003','Lv','Lead','lv-lead@dtgeotech.com','Ops','Lead','2024-01-01',0,'${U.LEAD}',null,false,true,null,false),
          ('${E.STAFF}','LV-004','Lv','Staff','lv-staff@dtgeotech.com','Ops','Technician','2025-01-01',0,'${U.STAFF}','${E.LEAD}',false,true,'Male',false),
          ('${E.STUDENT}','LV-005','Lv','Student','lv-student@dtgeotech.com','Ops','Analyst','2025-01-01',0,'${U.STUDENT}',null,false,true,'female',true);
    `);

    const raises = async (fn, pattern, code) => {
        try {
            await fn();
        } catch (e) {
            if (!pattern.test(e.message)) throw new Error(`wrong error: ${e.message}`);
            if (code && e.code !== code) throw new Error(`code ${e.code}, expected ${code}`);
            return;
        }
        throw new Error("expected a raise");
    };
    const submit = async (uid, payload) =>
        (await tx(uid, `select public.submit_leave_request($1::jsonb) j`, [JSON.stringify(payload)])).rows[0].j;
    const queue = async (uid) =>
        (await tx(uid, `select public.leaves_pending_approvals(1, 100) j`)).rows[0].j;
    const position = async (emp, through) =>
        (await db.query(`select * from public.leaves_annual_position($1::uuid, $2::date)`, [emp, through])).rows[0];

    // --- types -------------------------------------------------------------

    await step("leave types: study only when granted, family types by recorded gender", async () => {
        const staff = (await tx(U.STAFF, `select public.leaves_types() j`)).rows[0].j.map((t) => t.value);
        for (const v of ["study", "maternity", "miscarriage", "menstrual"])
            if (staff.includes(v)) throw new Error(`staff offered ${v}`);
        if (!staff.includes("paternity") || staff[0] !== "annual" || staff.length !== 8)
            throw new Error(staff.join(","));
        const student = (await tx(U.STUDENT, `select public.leaves_types() j`)).rows[0].j;
        const sv = student.map((t) => t.value);
        if (!sv.includes("study") || !sv.includes("maternity") || sv.includes("paternity") || sv.length !== 11)
            throw new Error(sv.join(","));
        const pat = (await tx(U.LEAD, `select public.leaves_types() j`)).rows[0].j;
        if (pat.length !== 11) throw new Error(`no gender recorded should offer all but study: ${pat.length}`);
        const marriage = student.find((t) => t.value === "marriage");
        if (marriage.allowance_days !== 3 || marriage.group !== "special" || marriage.needs_document !== false)
            throw new Error(JSON.stringify(marriage));
        const none = (await tx(DIRECTOR, `select public.leaves_types() j`)).rows[0].j;
        if (none.length !== 0) throw new Error("no employee record should get []");
    });

    // --- balances ----------------------------------------------------------

    await step("annual balance accrues a day a month, read at month end and year end", async () => {
        const [b] = (await tx(U.STAFF, `select public.get_leave_balances(null, 2026) j`)).rows[0].j;
        if (b.total_days !== 24 || b.used_days !== 0 || b.remaining_days !== 24) throw new Error(JSON.stringify(b));
        const exp = (await db.query(`
            select to_char(m, 'YYYY-MM-DD') as_at, round(public.accrued_annual_leave('2025-01-01', m), 2)::float a
              from (select least((date_trunc('month', current_date) + interval '1 month - 1 day')::date,
                                 '2026-12-31'::date) m) x`)).rows[0];
        if (b.as_at !== exp.as_at || b.accrued_now !== exp.a || b.remaining_now !== exp.a || b.used_now !== 0)
            throw new Error(`${JSON.stringify(b)} vs ${JSON.stringify(exp)}`);
        if (b.year_end !== "2026-12-31" || b.year !== 2026) throw new Error(JSON.stringify(b));
    });

    await step("founders carry no balance and book no leave", async () => {
        const r = (await tx(U.MARK, `select public.get_leave_balances(null, 2026) j`)).rows[0].j;
        if (r.length !== 0) throw new Error(`got ${r.length}`);
        await raises(() => submit(U.MARK, { leave_type: "annual", start_date: "2026-10-05",
            end_date: "2026-10-05", days_requested: 1 }), /^Founders do not carry a leave balance\.$/, "PT403");
    });

    await step("another's balances: the named manager only, not administrators", async () => {
        const r = (await tx(U.LEAD, `select public.get_leave_balances($1::uuid, 2026) j`, [E.STAFF])).rows[0].j;
        if (r[0].employee_id !== E.STAFF) throw new Error("wrong employee");
        await raises(() => tx(PETER, `select public.get_leave_balances($1::uuid, 2026)`, [E.STAFF]),
            /^You are not the manager of this employee$/, "PT403");
        await raises(() => tx(U.LEAD, `select public.get_leave_balances('67000000-0000-0000-0000-0000000000ff', 2026)`),
            /^Employee not found$/, "PT404");
        await raises(() => tx(DIRECTOR, `select public.get_leave_balances(null, 2026)`),
            /^No employee profile linked to this user account$/, "PT403");
    });

    // --- submit ------------------------------------------------------------

    await step("annual is checked against the year-end position", async () => {
        await raises(() => submit(U.STAFF, { leave_type: "annual", start_date: "2026-10-01",
            end_date: "2026-10-30", days_requested: 30 }),
            /^Insufficient annual leave\. 24\.00 day\(s\) left at the end of 2026, 30 requested\.$/, "PT400");
    });

    await step("request validation answers 422", async () => {
        await raises(() => submit(U.STAFF, { leave_type: "annual", start_date: "2026-10-12",
            end_date: "2026-10-10", days_requested: 1 }), /end_date must be on or after start_date/, "PT422");
        await raises(() => submit(U.STAFF, { leave_type: "personal", start_date: "2026-10-12",
            end_date: "2026-10-12", days_requested: 1 }), /Invalid leave_type/, "PT422");
        await raises(() => submit(U.STAFF, { leave_type: "sick", start_date: "2026-10-12",
            end_date: "2026-10-12", days_requested: 0 }), /days_requested must be positive/, "PT422");
    });

    let staffSick;
    await step("submit creates a pending request and logs it", async () => {
        staffSick = await submit(U.STAFF, { leave_type: "sick", start_date: "2026-11-02",
            end_date: "2026-11-03", days_requested: 2, reason: "flu" });
        if (staffSick.status !== "pending" || staffSick.employee_name !== "Lv Staff" || staffSick.days_requested !== 2)
            throw new Error(JSON.stringify(staffSick));
        const log = await db.query(`select description from public.activity_logs
                                     where action='LEAVE_REQUESTED' and target_id=$1`, [staffSick.id]);
        if (log.rows[0]?.description !== "Lv Staff requested 2.0 day(s) of sick leave")
            throw new Error(log.rows[0]?.description);
        await raises(() => submit(U.STAFF, { leave_type: "annual", start_date: "2026-11-03",
            end_date: "2026-11-04", days_requested: 2 }), /^Overlapping leave request/, "PT409");
    });

    // --- the queue ---------------------------------------------------------

    let nurLeave;
    await step("pending approvals: management and administrators see all but their own", async () => {
        nurLeave = await submit(U.NUR, { leave_type: "annual", start_date: "2026-11-09",
            end_date: "2026-11-10", days_requested: 2 });
        const nur = (await queue(U.NUR)).items.map((x) => x.id);
        if (nur.includes(nurLeave.id)) throw new Error("the director sees her own request");
        if (!nur.includes(staffSick.id)) throw new Error("the director misses staff's request");
        const mark = (await queue(U.MARK)).items.map((x) => x.id);
        if (!mark.includes(nurLeave.id) || !mark.includes(staffSick.id)) throw new Error("management queue incomplete");
        const peter = (await queue(PETER)).items.map((x) => x.id);
        if (!peter.includes(nurLeave.id)) throw new Error("executive misses the director's request");
    });

    await step("pending approvals: a named manager sees direct reports only", async () => {
        const lead = await queue(U.LEAD);
        if (lead.total !== 1 || lead.items[0].id !== staffSick.id) throw new Error(JSON.stringify(lead));
        const staff = await queue(U.STAFF);
        if (staff.total !== 0 || staff.page !== 1 || staff.page_size !== 100) throw new Error(JSON.stringify(staff));
    });

    // --- approve / reject --------------------------------------------------

    await step("nobody approves their own leave, not even the director", async () => {
        await raises(() => tx(U.NUR, `select public.approve_leave_request($1::uuid, null)`, [nurLeave.id]),
            /^You cannot approve your own leave\.$/, "PT403");
        await raises(() => tx(U.NUR, `select public.reject_leave_request($1::uuid, null)`, [nurLeave.id]),
            /^You cannot approve your own leave\.$/, "PT403");
    });

    await step("the director's leave is approved by management", async () => {
        const r = (await tx(U.MARK, `select public.approve_leave_request($1::uuid, 'enjoy') j`, [nurLeave.id])).rows[0].j;
        if (r.status !== "approved" || r.reviewed_by !== E.MARK || r.reviewer_note !== "enjoy")
            throw new Error(JSON.stringify(r));
        const p = await position(E.NUR, "2026-12-31");
        if (p.taken !== 2) throw new Error(`taken ${p.taken}`);
    });

    await step("an employee who is not the manager cannot approve", async () => {
        await raises(() => tx(U.STUDENT, `select public.approve_leave_request($1::uuid, null)`, [staffSick.id]),
            /^You are not set up to approve this person's leave\.$/, "PT403");
    });

    await step("the named manager approves a direct report's leave", async () => {
        const r = (await tx(U.LEAD, `select public.approve_leave_request($1::uuid, null) j`, [staffSick.id])).rows[0].j;
        if (r.status !== "approved" || r.reviewed_by !== E.LEAD) throw new Error(JSON.stringify(r));
        const log = await db.query(`select description from public.activity_logs
                                     where action='LEAVE_APPROVED' and target_id=$1`, [staffSick.id]);
        if (log.rows[0]?.description !== "Approved Lv Staff's sick leave request") throw new Error(log.rows[0]?.description);
    });

    await step("a decision stands: nobody reverses a settled request", async () => {
        await raises(() => tx(PETER, `select public.reject_leave_request($1::uuid, 'no')`, [staffSick.id]),
            /^Leave request is already 'approved'$/, "PT400");
    });

    await step("an administrator with no roster row may still review", async () => {
        const req = await submit(U.STAFF, { leave_type: "marriage", start_date: "2026-11-16",
            end_date: "2026-11-18", days_requested: 3 });
        const r = (await tx(DIRECTOR, `select public.reject_leave_request($1::uuid, 'busy') j`, [req.id])).rows[0].j;
        if (r.status !== "rejected" || r.reviewed_by !== null) throw new Error(JSON.stringify(r));
    });

    // --- annual counted from dates -----------------------------------------

    await step("a day on the roster and in an approved request counts once", async () => {
        await db.exec(`insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
                       values (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001', '${E.STAFF}', '2026-09-15', 'AL')`);
        let p = await position(E.STAFF, "2026-12-31");
        if (p.taken !== 1) throw new Error(`roster cell: taken ${p.taken}`);
        const req = await submit(U.STAFF, { leave_type: "annual", start_date: "2026-09-15",
            end_date: "2026-09-16", days_requested: 2 });
        await tx(U.LEAD, `select public.approve_leave_request($1::uuid, null)`, [req.id]);
        p = await position(E.STAFF, "2026-12-31");
        if (p.taken !== 2) throw new Error(`taken ${p.taken}, expected 2`);
        const [b] = (await tx(U.STAFF, `select public.get_leave_balances(null, 2026) j`)).rows[0].j;
        if (b.used_days !== 2 || b.remaining_days !== 22) throw new Error(JSON.stringify(b));

        // Cancelling an approved annual request gives its dates back.
        await tx(U.STAFF, `select public.cancel_leave_request($1::uuid)`, [req.id]);
        p = await position(E.STAFF, "2026-12-31");
        if (p.taken !== 1) throw new Error(`after cancel taken ${p.taken}`);
    });

    // --- stored counters for the other types ---------------------------------

    await step("a stored counter moves on approval and back on cancel", async () => {
        await db.exec(`insert into public.leave_balances (id, employee_id, leave_type, year, total_days, used_days)
                       values (gen_random_uuid(), '${E.STUDENT}', 'study', 2026, 5, 0)`);
        const used = async () => Number((await db.query(`select used_days from public.leave_balances
            where employee_id='${E.STUDENT}' and leave_type='study' and year=2026`)).rows[0].used_days);
        await raises(() => submit(U.STUDENT, { leave_type: "study", start_date: "2026-10-01",
            end_date: "2026-10-06", days_requested: 6 }),
            /^Insufficient study leave balance\. Remaining: 5\.0, Requested: 6\.0$/, "PT400");
        const req = await submit(U.STUDENT, { leave_type: "study", start_date: "2026-10-01",
            end_date: "2026-10-02", days_requested: 2 });
        await tx(PETER, `select public.approve_leave_request($1::uuid, null)`, [req.id]);
        if (await used() !== 2) throw new Error(`used ${await used()}`);
        await tx(U.STUDENT, `select public.cancel_leave_request($1::uuid)`, [req.id]);
        if (await used() !== 0) throw new Error(`used after cancel ${await used()}`);
    });

    // --- cancel ------------------------------------------------------------

    await step("cancel: own requests only, and only while pending or approved", async () => {
        await raises(() => tx(U.LEAD, `select public.cancel_leave_request($1::uuid)`, [staffSick.id]),
            /^You can only cancel your own leave requests$/, "PT403");
        const r = (await tx(U.STAFF, `select public.cancel_leave_request($1::uuid) j`, [staffSick.id])).rows[0].j;
        if (r.status !== "cancelled") throw new Error(r.status);
        await raises(() => tx(U.STAFF, `select public.cancel_leave_request($1::uuid)`, [staffSick.id]),
            /^Cannot cancel a leave request with status 'cancelled'$/, "PT400");
        await raises(() => tx(U.STAFF, `select public.cancel_leave_request('67000000-0000-0000-0000-0000000000ff')`),
            /^Leave request not found$/, "PT404");
    });

    // --- lists and reads -----------------------------------------------------

    await step("my requests: newest first, filtered and paged", async () => {
        const all = (await tx(U.STAFF, `select public.leaves_list_mine(1, 20, null, null) j`)).rows[0].j;
        if (all.total !== 3 || all.items.length !== 3) throw new Error(`total ${all.total}`);
        if (all.items.some((x) => x.employee_id !== E.STAFF)) throw new Error("someone else's row");
        const times = all.items.map((x) => x.created_at);
        if ([...times].sort().reverse().join() !== times.join()) throw new Error("not newest first");
        const cancelled = (await tx(U.STAFF, `select public.leaves_list_mine(1, 20, 'cancelled', null) j`)).rows[0].j;
        if (cancelled.total !== 2) throw new Error(`cancelled ${cancelled.total}`);
        const paged = (await tx(U.STAFF, `select public.leaves_list_mine(2, 2, null, null) j`)).rows[0].j;
        if (paged.items.length !== 1 || paged.page !== 2 || paged.total !== 3) throw new Error(JSON.stringify(paged));
        await raises(() => tx(DIRECTOR, `select public.leaves_list_mine(1, 20, null, null)`),
            /^No employee profile linked to this user account$/, "PT403");
    });

    await step("one request: own or a direct report's", async () => {
        const r = (await tx(U.LEAD, `select public.leaves_get($1::uuid) j`, [staffSick.id])).rows[0].j;
        if (r.id !== staffSick.id) throw new Error("wrong row");
        await raises(() => tx(U.STUDENT, `select public.leaves_get($1::uuid)`, [staffSick.id]),
            /^Access denied$/, "PT403");
    });

    await step("summary is for administrators", async () => {
        const s = (await tx(PETER, `select public.leave_summary() j`)).rows[0].j;
        if (!(s.sick?.cancelled >= 1)) throw new Error(JSON.stringify(s));
        await raises(() => tx(U.MARK, `select public.leave_summary()`), /^Admin only$/, "PT403");
    });
};
