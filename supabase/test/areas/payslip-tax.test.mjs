// The actual PPh 21 on payslips (20260928000400_payslip_tax_actuals.sql).
//
// The payroll is approved with an estimated PPh 21; finance enters the actual
// later, and the payslip shows the actual. The tax is company-borne, so net
// pay never moves. Months here are in 2082, this suite's own.
import { inflateSync } from "node:zlib";

export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN, RINA } = people;
    const FINANCE = HIMAWAN;
    const EXEC = PETER;
    const RINA_EMP = "aaaaaaaa-0000-0000-0000-000000000001";

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
    const set = (uid, line, actual, note = null) =>
        call(uid, "payroll_tax_set", [line, actual, note], ["uuid", "numeric", "text"]);
    const clear = (uid, line) => call(uid, "payroll_tax_clear", [line], ["uuid"]);
    const slip = async (line) =>
        (await db.query(`select * from public.payslips where payroll_line_id = $1`, [line])).rows[0];
    const overviewFor = async (uid, day) => {
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

    const month = async (m, status) => {
        const r = await db.query(
            `insert into public.payroll_months (year, month, status, approved_at)
             values (2082, $1, $2::varchar, case when $2::varchar = 'approved' then now() end) returning id`,
            [m, status]);
        const id = r.rows[0].id;
        const lines = await db.query(`
            insert into public.payroll_lines (month_id, employee_id, labour_group, row_no, person_name, position,
                ptkp_status, base, health_allowance, responsibility_allowance, bpjs_employment, bpjs_health, income_tax)
            values ($1, $2, 'admin', 1, 'Rina Sari', 'Geologist', 'K/1', 22000000, 1000000, 10000000, 1705389, 600000, 5000000),
                   ($1, null, 'admin', 2, 'Guest Consultant', null, null, 5000000, 0, 0, 0, 0, 0)
            returning id, person_name`, [id, RINA_EMP]);
        return { id, rina: lines.rows.find((l) => l.person_name === "Rina Sari").id };
    };

    const SEP = await month(9, "approved");
    const OCT = await month(10, "approved");
    const DRAFT = await month(11, "draft");

    await step("tax: finance and the director set actuals; the executive reads; others 404", async () => {
        const list = await call(EXEC, "payroll_tax_list", [2082], ["int"]);
        eq(list.can_edit, false, "the executive reads only");
        eq(list.months.map((m) => m.label).join(","), "October 2082,September 2082", "approved months, newest first");
        const rina = list.months[1].lines.find((l) => l.person_name === "Rina Sari");
        eq(rina.estimate, 5000000, "estimate");
        eq(rina.actual, null, "no actual yet");
        eq(rina.slip_status, "not_issued", "no slip yet");
        eq((await call(FINANCE, "payroll_tax_list", [2082], ["int"])).can_edit, true, "finance edits");
        await refused(call(RINA, "payroll_tax_list", [2082], ["int"]), "PT404");
        await refused(set(RINA, SEP.rina, 4942754), "PT404");
        await refused(set(EXEC, SEP.rina, 4942754), "PT403");
        await refused(clear(EXEC, SEP.rina), "PT403");
        await refused(set(FINANCE, SEP.rina, -1), "PT422");
        await refused(set(FINANCE, DRAFT.rina, 4942754), "PT409");
        const row = await set(DIRECTOR, OCT.rina, 4100000);
        eq(Number(row.actual), 4100000, "the director sets one");
        eq(Number(row.difference), -900000, "difference");
    });

    await step("tax: a slip issued with the estimate says so", async () => {
        await call(DIRECTOR, "payslips_issue_now", [SEP.id, null], ["uuid", "uuid"]);
        const s = await slip(SEP.rina);
        eq(s.data.tax_is_estimate, true, "estimate");
        eq(s.data.earnings.income_tax, 5000000, "estimated tax allowance");
        eq(s.data.net_pay, 33000000, "net pay");
        const guest = (await db.query(
            `select data from public.payslips where month_id = $1 and employee_id is null`, [SEP.id])).rows[0];
        eq(guest.data.tax_is_estimate, false, "a zero estimate is not flagged");
        const list = await call(FINANCE, "payroll_tax_list", [2082], ["int"]);
        eq(list.months[1].lines.find((l) => l.person_name === "Rina Sari").slip_status, "estimate", "status");
    });

    await step("tax: setting the actual rebuilds the issued slip; net pay is unchanged", async () => {
        const before = await call(FINANCE, "payroll_get_month", [SEP.id], ["uuid"]);
        const by = (await slip(SEP.rina)).generated_by_id;
        await set(FINANCE, SEP.rina, 4942754, "From the A1 workings");
        const s = await slip(SEP.rina);
        const d = s.data;
        eq(d.tax_is_estimate, false, "actual");
        eq(d.earnings.income_tax, 4942754, "tax allowance");
        eq(d.deductions.income_tax, 4942754, "tax deduction");
        eq(d.total_earnings, 22000000 + 1000000 + 10000000 + 1705389 + 600000 + 4942754, "total earnings");
        eq(d.total_earnings, 40248143, "the sample's total");
        eq(d.total_deductions, 7248143, "total deductions");
        eq(d.net_pay, 33000000, "net pay unchanged");
        eq(s.generated_by_id, by, "still issued by whoever issued it");
        const after = await call(FINANCE, "payroll_get_month", [SEP.id], ["uuid"]);
        eq(after.grand_total, before.grand_total, "approved payroll total unchanged");
        eq(after.lines.find((l) => l.id === SEP.rina).income_tax, 5000000, "the line keeps the estimate");
        const mine = await call(RINA, "payslips_mine");
        eq(mine.find((m) => m.label === "September 2082")?.net_pay, 33000000, "Rina sees it");
        const log = await db.query(
            `select description from public.activity_logs where action = 'PAYROLL_TAX_ACTUAL_SET'
              order by created_at desc limit 1`);
        eq(log.rows[0]?.description,
            "Set the actual PPh 21 for Rina Sari, September 2082: estimate 5,000,000 -> 4,942,754", "logged");
        const list = await call(EXEC, "payroll_tax_list", [2082], ["int"]);
        eq(list.months[1].lines.find((l) => l.person_name === "Rina Sari").slip_status, "actual", "status");
    });

    await step("tax: clearing the actual returns the slip to the estimate", async () => {
        await clear(FINANCE, SEP.rina);
        const d = (await slip(SEP.rina)).data;
        eq(d.tax_is_estimate, true, "estimate again");
        eq(d.earnings.income_tax, 5000000, "estimated tax");
        eq(d.total_earnings, 40305389, "total with the estimate");
        eq(d.net_pay, 33000000, "net pay unchanged");
    });

    await step("tax: an actual for someone without a slip issues nothing, even if others have one", async () => {
        // December: only Rina's slip issued early (as Nurhuda's August was on live).
        const DEC = await month(12, "approved");
        await call(DIRECTOR, "payslips_issue_now", [DEC.id, RINA_EMP], ["uuid", "uuid"]);
        const guest = (await db.query(
            `select id from public.payroll_lines where month_id = $1 and employee_id is null`, [DEC.id])).rows[0].id;
        await set(FINANCE, guest, 100000);
        eq(await slip(guest), undefined, "setting did not issue the guest a slip");
        await clear(FINANCE, guest);
        eq(await slip(guest), undefined, "clearing did not either");
        eq((await slip(DEC.rina))?.data.person_name, "RINA SARI", "Rina's slip is untouched");
        await db.query(`delete from public.payroll_months where id = $1`, [DEC.id]);
    });

    await step("tax: an actual set before release is used when the slips go out", async () => {
        eq(await slip(OCT.rina), undefined, "October not issued");
        await call(DIRECTOR, "payslips_issue_now", [OCT.id, null], ["uuid", "uuid"]);
        const d = (await slip(OCT.rina)).data;
        eq(d.tax_is_estimate, false, "actual");
        eq(d.earnings.income_tax, 4100000, "the actual");
    });

    await step("tax: only finance previews anyone's slip of an approved month", async () => {
        const d = await call(FINANCE, "payslips_preview", [SEP.id, SEP.rina], ["uuid", "uuid"]);
        eq(d.person_name, "RINA SARI", "preview for finance");
        eq(d.issue_date, "2082-09-30", "dated the release day");
        await refused(call(EXEC, "payslips_preview", [SEP.id, SEP.rina], ["uuid", "uuid"]), "PT404");
        // The director, for now, while she reviews the screens (temporary).
        eq((await call(DIRECTOR, "payslips_preview", [SEP.id, SEP.rina], ["uuid", "uuid"])).person_name,
            "RINA SARI", "director preview");
        await refused(call(RINA, "payslips_preview", [SEP.id, SEP.rina], ["uuid", "uuid"]), "PT404");
        await refused(call(FINANCE, "payslips_preview", [DRAFT.id, DRAFT.rina], ["uuid", "uuid"]), "PT409");
        await refused(call(FINANCE, "payslips_preview", [OCT.id, SEP.rina], ["uuid", "uuid"]), "PT404");
    });

    await step("tax: finance is reminded of months still on the estimate", async () => {
        const due = async () =>
            ((await overviewFor(FINANCE, "2082-10-15")).payroll_desk.tax_actuals_due ?? [])
                .find((x) => x.label === "September 2082");
        eq((await due())?.people, 1, "September has one person on the estimate");
        const exec = await overviewFor(EXEC, "2082-10-15");
        eq(exec.payroll_desk, null, "finance only");
        await set(FINANCE, SEP.rina, 4942754);
        eq(await due(), undefined, "gone once entered");
    });

    await step("tax: the PDF marks an estimate, and only an estimate", async () => {
        const { fillPayslip, ESTIMATE_NOTE } = await import(
            new URL("../../../src/lib/payslipPdf.ts", import.meta.url));
        const tpl = (await db.query(`select pdf from public.payslip_template where id = 1`)).rows[0].pdf;
        const actual = (await slip(SEP.rina)).data;
        const estimate = { ...actual, tax_is_estimate: true };
        const a = drawnText(await fillPayslip(tpl, actual));
        const e = drawnText(await fillPayslip(tpl, estimate));
        eq(a.includes(" (estimate)"), false, "nothing on an actual");
        eq(a.includes(ESTIMATE_NOTE), false, "no note on an actual");
        // Deductions label has room for the word; the earnings one gets an asterisk.
        eq(e.filter((t) => t === " (estimate)").length, 1, "deductions label");
        eq(e.filter((t) => t === "*").length, 1, "earnings asterisk");
        eq(e.includes("* " + ESTIMATE_NOTE), true, "the note, starred");
    });

    for (const m of [SEP, OCT, DRAFT]) {
        await db.query(`delete from public.payroll_months where id = $1`, [m.id]);
    }
};

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
