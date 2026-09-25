// KPI: the scorecard arithmetic (tests/test_kpi_service.py) and the review
// chain (tests/test_kpi_routes.py), ported onto the SQL functions.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, RINA, HIMAWAN } = people;

    // --- fixtures, under our own ids ---------------------------------------
    const ENGINEER = "c1c1c1c1-0000-0000-0000-000000000001";
    const E_ENGINEER = "c1c1c1c1-0000-0000-0000-0000000000e1";
    const E_DIRECTOR = "c1c1c1c1-0000-0000-0000-0000000000e2";
    const E_NO_TEMPLATE = "c1c1c1c1-0000-0000-0000-0000000000e3";
    const E_EXEMPT = "c1c1c1c1-0000-0000-0000-0000000000e4";

    const MONITORING_WEIGHTS = [20, 15, 15, 10, 10, 10, 5, 5, 5, 5];

    const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - b) < eps;
    const eq = (got, want, what) => {
        if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    };
    const approx = (got, want, what, eps = 1e-6) => {
        if (!near(got, want, eps)) throw new Error(`${what}: got ${got}, expected ${want}`);
    };
    async function refused(fn, pattern, code) {
        try {
            await fn();
        } catch (e) {
            if (!pattern.test(e.message)) throw new Error(`wrong error: ${e.message}`);
            if (code && e.code !== code) throw new Error(`wrong code ${e.code} for: ${e.message}`);
            return;
        }
        throw new Error("expected a refusal");
    }

    const j = async (uid, sql, params) => (await tx(uid, sql, params)).rows[0].j;
    const score = async (items) =>
        (await db.query(`select public.kpi_score($1::jsonb) j`, [JSON.stringify(items)])).rows[0].j;
    const card = (ratings, weights = MONITORING_WEIGHTS) =>
        weights.map((w, i) => ({ weight: w, rating: ratings[i], is_not_applicable: false }));
    const reward = async (o) => {
        const b = {
            total: 101.5, is_complete: true, critical_gate_cleared: true, hard_gate_triggered: false,
            bonus_available: true, target_bonus_amount: 10_000_000, current_basic_salary: null,
            approved_increase_pct: null, ...o,
        };
        return (await db.query(
            `select public.kpi_reward($1, $2, $3, $4, $5, $6, $7, $8) j`,
            [b.total, b.is_complete, b.critical_gate_cleared, b.hard_gate_triggered,
             b.bonus_available, b.target_bonus_amount, b.current_basic_salary, b.approved_increase_pct],
        )).rows[0].j;
    };

    // --- arithmetic -------------------------------------------------------

    await step("the kpi migration re-runs cleanly", async () => {
        await db.exec(readFileSync(join(import.meta.dirname, "..", "..", "migrations",
            "20260926000500_kpi.sql"), "utf8"));
        const r = await db.query(`select data_type from information_schema.columns
            where table_schema = 'public' and table_name = 'kpi_reviews' and column_name = 'status'`);
        eq(r.rows[0].data_type, "character varying", "status type");
        const fk = await db.query(`select count(*)::int n from pg_constraint
            where conrelid = 'public.kpi_reviews'::regclass and contype = 'f'
              and confrelid = 'public.users'::regclass`);
        eq(fk.rows[0].n, 2, "assessor/approver reference users");
    });

    await step("rating factors match the document; 6 is refused", async () => {
        const r = await db.query(`select g, public.kpi_rating_factor(g)::float8 f from generate_series(0, 5) g`);
        const want = { 0: 0, 1: 0.5, 2: 0.75, 3: 1.0, 4: 1.15, 5: 1.3 };
        for (const row of r.rows) approx(row.f, want[row.g], `factor ${row.g}`);
        await refused(() => db.query(`select public.kpi_rating_factor(6)`), /rating must be 0-5/);
    });

    await step("band thresholds are inclusive lower bounds on the out-of-130 total", async () => {
        const cases = [[0, "band_1"], [69.9, "band_1"], [70, "band_2l"], [84.9, "band_2l"],
            [85, "band_2m"], [100, "band_2m"], [104.9, "band_2m"], [105, "band_2h"],
            [114.9, "band_2h"], [115, "band_3"], [130, "band_3"]];
        for (const [t, b] of cases) {
            const r = await db.query(`select public.kpi_band_for_score($1) b`, [t]);
            eq(r.rows[0].b, b, `band for ${t}`);
        }
    });

    await step("all meets target scores 100, all exceptional 130, all zero 0", async () => {
        let s = await score(card(Array(10).fill(3)));
        eq(s.total, 100, "all 3"); eq(s.band, "band_2m", "band"); eq(s.is_complete, true, "complete");
        s = await score(card(Array(10).fill(5)));
        eq(s.total, 130, "all 5"); eq(s.band, "band_3", "band");
        s = await score(card(Array(10).fill(0)));
        eq(s.total, 0, "all 0"); eq(s.band, "band_1", "band"); eq(s.is_complete, true, "rated, just badly");
    });

    await step("worked example: a 20% KPI rated 4 contributes 23.0", async () => {
        const s = await score(card([4, 3, 3, 3, 3, 3, 3, 3, 3, 3]));
        approx(s.item_scores[0].effective_weight, 20, "effective weight");
        approx(s.item_scores[0].points, 23.0, "points");
        approx(s.total, 103, "total");
    });

    await step("mixed ratings total correctly", async () => {
        const ratings = [4, 3, 3, 5, 3, 2, 3, 3, 4, 3];
        const f = { 5: 1.3, 4: 1.15, 3: 1, 2: 0.75, 1: 0.5, 0: 0 };
        const expected = Math.round(MONITORING_WEIGHTS.reduce((a, w, i) => a + w * f[ratings[i]], 0) * 100) / 100;
        approx((await score(card(ratings))).total, expected, "total");
    });

    await step("N/A weight is redistributed, not zeroed", async () => {
        const items = card(Array(10).fill(3));
        items[7] = { ...items[7], rating: null, is_not_applicable: true };
        const s = await score(items);
        approx(s.total, 100, "total with KPI 08 N/A");
        eq(s.band, "band_2m", "band");
        eq(s.not_applicable_count, 1, "na count");
        eq(s.applicable_count, 9, "applicable");
        eq(s.is_complete, true, "complete");
        const eff = s.item_scores.map((x) => x.effective_weight);
        eq(eff[7], 0, "N/A effective weight");
        approx(eff.reduce((a, b) => a + b, 0), 100, "effective sum", 0.01);
        approx(eff[0], 2000 / 95, "20% share", 1e-3);
        approx(eff[1], 1500 / 95, "15% share", 1e-3);
    });

    await step("N/A leaves a strong card at the ceiling; all N/A is not banded", async () => {
        const items = card(Array(10).fill(5));
        items[9] = { ...items[9], rating: null, is_not_applicable: true };
        let s = await score(items);
        approx(s.total, 130, "total"); eq(s.band, "band_3", "band");
        s = await score(card(Array(10).fill(null)).map((i) => ({ ...i, is_not_applicable: true })));
        eq(s.total, 0, "total"); eq(s.band, null, "band"); eq(s.is_complete, false, "complete");
        eq(s.applicable_count, 0, "applicable");
    });

    await step("a partly-rated card is incomplete and unbanded until the last line", async () => {
        let s = await score(card([3, 3, 3, null, null, null, null, null, null, null]));
        eq(s.is_complete, false, "complete"); eq(s.band, null, "band"); eq(s.rated_count, 3, "rated");
        s = await score(card([3, 3, 3, 3, 3, 3, 3, 3, 3, null]));
        eq(s.band, null, "nine of ten");
        s = await score(card(Array(10).fill(3)));
        eq(s.band, "band_2m", "ten of ten");
        approx(s.percent_of_max, 76.9, "percent of 130", 0.1);
    });

    await step("band code and label use the document's wording", async () => {
        const s = await score(card(Array(10).fill(4)));
        approx(s.total, 115, "total"); eq(s.band_code, "3", "code"); eq(s.band_label, "Outstanding / Key Talent", "label");
    });

    await step("bonus tiers are the workbook's, not the band thresholds", async () => {
        const cases = [[0, 0], [84.9, 0], [85, 0.5], [94.9, 0.5], [95, 1], [101.5, 1], [104.9, 1],
            [105, 1.25], [114.9, 1.25], [115, 1.5], [130, 1.5]];
        for (const [t, m] of cases) {
            const r = await db.query(`select public.kpi_bonus_multiplier($1) j`, [t]);
            approx(r.rows[0].j.multiplier, m, `multiplier at ${t}`);
        }
        const r = await db.query(`select public.kpi_band_for_score(90) b, public.kpi_bonus_multiplier(90) j`);
        eq(r.rows[0].b, "band_2m", "90 is Meets Expectations");
        approx(r.rows[0].j.multiplier, 0.5, "and half a bonus");
        eq(r.rows[0].j.label, "Half of target bonus", "label");
    });

    await step("recommended bonus is target x multiplier", async () => {
        approx((await reward({})).recommended_bonus, 10_000_000, "at 101.5");
        approx((await reward({ total: 115 })).recommended_bonus, 15_000_000, "at 115");
        approx((await reward({ total: 90 })).recommended_bonus, 5_000_000, "at 90");
    });

    await step("gates block any reward and say which", async () => {
        let r = await reward({ total: 130, critical_gate_cleared: false });
        eq(r.multiplier, 0, "multiplier"); eq(r.recommended_bonus, null, "bonus");
        if (!/integrity gate/.test(r.blocked_reason)) throw new Error(r.blocked_reason);
        r = await reward({ total: 130, hard_gate_triggered: true });
        eq(r.recommended_bonus, null, "bonus");
        if (!/Hard gate/.test(r.blocked_reason)) throw new Error(r.blocked_reason);
        r = await reward({ is_complete: false });
        if (!/not finished/.test(r.blocked_reason)) throw new Error(r.blocked_reason);
    });

    await step("salary route when no bonus is available, and the proposed salary", async () => {
        let r = await reward({ bonus_available: false, total: 101.5 });
        if (!/basic-salary adjustment may be considered/.test(r.salary_review_status)
            || !/Not automatic/.test(r.salary_review_status)) throw new Error(r.salary_review_status);
        r = await reward({ bonus_available: false, total: 90 });
        if (!/no salary adjustment recommended/.test(r.salary_review_status)) throw new Error(r.salary_review_status);
        approx((await reward({ current_basic_salary: 12_000_000, approved_increase_pct: 6 })).proposed_basic_salary,
            12_720_000, "proposed");
        eq((await reward({ current_basic_salary: 12_000_000 })).proposed_basic_salary, null, "needs both");
        eq((await reward({ approved_increase_pct: 6 })).proposed_basic_salary, null, "needs both");
    });

    // --- the chain --------------------------------------------------------

    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
          ('00000000-0000-0000-0000-000000000000','${ENGINEER}',
           'authenticated','authenticated','kpi.engineer@dtgeotech.com','x', now(),
           '{"provider":"email","providers":["email"]}'::jsonb,
           '{"full_name":"Lintang Sadewa"}'::jsonb, now(), now(), '', '', '', '')
        on conflict (id) do nothing;

        insert into public.employees (id, employee_id, first_name, last_name, email, department,
                                      position, date_of_joining, user_id, kpi_template_id)
        select v.id::uuid, v.code, v.first, v.last, v.email, 'Operations', v.pos, '2025-04-01',
               v.uid::uuid, case when v.tmpl then t.id end
          from (values
            ('${E_ENGINEER}', 'KPI-001', 'Lintang', 'Sadewa', 'kpi.engineer@dtgeotech.com', 'Monitoring Engineer', '${ENGINEER}', true),
            ('${E_DIRECTOR}', 'KPI-002', 'Nurhuda', 'Santoso', 'kpi.director@dtgeotech.com', 'Director', '${DIRECTOR}', true),
            ('${E_NO_TEMPLATE}', 'KPI-003', 'Himawan', 'Praptomo', 'kpi.finance@dtgeotech.com', 'Finance', null, false),
            ('${E_EXEMPT}', 'KPI-004', 'Mark', 'Founder', 'kpi.founder@dtgeotech.com', 'Management', null, true)
          ) v(id, code, first, last, email, pos, uid, tmpl)
          cross join (select id from public.kpi_role_templates where code = 'monitoring_engineer') t;

        update public.employees set kpi_review_required = false,
               kpi_exemption_reason = 'Founder - not assessed'
         where id = '${E_EXEMPT}';
    `);

    // The default chain, by the rule: the first director, the earliest executive.
    const chainIds = (await db.query(`
        select (select id from public.users where role::text = 'director' order by created_at, id limit 1) d,
               (select id from public.users where role::text = 'executive' order by created_at, id limit 1) x`)).rows[0];
    const DIR = chainIds.d;
    const EXEC = chainIds.x;

    let seq = 0;
    const open = async (actor, employeeId, label) =>
        j(actor, `select public.kpi_create_review($1::jsonb) j`, [JSON.stringify({
            employee_id: employeeId, period_type: "quarterly",
            period_label: label ?? `T${++seq}`, period_start: "2026-07-01", period_end: "2026-09-30",
        })]);
    const rate = (actor, review, item, body) =>
        j(actor, `select public.kpi_update_item($1, $2, $3::jsonb) j`, [review.id, item.id, JSON.stringify(body)]);
    const rateAll = async (actor, review, rating) => {
        let out = review;
        for (const item of review.items) out = await rate(actor, review, item, { rating });
        return out;
    };
    const call = (actor, fn, review, ...args) =>
        j(actor, `select public.${fn}($1${args.map((_, i) => `, $${i + 2}`).join("")}) j`, [review.id, ...args]);
    const patch = (actor, review, body) =>
        j(actor, `select public.kpi_update_review($1, $2::jsonb) j`, [review.id, JSON.stringify(body)]);
    const approved = async () => {
        let r = await open(DIR, E_ENGINEER);
        r = await rateAll(DIR, r, 3);
        await call(DIR, "kpi_submit_review", r);
        return call(EXEC, "kpi_approve_review", r, null);
    };

    await step("the chain is the director and the earliest executive", async () => {
        eq(DIR, DIRECTOR, "director");
        eq(EXEC, PETER, "executive");
    });

    await step("staff and finance cannot reach scorecards", async () => {
        for (const who of [ENGINEER, RINA, HIMAWAN]) {
            for (const sql of [`select public.kpi_meta()`, `select public.kpi_list_templates()`,
                               `select public.kpi_list_reviews(null)`]) {
                await refused(() => tx(who, sql), /not available on this account/, "PT403");
            }
        }
    });

    await step("director and executive read the reference data", async () => {
        for (const who of [DIR, EXEC]) {
            const m = await j(who, `select public.kpi_meta() j`);
            eq(m.max_score, 130, "max_score");
            approx(m.rating_scale.find((e) => e.rating === 4).factor, 1.15, "factor for 4");
            eq(m.bands[0].code, "3", "highest band first");
        }
        const ts = await j(DIR, `select public.kpi_list_templates() j`);
        if (ts.length < 6) throw new Error(`templates ${ts.length}`);
        const mon = ts.find((t) => t.code === "monitoring_engineer");
        eq(mon.item_count, 10, "item_count");
        const d = await j(DIR, `select public.kpi_get_template($1) j`, [mon.id]);
        eq(d.items.length, 10, "template items");
        await refused(() => tx(DIR, `select public.kpi_get_template('00000000-0000-0000-0000-00000000dead')`),
            /Template not found/, "PT404");
    });

    await step("an engineer's card: director assesses, executive approves", async () => {
        const r = await open(DIR, E_ENGINEER);
        eq(r.assessor_id, DIR, "assessor"); eq(r.approver_id, EXEC, "approver");
        eq(r.items.length, 10, "items"); eq(r.status, "draft", "status");
        eq(r.template_title, "Geotechnical Monitoring Engineer", "template_title");
        const log = await db.query(`select count(*)::int n from public.activity_logs
            where action = 'KPI_REVIEW_OPENED' and target_id = $1`, [E_ENGINEER]);
        if (log.rows[0].n < 1) throw new Error("not logged");
    });

    await step("the director's own card: the executive holds both ends", async () => {
        const r = await open(EXEC, E_DIRECTOR);
        eq(r.assessor_id, EXEC, "assessor"); eq(r.approver_id, EXEC, "approver");
        // And she can neither edit, approve nor set the reward on it.
        const mine = await j(DIRECTOR, `select public.kpi_get_review($1) j`, [r.id]);
        eq(mine.can_edit, false, "can_edit"); eq(mine.can_approve, false, "can_approve");
        eq(mine.can_edit_reward, false, "can_edit_reward");
        await refused(() => rate(DIRECTOR, r, r.items[0], { rating: 5 }), /Only the assessor/, "PT403");
        await refused(() => patch(DIRECTOR, r, { target_bonus_amount: 1 }), /reward figures/, "PT403");
    });

    await step("no template, a second card for a period, and an exemption are refused", async () => {
        await refused(() => open(DIR, E_NO_TEMPLATE), /no KPI scorecard assigned/, "PT400");
        await open(DIR, E_ENGINEER, "2026 Q3");
        await refused(() => open(DIR, E_ENGINEER, "2026 Q3"), /A 2026 Q3 review already exists/, "PT409");
        await refused(() => open(DIR, E_EXEMPT), /Mark Founder is not assessed: Founder - not assessed/, "PT400");
        await refused(() => open(DIR, "00000000-0000-0000-0000-00000000dead"), /Employee not found/, "PT404");
    });

    await step("either reviewer may rate; a rating out of range is refused", async () => {
        const r = await open(DIR, E_ENGINEER);
        const out = await rate(EXEC, r, r.items[0], { rating: 5 });
        eq(out.items[0].rating, 5, "rated by the executive");
        await refused(() => rate(DIR, r, r.items[0], { rating: 7 }), /0 to 5/, "PT422");
        await refused(() => rate(DIR, r, { id: "00000000-0000-0000-0000-00000000dead" }, { rating: 1 }),
            /Scorecard line not found/, "PT404");
    });

    await step("rated 3 throughout scores 100, band 2M, complete", async () => {
        const r = await rateAll(DIR, await open(DIR, E_ENGINEER), 3);
        eq(r.total_score, 100, "total"); eq(r.band_code, "2M", "band"); eq(r.is_complete, true, "complete");
        eq(r.can_submit, true, "can_submit");
        approx(r.items[0].points, 20, "line points");
        const cached = await db.query(`select total_score, band from public.kpi_reviews where id = $1`, [r.id]);
        eq(cached.rows[0].band, "band_2m", "cached band");
    });

    await step("N/A clears a stale rating and its weight is reallocated", async () => {
        const r = await open(DIR, E_ENGINEER);
        let out = await rate(DIR, r, r.items[7], { rating: 5 });
        eq(out.items[7].rating, 5, "rated");
        out = await rate(DIR, r, r.items[7], { is_not_applicable: true });
        eq(out.items[7].is_not_applicable, true, "flag"); eq(out.items[7].rating, null, "rating cleared");
        for (const [i, item] of r.items.entries()) if (i !== 7) out = await rate(DIR, r, item, { rating: 3 });
        approx(out.total_score, 100, "total"); eq(out.not_applicable_count, 1, "na");
        eq(out.is_complete, true, "complete");
    });

    await step("an incomplete card cannot be submitted", async () => {
        const r = await open(DIR, E_ENGINEER);
        await rate(DIR, r, r.items[0], { rating: 3 });
        await refused(() => call(DIR, "kpi_submit_review", r), /9 lines still unrated/, "PT400");
    });

    await step("full flow: submit, no self-approval, executive approves at 115", async () => {
        let r = await rateAll(DIR, await open(DIR, E_ENGINEER), 4);
        r = await call(DIR, "kpi_submit_review", r);
        eq(r.status, "submitted", "status");
        await refused(() => call(DIR, "kpi_approve_review", r, "ok"), /named approver/, "PT403");
        r = await call(EXEC, "kpi_approve_review", r, "Strong year.");
        eq(r.status, "approved", "status"); eq(r.band_code, "3", "band"); approx(r.total_score, 115, "total");
        eq(r.approver_comment, "Strong year.", "comment");
        if (!r.approved_at) throw new Error("approved_at not set");
    });

    await step("ratings and commentary lock on submit; the reward does not", async () => {
        let r = await rateAll(DIR, await open(DIR, E_ENGINEER), 3);
        await call(DIR, "kpi_submit_review", r);
        await refused(() => rate(DIR, r, r.items[0], { rating: 5 }), /only before it is submitted/, "PT403");
        await refused(() => patch(DIR, r, { assessor_comment: "changed my mind" }), /only before it is submitted/, "PT403");
        r = await patch(DIR, r, { target_bonus_amount: 10_000_000, critical_gate_cleared: false });
        eq(r.critical_gate_cleared, false, "gate"); eq(r.can_edit_reward, true, "can_edit_reward");
        eq(r.bonus_applies, false, "bonus_applies"); eq(r.recommended_bonus, null, "no bonus outside management");
        await refused(() => patch(DIR, r, { target_bonus_amount: -1 }), /greater than or equal to 0/, "PT422");
    });

    await step("the approver may set the reward figures", async () => {
        const r = await open(DIR, E_ENGINEER);
        const out = await patch(EXEC, r, { critical_gate_cleared: false });
        eq(out.critical_gate_cleared, false, "gate");
    });

    await step("the scorecard no longer takes salary figures", async () => {
        const r = await open(DIR, E_ENGINEER);
        const out = await patch(DIR, r, { current_basic_salary: 12_000_000, approved_increase_pct: 6.0 });
        eq(out.current_basic_salary, null, "current_basic_salary");
        eq(out.approved_increase_pct, null, "approved_increase_pct");
    });

    await step("returning needs a reason and reopens the card", async () => {
        let r = await rateAll(DIR, await open(DIR, E_ENGINEER), 3);
        await call(DIR, "kpi_submit_review", r);
        await refused(() => call(DIR, "kpi_return_review", r, "no"), /named approver can return/, "PT403");
        await refused(() => call(EXEC, "kpi_return_review", r, "  "), /Say what needs changing/, "PT400");
        r = await call(EXEC, "kpi_return_review", r, "Add evidence for KPI 03.");
        eq(r.status, "returned", "status"); eq(r.submitted_at, null, "submitted_at");
        eq(r.approver_comment, "Add evidence for KPI 03.", "note");
        const out = await rate(DIR, r, r.items[0], { rating: 4 });
        eq(out.items[0].rating, 4, "editable again");
    });

    await step("approval alone does not release the card to its subject", async () => {
        const r = await approved();
        eq(r.status, "approved", "status");
        await refused(() => tx(ENGINEER, `select public.kpi_get_review($1)`, [r.id]), /^Scorecard not found\.$/, "PT404");
        await refused(() => tx(RINA, `select public.kpi_get_review($1)`, [r.id]), /not available on this account/, "PT403");
        const mine = await j(ENGINEER, `select public.kpi_list_my_reviews() j`);
        eq(mine.total, 0, "nothing published yet");
        // Nor through the table.
        const t = await tx(ENGINEER, `select count(*)::int n from public.kpi_reviews`);
        eq(t.rows[0].n, 0, "table rows visible to the subject");
    });

    await step("only the approver publishes; then the subject reads it without the reward", async () => {
        const r = await approved();
        await refused(() => call(DIR, "kpi_publish_review", r), /named approver can publish/, "PT403");
        const p = await call(EXEC, "kpi_publish_review", r);
        eq(p.status, "published", "status");
        if (!p.published_at) throw new Error("published_at not set");
        eq(p.can_edit, false, "published is read-only");
        await patch(EXEC, r, { target_bonus_amount: 5_000_000 });
        await db.query(`update public.kpi_reviews set current_basic_salary = 12500000, approved_increase_pct = 5 where id = $1`, [r.id]);

        const body = await j(ENGINEER, `select public.kpi_get_review($1) j`, [r.id]);
        approx(body.total_score, 100, "total"); eq(body.band_code, "2M", "band");
        eq(body.can_see_reward, false, "can_see_reward");
        eq(body.bonus_multiplier, 0, "multiplier"); eq(body.bonus_multiplier_label, "", "label");
        eq(body.recommended_bonus, null, "recommended"); eq(body.target_bonus_amount, null, "target");
        eq(body.current_basic_salary, null, "salary"); eq(body.approved_increase_pct, null, "pct");
        eq(body.proposed_basic_salary, null, "proposed"); eq(body.salary_review_status, "", "status");
        eq(body.can_edit, false, "can_edit"); eq(body.can_edit_reward, false, "can_edit_reward");

        const mine = await j(ENGINEER, `select public.kpi_list_my_reviews() j`);
        if (!mine.items.some((x) => x.id === r.id)) throw new Error("not in my list");
        if ("target_bonus_amount" in mine.items[0]) throw new Error("summary carries reward fields");

        // The chain still sees the salary figure already on the row.
        const dir = await j(DIR, `select public.kpi_get_review($1) j`, [r.id]);
        approx(dir.current_basic_salary, 12_500_000, "chain sees salary");
    });

    await step("no bonus outside management roles; the multiplier is worded neutrally", async () => {
        const r = await approved();
        let body = await j(DIR, `select public.kpi_get_review($1) j`, [r.id]);
        eq(body.bonus_applies, false, "bonus_applies"); eq(body.recommended_bonus, null, "recommended");
        eq(body.target_bonus_amount, null, "target"); eq(body.bonus_available, false, "available");
        approx(body.bonus_multiplier, 1.0, "multiplier still reaches the chain");
        eq(body.bonus_multiplier_label, "At target", "neutral wording");

        await db.query(`update public.employees set is_management_role = true, bonus_eligible = true where id = $1`, [E_ENGINEER]);
        try {
            await patch(EXEC, r, { target_bonus_amount: 10_000_000 });
            body = await j(DIR, `select public.kpi_get_review($1) j`, [r.id]);
            eq(body.bonus_applies, true, "bonus_applies"); approx(body.target_bonus_amount, 10_000_000, "target");
            approx(body.recommended_bonus, 10_000_000, "recommended");
            eq(body.bonus_multiplier_label, "Target bonus", "bonus wording");
        } finally {
            await db.query(`update public.employees set is_management_role = false, bonus_eligible = false where id = $1`, [E_ENGINEER]);
        }
    });

    await step("a published card is withdrawn by the director only", async () => {
        const r = await approved();
        await call(EXEC, "kpi_publish_review", r);
        await refused(() => call(EXEC, "kpi_unpublish_review", r), /Only an administrator can withdraw/, "PT403");
        const out = await call(DIR, "kpi_unpublish_review", r);
        eq(out.status, "approved", "status"); eq(out.published_at, null, "published_at");
        await refused(() => tx(ENGINEER, `select public.kpi_get_review($1)`, [r.id]), /Scorecard not found/, "PT404");
    });

    await step("reset clears the ratings and the sign-off; director only", async () => {
        const r = await approved();
        await refused(() => call(EXEC, "kpi_reset_review", r), /Only an administrator can reset/, "PT403");
        const out = await call(DIR, "kpi_reset_review", r);
        eq(out.status, "draft", "status"); eq(out.approved_at, null, "approved_at");
        eq(out.published_at, null, "published_at"); eq(out.approver_comment, null, "approver_comment");
        eq(out.rated_count, 0, "rated_count");
        if (!out.items.every((i) => i.rating === null)) throw new Error("ratings survived");
    });

    await step("only the assessor discards a card, and never an approved one", async () => {
        const a = await approved();
        await refused(() => tx(DIR, `select public.kpi_delete_review($1)`, [a.id]), /approved scorecard cannot be deleted/, "PT409");
        const d = await open(DIR, E_ENGINEER);
        await refused(() => tx(EXEC, `select public.kpi_delete_review($1)`, [d.id]), /Only the assessor can discard/, "PT403");
        await tx(DIR, `select public.kpi_delete_review($1)`, [d.id]);
        await refused(() => tx(DIR, `select public.kpi_get_review($1)`, [d.id]), /Review not found/, "PT404");
    });

    await step("list reviews filters by employee, newest period first", async () => {
        const all = await j(EXEC, `select public.kpi_list_reviews(null) j`);
        const eng = await j(EXEC, `select public.kpi_list_reviews($1) j`, [E_ENGINEER]);
        if (eng.total < 1 || eng.total > all.total) throw new Error(`eng ${eng.total} all ${all.total}`);
        if (!eng.items.every((x) => x.employee_id === E_ENGINEER)) throw new Error("filter leaked");
        eq(eng.items[0].employee_name, "Lintang Sadewa", "employee_name");
    });

    // Leave nothing that changes who the director is to the suites after us.
    await db.exec(`delete from public.employees where id in
        ('${E_ENGINEER}', '${E_DIRECTOR}', '${E_NO_TEMPLATE}', '${E_EXEMPT}')`);
};
