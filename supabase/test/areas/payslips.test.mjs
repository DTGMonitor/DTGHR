// Payslips: issued from the approved payroll at the month's release moment.
//
// Every month here is in 2079-2081, and the suite moves the settings' start
// month to January 2080 for its duration, so the scheduled run only ever
// considers this suite's months (and restores the settings at the end).
import { inflateSync } from "node:zlib";

export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN, RINA } = people;
    const FINANCE = HIMAWAN;
    const EXEC = PETER;
    const BUDI = "33333333-3333-3333-3333-333333333333";
    const RINA_EMP = "aaaaaaaa-0000-0000-0000-000000000001";
    const BUDI_EMP = "aaaaaaaa-0000-0000-0000-000000000002";

    const call = async (uid, fn, args = [], casts = []) => {
        const ph = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ""}`).join(", ");
        const r = await tx(uid, `select public.${fn}(${ph}) j`, args);
        return r.rows[0].j;
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
    const eq = (got, want, what) => {
        if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    };
    const utc = async (sql, params = []) =>
        (await db.query(`select to_char((${sql}) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') t`, params)).rows[0].t;
    const due = async (at) =>
        (await db.query(`select public.payslips_generate_due($1::timestamptz) n`, [at])).rows[0].n;
    const settings = (uid, body) =>
        call(uid, "payslips_settings_update", [JSON.stringify(body)], ["jsonb"]);
    const slipsOf = async (monthId) =>
        (await db.query(`select * from public.payslips where month_id = $1`, [monthId])).rows;

    const saved = (await db.query(`select * from public.payslip_settings where id = 1`)).rows[0];
    await db.query(`update public.payslip_settings set start_month = '2080-01-01', release_day = null,
                        release_time = '23:59', auto_enabled = true where id = 1`);

    // A month with three lines: Rina (a part month with shifts, a holiday,
    // overtime and a bonus), Budi, and a name with no staff record.
    const openMonth = async (year, month, status) => {
        const r = await db.query(
            `insert into public.payroll_months (year, month, status, approved_at)
             values ($1, $2, $3::varchar, case when $3::varchar = 'approved' then now() end) returning id`,
            [year, month, status]);
        const id = r.rows[0].id;
        await db.query(`
            insert into public.payroll_lines (month_id, employee_id, labour_group, row_no, person_name, position,
                ptkp_status, base, health_allowance, responsibility_allowance, shift_allowance_rate, shift_days,
                overtime_allowance, public_holiday_days, bonus_other, part_days, part_divisor,
                bpjs_employment, bpjs_health, income_tax)
            values
              ($1, $2, 'service', 1, 'Rina Sari', 'Geologist', 'TK/0', 20000000, 1000000, 0, 350000, 20,
               250000, 1, 500000, 22, 31, 1580589, 600000, 5000000),
              ($1, $3, 'admin', 1, 'Budi Santoso', 'Technician', 'K/1', 9000000, 1000000, 0, 0, 0,
               0, 0, 0, null, null, 739200, 600000, 1500000),
              ($1, null, 'admin', 2, 'Guest Consultant', null, null, 5000000, 0, 0, 0, 0,
               0, 0, 0, null, null, 0, 0, 0)`,
            [id, RINA_EMP, BUDI_EMP]);
        return id;
    };
    const approve = (id) =>
        db.query(`update public.payroll_months set status = 'approved', approved_at = now() where id = $1`, [id]);
    const sendBack = (id) =>
        db.query(`update public.payroll_months set status = 'changes_requested', approved_at = null where id = $1`, [id]);

    // --- the release moment ----------------------------------------------

    await step("payslips: release defaults to the month's last day at 23:59 WIB", async () => {
        eq(await utc(`public.payslips_release_at(2080, 9)`), "2080-09-30 16:59", "September");
        eq(await utc(`public.payslips_release_at(2080, 2)`), "2080-02-29 16:59", "leap February");
        eq(await utc(`public.payslips_release_at(2081, 1)`), "2081-01-31 16:59", "January");
    });

    await step("payslips: day 31 clamps to a 30-day month's last day", async () => {
        await settings(DIRECTOR, { release_day: 31 });
        eq(await utc(`public.payslips_release_at(2080, 9)`), "2080-09-30 16:59", "September");
        eq(await utc(`public.payslips_release_at(2080, 10)`), "2080-10-31 16:59", "October");
    });

    await step("payslips: a set day and time are Jakarta time", async () => {
        await settings(DIRECTOR, { release_day: 25, release_time: "08:00" });
        eq(await utc(`public.payslips_release_at(2080, 9)`), "2080-09-25 01:00", "25th 08:00");
        await settings(DIRECTOR, { release_day: 1, release_time: "06:00" });
        eq(await utc(`public.payslips_release_at(2080, 9)`), "2080-08-31 23:00", "1st 06:00 WIB");
        const s = await settings(DIRECTOR, { release_day: null, release_time: "23:59" });
        eq(s.release_day, null, "back to the last day");
        eq(s.release_time, "23:59", "back to 23:59");
    });

    await step("payslips: only the director changes the settings", async () => {
        await refused(settings(FINANCE, { release_day: 5 }), "PT403");
        await refused(settings(EXEC, { release_day: 5 }), "PT403");
        await refused(settings(RINA, { release_day: 5 }), "PT403");
        await refused(settings(DIRECTOR, { release_day: 32 }), "PT422");
        await refused(settings(DIRECTOR, { release_day: 0 }), "PT422");
        await refused(settings(DIRECTOR, { release_time: "25:00" }), "PT422");
        await refused(settings(DIRECTOR, { start_month: "2020-01-01" }), "PT422");
        const s = await call(FINANCE, "payslips_settings_get");
        eq(s.auto_enabled, true, "finance reads them");
        if (!s.next_release?.release_at) throw new Error("no next release");
        await refused(call(RINA, "payslips_settings_get"), "PT404");
    });

    // --- the scheduled run -----------------------------------------------

    const SEP = await openMonth(2080, 9, "approved");
    const BEFORE_START = await openMonth(2079, 12, "approved");
    const DRAFT = await openMonth(2080, 10, "draft");
    const SUBMITTED = await openMonth(2080, 11, "submitted");

    await step("payslips: nothing is issued before the release moment", async () => {
        eq(await due("2080-09-30 16:58:59+00"), 0, "a minute early");
        eq((await slipsOf(SEP)).length, 0, "September slips");
    });

    await step("payslips: everything is issued once the release moment passes", async () => {
        eq(await due("2080-09-30 16:59:00+00"), 3, "slips written");
        const rows = await slipsOf(SEP);
        eq(rows.length, 3, "one per line");
        eq(rows.every((r) => r.generated_by_id === null), true, "issued by the schedule");
        const dates = await db.query(
            `select distinct to_char(issue_date, 'YYYY-MM-DD') d, data ->> 'issue_date' j
               from public.payslips where month_id = $1`, [SEP]);
        eq(dates.rows.length, 1, "one issue date");
        eq(dates.rows[0].d, "2080-09-30", "dated the release day");
        eq(dates.rows[0].j, "2080-09-30", "and so is the snapshot");
        eq(await due("2080-09-30 17:30:00+00"), 0, "a second run writes nothing");
    });

    await step("payslips: months before the start month, drafts and submitted runs are left alone", async () => {
        eq(await due("2081-06-01 00:00:00+00"), 0, "nothing else due");
        eq((await slipsOf(BEFORE_START)).length, 0, "before the start month");
        eq((await slipsOf(DRAFT)).length, 0, "draft");
        eq((await slipsOf(SUBMITTED)).length, 0, "submitted");
    });

    await step("payslips: nothing is issued automatically while release is switched off", async () => {
        const OFF = await openMonth(2080, 12, "approved");
        await settings(DIRECTOR, { auto_enabled: false });
        eq(await due("2081-06-01 00:00:00+00"), 0, "switched off");
        await settings(DIRECTOR, { auto_enabled: true });
        eq(await due("2081-06-01 00:00:00+00"), 3, "switched back on");
        await db.query(`delete from public.payroll_months where id = $1`, [OFF]);
    });

    // --- the figures -----------------------------------------------------

    await step("payslips: a slip's figures are the payroll line's", async () => {
        const run = await call(FINANCE, "payroll_get_month", [SEP], ["uuid"]);
        const line = run.lines.find((l) => l.person_name === "Rina Sari");
        const slip = (await slipsOf(SEP)).find((r) => r.employee_id === RINA_EMP);
        const d = slip.data;
        const e = d.earnings;
        const rp = (x) => Math.round(x);
        eq(d.period_label, "September 2080", "period");
        eq(d.person_name, "RINA SARI", "name in capitals");
        eq(d.position, "GEOLOGIST", "position in capitals");
        eq(d.tax_bearer, "TK/0", "tax bearer");
        eq(d.file_name, "Payslip September 2080 - Rina.pdf", "file name");
        eq(e.base.rate, 20000000, "base rate is the full month");
        eq(e.base.unit, "22/31", "part month");
        eq(e.base.amount, rp(line.base_paid), "base paid");
        eq(e.base.amount, 14193548, "base paid, by hand");
        eq(e.shift.rate, 350000, "shift rate");
        eq(e.shift.unit, "20", "shift days");
        eq(e.shift.amount, rp(line.total_shift_allowance), "shift total");
        eq(e.overtime.amount, 250000, "overtime");
        eq(e.overtime.unit, "1", "overtime unit");
        eq(e.health.amount, 1000000, "health");
        eq(e.responsibility.amount, 0, "no responsibility allowance");
        eq(e.responsibility.unit, "0", "zero unit");
        eq(e.others, rp(line.public_holiday_allowance + line.bonus_other), "holiday pay and bonus");
        const earned = e.base.amount + e.health.amount + e.responsibility.amount + e.shift.amount
            + e.overtime.amount + e.bpjs_employment + e.bpjs_health + e.income_tax + e.others;
        eq(d.total_earnings, earned, "total earnings");
        eq(d.total_deductions, 1580589 + 600000 + 5000000, "total deductions");
        eq(d.net_pay, d.total_earnings - d.total_deductions, "net pay");

        const guest = (await slipsOf(SEP)).find((r) => r.employee_id === null);
        eq(guest.data.first_name, "Guest", "first name from the sheet");
        eq(guest.data.earnings.shift.unit, "0", "no shifts");
        eq(guest.data.earnings.others, 0, "nothing else");
    });

    // --- who sees what ----------------------------------------------------

    const slipIds = async () => {
        const rows = await slipsOf(SEP);
        return {
            rina: rows.find((r) => r.employee_id === RINA_EMP).id,
            budi: rows.find((r) => r.employee_id === BUDI_EMP).id,
        };
    };

    await step("payslips: an employee sees only their own slips", async () => {
        const ids = await slipIds();
        const mine = await call(RINA, "payslips_mine");
        eq(mine.length, 1, "Rina's slips");
        eq(mine[0].id, ids.rina, "her own");
        eq(mine[0].label, "September 2080", "label");
        eq(mine[0].issue_date, "2080-09-30", "issue date");
        const own = await call(RINA, "payslips_get", [ids.rina], ["uuid"]);
        eq(own.data.person_name, "RINA SARI", "her slip");
        await refused(call(RINA, "payslips_get", [ids.budi], ["uuid"]), "PT404");
        await refused(call(BUDI, "payslips_get", [ids.rina], ["uuid"]), "PT404");
        await refused(call(RINA, "payslips_for_month", [SEP], ["uuid"]), "PT404");
    });

    await step("payslips: finance, the director and the executive read any slip", async () => {
        const ids = await slipIds();
        for (const uid of [FINANCE, DIRECTOR, EXEC]) {
            const s = await call(uid, "payslips_get", [ids.budi], ["uuid"]);
            eq(s.data.person_name, "BUDI SANTOSO", `slip for ${uid}`);
        }
        const m = await call(FINANCE, "payslips_for_month", [SEP], ["uuid"]);
        eq(m.issued, true, "issued");
        eq(m.issue_date, "2080-09-30", "issue date");
        eq(m.slips.length, 3, "every slip listed");
    });

    await step("payslips: the template is for payroll viewers and people with a slip", async () => {
        const b64 = await call(RINA, "payslips_template");
        if (!b64.startsWith("JVBER")) throw new Error("not a PDF");
        await call(FINANCE, "payslips_template");
        // The executive has no payroll line of his own but reads payroll.
        await call(EXEC, "payslips_template");
    });

    await step("payslips: a month sent back hides its slips until it is re-issued", async () => {
        const ids = await slipIds();
        await sendBack(SEP);
        eq((await call(RINA, "payslips_mine")).length, 0, "hidden while sent back");
        await refused(call(RINA, "payslips_get", [ids.rina], ["uuid"]), "PT404");
        await refused(call(RINA, "payslips_template"), "PT404");
        await call(FINANCE, "payslips_get", [ids.rina], ["uuid"]);

        // Corrected and approved again: still hidden -- the slips predate it.
        await db.query(`update public.payroll_lines set part_days = null, part_divisor = null
                         where month_id = $1 and employee_id = $2`, [SEP, RINA_EMP]);
        await approve(SEP);
        eq((await call(RINA, "payslips_mine")).length, 0, "stale slips stay hidden");
        eq((await call(FINANCE, "payslips_for_month", [SEP], ["uuid"])).issued, false, "not issued yet");

        // The next run after the (long passed) release moment rebuilds them.
        eq(await due("2081-01-01 00:00:00+00"), 3, "rebuilt");
        const mine = await call(RINA, "payslips_mine");
        eq(mine.length, 1, "visible again");
        const s = await call(RINA, "payslips_get", [mine[0].id], ["uuid"]);
        eq(s.data.earnings.base.unit, "1", "the corrected figures");
        eq(s.data.earnings.base.amount, 20000000, "full month now");
    });

    await step("payslips: a user with no slips who is not a payroll viewer gets no template", async () => {
        await db.query(`delete from public.payslips where employee_id = $1`, [BUDI_EMP]);
        await refused(call(BUDI, "payslips_template"), "PT404");
        eq((await call(BUDI, "payslips_mine")).length, 0, "no slips");
    });

    await step("payslips: only the director issues now, and only for an approved month", async () => {
        await refused(call(FINANCE, "payslips_issue_now", [SEP, null], ["uuid", "uuid"]), "PT403");
        await refused(call(EXEC, "payslips_issue_now", [SEP, null], ["uuid", "uuid"]), "PT403");
        await refused(call(RINA, "payslips_issue_now", [SEP, null], ["uuid", "uuid"]), "PT403");
        await refused(call(DIRECTOR, "payslips_issue_now", [DRAFT, null], ["uuid", "uuid"]), "PT409",
            /Only an approved payroll month has payslips\./);

        // Before its release moment, on the director's say-so.
        const NOV = await openMonth(2081, 11, "approved");
        const one = await call(DIRECTOR, "payslips_issue_now", [NOV, BUDI_EMP], ["uuid", "uuid"]);
        eq(one.slips.length, 1, "just Budi's");
        eq(one.issue_date, "2081-11-30", "dated the release day");
        const all = await call(DIRECTOR, "payslips_issue_now", [NOV, null], ["uuid", "uuid"]);
        eq(all.slips.length, 3, "the whole month");
        const rows = await slipsOf(NOV);
        eq(rows.every((r) => r.generated_by_id === DIRECTOR), true, "issued by the director");
        const log = await db.query(
            `select description from public.activity_logs where action = 'PAYSLIPS_ISSUED' and target_id = $1
              order by created_at desc limit 1`, [NOV]);
        eq(log.rows[0]?.description, "Issued 3 payslips for November 2081", "logged");
        await db.query(`delete from public.payroll_months where id = $1`, [NOV]);
    });

    // --- the PDF -------------------------------------------------------------

    await step("payslips: the PDF carries the sample's figures", async () => {
        // The August 2026 sample's own line, through the database's arithmetic.
        const r = await db.query(
            `insert into public.payroll_months (year, month, status, approved_at)
             values (2081, 8, 'approved', now()) returning id`);
        const AUG = r.rows[0].id;
        await db.query(`
            insert into public.payroll_lines (month_id, labour_group, row_no, person_name, position, ptkp_status,
                base, health_allowance, responsibility_allowance, bpjs_employment, bpjs_health, income_tax)
            values ($1, 'admin', 1, 'Nurhuda Santoso', 'Engineer', 'K/1',
                    22000000, 1000000, 10000000, 1705389, 600000, 4942754)`, [AUG]);
        await call(DIRECTOR, "payslips_issue_now", [AUG, null], ["uuid", "uuid"]);
        const d = (await slipsOf(AUG))[0].data;
        eq(d.total_earnings, 40248143, "total earnings");
        eq(d.total_deductions, 7248143, "total deductions");
        eq(d.net_pay, 33000000, "net pay");
        eq(d.file_name, "Payslip August 2081 - Nurhuda.pdf", "file name");

        const { fillPayslip, ordinalSuffix, formatAmount } = await import(
            new URL("../../../src/lib/payslipPdf.ts", import.meta.url));
        const suffixes = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30, 31].map(ordinalSuffix).join(" ");
        eq(suffixes, "st nd rd th th th th st nd rd th st", "ordinals");
        eq(formatAmount(1705389.5), "1,705,390", "half-up rounding");

        const tpl = (await db.query(`select pdf from public.payslip_template where id = 1`)).rows[0].pdf;
        const bytes = await fillPayslip(tpl, d);
        const text = drawnText(bytes);
        for (const want of ["August 2081", "NURHUDA SANTOSO", "ENGINEER", "K/1", "22,000,000", "10,000,000",
                            "1,705,389", "600,000", "4,942,754", "40,248,143", "(7,248,143)", "33,000,000",
                            "August 31", "st", ", 2081"]) {
            if (!text.includes(want)) throw new Error(`the PDF does not say ${want}`);
        }
        await db.query(`delete from public.payroll_months where id = $1`, [AUG]);
    });

    // Put the settings back as they were.
    await db.query(
        `update public.payslip_settings set auto_enabled = $1, release_day = $2, release_time = $3,
                start_month = $4 where id = 1`,
        [saved.auto_enabled, saved.release_day, saved.release_time, saved.start_month]);
    for (const id of [SEP, BEFORE_START, DRAFT, SUBMITTED]) {
        await db.query(`delete from public.payroll_months where id = $1`, [id]);
    }
};

// The strings pdf-lib drew: its content streams are deflated, and standard
// fonts write each string as `<hex> Tj`.
function drawnText(bytes) {
    const pdf = Buffer.from(bytes).toString("latin1");
    const out = [];
    const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m;
    while ((m = re.exec(pdf))) {
        let body;
        try {
            body = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
        } catch {
            body = m[1];
        }
        for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
            out.push(Buffer.from(t[1], "hex").toString("latin1"));
        }
    }
    return out;
}
