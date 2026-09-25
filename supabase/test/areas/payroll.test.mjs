// Payroll: the monthly run and the pay forecast.
//
// Ported from the backend's tests/test_payroll_routes.py and
// tests/test_payroll_service.py. The arithmetic cases are the *Revised PT DTG
// - Salaries 2026* workbook's own rows, so a failure here means the port and
// the sheet have stopped agreeing about somebody's pay.
//
// Every scenario builds its own "August" in its own year (2031 onwards) so
// that nothing here leans on what another scenario, or another area, left.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN, RINA } = people;
    const FINANCE = HIMAWAN;
    const EXEC = PETER;

    // --- helpers ------------------------------------------------------------
    const call = async (uid, fn, args = [], casts = []) => {
        const ph = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ""}`).join(", ");
        const r = await tx(uid, `select public.${fn}(${ph}) j`, args);
        return r.rows[0].j;
    };
    const month = (uid, id) => call(uid, "payroll_get_month", [id], ["uuid"]);
    const open = (uid, year, m, copy = true) =>
        call(uid, "payroll_create_month", [year, m, copy], ["int", "int", "boolean"]);
    const putLine = (uid, id, body) =>
        call(uid, "payroll_update_line", [id, JSON.stringify(body)], ["uuid", "jsonb"]);
    const addLine = (uid, monthId, body) =>
        call(uid, "payroll_add_line", [monthId, JSON.stringify(body)], ["uuid", "jsonb"]);
    const act = (uid, action, id) => call(uid, `payroll_${action}_month`, [id], ["uuid"]);
    const sendBack = (uid, id, note, to = "finance") =>
        call(uid, "payroll_request_changes", [id, note, to], ["uuid", "text", "text"]);

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
    const eq = (got, want, what) => {
        if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    };
    const near = (got, want, what) => {
        if (Math.abs(got - want) > 0.01) throw new Error(`${what}: expected ${want}, got ${got}`);
    };
    const line = (run, prefix) => {
        const l = run.lines.find((x) => x.person_name.startsWith(prefix));
        if (!l) throw new Error(`no line for ${prefix}`);
        return l;
    };
    const totals = (run) => Object.fromEntries(run.totals.map((t) => [t.group, t]));

    // Employees of this suite's own.
    const EMP = {
        ISABELLA: "dddddddd-0600-0000-0000-000000000001",
        NESSY: "dddddddd-0600-0000-0000-000000000002",
        NESSA: "dddddddd-0600-0000-0000-000000000003",
        FOUNDER: "dddddddd-0600-0000-0000-000000000004",
        COMP: "dddddddd-0600-0000-0000-000000000005",
    };
    await db.exec(`
        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, is_active, work_pattern, is_backup_engineer,
                                      is_management_role, kpi_review_required, bank_name)
        values
          ('${EMP.ISABELLA}','PAY-001','Isabella','Ananta','pay.isabella@dtg.test','Finance','Finance Assistant',
           '2025-08-15', false, 'office_day', false, false, true, null),
          ('${EMP.NESSY}','PAY-002','Nessy','Salsabilita','pay.nessy@dtg.test','Engineering','Business & Technical Support',
           '2025-04-01', true, 'office_day', true, false, true, null),
          ('${EMP.NESSA}','PAY-003','Nessa','Backup','pay.nessa@dtg.test','Engineering','Support',
           '2025-04-01', true, 'office_day', true, false, true, null),
          ('${EMP.FOUNDER}','PAY-004','Frank','Founder','pay.founder@dtg.test','Management','Founder',
           '2020-01-01', true, 'office_day', false, true, false, null),
          ('${EMP.COMP}','PAY-005','Comp','Person','pay.comp@dtg.test','Engineering','Engineer',
           '2024-01-01', true, 'office_day', false, false, true, 'BCA')
        on conflict (id) do nothing;
    `);

    // The August sheet's four rows, plus the optional leaver and back-up.
    const august = async (year, { isabella = false, nessy = null } = {}) => {
        const r = await db.query(
            `insert into public.payroll_months (year, month) values ($1, 8) returning id`, [year]);
        const id = r.rows[0].id;
        await db.query(`
            insert into public.payroll_lines (month_id, labour_group, row_no, person_name, base,
                health_allowance, responsibility_allowance, shift_allowance_rate, shift_days,
                public_holiday_days, public_holiday_rate_override, bonus_other, part_days, part_divisor,
                bpjs_employment, bpjs_health, income_tax)
            values
              ($1,'service',1,'LINTANG PUTRA SADEWA',20000000,1000000,0,350000,20,1,null,0,null,null,1580589,600000,5000000),
              ($1,'service',2,'ARIS KURNIA REGIANSYAH',20000000,1000000,0,350000,12,2,1333333,0,22,31,1580589,600000,5000000),
              ($1,'admin',1,'HIMAWAN PRAPTOMO',7000000,1000000,0,0,0,0,null,8000000,null,null,739200,600000,1500000),
              ($1,'admin',2,'NURHUDA SANTOSO',22000000,1000000,10000000,0,0,0,null,0,null,null,1705389,600000,5000000)`,
            [id]);
        if (isabella) {
            await db.query(`
                insert into public.payroll_lines (month_id, employee_id, labour_group, row_no, person_name,
                    base, part_days, part_divisor, bonus_other, bpjs_employment, income_tax)
                values ($1, $2, 'admin', 3, 'ISABELLA TENING ANANTA', 15000000, 10, 21, 20714288, 1268589, 976115)`,
                [id, EMP.ISABELLA]);
        }
        if (nessy) {
            const name = nessy === EMP.NESSY ? "NESSY SALSABILITA" : "NESSA BACKUP";
            await db.query(`
                insert into public.payroll_lines (month_id, employee_id, labour_group, row_no, person_name,
                    base, health_allowance, shift_allowance_rate, shift_days, bpjs_employment, bpjs_health, income_tax)
                values ($1, $2, 'service', 3, $3, 20000000, 1000000, 350000, 11, 1580589, 600000, 5000000)`,
                [id, nessy, name]);
        }
        return id;
    };

    const roster = async (employeeId, year, m, codes) => {
        const s = await db.query(`
            insert into public.work_schedules (id, name, start_date, end_date, status)
            values (gen_random_uuid(), $1, make_date($2, $3, 1), make_date($2, $3, 28), 'published')
            returning id`, [`Payroll test ${year}-${m}`, year, m]);
        for (let i = 0; i < codes.length; i++) {
            await db.query(`
                insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
                values (gen_random_uuid(), $1, $2, make_date($3, $4, $5), $6)`,
                [s.rows[0].id, employeeId, year, m, i + 1, codes[i]]);
        }
    };

    // --- the arithmetic, against the workbook ---------------------------------
    const A31 = await august(2031, { isabella: true });

    await step("payroll: a full month comes to what the sheet says", async () => {
        const l = line(await month(FINANCE, A31), "LINTANG");
        eq(l.total_shift_allowance, 7_000_000, "shift total");
        eq(l.public_holiday_rate, 1_333_333, "holiday rate");
        eq(l.public_holiday_allowance, 1_333_333, "holiday pay");
        eq(l.before_tax_and_bpjs, 29_333_333, "before tax and BPJS");
        eq(l.before_tax, 31_513_922, "before tax");
        eq(l.total_expense, 36_513_922, "total expense");
        eq(l.is_part_month, false, "part month");
    });

    await step("payroll: a typed public holiday rate wins, and the base is prorated separately", async () => {
        const l = line(await month(FINANCE, A31), "ARIS");
        eq(l.public_holiday_rate, 1_333_333, "rate");
        eq(l.public_holiday_allowance, 2_666_666, "holiday pay");
        eq(l.base, 20_000_000, "base");
        near(l.base_paid, 14_193_548.39, "base paid");
        near(l.total_expense, 29_240_803.39, "total expense");
        eq(l.is_part_month, true, "part month");
    });

    await step("payroll: the responsibility allowance is in the total", async () => {
        const l = line(await month(FINANCE, A31), "NURHUDA");
        eq(l.before_tax_and_bpjs, 33_000_000, "before tax and BPJS");
        eq(l.total_expense, 40_305_389, "total expense");
    });

    await step("payroll: only the service group carries the markup; totals count every line", async () => {
        const run = await month(FINANCE, A31);
        const t = totals(run);
        near(t.service.markup, t.service.total_expense * 0.075, "markup");
        near(t.service.invoiced, t.service.total_expense + t.service.markup, "invoiced");
        eq(t.admin.markup, null, "admin markup");
        eq(t.admin.invoiced, null, "admin invoiced");
        eq(t.admin.people, 3, "admin people");
        eq(t.admin.base, 44_000_000, "admin base");   // 7m + 22m + Isabella's 15m, nobody left out
        eq(t.service.rounded, Math.ceil(t.service.invoiced / 10000) * 10000, "service rounded");
        eq(t.admin.rounded, Math.ceil(t.admin.total_expense / 10000) * 10000, "admin rounded");
        near(run.grand_total, t.service.total_expense + t.admin.total_expense, "grand total");
        eq(run.label, "August 2031", "label");
        eq(run.days_in_month, 31, "days in month");
        eq(run.lines[0].labour_group, "service", "service first");
    });

    await step("payroll: the roundup matches Excel's ROUNDUP(x, -4)", async () => {
        const cases = [[0, 0], [144_371_679.12, 144_380_000], [136_753_617.14, 136_760_000],
                       [10_000, 10_000], [9_999.01, 10_000]];
        for (const [v, want] of cases) {
            const r = await db.query(`select public.payroll_roundup_10k($1::float8) v`, [v]);
            eq(r.rows[0].v, want, `roundup(${v})`);
        }
    });

    await step("payroll: August still shows what the leaver was paid, flagged as gone", async () => {
        const run = await month(FINANCE, A31);
        const isa = line(run, "ISABELLA");
        near(isa.total_expense, 30_101_849.14, "Isabella's total");
        eq(isa.employee_active, false, "Isabella inactive");
        eq(line(run, "HIMAWAN").employee_active, null, "no staff record stays null");
    });

    // --- who may see it -------------------------------------------------------
    await step("payroll: invisible to staff, as a 404", async () => {
        await refused(call(RINA, "payroll_list_months", [null], ["int"]), "PT404", /^Not found$/);
        await refused(month(RINA, A31), "PT404", /^Not found$/);
        await refused(open(RINA, 2031, 9), "PT404");
    });

    await step("payroll: finance and the two signatories may read it", async () => {
        for (const uid of [FINANCE, DIRECTOR, EXEC]) {
            const list = await call(uid, "payroll_list_months", [2031], ["int"]);
            const aug = list.find((m) => m.id === A31);
            if (!aug) throw new Error("August 2031 missing");
            eq(aug.people, 5, "people");
            eq(aug.label, "August 2031", "label");
        }
    });

    // --- preparing a month ----------------------------------------------------
    await step("payroll: editing a line returns the recomputed month", async () => {
        const before = totals(await month(FINANCE, A31)).service;
        const lid = line(await month(FINANCE, A31), "LINTANG").id;
        const run = await putLine(FINANCE, lid, { overtime_allowance: 1_000_000 });
        const after = totals(run).service;
        near(after.total_expense, before.total_expense + 1_000_000, "total");
        near(after.markup, after.total_expense * 0.075, "markup");
        eq(after.rounded, Math.ceil(after.invoiced / 10000) * 10000, "rounded");
        await putLine(FINANCE, lid, { overtime_allowance: 0 });
    });

    await step("payroll: an unknown field or an emptied figure is refused", async () => {
        const lid = line(await month(FINANCE, A31), "LINTANG").id;
        await refused(putLine(FINANCE, lid, { salary: 1 }), "PT422");
        await refused(putLine(FINANCE, lid, { base: null }), "PT422");
    });

    await step("payroll: the markup can be changed on a draft", async () => {
        const run = await call(FINANCE, "payroll_update_month",
            [A31, JSON.stringify({ service_markup_pct: 10 })], ["uuid", "jsonb"]);
        const t = totals(run).service;
        near(t.markup, t.total_expense * 0.1, "markup at 10%");
        await refused(call(FINANCE, "payroll_update_month",
            [A31, JSON.stringify({ service_markup_pct: 101 })], ["uuid", "jsonb"]), "PT422");
        await call(FINANCE, "payroll_update_month",
            [A31, JSON.stringify({ service_markup_pct: 7.5 })], ["uuid", "jsonb"]);
    });

    await step("payroll: a line keeps its own copy of the bank details", async () => {
        const created = await addLine(FINANCE, A31, {
            labour_group: "admin", person_name: "TEST PERSON", employee_id: EMP.COMP,
            bank_name: "BNI", bank_account_number: "111", base: 1_000_000,
        });
        eq(created.row_no, 4, "next row in admin");
        eq(created.employee_active, null, "add response carries no staff flags");
        eq(created.base_paid, 1_000_000, "derived figures on the add response");
        await db.exec(`update public.employees set bank_account_number = '999' where id = '${EMP.COMP}'`);
        const again = (await month(FINANCE, A31)).lines.find((l) => l.id === created.id);
        eq(again.bank_account_number, "111", "snapshot");
        eq(again.employee_active, true, "linked employee is active");
        await tx(FINANCE, `select public.payroll_delete_line($1::uuid)`, [created.id]);
    });

    await step("payroll: somebody with no staff record is added with a null flag", async () => {
        const agus = await addLine(FINANCE, A31, { labour_group: "admin", person_name: "AGUS SANTOSO", base: 3_000_000 });
        eq(agus.employee_active, null, "no record");
        await refused(addLine(FINANCE, A31, { labour_group: "board", person_name: "X" }), "PT422");
        await refused(addLine(FINANCE, A31, { labour_group: "admin", person_name: "" }), "PT422");
    });

    await step("payroll: a new month copies the last one without its one-offs, leavers or prorations", async () => {
        const sep = await open(FINANCE, 2031, 9);
        eq(sep.status, "draft", "status");
        eq(sep.label, "September 2031", "label");
        eq(sep.days_in_month, 30, "days");
        const him = line(sep, "HIMAWAN");
        eq(him.bonus_other, 0, "bonus not repeated");
        eq(him.base, 7_000_000, "salary repeated");
        const aris = line(sep, "ARIS");
        eq(aris.is_part_month, false, "proration dropped");
        eq(aris.base_paid, 20_000_000, "a whole month");
        if (sep.lines.some((l) => l.person_name.startsWith("ISABELLA"))) throw new Error("leaver carried");
        if (!(sep.notes ?? "").includes("Left off, no longer employed: ISABELLA TENING ANANTA."))
            throw new Error(`notes: ${sep.notes}`);
        // The cleaner, with no staff record, comes across regardless.
        line(sep, "AGUS SANTOSO");
        // Active staff not on August's run are added, with their details.
        const comp = line(sep, "Comp Person");
        eq(comp.labour_group, "admin", "office staff are admin");
        eq(comp.bank_name, "BCA", "bank copied from the record");
        eq(comp.base, 0, "pay not invented");
        if (!(sep.notes ?? "").includes("Comp Person")) throw new Error(`notes: ${sep.notes}`);
        // Founders take drawings and are left off.
        if (sep.lines.some((l) => l.person_name === "Frank Founder")) throw new Error("founder added");
        const rows = sep.lines.filter((l) => l.labour_group === "admin").map((l) => l.row_no);
        eq(new Set(rows).size, rows.length, "admin row numbers are unique");
    });

    await step("payroll: two runs for the same month are refused", async () => {
        await refused(open(FINANCE, 2031, 8, false), "PT409", /^August 2031 already exists\.$/);
        await refused(open(FINANCE, 2031, 13), "PT422");
    });

    await step("payroll: a month with nothing before it is seeded from the staff", async () => {
        const nov = await open(FINANCE, 2031, 11);
        eq(nov.status, "draft", "status");
        eq(nov.notes, null, "no notes");
        line(nov, "Comp Person");
        const blank = await open(FINANCE, 2031, 12, false);
        eq(blank.lines.length, 0, "no copy asked for, nobody on it");
    });

    await step("payroll: opening a month is logged against the caller", async () => {
        const r = await db.query(`select count(*)::int n from public.activity_logs
                                   where action = 'PAYROLL_MONTH_OPENED' and actor_id = $1
                                     and description = 'Opened the payroll run for September 2031'`, [FINANCE]);
        eq(r.rows[0].n, 1, "log rows");
    });

    await step("payroll: a proration can be set and cleared", async () => {
        const lid = line(await month(FINANCE, A31), "ARIS").id;
        let run = await putLine(FINANCE, lid, { part_days: null, part_divisor: null });
        eq(line(run, "ARIS").is_part_month, false, "cleared");
        eq(line(run, "ARIS").base_paid, 20_000_000, "whole month");
        run = await putLine(FINANCE, lid, { part_days: 15 });
        near(line(run, "ARIS").base_paid, 20_000_000 * 15 / 31, "days in the month as divisor");
    });

    // --- the back-up engineer -------------------------------------------------
    const A32 = await august(2032, { nessy: EMP.NESSY });

    await step("payroll: a back-up drops to admin with no shifts, and returns when she covers", async () => {
        const lid = line(await month(FINANCE, A32), "NESSY").id;
        let run = await putLine(FINANCE, lid, { shift_days: 0 });
        eq(line(run, "NESSY").labour_group, "admin", "moved to admin");
        eq(totals(run).service.people, 2, "service people");
        const admin = run.lines.filter((l) => l.labour_group === "admin").map((l) => l.row_no);
        eq(new Set(admin).size, admin.length, "no row clash");
        run = await putLine(FINANCE, lid, { shift_days: 14 });
        eq(line(run, "NESSY").labour_group, "service", "back to service");
        eq(line(run, "NESSY").total_shift_allowance, 350_000 * 14, "shift total");
    });

    await step("payroll: a permanent crew member is not moved by a quiet month", async () => {
        const lid = line(await month(FINANCE, A32), "LINTANG").id;
        const run = await putLine(FINANCE, lid, { shift_days: 0 });
        eq(line(run, "LINTANG").labour_group, "service", "stays service");
    });

    await step("payroll: the group can be set by hand against the rule", async () => {
        const lid = line(await month(FINANCE, A32), "NURHUDA").id;
        const run = await putLine(FINANCE, lid, { labour_group: "service" });
        eq(line(run, "NURHUDA").labour_group, "service", "moved by hand");
        const svc = run.lines.filter((l) => l.labour_group === "service").map((l) => l.row_no);
        eq(new Set(svc).size, svc.length, "no row clash");
    });

    await step("payroll: opening a month seats the back-up by her copied shifts", async () => {
        const lid = line(await month(FINANCE, A32), "NESSY").id;
        await putLine(FINANCE, lid, { shift_days: 0 });
        const sep = await open(FINANCE, 2032, 9);
        eq(line(sep, "NESSY").labour_group, "admin", "admin");
    });

    await step("payroll: a new month takes a back-up's shifts from the published roster", async () => {
        await august(2033, { nessy: EMP.NESSY });
        await roster(EMP.NESSY, 2033, 9, [...Array(6).fill("DS"), ...Array(3).fill("NS"), "B", "D", "D"]);
        const sep = await open(FINANCE, 2033, 9);
        eq(line(sep, "NESSY").shift_days, 9, "DS and NS only");
        eq(line(sep, "NESSY").labour_group, "service", "service");
    });

    await step("payroll: without a published roster the days are copied", async () => {
        await august(2034, { nessy: EMP.NESSY });
        const sep = await open(FINANCE, 2034, 9);
        eq(line(sep, "NESSY").shift_days, 11, "copied");
        eq(line(sep, "NESSY").labour_group, "service", "service");
    });

    await step("payroll: ticking the back-up flag fills the days from the roster and moves her", async () => {
        const A36 = await august(2036, { nessy: EMP.NESSA });
        const lid = line(await month(FINANCE, A36), "NESSA").id;
        await putLine(FINANCE, lid, { shift_days: 0, shift_allowance_rate: 0 });
        await db.exec(`update public.employees set is_backup_engineer = false where id = '${EMP.NESSA}'`);
        await roster(EMP.NESSA, 2036, 8, [...Array(7).fill("DS"), ...Array(4).fill("NS")]);
        const jul = await db.query(`insert into public.payroll_months (year, month, status)
                                    values (2036, 7, 'approved') returning id`);
        await db.query(`insert into public.payroll_lines (month_id, employee_id, labour_group, row_no,
                            person_name, base, shift_allowance_rate, shift_days)
                        values ($1, $2, 'service', 1, 'NESSA BACKUP', 20000000, 350000, 10)`,
                       [jul.rows[0].id, EMP.NESSA]);
        await db.exec(`update public.employees set is_backup_engineer = true where id = '${EMP.NESSA}'`);
        const l = line(await month(FINANCE, A36), "NESSA");
        eq(l.shift_days, 11, "days from the roster");
        eq(l.shift_allowance_rate, 350_000, "last rate paid");
        eq(l.labour_group, "service", "service");
        // And the approved July is a record: untouched.
        const j = await db.query(`select shift_days from public.payroll_lines where month_id = $1`, [jul.rows[0].id]);
        eq(j.rows[0].shift_days, 10, "approved month untouched");
    });

    await step("payroll: one person's months across the year", async () => {
        const list = await call(FINANCE, "payroll_person_by_month", [EMP.NESSY, 2033], ["uuid", "int"]);
        eq(list.map((m) => m.month).join(","), "8,9", "months");
        eq(list[0].people, 1, "their lines only");
        near(list[0].total_expense, 32_030_589, "their total");
        await refused(call(RINA, "payroll_person_by_month", [EMP.NESSY, 2033], ["uuid", "int"]), "PT404");
    });

    // --- the chain ------------------------------------------------------------
    await step("payroll: finance, then director, then executive", async () => {
        const id = await august(2037);
        let run = await act(FINANCE, "submit", id);
        eq(run.status, "submitted", "submitted");
        eq(run.awaiting, "director", "awaiting director");
        eq(run.is_editable, false, "locked");
        run = await act(DIRECTOR, "endorse", id);
        eq(run.status, "endorsed", "endorsed");
        eq(run.awaiting, "executive", "awaiting executive");
        run = await act(EXEC, "approve", id);
        eq(run.status, "approved", "approved");
        eq(run.awaiting, null, "awaiting nobody");
        if (!run.approved_at) throw new Error("approved_at missing");
        eq(run.is_editable, false, "locked");
        await refused(act(EXEC, "approve", id), "PT409", /^August 2037 is not waiting on a decision\.$/);
    });

    await step("payroll: a submitted month refuses every edit", async () => {
        const id = await august(2038);
        const lid = (await month(FINANCE, id)).lines[0].id;
        await act(FINANCE, "submit", id);
        const msg = /^August 2038 is with the director for review\. Ask for it to be sent back if it needs changing\.$/;
        await refused(putLine(FINANCE, lid, { base: 1 }), "PT409", msg);
        await refused(tx(FINANCE, `select public.payroll_delete_line($1::uuid)`, [lid]), "PT409", msg);
        await refused(addLine(FINANCE, id, { labour_group: "admin", person_name: "Someone New" }), "PT409", msg);
        await refused(tx(FINANCE, `select public.payroll_delete_month($1::uuid)`, [id]), "PT409", msg);
        await refused(act(FINANCE, "submit", id), "PT409");
    });

    await step("payroll: finance cannot approve its own run; the executive does not sign first", async () => {
        const id = await august(2039);
        await act(FINANCE, "submit", id);
        await refused(act(FINANCE, "endorse", id), "PT403",
            /^August 2039 is waiting on the director, not on you\.$/);
        await refused(act(EXEC, "approve", id), "PT403");
    });

    await step("payroll: sending it back needs a reason, and lets the figures move again", async () => {
        const id = await august(2040);
        await act(FINANCE, "submit", id);
        await refused(sendBack(DIRECTOR, id, ""), "PT422");
        await refused(sendBack(DIRECTOR, id, "ab"), "PT422");
        await refused(sendBack(FINANCE, id, "Not mine to send"), "PT403");
        const run = await sendBack(DIRECTOR, id, "  Aris should be a full month.  ");
        eq(run.status, "changes_requested", "status");
        eq(run.is_editable, true, "editable");
        eq(run.revision_note, "Aris should be a full month.", "note, trimmed");
        await putLine(FINANCE, run.lines[0].id, { overtime_allowance: 500_000 });
        const again = await act(FINANCE, "submit", id);
        eq(again.revision_note, null, "the note is answered on submit");
    });

    await step("payroll: the executive can send it back to the director, not the director herself", async () => {
        const id = await august(2041);
        await act(FINANCE, "submit", id);
        await refused(sendBack(DIRECTOR, id, "To myself.", "director"), "PT403",
            /^Only the executive can send a run back to the director, once the director has passed it on\.$/);
        await act(DIRECTOR, "endorse", id);
        let run = await sendBack(EXEC, id, "Check Aris's bonus with me.", "director");
        eq(run.status, "submitted", "status");
        eq(run.awaiting, "director", "awaiting director");
        eq(run.is_editable, false, "still locked");
        eq(run.revision_note, "Check Aris's bonus with me.", "note");
        eq(run.endorsed_at, null, "endorsement cleared");
        run = await act(DIRECTOR, "endorse", id);
        eq(run.awaiting, "executive", "passed on again");
        eq(run.revision_note, null, "note answered");
        await refused(sendBack(EXEC, id, "Whatever", "board"), "PT422");
    });

    await step("payroll: the executive can still send it to finance; the signatures are cleared", async () => {
        const id = await august(2042);
        await act(FINANCE, "submit", id);
        await act(DIRECTOR, "endorse", id);
        const run = await sendBack(EXEC, id, "BPJS figures are last month's.");
        eq(run.status, "changes_requested", "status");
        eq(run.is_editable, true, "editable");
        eq(run.endorsed_at, null, "endorsed_at");
        eq(run.approved_at, null, "approved_at");
    });

    await step("payroll: an approved run can be reopened by a signatory only", async () => {
        const id = await august(2043);
        await act(FINANCE, "submit", id);
        await act(DIRECTOR, "endorse", id);
        await act(EXEC, "approve", id);
        const lid = (await month(FINANCE, id)).lines[0].id;
        await refused(putLine(FINANCE, lid, { base: 1 }), "PT409",
            /^August 2043 has been approved and paid\. An approved run cannot be edited\.$/);
        await refused(sendBack(FINANCE, id, "oops"), "PT403",
            /^Only the director or the executive can reopen an approved run\.$/);
        const run = await sendBack(DIRECTOR, id, "Nessy was double counted.");
        eq(run.is_editable, true, "editable");
        eq(run.approved_at, null, "approval cleared");
    });

    await step("payroll: an empty run cannot be sent for approval, and a draft can be deleted", async () => {
        const id = await august(2044);
        for (const l of (await month(FINANCE, id)).lines) {
            await tx(FINANCE, `select public.payroll_delete_line($1::uuid)`, [l.id]);
        }
        await refused(act(FINANCE, "submit", id), "PT409", /^There is nobody on this run to approve\.$/);
        await tx(FINANCE, `select public.payroll_delete_month($1::uuid)`, [id]);
        await refused(month(FINANCE, id), "PT404");
    });

    await step("payroll: the tables are closed to direct reads", async () => {
        const r = await tx(FINANCE, `select count(*)::int n from public.payroll_lines`).catch((e) => e);
        if (!(r instanceof Error) && r.rows[0].n !== 0) throw new Error("payroll lines readable directly");
    });

    // --- the pay forecast -----------------------------------------------------
    const plan = (uid, emp, body, year = 2040) =>
        call(uid, "compensation_upsert", [emp, JSON.stringify(body), year], ["uuid", "jsonb", "int"]);
    const forecast = (uid, year = 2040) => call(uid, "compensation_list", [year], ["int"]);

    await step("compensation: management only, a 404 for everybody else", async () => {
        await refused(forecast(RINA), "PT404", /^Not found$/);
        await refused(forecast(FINANCE), "PT404");
        await refused(plan(RINA, EMP.COMP, { current_basic: 1 }), "PT404");
        await forecast(DIRECTOR);
        await forecast(EXEC);
        await db.exec(`update public.employees set is_management_role = true where user_id = '${RINA}'`);
        try {
            await forecast(RINA);
        } finally {
            await db.exec(`update public.employees set is_management_role = false where user_id = '${RINA}'`);
        }
    });

    await step("compensation: the Salary_Forecast arithmetic, on the gross", async () => {
        const row = await plan(DIRECTOR, EMP.COMP, {
            current_basic: 10_000_000, current_gross: 12_000_000, increase_pct: 10,
            additional_gross: 500_000, bpjs_employment: 400_000, bpjs_health: 100_000,
            tax_bearer: "company", income_tax: 1_000_000,
        });
        eq(row.proposed_basic, 11_000_000, "proposed basic");
        eq(row.proposed_gross, 13_500_000, "proposed gross");
        eq(row.monthly_cost, 15_000_000, "monthly");
        eq(row.annual_cost, 180_000_000, "annual");
        eq(row.annual_cost_with_bonus, 180_000_000, "with no bonus");
        eq(row.employee_name, "Comp Person", "name");
        eq(row.kpi_score, null, "no KPI figures on the PUT");
        const emp = await plan(DIRECTOR, EMP.COMP, { tax_bearer: "employee" });
        eq(emp.monthly_cost, 14_000_000, "an employee-borne tax is not a company cost");
        await plan(DIRECTOR, EMP.COMP, { tax_bearer: "company" });
    });

    await step("compensation: a bonus needs the person to be bonus-eligible", async () => {
        await refused(plan(DIRECTOR, EMP.COMP, { bonus_amount: 5_000_000 }), "PT409",
            /^Comp is not bonus-eligible\. Turn Bonus on in Settings first\.$/);
        await refused(plan(DIRECTOR, EMP.COMP, { increase_pct: 2000 }), "PT422");
        await refused(plan(DIRECTOR, EMP.COMP, { current_basic: -1 }), "PT422");
        await db.exec(`update public.employees set bonus_eligible = true where id = '${EMP.COMP}'`);
        const row = await plan(DIRECTOR, EMP.COMP, { bonus_amount: 5_000_000 });
        eq(row.annual_cost_with_bonus, 185_000_000, "a bonus is added to the year");
    });

    await step("compensation: the list reads the latest published KPI score and multiplier", async () => {
        await db.exec(`
            insert into public.kpi_reviews (id, employee_id, period_label, period_start, period_end, status)
            values ('dddddddd-0600-0000-0000-0000000000a1', '${EMP.COMP}', 'PAY-FY2039', '2039-01-01', '2039-12-31', 'published'),
                   ('dddddddd-0600-0000-0000-0000000000a2', '${EMP.COMP}', 'PAY-FY2038', '2038-01-01', '2038-12-31', 'published')
            on conflict do nothing;
            insert into public.kpi_review_items (review_id, number, name, weight, rating, is_not_applicable) values
              ('dddddddd-0600-0000-0000-0000000000a1', 'P-1', 'One', 50, 4, false),
              ('dddddddd-0600-0000-0000-0000000000a1', 'P-2', 'Two', 30, 3, false),
              ('dddddddd-0600-0000-0000-0000000000a1', 'P-3', 'Three', 20, null, true),
              ('dddddddd-0600-0000-0000-0000000000a2', 'P-1', 'One', 100, 1, false)
            on conflict do nothing;`);
        const res = await forecast(DIRECTOR);
        eq(res.year, 2040, "year");
        const row = res.items.find((r) => r.employee_id === EMP.COMP);
        if (!row) throw new Error("Comp Person missing");
        eq(row.kpi_period, "PAY-FY2039", "the latest review");
        eq(row.kpi_score, 109.38, "renormalised around the N/A line");
        eq(row.kpi_band, "Exceeds Expectations", "band");
        eq(row.kpi_multiplier, 1.25, "multiplier");
        eq(row.annual_cost_with_bonus, 185_000_000, "annual with bonus");
        eq(row.work_pattern, "office_day", "work pattern");
        if (res.items.some((r) => r.employee_id === EMP.FOUNDER)) throw new Error("founder listed");
        if (res.items.some((r) => r.employee_id === EMP.ISABELLA)) throw new Error("leaver listed");
        eq(res.totals.people, res.items.length, "people");
        near(res.totals.annual_total, res.items.reduce((s, r) => s + (r.annual_cost_with_bonus ?? 0), 0), "annual total");
        near(res.totals.office_annual + res.totals.roster_annual, res.totals.annual_total, "split");
        near(res.totals.bonus_total, res.items.reduce((s, r) => s + (r.bonus_amount ?? 0), 0), "bonus total");
    });

    await step("compensation: an exchange rate is shown only once one has been recorded", async () => {
        const before = await db.query(`select count(*)::int n from public.compensation_fx_rates`);
        if (before.rows[0].n === 0) eq((await forecast(DIRECTOR)).rate, null, "no rate invented");
        await refused(call(FINANCE, "compensation_record_rate", [12684.69, "x"], ["float8", "text"]), "PT404");
        await call(EXEC, "compensation_record_rate", [12684.689693, "Fri, 25 Sep 2026 00:02:31 +0000"], ["float8", "text"]);
        const rate = (await forecast(DIRECTOR)).rate;
        eq(rate.idr_per_aud, 12684.689693, "rate");
        eq(rate.stale, false, "fresh");
    });
};
