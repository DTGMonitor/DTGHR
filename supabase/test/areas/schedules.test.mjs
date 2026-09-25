// Schedules (the roster): visibility by work pattern, the grid's name list,
// proposals and review, the rotation generator, and the holiday calendar.
// Ported from backend tests/test_schedule_routes.py and
// tests/test_schedule_visibility.py.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN } = people;

    // Users -- auth row first; the trigger provisions the profile.
    const U = {
        OFFICE: "5c000000-0000-0000-0000-000000000001", // Bintang, office-day
        CREW: "5c000000-0000-0000-0000-000000000002",   // Lintang, roster
        BACKUP: "5c000000-0000-0000-0000-000000000003", // Nessy, office-day + back-up
        ORPHAN: "5c000000-0000-0000-0000-000000000004", // an account with no row yet
        NOBODY: "5c000000-0000-0000-0000-000000000005", // an account with no row at all
    };
    const E = {
        OFFICE: "5ce00000-0000-0000-0000-000000000001",
        CREW: "5ce00000-0000-0000-0000-000000000002",
        BACKUP: "5ce00000-0000-0000-0000-000000000003",
        FORMER: "5ce00000-0000-0000-0000-000000000004",
        FOUNDER: "5ce00000-0000-0000-0000-000000000005",
        ORPHAN: "5ce00000-0000-0000-0000-000000000006",
    };
    const FEB = "5cb00000-0000-0000-0000-000000000001"; // February 2029, published
    const MAR = "5cb00000-0000-0000-0000-000000000002"; // March 2029, published
    const DRAFT = "5cb00000-0000-0000-0000-000000000003"; // June 2029, draft

    const authUser = (id, email, name) => `
        ('00000000-0000-0000-0000-000000000000','${id}','authenticated','authenticated',
         '${email}','x', now(), '{"provider":"email","providers":["email"]}'::jsonb,
         '{"full_name":"${name}"}'::jsonb, now(), now(), '', '', '', '')`;

    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
        ${authUser(U.OFFICE, "bintang.s@dtgeotech.com", "Bintang Test")},
        ${authUser(U.CREW, "lintang.s@dtgeotech.com", "Lintang Test")},
        ${authUser(U.BACKUP, "nessy.s@dtgeotech.com", "Nessy Test")},
        ${authUser(U.ORPHAN, "Orphan.S@dtgeotech.com", "Orphan Test")},
        ${authUser(U.NOBODY, "nobody.s@dtgeotech.com", "Nobody Test")};

        insert into public.employees (id, employee_id, first_name, last_name, email, department,
                                      position, date_of_joining, annual_leave_opening_balance,
                                      user_id, work_pattern, is_backup_engineer, is_active,
                                      is_management_role, kpi_review_required) values
          ('${E.OFFICE}','SCH-01','Bintang','Test','bintang.s@dtgeotech.com','Ops','Engineer','2029-01-01',0,'${U.OFFICE}','office_day',false,true,false,true),
          ('${E.CREW}','SCH-02','Lintang','Test','lintang.s@dtgeotech.com','Ops','Engineer','2025-04-01',0,'${U.CREW}','roster',false,true,false,true),
          ('${E.BACKUP}','SCH-03','Nessy','Test','nessy.s@dtgeotech.com','Ops','Engineer','2025-04-01',0,'${U.BACKUP}','office_day',true,true,false,true),
          ('${E.FORMER}','SCH-04','Isabella','Test','isabella.s@dtgeotech.com','Ops','Engineer','2025-04-01',0,null,'roster',false,false,false,true),
          ('${E.FOUNDER}','SCH-05','Mark','Test','mark.s@dtgeotech.com','Management','Director','2020-01-01',0,null,'office_day',false,true,true,false),
          -- Imported from the workbook: no account linked, email differs by case.
          ('${E.ORPHAN}','SCH-06','Orphan','Test','orphan.s@dtgeotech.com','Ops','Engineer','2025-04-01',5,null,'roster',false,true,false,true);

        insert into public.work_schedules (id, name, start_date, end_date, status) values
          ('${FEB}','February 2029','2029-02-01','2029-02-28','published'),
          ('${MAR}','March 2029','2029-03-01','2029-03-31','published'),
          ('${DRAFT}','June 2029','2029-06-01','2029-06-30','draft');

        insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
        select gen_random_uuid(), '${FEB}', e.id, '2029-02-02',
               case when e.work_pattern::text = 'office_day' then 'D' else 'DS' end
          from public.employees e
         where e.id in ('${E.OFFICE}','${E.CREW}','${E.BACKUP}','${E.FORMER}','${E.ORPHAN}');

        -- Lintang ends March three days into a night block of DS4/NS4/B4.
        insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
        select gen_random_uuid(), '${MAR}', '${E.CREW}', d::date,
               case when d::date <= '2029-03-28' then 'DS' else 'NS' end
          from generate_series('2029-03-25'::date, '2029-03-31'::date, interval '1 day') d;
    `);

    const expectError = async (fn, code, pattern) => {
        try {
            await fn();
        } catch (e) {
            if (code && e.code !== code) throw new Error(`code ${e.code}: ${e.message}`);
            if (pattern && !pattern.test(e.message)) throw new Error(`wrong error: ${e.message}`);
            return e;
        }
        throw new Error("expected a raise");
    };
    const detail = async (uid, id = FEB) =>
        (await tx(uid, `select public.get_schedule_detail($1::uuid) j`, [id])).rows[0].j;
    const names = async (uid) =>
        new Set((await detail(uid)).assignments.map((a) => a.employee_name));

    // --- visibility -------------------------------------------------------
    await step("office-day staff cannot see the roster", async () => {
        const n = await names(U.OFFICE);
        if (n.has("Lintang Test")) throw new Error("an office-day engineer saw the roster");
        if (!n.has("Bintang Test")) throw new Error("lost their own schedule");
    });

    await step("the roster crew cannot see the office-day schedule", async () => {
        const n = await names(U.CREW);
        if (n.has("Bintang Test")) throw new Error("a roster engineer saw the office-day schedule");
        if (!n.has("Lintang Test")) throw new Error("lost their own schedule");
    });

    await step("the back-up engineer sees both, until the flag is cleared", async () => {
        const n = await names(U.BACKUP);
        if (!n.has("Lintang Test") || !n.has("Nessy Test")) throw new Error([...n].join(","));
        await db.exec(`update public.employees set is_backup_engineer = false where id = '${E.BACKUP}'`);
        const after = await names(U.BACKUP);
        await db.exec(`update public.employees set is_backup_engineer = true where id = '${E.BACKUP}'`);
        if (after.has("Lintang Test")) throw new Error("clearing back-up kept the roster");
        if (!after.has("Nessy Test")) throw new Error("lost their own schedule");
    });

    await step("administrators see everyone, former staff included; colleagues do not", async () => {
        for (const who of [DIRECTOR, PETER]) {
            const n = await names(who);
            for (const x of ["Bintang Test", "Lintang Test", "Nessy Test", "Isabella Test"])
                if (!n.has(x)) throw new Error(`${who} cannot see ${x}`);
        }
        for (const who of [U.OFFICE, U.CREW, U.BACKUP]) {
            if ((await names(who)).has("Isabella Test")) throw new Error(`${who} saw a former employee`);
        }
    });

    await step("finance sees both schedules to price payroll", async () => {
        const n = await names(HIMAWAN);
        if (!n.has("Lintang Test") || !n.has("Bintang Test")) throw new Error([...n].join(","));
        if (n.has("Isabella Test")) throw new Error("finance saw a former employee");
    });

    await step("totals carry the work pattern", async () => {
        const w = (await detail(DIRECTOR)).working_days;
        const by = Object.fromEntries(w.map((x) => [x.employee_name, x.work_pattern]));
        if (by["Lintang Test"] !== "roster") throw new Error(JSON.stringify(by));
        if (by["Bintang Test"] !== "office_day") throw new Error(JSON.stringify(by));
        if (by["Nessy Test"] !== "office_day") throw new Error("back-up is still office-day staff");
    });

    await step("RLS on shift_assignments applies the same rule", async () => {
        const r = await tx(U.CREW, `select distinct employee_id from public.shift_assignments
                                     where schedule_id = '${FEB}'`);
        const ids = r.rows.map((x) => x.employee_id);
        if (ids.includes(E.OFFICE)) throw new Error("crew read an office-day row");
        if (!ids.includes(E.CREW)) throw new Error("crew lost their own row");
    });

    await step("the grid's name list is scoped, active only, founders left out", async () => {
        const all = (await tx(DIRECTOR, `select public.schedules_list_employees() j`)).rows[0].j;
        const ids = all.map((x) => x.id);
        if (ids.includes(E.FOUNDER)) throw new Error("a founder is a roster row");
        if (ids.includes(E.FORMER)) throw new Error("a former employee is listed");
        if (!ids.includes(E.CREW) || !ids.includes(E.OFFICE)) throw new Error("rows missing");
        const keys = Object.keys(all[0]).sort().join(",");
        if (keys !== "employee_id,first_name,id,is_backup_engineer,last_name,position,work_pattern")
            throw new Error(`shape ${keys}`);
        const office = (await tx(U.OFFICE, `select public.schedules_list_employees() j`)).rows[0].j;
        if (office.some((x) => x.id === E.CREW)) throw new Error("office user got a crew name");
        const nobody = (await tx(U.NOBODY, `select public.schedules_list_employees() j`)).rows[0].j;
        if (nobody.length !== 0) throw new Error("an unlinked account saw names");
    });

    await step("the period list pages, and hides drafts from employees", async () => {
        const a = (await tx(DIRECTOR, `select public.schedules_list(1, 100) j`)).rows[0].j;
        const e = (await tx(U.CREW, `select public.schedules_list(1, 100) j`)).rows[0].j;
        if (!a.items.some((s) => s.id === DRAFT)) throw new Error("admin lost the draft");
        if (e.items.some((s) => s.status !== "published")) throw new Error("employee saw a draft");
        if (e.total !== e.items.length || a.page_size !== 100) throw new Error(JSON.stringify(e));
        const dates = a.items.map((s) => s.start_date);
        if ([...dates].sort().reverse().join() !== dates.join()) throw new Error("not newest first");
        await expectError(() => tx(U.CREW, `select public.schedules_list(1, 101)`), "PT422");
    });

    // --- proposals --------------------------------------------------------
    await step("dates outside the period are refused, listed as the backend did", async () => {
        await expectError(() => tx(U.CREW, `select public.propose_shift_changes($1::uuid, $2::jsonb, null)`, [FEB,
            JSON.stringify([{ employee_id: E.CREW, date: "2029-03-04", requested_code: "AL" }])]),
            "P0001", /^These dates fall outside the period: \['2029-03-04'\]$/);
    });

    await step("the same day twice, or a code off the legend, is a 422", async () => {
        await expectError(() => tx(U.CREW, `select public.propose_shift_changes($1::uuid, $2::jsonb, null)`, [FEB,
            JSON.stringify([{ employee_id: E.CREW, date: "2029-02-03", requested_code: "AL" },
                            { employee_id: E.CREW, date: "2029-02-03", requested_code: "SL" }])]),
            "PT422", /more than once/);
        await expectError(() => tx(U.CREW, `select public.propose_shift_changes($1::uuid, $2::jsonb, null)`, [FEB,
            JSON.stringify([{ employee_id: E.CREW, date: "2029-02-03", requested_code: "XX" }])]),
            "PT422");
    });

    await step("an unclaimed roster row is adopted on the first proposal", async () => {
        await db.exec(`update public.employees set user_id = null where id = '${E.ORPHAN}'`);
        const r = await tx(U.ORPHAN, `select public.propose_shift_changes($1::uuid, $2::jsonb, 'swap') j`, [FEB,
            JSON.stringify([{ employee_id: E.ORPHAN, date: "2029-02-06", requested_code: "AL" }])]);
        if (r.rows[0].j.status !== "pending") throw new Error(JSON.stringify(r.rows[0].j));
        const e = await db.query(`select user_id from public.employees where id = '${E.ORPHAN}'`);
        if (e.rows[0].user_id !== U.ORPHAN) throw new Error(`user_id ${e.rows[0].user_id}`);
    });

    await step("a clash names the day already awaiting approval", async () => {
        await expectError(() => tx(U.ORPHAN, `select public.propose_shift_changes($1::uuid, $2::jsonb, null)`, [FEB,
            JSON.stringify([{ employee_id: E.ORPHAN, date: "2029-02-06", requested_code: "SL" }])]),
            "PT409", /awaiting approval: \['2029-02-06'\]/);
    });

    await step("an employee sees only proposals on their own row", async () => {
        // The administrator proposes against Lintang's row: it is Lintang's too.
        await tx(DIRECTOR, `select public.propose_shift_changes($1::uuid, $2::jsonb, null)`, [FEB,
            JSON.stringify([{ employee_id: E.CREW, date: "2029-02-10", requested_code: "NS" }])]);
        const crew = (await tx(U.CREW, `select public.list_change_requests(null, $1::uuid) j`, [FEB])).rows[0].j;
        if (crew.length !== 1 || crew[0].items[0].employee_id !== E.CREW) throw new Error(JSON.stringify(crew));
        const orphan = (await tx(U.ORPHAN, `select public.list_change_requests(null, $1::uuid) j`, [FEB])).rows[0].j;
        if (orphan.some((r) => r.items.some((i) => i.employee_id !== E.ORPHAN))) throw new Error("leak");
        const pend = (await detail(U.CREW)).pending_changes;
        if (pend.length !== 1) throw new Error(`pending_changes ${pend.length}`);
        await expectError(() => tx(U.NOBODY, `select public.list_change_requests(null, null)`),
            "PT403", /No employee profile linked/);
    });

    await step("the annual-leave cap counts approved requests as well as AL cells", async () => {
        // Bintang joined 1 Jan 2029: two days accrued by 28 Feb, both spent by
        // an approved request in January. The roster has no AL cells at all.
        await db.exec(`insert into public.leave_requests
            (id, employee_id, leave_type, start_date, end_date, days_requested, status)
            values ('5cf00000-0000-0000-0000-000000000001','${E.OFFICE}','annual',
                    '2029-01-10','2029-01-11', 2, 'approved')`);
        await expectError(() => tx(U.OFFICE, `select public.propose_shift_changes($1::uuid, $2::jsonb, null)`, [FEB,
            JSON.stringify([{ employee_id: E.OFFICE, date: "2029-02-05", requested_code: "AL" }])]),
            "P0001", /^Not enough annual leave: 1 day\(s\) requested but only 0 left\. Ask a superuser if this is urgent\.$/);
        const w = (await detail(DIRECTOR)).working_days.find((x) => x.employee_id === E.OFFICE);
        if (Number(w.annual_leave_days) !== 0) throw new Error(`balance ${w.annual_leave_days}`);
        // A superuser may still book past it.
        await tx(DIRECTOR, `select public.propose_shift_changes($1::uuid, $2::jsonb, null)`, [FEB,
            JSON.stringify([{ employee_id: E.OFFICE, date: "2029-02-05", requested_code: "AL" }])]);
    });

    await step("review: approve and reject the same item is a 422; unknown ids are named", async () => {
        const req = (await tx(U.ORPHAN, `select public.list_change_requests('pending', $1::uuid) j`, [FEB])).rows[0].j[0];
        const item = req.items[0].id;
        await expectError(() => tx(DIRECTOR,
            `select public.review_shift_change($1::uuid, array[$2::uuid], array[$2::uuid], null)`, [req.id, item]),
            "PT422", /both approved and rejected/);
        const stray = "5c999999-0000-0000-0000-000000000000";
        await expectError(() => tx(DIRECTOR,
            `select public.review_shift_change($1::uuid, array[$2::uuid], null, null)`, [req.id, stray]),
            "P0001", new RegExp(`not pending in this proposal: \\['${stray}'\\]`));
        const ok = await tx(DIRECTOR, `select public.review_shift_change($1::uuid, null, null, null) j`, [req.id]);
        if (ok.rows[0].j.status !== "approved") throw new Error(ok.rows[0].j.status);
    });

    // --- the rotation generator ------------------------------------------
    const pattern = JSON.stringify([
        { shift_code: "DS", days: 4 }, { shift_code: "NS", days: 4 }, { shift_code: "B", days: 4 },
    ]);
    const codes = async (emp, from, to) =>
        (await db.query(`select shift_code from public.shift_assignments
                          where employee_id = $1 and date between $2 and $3 order by date`,
            [emp, from, to])).rows.map((r) => r.shift_code).join(",");

    await step("an employee cannot generate a pattern", async () => {
        await expectError(() => tx(U.CREW, `select public.schedules_apply_roster_pattern(
            array[$1::uuid], $2::jsonb, '2029-04-01', '2029-04-30')`, [E.CREW, pattern]),
            "PT403", /Admin only/);
    });

    await step("the generator resumes each person on the leg the roster left them on", async () => {
        // Lintang is three nights into a four-night block on 31 March.
        const r = await tx(DIRECTOR, `select public.schedules_apply_roster_pattern(
            array[$1::uuid], $2::jsonb, '2029-04-01', '2029-04-12') j`, [E.CREW, pattern]);
        if (r.rows[0].j.cells_written !== 12) throw new Error(JSON.stringify(r.rows[0].j));
        const got = await codes(E.CREW, "2029-04-01", "2029-04-12");
        if (got !== "NS,B,B,B,B,DS,DS,DS,DS,NS,NS,NS") throw new Error(got);
        const s = await db.query(`select name, status from public.work_schedules where start_date = '2029-04-01'`);
        if (s.rows[0]?.name !== "April 2029" || s.rows[0].status !== "draft") throw new Error("April not created");
    });

    await step("continue_rotation off restarts the cycle on the start date", async () => {
        await tx(DIRECTOR, `select public.schedules_apply_roster_pattern(
            array[$1::uuid], $2::jsonb, '2029-04-01', '2029-04-05', 0, true, true, false, false)`,
            [E.CREW, pattern]);
        const got = await codes(E.CREW, "2029-04-01", "2029-04-05");
        if (got !== "DS,DS,DS,DS,NS") throw new Error(got);
    });

    await step("office-day mode: weekdays only, weekends B, national holidays PH", async () => {
        await tx(DIRECTOR, `select public.schedules_create_public_holiday('2029-05-01', 'Hari Buruh', true)`);
        await tx(DIRECTOR, `select public.schedules_create_public_holiday('2029-05-02', 'Cuti Bersama Test', false)`);
        const r = await tx(DIRECTOR, `select public.schedules_apply_roster_pattern(
            array[$1::uuid], '[{"shift_code":"D","days":1}]'::jsonb, '2029-05-01', '2029-05-07',
            0, true, true, true, true) j`, [E.OFFICE]);
        if (r.rows[0].j.cells_written !== 7) throw new Error(JSON.stringify(r.rows[0].j));
        // Tue 1 PH, Wed 2 cuti bersama (a D), Thu, Fri, Sat B, Sun B, Mon D.
        const got = await codes(E.OFFICE, "2029-05-01", "2029-05-07");
        if (got !== "PH,D,D,D,B,B,D") throw new Error(got);
    });

    await step("a rotating crew keeps its shift on a holiday and earns the loading", async () => {
        await tx(DIRECTOR, `select public.schedules_apply_roster_pattern(
            array[$1::uuid], '[{"shift_code":"DS","days":1}]'::jsonb, '2029-05-01', '2029-05-03',
            0, true, true, false, false)`, [E.CREW]);
        const got = await codes(E.CREW, "2029-05-01", "2029-05-03");
        if (got !== "DS,DS,DS") throw new Error(got);
        const may = (await db.query(`select id from public.work_schedules where start_date = '2029-05-01'`)).rows[0].id;
        const w = (await detail(DIRECTOR, may)).working_days.find((x) => x.employee_id === E.CREW);
        if (w.public_holiday_loading !== 1) throw new Error(`loading ${w.public_holiday_loading}`);
    });

    await step("overwrite off skips cells that already hold a code", async () => {
        const r = await tx(DIRECTOR, `select public.schedules_apply_roster_pattern(
            array[$1::uuid], '[{"shift_code":"C","days":1}]'::jsonb, '2029-05-01', '2029-05-05',
            0, false, false, false, false) j`, [E.CREW]);
        const j = r.rows[0].j;
        if (j.cells_skipped !== 3 || j.cells_written !== 2) throw new Error(JSON.stringify(j));
    });

    // --- holiday calendar -------------------------------------------------
    await step("holiday calendar: admin only, clashes named, moved, removed", async () => {
        await expectError(() => tx(U.CREW, `select public.schedules_create_public_holiday('2029-08-17', 'X', true)`),
            "PT403", /^Only an administrator can change the holiday calendar\.$/);
        await expectError(() => tx(DIRECTOR, `select public.schedules_create_public_holiday('2029-05-01', 'Again', true)`),
            "PT409", /^Hari Buruh is already on 01 May 2029\.$/);
        const h = (await tx(DIRECTOR, `select public.schedules_create_public_holiday('2029-12-25', 'Natal', true) j`)).rows[0].j;
        const moved = (await tx(DIRECTOR, `select public.schedules_update_public_holiday($1::uuid, '{"date":"2029-12-26"}'::jsonb) j`, [h.id])).rows[0].j;
        if (moved.date !== "2029-12-26" || moved.name !== "Natal" || moved.is_national !== true)
            throw new Error(JSON.stringify(moved));
        await expectError(() => tx(DIRECTOR, `select public.schedules_update_public_holiday($1::uuid, '{"date":"2029-05-01"}'::jsonb)`, [h.id]),
            "PT409", /Hari Buruh is already on/);
        const year = (await tx(U.CREW, `select public.schedules_list_public_holidays(2029) j`)).rows[0].j;
        if (year.map((x) => x.date).join() !== "2029-05-01,2029-05-02,2029-12-26") throw new Error(JSON.stringify(year));
        await tx(DIRECTOR, `select public.schedules_delete_public_holiday($1::uuid)`, [h.id]);
        await expectError(() => tx(DIRECTOR, `select public.schedules_delete_public_holiday($1::uuid)`, [h.id]),
            "PT404", /^Not found$/);
        const log = await db.query(`select count(*)::int n from public.activity_logs
                                     where action like 'PUBLIC_HOLIDAY_%' and target_id = $1`, [h.id]);
        if (log.rows[0].n !== 3) throw new Error(`logged ${log.rows[0].n}`);
    });
};
