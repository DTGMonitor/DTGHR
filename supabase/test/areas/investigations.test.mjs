// Monitoring investigations and disciplinary outcomes
// (supabase/migrations/20260928001400_investigations.sql, and the review flow and
// DS/NS shifts of 20260928001500_investigation_review.sql).
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN, RINA } = people;

    // Our own people: Mark (an executive, not an investigator), three of the
    // monitoring team, one former member, and the director's employee record
    // (the seed's director has none; removed again at the end).
    const MARK = "1e000000-0000-0000-0000-000000000001";
    const LINTANG = "1e000000-0000-0000-0000-000000000002";
    const ARIS = "1e000000-0000-0000-0000-000000000003";
    const NESSY = "1e000000-0000-0000-0000-000000000004";
    const GONE = "1e000000-0000-0000-0000-000000000005";
    const E = {
        MARK: "1f000000-0000-0000-0000-000000000001",
        LINTANG: "1f000000-0000-0000-0000-000000000002",
        ARIS: "1f000000-0000-0000-0000-000000000003",
        NESSY: "1f000000-0000-0000-0000-000000000004",
        GONE: "1f000000-0000-0000-0000-000000000005",
        DIRECTOR: "1f000000-0000-0000-0000-000000000009",
    };
    const MAIL = {
        MARK: "inv.mark@dtgeotech.com",
        LINTANG: "inv.lintang@dtgeotech.com",
        ARIS: "inv.aris@dtgeotech.com",
        NESSY: "inv.nessy@dtgeotech.com",
        GONE: "inv.gone@dtgeotech.com",
        DIRECTOR: "admin@dtgeotech.com",
        PETER: "peter@dtgeotech.com",
    };

    const authRow = (id, email, name) => `('00000000-0000-0000-0000-000000000000','${id}','authenticated',
        'authenticated','${email}','x', now(), '{"provider":"email"}'::jsonb,
        '{"full_name":"${name}"}'::jsonb, now(), now(), '', '', '', '')`;

    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
          ${authRow(MARK, MAIL.MARK, "Mark Inv")},
          ${authRow(LINTANG, MAIL.LINTANG, "Lintang Inv")},
          ${authRow(ARIS, MAIL.ARIS, "Aris Inv")},
          ${authRow(NESSY, MAIL.NESSY, "Nessy Inv")},
          ${authRow(GONE, MAIL.GONE, "Gone Inv")};
        update public.users set role = 'executive' where id = '${MARK}';

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, user_id) values
          ('${E.MARK}','INV-E01','Mark','Inv','${MAIL.MARK}','Management','Director','2024-01-01',0,'${MARK}'),
          ('${E.LINTANG}','INV-E02','Lintang','Inv','${MAIL.LINTANG}','Ops','Monitoring Engineer','2024-01-01',0,'${LINTANG}'),
          ('${E.ARIS}','INV-E03','Aris','Inv','${MAIL.ARIS}','Ops','Monitoring Engineer','2024-01-01',0,'${ARIS}'),
          ('${E.NESSY}','INV-E04','Nessy','Inv','${MAIL.NESSY}','Ops','Monitoring Engineer','2024-01-01',0,'${NESSY}'),
          ('${E.GONE}','INV-E05','Gone','Inv','${MAIL.GONE}','Ops','Monitoring Engineer','2024-01-01',0,'${GONE}'),
          ('${E.DIRECTOR}','INV-E09','Nurhuda','Inv','inv.director@dtgeotech.com','Management','Director','2024-01-01',0,'${DIRECTOR}');

        update public.employees set is_monitoring_team = true
         where id in ('${E.LINTANG}','${E.ARIS}','${E.NESSY}','${E.GONE}');
        update public.employees set is_active = false where id = '${E.GONE}';
        update public.employees set can_investigate = true where id = '${E.DIRECTOR}' or user_id = '${PETER}';
        -- Mark is management and an administrator, but not an investigator.
        update public.employees set is_management_role = true where id = '${E.MARK}';
    `);

    const j = async (uid, sql, params) => (await tx(uid, `select ${sql} j`, params)).rows[0].j;
    const fails = async (fn, code, pattern) => {
        try {
            await fn();
        } catch (e) {
            if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
            if (pattern && !pattern.test(e.message)) throw new Error(`wrong message: ${e.message}`);
            return;
        }
        throw new Error("was allowed");
    };
    const eq = (a, b, what) => {
        if (JSON.stringify(a) !== JSON.stringify(b))
            throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    };

    const siteId = async (name) =>
        (await db.query(`select id from public.monitoring_sites where name = $1`, [name])).rows[0].id;
    const HV = await siteId("Hidden Valley");

    const draft = (uid, extra = {}) =>
        j(uid, `public.investigations_save(null, $1::jsonb)`, [JSON.stringify({
            event_at: "2026-09-20T02:15:00+07:00",
            site_id: HV,
            radar: "SSR-XT-001",
            title: "Missed amber alarm",
            ds_employee_id: E.LINTANG,
            ns_employee_id: E.ARIS,
            handover_note: "Handover from Aris at 18:00",
            findings: "Alarm acknowledged 40 minutes late.",
            technical_summary: "Data shows the alarm at 02:15.",
            investigation_result: "Late response to an amber alarm.",
            recommendation: "Refresher on alarm procedure.",
            ...extra,
        })]);
    const edit = (uid, id, payload) =>
        j(uid, `public.investigations_save($1::uuid, $2::jsonb)`, [id, JSON.stringify(payload)]);
    const addOutcome = (uid, invId, payload) =>
        j(uid, `public.investigations_save_outcome($1::uuid, null, $2::jsonb)`, [invId, JSON.stringify(payload)]);
    const reviseOutcome = (uid, invId, outcomeId, payload) =>
        j(uid, `public.investigations_save_outcome($1::uuid, $2::uuid, $3::jsonb)`,
            [invId, outcomeId, JSON.stringify(payload)]);
    const submit = (uid, id) => j(uid, `public.investigations_submit($1::uuid)`, [id]);
    const approve = (uid, id) => j(uid, `public.investigations_approve($1::uuid)`, [id]);
    const sendBack = (uid, id, note) => j(uid, `public.investigations_send_back($1::uuid, $2)`, [id, note]);
    const comment = (uid, id, body) => j(uid, `public.investigations_comment($1::uuid, $2)`, [id, body]);
    // Released the only way there is now: submitted by one investigator,
    // approved by the other.
    const issue = async (uid, id) => {
        await submit(uid, id);
        return approve(uid === DIRECTOR ? PETER : DIRECTOR, id);
    };
    const mine = (uid) => j(uid, `public.investigations_my_outcomes()`);
    const respond = (uid, outcomeId, response, text = null) =>
        j(uid, `public.investigations_respond($1::uuid, $2, $3)`, [outcomeId, response, text]);
    const outbox = async (kind) =>
        (await db.query(`select to_email, link_path from public.email_outbox where kind = $1 order by to_email`,
            [kind])).rows;
    const reset = () => db.exec(`
        delete from public.investigations;
        delete from public.email_outbox where kind like 'investigation_%';
    `);

    // ── Session and access ──────────────────────────────────────────────

    await step("investigations: the session carries can_investigate", async () => {
        const d = await j(DIRECTOR, `public.bootstrap_session()`);
        const p = await j(PETER, `public.bootstrap_session()`);
        const m = await j(MARK, `public.bootstrap_session()`);
        const h = await j(HIMAWAN, `public.bootstrap_session()`);
        eq([d.can_investigate, p.can_investigate, m.can_investigate, h.can_investigate],
            [true, true, false, false], "can_investigate");
    });

    await step("investigations: only investigators list, read and create", async () => {
        await reset();
        const list = await j(DIRECTOR, `public.investigations_list()`);
        if (!Array.isArray(list.items) || list.sites.length < 3) throw new Error(JSON.stringify(list));
        await j(PETER, `public.investigations_list()`);
        for (const uid of [MARK, HIMAWAN, RINA, LINTANG]) {
            await fails(() => j(uid, `public.investigations_list()`), "PT404");
            await fails(() => draft(uid), "PT404");
            await fails(() => j(uid, `public.investigations_people()`), "PT404");
        }
        const inv = await draft(PETER);
        for (const uid of [MARK, HIMAWAN, RINA, LINTANG]) {
            await fails(() => j(uid, `public.investigations_get($1::uuid)`, [inv.id]), "PT404");
            await fails(() => issue(uid, inv.id), "PT404");
            await fails(() => j(uid, `public.investigations_delete($1::uuid)`, [inv.id]), "PT404");
        }
    });

    await step("investigations: the seeded sites carry their clients", async () => {
        const sites = await j(DIRECTOR, `public.investigations_sites()`);
        const byName = Object.fromEntries(sites.map((s) => [s.name, s.client]));
        eq([byName["Hidden Valley"], byName["Telfer"], byName["Sorowako"]], ["Harmony", "Greatland", "Vale"], "sites");
    });

    await step("investigations: references run INV-0001, INV-0002 and skip past the highest", async () => {
        await reset();
        const a = await draft(DIRECTOR);
        const b = await draft(PETER);
        eq([a.reference, b.reference], ["INV-0001", "INV-0002"], "references");
        await db.query(`update public.investigations set reference = 'INV-0041' where id = $1`, [b.id]);
        const c = await draft(DIRECTOR);
        eq(c.reference, "INV-0042", "after the highest");
        eq(a.status, "draft", "status");
        eq([a.site_name, a.site_client, a.ds_name, a.ns_name],
            ["Hidden Valley", "Harmony", "Lintang Inv", "Aris Inv"], "names");
    });

    await step("investigations: only active monitoring-team members may be named", async () => {
        await reset();
        for (const who of [E.MARK, E.GONE, (await db.query(
            `select id from public.employees where user_id = $1`, [RINA])).rows[0].id]) {
            await fails(() => draft(DIRECTOR, { ds_employee_id: who }), "PT422", /monitoring team/);
            await fails(() => draft(DIRECTOR, { ns_employee_id: who }), "PT422", /monitoring team/);
        }
        const inv = await draft(DIRECTOR);
        await fails(() => addOutcome(DIRECTOR, inv.id, { employee_id: E.MARK, decision: "no_action" }),
            "PT422", /monitoring team/);
        await fails(() => addOutcome(DIRECTOR, inv.id, { employee_id: E.GONE, decision: "no_action" }),
            "PT422", /monitoring team/);
        await fails(() => draft(DIRECTOR, { ns_employee_id: E.LINTANG }), "PT422", /different people/);
        // Either shift alone is fine while drafting.
        const dsOnly = await draft(DIRECTOR, { ns_employee_id: null });
        const nsOnly = await draft(DIRECTOR, { ds_employee_id: null });
        eq([dsOnly.ds_name, dsOnly.ns_name, nsOnly.ds_name, nsOnly.ns_name],
            ["Lintang Inv", null, null, "Aris Inv"], "one shift");
        await fails(() => draft(DIRECTOR, { title: "  " }), "PT422", /short title/);
        await fails(() => draft(DIRECTOR, { site_id: null }), "PT422", /choose the site/);
        await fails(() => draft(DIRECTOR, { event_at: "" }), "PT422", /date and time/);
    });

    await step("investigations: the people picker lists the active monitoring team only", async () => {
        const list = await j(PETER, `public.investigations_people()`);
        const ids = list.map((p) => p.id);
        for (const id of [E.LINTANG, E.ARIS, E.NESSY]) if (!ids.includes(id)) throw new Error(`missing ${id}`);
        for (const id of [E.GONE, E.MARK, E.DIRECTOR]) if (ids.includes(id)) throw new Error(`listed ${id}`);
    });

    // ── active_until ────────────────────────────────────────────────────

    await step("investigations: active_until follows the policy's periods", async () => {
        const r = await db.query(`select
            public.investigations_active_until('verbal_warning', '2026-09-28', null)::text v,
            public.investigations_active_until('written_warning', '2026-09-28', null)::text w,
            public.investigations_active_until('suspension', '2026-09-28', 3)::text s,
            public.investigations_active_until('suspension', '2026-09-28', 1)::text s1,
            public.investigations_active_until('no_action', '2026-09-28', null)::text n,
            public.investigations_active_until('further_action', '2026-09-28', null)::text f,
            public.investigations_active_until('verbal_warning', '2026-11-30', null)::text edge,
            public.investigations_active_until('written_warning', '2026-08-31', null)::text edge6,
            public.investigations_active_until('verbal_warning', '2027-11-30', null)::text leap`);
        eq(r.rows[0], {
            v: "2026-12-28", w: "2027-03-28", s: "2026-09-30", s1: "2026-09-28", n: null, f: null,
            edge: "2027-02-28", edge6: "2027-02-28", leap: "2028-02-29",
        }, "periods");
    });

    await step("investigations: outcomes store the computed period and validate their terms", async () => {
        await reset();
        const inv = await draft(DIRECTOR);
        let d = await addOutcome(DIRECTOR, inv.id, {
            employee_id: E.LINTANG, decision: "verbal_warning", reason: "Late alarm", effective_from: "2026-11-30",
        });
        eq([d.outcomes[0].active_until, d.outcomes[0].decision_label], ["2027-02-28", "Verbal warning"], "verbal");
        await fails(() => addOutcome(DIRECTOR, inv.id, { employee_id: E.LINTANG, decision: "no_action" }),
            "PT409", /already has a decision/);
        await fails(() => addOutcome(DIRECTOR, inv.id, { employee_id: E.ARIS, decision: "suspension", reason: "x" }),
            "PT422", /suspension days/);
        await fails(() => addOutcome(DIRECTOR, inv.id,
            { employee_id: E.ARIS, decision: "suspension", reason: "x", suspension_days: 3 }), "PT422", /with or without pay/);
        await fails(() => addOutcome(DIRECTOR, inv.id, { employee_id: E.ARIS, decision: "further_action", reason: "x" }),
            "PT422", /further action/);
        await fails(() => addOutcome(DIRECTOR, inv.id, { employee_id: E.ARIS, decision: "written_warning" }),
            "PT422", /reason/);
        await fails(() => addOutcome(DIRECTOR, inv.id, { employee_id: E.ARIS, decision: "sacked", reason: "x" }),
            "PT422", /Discipline Policy/);
        d = await addOutcome(DIRECTOR, inv.id, {
            employee_id: E.ARIS, decision: "suspension", reason: "Radar left offline",
            effective_from: "2026-10-01", suspension_days: 5, suspension_paid: false,
        });
        const aris = d.outcomes.find((o) => o.employee_id === E.ARIS);
        eq([aris.active_until, aris.suspension_days, aris.suspension_paid], ["2026-10-05", 5, false], "suspension");
        d = await addOutcome(DIRECTOR, inv.id, {
            employee_id: E.NESSY, decision: "further_action", reason: "Serious", further_action_note: "Refer to HR",
            suspension_days: 4, suspension_paid: true,
        });
        const nessy = d.outcomes.find((o) => o.employee_id === E.NESSY);
        eq([nessy.active_until, nessy.suspension_days, nessy.suspension_paid, nessy.further_action_note],
            [null, null, null, "Refer to HR"], "further action");
        // A draft may leave the date empty: it becomes the issue date.
        d = await reviseOutcome(DIRECTOR, inv.id, nessy.id, { decision: "no_action" });
        const n2 = d.outcomes.find((o) => o.employee_id === E.NESSY);
        eq([n2.effective_from, n2.active_until, n2.further_action_note], [null, null, null], "no action");
        // Removing works on a draft.
        d = await j(DIRECTOR, `public.investigations_remove_outcome($1::uuid)`, [n2.id]);
        eq(d.outcomes.length, 2, "removed");
    });

    // ── Issue, visibility, responses ────────────────────────────────────

    let invId, lintangOutcome, arisOutcome;

    await step("investigations: a draft is invisible to its subjects", async () => {
        await reset();
        const inv = await draft(DIRECTOR);
        invId = inv.id;
        await addOutcome(DIRECTOR, invId, { employee_id: E.LINTANG, decision: "verbal_warning", reason: "Late alarm" });
        const d = await addOutcome(DIRECTOR, invId, { employee_id: E.ARIS, decision: "no_action" });
        lintangOutcome = d.outcomes.find((o) => o.employee_id === E.LINTANG).id;
        arisOutcome = d.outcomes.find((o) => o.employee_id === E.ARIS).id;
        eq(await mine(LINTANG), [], "draft visible");
        await fails(() => respond(LINTANG, lintangOutcome, "accepted"), "PT404");
        eq((await outbox("investigation_issued")).length, 0, "emails before issue");
    });

    await step("investigations: submitting needs a shift engineer, a result and a decision", async () => {
        const bare = await draft(DIRECTOR, { ds_employee_id: null, ns_employee_id: null, investigation_result: "" });
        await fails(() => submit(DIRECTOR, bare.id), "PT422", /at least one/);
        await edit(DIRECTOR, bare.id, { ...bare, ns_employee_id: E.NESSY });
        await fails(() => submit(DIRECTOR, bare.id), "PT422", /investigation result/);
        await edit(DIRECTOR, bare.id, { ...bare, ns_employee_id: E.NESSY, investigation_result: "Result" });
        await fails(() => submit(DIRECTOR, bare.id), "PT422", /at least one decision/);
        await j(DIRECTOR, `public.investigations_delete($1::uuid)`, [bare.id]);
        await fails(() => j(DIRECTOR, `public.investigations_issue($1::uuid)`, [invId]), "PT409", /Submit/);
    });

    await step("investigations: submitting puts the case in review and emails the other investigators", async () => {
        const d = await submit(DIRECTOR, invId);
        eq([d.status, d.submitted_by_id], ["in_review", DIRECTOR], "in review");
        eq((await outbox("investigation_review")).map((m) => m.to_email), [MAIL.PETER], "review email");
        await fails(() => submit(DIRECTOR, invId), "PT409");
        // Read-only while in review, bar the discussion.
        await fails(() => edit(PETER, invId, d), "PT409", /in review/);
        await fails(() => reviseOutcome(PETER, invId, lintangOutcome, { decision: "no_action" }), "PT409", /in review/);
        await fails(() => j(PETER, `public.investigations_remove_outcome($1::uuid)`, [arisOutcome]), "PT409");
        await comment(DIRECTOR, invId, "Peter, the console logs are attached to the ticket.");
        eq(await mine(LINTANG), [], "in review, invisible");
        eq((await j(PETER, `public.investigations_waiting()`)).reviews.map((x) => x.reference), ["INV-0001"], "Peter to review");
        eq((await j(DIRECTOR, `public.investigations_waiting()`)).reviews, [], "not her own");
    });

    await step("investigations: nobody approves or sends back their own submission", async () => {
        await fails(() => approve(DIRECTOR, invId), "PT403", /another investigator/);
        await fails(() => sendBack(DIRECTOR, invId, "Needs work"), "PT403", /another investigator/);
        await fails(() => approve(MARK, invId), "PT404");
    });

    await step("investigations: sending back needs a note, posts it and emails the submitter", async () => {
        await fails(() => sendBack(PETER, invId, "  "), "PT422", /what needs to change/);
        const d = await sendBack(PETER, invId, "Add the radar's alarm log.");
        eq(d.status, "changes_requested", "sent back");
        eq(d.comments.map((c) => c.body),
            ["Peter, the console logs are attached to the ticket.", "Sent back for changes: Add the radar's alarm log."],
            "thread");
        eq(d.comments[1].author_name, "Peter Saunders", "author");
        eq((await outbox("investigation_sent_back")).map((m) => m.to_email), [MAIL.DIRECTOR], "sent-back email");
        eq((await j(DIRECTOR, `public.investigations_waiting()`)).sent_back.map((x) => x.reference), ["INV-0001"], "sent back");
        eq(await mine(LINTANG), [], "sent back, invisible");
        // Editable again, then resubmitted.
        await edit(DIRECTOR, invId, { ...d, findings: "Alarm log added." });
        await reviseOutcome(DIRECTOR, invId, lintangOutcome,
            { employee_id: E.LINTANG, decision: "verbal_warning", reason: "Late alarm" });
        eq((await submit(DIRECTOR, invId)).status, "in_review", "resubmitted");
        eq((await outbox("investigation_issued")).length, 0, "no subject email before approval");
    });

    await step("investigations: the discussion is the investigators' only", async () => {
        for (const uid of [MARK, HIMAWAN, RINA, LINTANG]) {
            await fails(() => comment(uid, invId, "hello"), "PT404");
            await fails(() => j(uid, `public.investigations_get($1::uuid)`, [invId]), "PT404");
        }
        await fails(() => comment(PETER, invId, " "), "PT422");
        await fails(() => comment(PETER, invId, "x".repeat(4001)), "PT422");
        const d = await comment(PETER, invId, "Looks right now.");
        eq(d.comments.length, 3, "thread length");
    });

    await step("investigations: approval by the other investigator issues and emails each subject", async () => {
        const d = await approve(PETER, invId);
        eq(d.status, "issued", "status");
        eq([d.approved_by_id, d.approved_by_name], [PETER, "Peter Saunders"], "approved by");
        if (!d.approved_at || !d.issued_at) throw new Error("approval not dated");
        const today = (await db.query(`select public.local_today()::text t`)).rows[0].t;
        const l = d.outcomes.find((o) => o.id === lintangOutcome);
        eq([l.effective_from, l.response_status], [today, "pending"], "effective from");
        const expected = (await db.query(`select (public.local_today() + interval '3 months')::date::text t`)).rows[0].t;
        eq(l.active_until, expected, "active until");
        const mails = await outbox("investigation_issued");
        eq(mails.map((m) => m.to_email), [MAIL.ARIS, MAIL.LINTANG], "recipients");
        eq(mails.find((m) => m.to_email === MAIL.LINTANG).link_path, `/employees/${E.LINTANG}?tab=conduct`, "link");
        await fails(() => submit(PETER, invId), "PT409", /cannot be submitted/);
        await fails(() => approve(PETER, invId), "PT409", /not waiting for review/);
        await fails(() => j(PETER, `public.investigations_delete($1::uuid)`, [invId]), "PT409", /Only a draft/);
        await fails(() => j(PETER, `public.investigations_remove_outcome($1::uuid)`, [arisOutcome]), "PT409");
    });

    await step("investigations: an issued outcome is visible to its own subject only", async () => {
        const l = await mine(LINTANG);
        eq(l.length, 1, "Lintang's count");
        eq([l[0].id, l[0].reference, l[0].decision, l[0].can_respond], [lintangOutcome, "INV-0001", "verbal_warning", true],
            "Lintang's outcome");
        for (const k of ["findings", "technical_summary", "outcomes", "employee_id"])
            if (k in l[0]) throw new Error(`subject sees ${k}`);
        eq(l[0].investigation_result, "Late response to an amber alarm.", "result shown");
        const a = await mine(ARIS);
        eq(a.map((o) => o.id), [arisOutcome], "Aris sees only his");
        eq(await mine(NESSY), [], "non-subject");
        eq(await mine(RINA), [], "staff");
        eq(await mine(DIRECTOR), [], "director has none of her own");
        await fails(() => respond(ARIS, lintangOutcome, "accepted"), "PT404");
        await fails(() => respond(NESSY, lintangOutcome, "accepted"), "PT404");
    });

    await step("investigations: responses are acknowledge, accept or dispute, once", async () => {
        await fails(() => respond(LINTANG, lintangOutcome, "whatever"), "PT422");
        await fails(() => respond(LINTANG, lintangOutcome, "disputed"), "PT422", /at least 10/);
        await fails(() => respond(LINTANG, lintangOutcome, "disputed", "too short"), "PT422", /at least 10/);
        await fails(() => respond(LINTANG, lintangOutcome, "disputed", "x".repeat(2001)), "PT422", /2,000/);
        const a = await respond(ARIS, arisOutcome, "acknowledged");
        eq([a.response_status, a.can_respond], ["acknowledged", false], "acknowledged");
        await fails(() => respond(ARIS, arisOutcome, "accepted"), "PT409", /already responded/);
        const l = await respond(LINTANG, lintangOutcome, "disputed", "The alarm never reached my console.");
        eq([l.response_status, l.response_text], ["disputed", "The alarm never reached my console."], "disputed");
        await fails(() => respond(LINTANG, lintangOutcome, "accepted"), "PT409");
    });

    await step("investigations: a dispute emails the investigators, not Mark", async () => {
        const mails = await outbox("investigation_disputed");
        eq(mails.map((m) => m.to_email), [MAIL.DIRECTOR, MAIL.PETER], "dispute recipients");
        if (!mails[0].link_path.startsWith("/investigations")) throw new Error(mails[0].link_path);
        const w = await j(DIRECTOR, `public.investigations_waiting()`);
        eq(w.disputes.map((x) => [x.reference, x.name]), [["INV-0001", "Lintang"]], "waiting disputes");
        const m = await j(MARK, `public.investigations_waiting()`);
        eq(m.disputes, [], "Mark has none");
    });

    await step("investigations: a resolution note answers the dispute", async () => {
        await fails(() => j(DIRECTOR, `public.investigations_resolve($1::uuid, '  ')`, [lintangOutcome]), "PT422");
        await fails(() => j(MARK, `public.investigations_resolve($1::uuid, 'no')`, [lintangOutcome]), "PT404");
        const d = await j(DIRECTOR, `public.investigations_resolve($1::uuid, 'Console logs show it arrived.')`,
            [lintangOutcome]);
        eq(d.outcomes.find((o) => o.id === lintangOutcome).resolution_note, "Console logs show it arrived.", "note");
        eq((await j(DIRECTOR, `public.investigations_waiting()`)).disputes, [], "answered");
        const l = await mine(LINTANG);
        eq(l[0].resolution_note, "Console logs show it arrived.", "subject reads the answer");
    });

    await step("investigations: revising an outcome resets the response and emails again", async () => {
        const before = (await outbox("investigation_revised")).length;
        // Unchanged terms: no reset, no email.
        let d = await reviseOutcome(PETER, invId, arisOutcome, { employee_id: E.ARIS, decision: "no_action" });
        eq(d.outcomes.find((o) => o.id === arisOutcome).response_status, "acknowledged", "unchanged");
        eq((await outbox("investigation_revised")).length, before, "no email for no change");
        d = await reviseOutcome(PETER, invId, lintangOutcome, {
            employee_id: E.LINTANG, decision: "written_warning", reason: "Late alarm, second time",
            effective_from: "2026-09-28",
        });
        const l = d.outcomes.find((o) => o.id === lintangOutcome);
        eq([l.decision, l.active_until, l.response_status, l.response_text],
            ["written_warning", "2027-03-28", "pending", null], "revised");
        if (!l.revised_at) throw new Error("revised_at not set");
        eq((await outbox("investigation_revised")).map((m) => m.to_email), [MAIL.LINTANG], "revision email");
        await fails(() => reviseOutcome(PETER, invId, lintangOutcome, { employee_id: E.NESSY, decision: "no_action" }),
            "PT409", /cannot be changed/);
        const w = await j(LINTANG, `public.investigations_waiting()`);
        eq(w.respond.map((x) => x.reference), ["INV-0001"], "waiting on Lintang");
        const again = await respond(LINTANG, lintangOutcome, "accepted");
        eq(again.response_status, "accepted", "responds again after revision");
        eq((await j(LINTANG, `public.investigations_waiting()`)).respond, [], "nothing waiting");
    });

    await step("investigations: closing makes the case read-only until reopened", async () => {
        const d = await j(DIRECTOR, `public.investigations_close($1::uuid)`, [invId]);
        eq(d.status, "closed", "closed");
        await fails(() => edit(DIRECTOR, invId, { ...d }), "PT409", /Reopen/);
        await fails(() => reviseOutcome(DIRECTOR, invId, arisOutcome, { decision: "no_action" }), "PT409", /Reopen/);
        await fails(() => j(DIRECTOR, `public.investigations_close($1::uuid)`, [invId]), "PT409");
        // Still on the subject's profile, but no longer answerable.
        const l = await mine(LINTANG);
        eq([l.length, l[0].can_respond, l[0].case_status], [1, false, "closed"], "closed on profile");
        const r = await j(PETER, `public.investigations_reopen($1::uuid)`, [invId]);
        eq(r.status, "issued", "reopened");
        await fails(() => j(PETER, `public.investigations_reopen($1::uuid)`, [invId]), "PT409");
    });

    await step("investigations: activity is logged for create, issue, revise, respond and close", async () => {
        const r = await db.query(`select distinct action from public.activity_logs where action like 'INVESTIGATION_%'`);
        const got = r.rows.map((x) => x.action);
        for (const a of ["INVESTIGATION_CREATED", "INVESTIGATION_ISSUED", "INVESTIGATION_REVISED",
                         "INVESTIGATION_RESPONDED", "INVESTIGATION_CLOSED"])
            if (!got.includes(a)) throw new Error(`missing ${a}`);
    });

    await step("investigations: an investigator with email off is not emailed a dispute", async () => {
        await db.query(`update public.users set email_notifications = false where id = $1`, [PETER]);
        try {
            const inv = await draft(DIRECTOR);
            const d = await addOutcome(DIRECTOR, inv.id, { employee_id: E.NESSY, decision: "verbal_warning", reason: "x" });
            await issue(DIRECTOR, inv.id);
            await db.exec(`delete from public.email_outbox where kind = 'investigation_disputed'`);
            await respond(NESSY, d.outcomes[0].id, "disputed", "I was not on shift that night.");
            eq((await outbox("investigation_disputed")).map((m) => m.to_email), [MAIL.DIRECTOR], "opted out");
        } finally {
            await db.query(`update public.users set email_notifications = true where id = $1`, [PETER]);
        }
    });

    // ── Sites ───────────────────────────────────────────────────────────

    await step("investigations: investigators manage sites", async () => {
        await fails(() => j(MARK, `public.investigations_save_site(null, 'Grasberg', 'Freeport', true, null)`), "PT404");
        let s = await j(PETER, `public.investigations_save_site(null, 'Grasberg', 'Freeport', true, null)`);
        const g = s.find((x) => x.name === "Grasberg");
        if (!g || g.client !== "Freeport") throw new Error(JSON.stringify(s));
        await fails(() => j(PETER, `public.investigations_save_site(null, 'grasberg', null, true, null)`), "PT409");
        s = await j(PETER, `public.investigations_save_site($1::uuid, 'Grasberg Block Cave', 'Freeport', false, null)`, [g.id]);
        eq(s.find((x) => x.id === g.id).is_active, false, "deactivated");
        await fails(() => draft(DIRECTOR, { site_id: g.id }), "PT422", /no longer an active site/);
    });

    // ── Settings ────────────────────────────────────────────────────────

    await step("investigations: only the platform administrator sets the two flags", async () => {
        for (const uid of [PETER, MARK, HIMAWAN, RINA]) {
            await fails(() => j(uid, `public.investigations_team_settings()`), "PT403");
            await fails(() => j(uid, `public.investigations_set_flag($1::uuid, 'can_investigate', true)`, [E.MARK]), "PT403");
        }
        const list = await j(DIRECTOR, `public.investigations_team_settings()`);
        const n = list.find((x) => x.id === E.NESSY);
        eq([n.is_monitoring_team, n.can_investigate], [true, false], "Nessy");
        if (list.some((x) => x.id === E.GONE)) throw new Error("inactive listed");
        await fails(() => j(DIRECTOR, `public.investigations_set_flag($1::uuid, 'is_superuser', true)`, [E.MARK]), "PT422");
        const m = await j(DIRECTOR, `public.investigations_set_flag($1::uuid, 'can_investigate', true)`, [E.MARK]);
        eq(m.can_investigate, true, "Mark flagged");
        eq((await j(MARK, `public.bootstrap_session()`)).can_investigate, true, "session follows");
        await j(MARK, `public.investigations_list()`);
        await j(DIRECTOR, `public.investigations_set_flag($1::uuid, 'can_investigate', false)`, [E.MARK]);
        await fails(() => j(MARK, `public.investigations_list()`), "PT404");
        await j(DIRECTOR, `public.investigations_set_flag($1::uuid, 'is_monitoring_team', false)`, [E.NESSY]);
        await fails(() => draft(DIRECTOR, { ds_employee_id: E.NESSY }), "PT422", /monitoring team/);
        await j(DIRECTOR, `public.investigations_set_flag($1::uuid, 'is_monitoring_team', true)`, [E.NESSY]);
    });

    await step("investigations: the backfill moves on-duty and handover into DS and NS by the WIB hour", async () => {
        await reset();
        const mk = (ref, at, onDuty, handover) => db.query(
            `insert into public.investigations (reference, event_at, site_id, title, on_duty_employee_id,
                                                handover_employee_id, status)
             values ($1, $2::timestamptz, $3, 'Old case', $4, $5, 'draft') returning id`,
            [ref, at, HV, onDuty, handover]);
        const day = (await mk("INV-0901", "2026-09-10T10:00:00+07:00", E.LINTANG, E.ARIS)).rows[0].id;
        const night = (await mk("INV-0902", "2026-09-10T20:30:00+07:00", E.LINTANG, E.ARIS)).rows[0].id;
        const early = (await mk("INV-0903", "2026-09-10T05:59:00+07:00", E.LINTANG, null)).rows[0].id;
        const six = (await mk("INV-0904", "2026-09-10T06:00:00+07:00", E.LINTANG, null)).rows[0].id;
        const hoOnly = (await mk("INV-0905", "2026-09-10T22:00:00+07:00", null, E.ARIS)).rows[0].id;
        await db.query(`select public.investigations_backfill_shifts()`);
        const r = await db.query(`select id, ds_employee_id ds, ns_employee_id ns from public.investigations`);
        const by = Object.fromEntries(r.rows.map((x) => [x.id, [x.ds, x.ns]]));
        eq(by[day], [E.LINTANG, E.ARIS], "day: on duty to DS, handover to NS");
        eq(by[night], [E.ARIS, E.LINTANG], "night: on duty to NS, handover to DS");
        eq(by[early], [null, E.LINTANG], "05:59 is night");
        eq(by[six], [E.LINTANG, null], "06:00 is day");
        eq(by[hoOnly], [E.ARIS, null], "handover alone takes the free slot");
        await fails(() => tx(DIRECTOR, `select public.investigations_backfill_shifts()`), null, /permission denied/);
    });

    await step("investigations: clients cannot read or write the tables directly", async () => {
        for (const t of ["investigations", "investigation_outcomes", "monitoring_sites", "investigation_comments"]) {
            await fails(() => tx(LINTANG, `select * from public.${t}`), null, /permission denied/);
            await fails(() => tx(DIRECTOR, `delete from public.${t}`), null, /permission denied/);
        }
    });

    // Leave nothing behind for the suites that follow: the director has no
    // employee record in the seed, and later suites add their own.
    await reset();
    await db.exec(`
        delete from public.monitoring_sites where name like 'Grasberg%';
        delete from public.employees where id = '${E.DIRECTOR}';
        update public.employees set can_investigate = false where user_id = '${PETER}';
    `);
};
