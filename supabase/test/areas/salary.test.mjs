// Salary: reviews, the KPI summary, the band table, and the CPI / AUD->IDR year.
// Ported from the backend's tests/test_salary_kpi_summary.py and
// tests/test_salary_guidance.py, plus the review chain in routes/salary.py.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN, RINA } = people;

    // Our own people. Lina is assessed; Mark is a founder (not assessed).
    const LINA = "aaaaaaaa-0000-0000-0700-000000000001";
    const OMAR = "aaaaaaaa-0000-0000-0700-000000000002";
    const MARK = "aaaaaaaa-0000-0000-0700-000000000003";
    const PETER_EMP = "aaaaaaaa-0000-0000-0000-00000000000e";
    const KPI = "aaaaaaaa-0000-0000-0701-000000000001";

    await db.exec(`
        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance) values
          ('${LINA}','SAL-001','Lina','Salaria','lina.salary@dtgeotech.com','Ops','Engineer','2024-01-02',0),
          ('${OMAR}','SAL-002','Omar','Salaria','omar.salary@dtgeotech.com','Ops','Engineer','2024-01-02',0),
          ('${MARK}','SAL-003','Mark','Founder','mark.salary@dtgeotech.com','Management','Director','2024-01-02',0);
        update public.employees set is_management_role = true, kpi_review_required = false,
               kpi_exemption_reason = 'Founder' where id = '${MARK}';
    `);

    const expectErr = async (fn, code, re) => {
        try {
            await fn();
        } catch (e) {
            if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
            if (re && !re.test(e.message)) throw new Error(`wrong message: ${e.message}`);
            return;
        }
        throw new Error(`expected ${code} ${re ?? ""}`);
    };
    const j = async (uid, sql, params) => (await tx(uid, sql, params)).rows[0].j;
    const summaryRow = async (uid, id) => {
        const s = await j(uid, `select public.salary_kpi_summary() j`);
        return s.items.find((r) => r.employee_id === id);
    };
    const draft = (emp, current = 10_000_000, proposed = 10_500_000) =>
        j(DIRECTOR, `select public.salary_create_review($1::jsonb) j`, [JSON.stringify({
            employee_id: emp, effective_date: "2027-01-01",
            current_amount: current, proposed_amount: proposed, rationale: "Band 2M",
        })]);

    // ── Who may see ─────────────────────────────────────────────────────
    await step("finance and staff are answered 404 on every salary function", async () => {
        for (const who of [HIMAWAN, RINA]) {
            for (const sql of [
                `select public.salary_list_reviews()`,
                `select public.salary_kpi_summary()`,
                `select public.salary_guidance_data()`,
                `select public.salary_annual_average(null)`,
                `select public.salary_guidance_missing(null)`,
                `select public.salary_upsert_indicator('cpi_yoy','2026-08-01',1,null)`,
                `select public.salary_set_band_increases('{"1":1}'::jsonb)`,
            ]) {
                await expectErr(() => tx(who, sql), "PT404", /^Not found$/);
            }
            await expectErr(() => tx(who, `select public.salary_create_review('{}'::jsonb)`), "PT404");
        }
    });

    await step("the tables are closed to direct reads", async () => {
        await draft(OMAR);
        const r = await tx(DIRECTOR, `select count(*)::int n from public.salary_reviews`).catch(() => ({ rows: [{ n: 0 }] }));
        if (r.rows[0].n !== 0) throw new Error(`read ${r.rows[0].n} rows past RLS`);
        await db.query(`delete from public.salary_reviews where employee_id = $1`, [OMAR]);
    });

    // ── The review chain ────────────────────────────────────────────────
    let reviewId;
    await step("a figure that differs needs a rationale", async () => {
        await expectErr(() => tx(DIRECTOR, `select public.salary_create_review($1::jsonb)`, [JSON.stringify({
            employee_id: LINA, effective_date: "2027-01-01", current_amount: 1, proposed_amount: 2,
        })]), "PT422", /Give a rationale/);
    });

    await step("the director drafts; the draft is hers alone", async () => {
        const r = await draft(LINA);
        reviewId = r.id;
        if (r.status !== "draft" || r.awaiting_role !== null) throw new Error(JSON.stringify(r));
        if (r.employee_name !== "Lina Salaria" || r.currency !== "IDR") throw new Error(JSON.stringify(r));
        if (r.proposed_amount !== 10_500_000) throw new Error(`amount ${r.proposed_amount}`);
        const mine = await j(DIRECTOR, `select public.salary_list_reviews() j`);
        if (!mine.items.some((i) => i.id === reviewId)) throw new Error("author cannot see her draft");
        if (!mine.can_prepare || mine.can_approve || mine.can_endorse) throw new Error(JSON.stringify(mine));
        const peter = await j(PETER, `select public.salary_list_reviews() j`);
        if (peter.items.some((i) => i.id === reviewId)) throw new Error("executive saw a draft");
        if (peter.can_prepare || !peter.can_approve) throw new Error(JSON.stringify(peter));
    });

    await step("the author edits a draft, only the fields sent", async () => {
        const r = await j(DIRECTOR, `select public.salary_update_review($1::uuid, $2::jsonb) j`,
            [reviewId, JSON.stringify({ proposed_amount: 10_600_000 })]);
        if (r.proposed_amount !== 10_600_000 || r.rationale !== "Band 2M") throw new Error(JSON.stringify(r));
        await expectErr(() => tx(PETER, `select public.salary_update_review($1::uuid, '{}'::jsonb)`, [reviewId]),
            "PT409", /cannot be edited at its current step/);
    });

    await step("the executive cannot approve a draft; the director cannot approve at all", async () => {
        await expectErr(() => tx(PETER, `select public.salary_approve_review($1::uuid, null)`, [reviewId]),
            "PT409", /has not been endorsed yet/);
        await expectErr(() => tx(DIRECTOR, `select public.salary_approve_review($1::uuid, null)`, [reviewId]),
            "PT404", /Not found/);
    });

    await step("submitted, it waits on the executive", async () => {
        const r = await j(DIRECTOR, `select public.salary_submit_review($1::uuid) j`, [reviewId]);
        if (r.status !== "submitted" || r.awaiting_role !== "executive" || !r.submitted_at) throw new Error(JSON.stringify(r));
        await expectErr(() => tx(DIRECTOR, `select public.salary_submit_review($1::uuid)`, [reviewId]),
            "PT409", /already been submitted/);
        const peter = await j(PETER, `select public.salary_list_reviews() j`);
        if (peter.awaiting_me !== 1) throw new Error(`awaiting_me ${peter.awaiting_me}`);
        await expectErr(() => tx(DIRECTOR, `select public.salary_update_review($1::uuid, '{}'::jsonb)`, [reviewId]),
            "PT409");
    });

    await step("a decline needs a reason and returns it to draft", async () => {
        await expectErr(() => tx(DIRECTOR, `select public.salary_decline_review($1::uuid, 'no')`, [reviewId]),
            "PT409", /not waiting on you/);
        await expectErr(() => tx(HIMAWAN, `select public.salary_decline_review($1::uuid, 'no')`, [reviewId]),
            "PT404", /not waiting on you/);
        await expectErr(() => tx(PETER, `select public.salary_decline_review($1::uuid, '  ')`, [reviewId]),
            "PT422", /Say why/);
        const r = await j(PETER, `select public.salary_decline_review($1::uuid, 'Too early') j`, [reviewId]);
        if (r.status !== "draft" || r.decline_reason !== "Too early" || r.submitted_at !== null) throw new Error(JSON.stringify(r));
        const again = await j(DIRECTOR, `select public.salary_submit_review($1::uuid) j`, [reviewId]);
        if (again.decline_reason !== null) throw new Error("resubmission kept the old reason");
    });

    await step("the executive approves; then nobody edits or discards it", async () => {
        const r = await j(PETER, `select public.salary_approve_review($1::uuid, null) j`, [reviewId]);
        if (r.status !== "approved" || r.awaiting_role !== null || !r.approved_at) throw new Error(JSON.stringify(r));
        await expectErr(() => tx(DIRECTOR, `select public.salary_update_review($1::uuid, '{}'::jsonb)`, [reviewId]), "PT409");
        await expectErr(() => tx(DIRECTOR, `select public.salary_delete_review($1::uuid)`, [reviewId]),
            "PT409", /Only a draft can be discarded/);
        const log = await db.query(`select count(*)::int n from public.activity_logs
                                     where target_id = $1 and action like 'SALARY_REVIEW_%'`, [reviewId]);
        if (log.rows[0].n < 4) throw new Error(`logged ${log.rows[0].n}`);
    });

    await step("nobody signs their own review", async () => {
        const r = await draft(PETER_EMP);
        await j(DIRECTOR, `select public.salary_submit_review($1::uuid) j`, [r.id]);
        const peter = await j(PETER, `select public.salary_list_reviews() j`);
        if (peter.awaiting_me !== 0) throw new Error("his own review counted as waiting on him");
        await expectErr(() => tx(PETER, `select public.salary_approve_review($1::uuid, null)`, [r.id]),
            "PT403", /cannot sign off your own salary review/);
        await expectErr(() => tx(PETER, `select public.salary_decline_review($1::uuid, 'x')`, [r.id]),
            "PT403", /cannot sign off your own/);
        await db.query(`delete from public.salary_reviews where id = $1`, [r.id]);
    });

    await step("the director discards a draft; nobody else may", async () => {
        const r = await draft(OMAR);
        await expectErr(() => tx(PETER, `select public.salary_delete_review($1::uuid)`, [r.id]), "PT404");
        await tx(DIRECTOR, `select public.salary_delete_review($1::uuid)`, [r.id]);
        const n = await db.query(`select count(*)::int n from public.salary_reviews where id = $1`, [r.id]);
        if (n.rows[0].n !== 0) throw new Error("not deleted");
    });

    // ── KPI summary ─────────────────────────────────────────────────────
    await step("no scorecard means an empty recommendation", async () => {
        const row = await summaryRow(DIRECTOR, OMAR);
        if (!row) throw new Error("Omar missing");
        if (row.kpi_review_id !== null || row.recommended_increase_pct !== null || row.recommendation_note !== null)
            throw new Error(JSON.stringify(row));
        if (row.max_score !== 130 || row.is_complete !== false || row.critical_gate_cleared !== true)
            throw new Error(JSON.stringify(row));
    });

    await step("founders are left out of the summary", async () => {
        const s = await j(DIRECTOR, `select public.salary_kpi_summary() j`);
        if (s.items.some((r) => r.employee_id === MARK)) throw new Error("founder listed");
    });

    await db.exec(`
        insert into public.kpi_reviews (id, employee_id, period_label, period_start, period_end, status,
                                        assessor_id, current_basic_salary)
        values ('${KPI}', '${OMAR}', '2026', '2026-01-01', '2026-12-31', 'draft', '${PETER}', 12000000);
        insert into public.kpi_review_items (review_id, number, name, weight, rating, sort_order)
        select '${KPI}', n::text, 'KPI ' || n, 10, 3, n from generate_series(1, 10) n;
    `);

    await step("nothing is recommended before the scorecard is approved", async () => {
        const row = await summaryRow(DIRECTOR, OMAR);
        if (row.kpi_review_id !== KPI || row.is_complete !== true) throw new Error(JSON.stringify(row));
        if (row.recommended_increase_pct !== null || !/approved/.test(row.recommendation_note))
            throw new Error(JSON.stringify(row));
    });

    await step("the old scorecard salary is the starting figure", async () => {
        const row = await summaryRow(PETER, OMAR);
        if (row.current_salary !== 12_000_000) throw new Error(`got ${row.current_salary}`);
    });

    await db.exec(`update public.kpi_reviews set status = 'approved' where id = '${KPI}'`);

    await step("an approved scorecard gets its band's increase", async () => {
        const row = await summaryRow(DIRECTOR, OMAR);
        if (row.total_score !== 100 || row.band_code !== "2M" || row.band_label !== "Meets Expectations")
            throw new Error(JSON.stringify(row));
        if (row.recommended_increase_pct !== 3) throw new Error(`pct ${row.recommended_increase_pct}`);
        if (row.recommendation_note !== "Band 2M (Meets Expectations)") throw new Error(row.recommendation_note);
        if ("multiplier" in row) throw new Error("multiplier leaked");
        if (row.can_edit_gate !== false) throw new Error("the director is not this card's assessor");
        const peter = await summaryRow(PETER, OMAR);
        if (peter.can_edit_gate !== true) throw new Error("the assessor may set the gate");
    });

    await step("the band table is applied as set", async () => {
        const out = await j(PETER, `select public.salary_set_band_increases($1::jsonb) j`,
            [JSON.stringify({ "1": 2, "2L": 2, "2M": 4, "2H": 6, "3": 8 })]);
        if (out.band_increases["2M"] !== 4) throw new Error(JSON.stringify(out));
        const row = await summaryRow(DIRECTOR, OMAR);
        if (row.recommended_increase_pct !== 4) throw new Error(`pct ${row.recommended_increase_pct}`);
    });

    await step("a serious violation or a hard gate blocks the increase", async () => {
        await db.exec(`update public.kpi_reviews set critical_gate_cleared = false where id = '${KPI}'`);
        let row = await summaryRow(DIRECTOR, OMAR);
        if (row.recommended_increase_pct !== null || !/Serious violation/.test(row.recommendation_note))
            throw new Error(JSON.stringify(row));
        await db.exec(`update public.kpi_reviews set critical_gate_cleared = true, hard_gate_triggered = true where id = '${KPI}'`);
        row = await summaryRow(DIRECTOR, OMAR);
        if (row.recommended_increase_pct !== null || !/Hard gate raised/.test(row.recommendation_note))
            throw new Error(JSON.stringify(row));
        await db.exec(`update public.kpi_reviews set hard_gate_triggered = false where id = '${KPI}'`);
    });

    await step("scoring renormalises around N/A lines and withholds the band until complete", async () => {
        await db.exec(`update public.kpi_review_items set is_not_applicable = true, rating = null
                        where review_id = '${KPI}' and number::int > 5;
                       update public.kpi_review_items set rating = 5 where review_id = '${KPI}'`);
        let row = await summaryRow(DIRECTOR, OMAR);
        if (row.total_score !== 130 || row.band_code !== "3") throw new Error(JSON.stringify(row));
        await db.exec(`update public.kpi_review_items set rating = null where review_id = '${KPI}' and number = '1'`);
        row = await summaryRow(DIRECTOR, OMAR);
        if (row.total_score !== 104 || row.band_code !== null || row.is_complete !== false
            || row.recommendation_note !== "Scorecard not fully rated.") throw new Error(JSON.stringify(row));
    });

    await step("an approved salary review beats the old figure", async () => {
        await db.exec(`insert into public.salary_reviews (employee_id, effective_date, current_amount,
                          proposed_amount, status) values ('${OMAR}', '2026-01-01', 12000000, 12600000, 'approved');
                       insert into public.salary_reviews (employee_id, effective_date, current_amount,
                          proposed_amount, status, rationale) values ('${OMAR}', '2027-06-01', 12600000, 13000000, 'draft', 'x');`);
        const peter = await summaryRow(PETER, OMAR);
        if (peter.current_salary !== 12_600_000 || peter.salary_review_status !== "approved")
            throw new Error(JSON.stringify(peter));
        // The director sees her own newer draft as the latest review.
        const mine = await summaryRow(DIRECTOR, OMAR);
        if (mine.salary_review_status !== "draft" || mine.salary_review_proposed_amount !== 13_000_000)
            throw new Error(JSON.stringify(mine));
    });

    // ── The band table ──────────────────────────────────────────────────
    await step("the band table rejects unknown codes and out-of-range figures", async () => {
        await expectErr(() => tx(DIRECTOR, `select public.salary_set_band_increases('{"4":1}'::jsonb)`),
            "PT422", /Unknown band codes: 4/);
        await expectErr(() => tx(DIRECTOR, `select public.salary_set_band_increases('{"1":51}'::jsonb)`),
            "PT422", /between 0 and 50/);
        const out = await j(DIRECTOR, `select public.salary_set_band_increases('{"2H":5}'::jsonb) j`);
        const b = out.band_increases;
        if (Object.keys(b).length !== 5 || b["1"] !== 0 || b["2H"] !== 5) throw new Error(JSON.stringify(b));
        const count = await db.query(`select count(*)::int n from public.salary_increase_settings`);
        if (count.rows[0].n !== 1) throw new Error(`${count.rows[0].n} settings rows`);
    });

    await step("the band table starts from Nurhuda's figures", async () => {
        await db.exec(`delete from public.salary_increase_settings`);
        const d = await j(DIRECTOR, `select public.salary_guidance_data() j`);
        const want = { "1": 3, "2L": 3, "2M": 3, "2H": 5, "3": 7 };
        for (const [k, v] of Object.entries(want))
            if (d.band_increases[k] !== v) throw new Error(JSON.stringify(d.band_increases));
    });

    // ── The twelve-month average ────────────────────────────────────────
    await db.exec(`delete from public.economic_indicators`);
    const month = async (sql) => (await db.query(`select to_char((${sql})::date, 'YYYY-MM-DD') m`)).rows[0].m;
    const lastMonth = await month(`date_trunc('month', public.local_today()) - interval '1 month'`);
    const twoBack = await month(`date_trunc('month', public.local_today()) - interval '2 months'`);
    const thisMonth = await month(`date_trunc('month', public.local_today())`);

    await step("with nothing stored, the default year ends last month and asks for four candidates", async () => {
        const m = await j(DIRECTOR, `select public.salary_guidance_missing(null) j`);
        if (m.end !== lastMonth || m.candidates.length !== 4) throw new Error(JSON.stringify(m));
        if (m.cpi_yoy.length !== 12 || m.aud_idr.length !== 24) throw new Error(JSON.stringify(m));
    });

    await step("the default is the latest month published", async () => {
        await db.query(`select public.salary_store_readings('cpi_yoy', $1::jsonb)`,
            [JSON.stringify([{ month: twoBack, value: 2.5, source: "BPS (automatic)" }])]);
        const m = await j(DIRECTOR, `select public.salary_guidance_missing(null) j`);
        if (m.end !== twoBack || m.candidates.length !== 3) throw new Error(JSON.stringify(m));
        const a = await j(DIRECTOR, `select public.salary_annual_average(null) j`);
        if (a.end !== twoBack || a.months[11].cpi_yoy !== 2.5) throw new Error(JSON.stringify(a));
    });

    await step("a month that has not started is never asked for", async () => {
        const m = await j(DIRECTOR, `select public.salary_guidance_missing('2099-06-15') j`);
        if (m.end !== "2099-06-01") throw new Error(m.end);
        if ([...m.cpi_yoy, ...m.aud_idr].some((d) => d > thisMonth)) throw new Error("future month requested");
    });

    await db.exec(`
        delete from public.economic_indicators;
        insert into public.economic_indicators (kind, month, value, source)
        select 'cpi_yoy', m::date, case when m = '2026-08-01' then 4.2 else 3.0 end, 'BPS (automatic)'
          from generate_series('2025-08-01'::date, '2026-08-01'::date, interval '1 month') m;
        insert into public.economic_indicators (kind, month, value, source)
        select 'aud_idr', m::date, case when m >= '2025-09-01' then 11000.0 else 10000.0 end, 'ECB (automatic)'
          from generate_series('2024-08-01'::date, '2026-08-01'::date, interval '1 month') m;
    `);

    await step("twelve months averaged", async () => {
        const a = await j(DIRECTOR, `select public.salary_annual_average('2026-08-17') j`);
        if (a.start !== "2025-09-01" || a.end !== "2026-08-01" || a.months.length !== 12) throw new Error(JSON.stringify(a));
        if (a.cpi_average !== 3.1 || a.aud_idr_average !== 10) throw new Error(`${a.cpi_average} ${a.aud_idr_average}`);
        if (a.missing.length !== 0) throw new Error(JSON.stringify(a.missing));
        const first = a.months[0];
        if (first.month !== "2025-09-01" || first.aud_idr !== 11000 || first.aud_idr_year_before !== 10000
            || first.aud_idr_yoy !== 10) throw new Error(JSON.stringify(first));
        const m = await j(DIRECTOR, `select public.salary_guidance_missing('2026-08-01') j`);
        if (m.cpi_yoy.length || m.aud_idr.length) throw new Error(`nothing to fetch: ${JSON.stringify(m)}`);
    });

    await step("it does not matter much which month ends the year", async () => {
        const a = await j(PETER, `select public.salary_annual_average('2026-07-01') j`);
        if (a.cpi_average !== 3) throw new Error(`${a.cpi_average}`);
    });

    await step("a month not found is named and left out of its average", async () => {
        await db.exec(`delete from public.economic_indicators where kind = 'cpi_yoy' and month = '2026-08-01';
                       delete from public.economic_indicators where kind = 'aud_idr' and month = '2025-03-01'`);
        const a = await j(DIRECTOR, `select public.salary_annual_average('2026-08-01') j`);
        if (a.cpi_average !== 3) throw new Error(`eleven months, not twelve with a zero: ${a.cpi_average}`);
        if (!a.missing.includes("CPI for August 2026")) throw new Error(JSON.stringify(a.missing));
        if (!a.missing.includes("AUD→IDR for March 2026")) throw new Error(JSON.stringify(a.missing));
        const m = await j(DIRECTOR, `select public.salary_guidance_missing('2026-08-01') j`);
        if (JSON.stringify(m.cpi_yoy) !== '["2026-08-01"]' || JSON.stringify(m.aud_idr) !== '["2025-03-01"]')
            throw new Error(JSON.stringify(m));
    });

    await step("a hand-entered figure is never overwritten by a fetch", async () => {
        const i = await j(DIRECTOR, `select public.salary_upsert_indicator('cpi_yoy', '2026-08-20', 9, null) j`);
        if (i.month !== "2026-08-01" || i.source !== "Entered by hand" || i.entered_by !== DIRECTOR) throw new Error(JSON.stringify(i));
        const n = await db.query(`select public.salary_store_readings('cpi_yoy', $1::jsonb) n`,
            [JSON.stringify([{ month: "2026-08-01", value: 3.0, source: "BPS" }])]);
        if (n.rows[0].n !== 0) throw new Error("a fetch stored over a hand-entered row");
        const a = await j(DIRECTOR, `select public.salary_annual_average('2026-08-01') j`);
        if (a.months[11].cpi_yoy !== 9) throw new Error(`${a.months[11].cpi_yoy}`);
    });

    await step("two fetches racing for the same month both succeed; the first stored wins", async () => {
        const one = JSON.stringify([{ month: "2025-03-01", value: 10500, source: "first" }]);
        const two = JSON.stringify([{ month: "2025-03-01", value: 10600, source: "second" }]);
        await db.query(`select public.salary_store_readings('aud_idr', $1::jsonb)`, [one]);
        await db.query(`select public.salary_store_readings('aud_idr', $1::jsonb)`, [two]);
        const r = await db.query(`select value from public.economic_indicators where kind='aud_idr' and month='2025-03-01'`);
        if (r.rows[0].value !== 10500) throw new Error(`${r.rows[0].value}`);
    });

    await step("only the service role may store fetched readings", async () => {
        await expectErr(() => tx(DIRECTOR, `select public.salary_store_readings('cpi_yoy', '[]'::jsonb)`),
            null, /permission denied/);
    });

    await step("a negative CPI may be entered, not a negative rate; a hand correction replaces a fetched row", async () => {
        const ok = await j(DIRECTOR, `select public.salary_upsert_indicator('cpi_yoy', '2025-02-01', -0.09, 'BPS release') j`);
        if (ok.value !== -0.09 || ok.source !== "BPS release") throw new Error(JSON.stringify(ok));
        await expectErr(() => tx(DIRECTOR, `select public.salary_upsert_indicator('aud_idr', '2025-02-01', -1, null)`),
            "PT422", /exchange rate must be above zero/);
        const fixed = await j(PETER, `select public.salary_upsert_indicator('aud_idr', '2025-04-01', 10100, null) j`);
        if (fixed.value !== 10100 || fixed.entered_by !== PETER) throw new Error(JSON.stringify(fixed));
    });

    await step("a retired kind does not break the page, and a reading can be removed", async () => {
        await db.exec(`insert into public.economic_indicators (kind, month, value, source)
                       values ('cpi', '2026-08-01', 111.97, 'old')`);
        const d = await j(DIRECTOR, `select public.salary_guidance_data() j`);
        if (d.indicators.some((i) => i.kind === "cpi")) throw new Error("retired kind listed");
        const first = d.indicators[0];
        if (first.kind !== "aud_idr") throw new Error("ordered by kind");
        await tx(DIRECTOR, `select public.salary_delete_indicator($1::uuid)`, [first.id]);
        await expectErr(() => tx(DIRECTOR, `select public.salary_delete_indicator($1::uuid)`, [first.id]), "PT404");
    });
};
