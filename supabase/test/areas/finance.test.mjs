// Finance requests (20260926000800). Ported from the FastAPI line's
// tests/test_finance_requests.py, plus the permission edges of each route.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN, RINA } = people;

    const REQUEST = {
        title: "October petty cash and statutory payments",
        due_date: "2026-10-10",
        items: [
            { category: "petty_cash", description: "Office petty cash", amount: 2_000_000 },
            { category: "tax", description: "PPh 21, September", amount: 16_680_801 },
            { category: "bpjs", description: "BPJS Ketenagakerjaan, September", amount: 11_893_323 },
        ],
    };

    const call = async (uid, fn, args = []) => {
        const ph = args.map((_, i) => `$${i + 1}`).join(", ");
        const r = await tx(uid, `select public.${fn}(${ph}) j`, args);
        return r.rows[0].j;
    };
    const expectError = async (p, code, re) => {
        try {
            await p;
        } catch (e) {
            if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
            if (re && !re.test(e.message)) throw new Error(`wrong message: ${e.message}`);
            return;
        }
        throw new Error("expected a raise");
    };
    const create = (uid = HIMAWAN, body = REQUEST) => call(uid, "finance_create", [JSON.stringify(body)]);
    const raise = async () => {
        const r = await create();
        return call(HIMAWAN, "finance_submit", [r.id]);
    };
    const setFinal = (on) => call(DIRECTOR, "finance_settings_update", [on]);

    // A clean slate for this suite's references.
    await db.exec(`delete from public.finance_requests`);

    await step("finance: the total is the sum of the lines, FR-0001 first", async () => {
        const r = await create();
        if (r.reference !== "FR-0001") throw new Error(`reference ${r.reference}`);
        if (Math.abs(r.total - 30_574_124) > 1e-6) throw new Error(`total ${r.total}`);
        if (r.status !== "draft" || r.is_editable !== true) throw new Error(`${r.status}/${r.is_editable}`);
        if (r.items.length !== 3 || r.items[0].category !== "petty_cash") throw new Error("items out of order");
        if (r.due_date !== "2026-10-10") throw new Error(`due_date ${r.due_date}`);
        if (r.requested_by_name !== "Himawan") throw new Error(`requested_by_name ${r.requested_by_name}`);
        for (const k of ["notes", "submitted_at", "reviewed_by_name", "approved_at", "revision_note",
                         "paid_on", "payment_note", "awaiting", "documents", "created_at"])
            if (!(k in r)) throw new Error(`missing ${k}`);
        const log = await db.query(`select description from public.activity_logs
            where action = 'FINANCE_REQUEST_DRAFTED' and target_id = $1`, [r.id]);
        if (log.rows[0]?.description !== `Drafted FR-0001: ${REQUEST.title}`) throw new Error("not logged");
    });

    await step("finance: references compare as numbers, not text", async () => {
        await db.exec(`insert into public.finance_requests (reference, title) values
            ('FR-9999', 'nine'), ('FR-10000', 'ten thousand')`);
        const r = await create();
        if (r.reference !== "FR-10001") throw new Error(`reference ${r.reference}`);
        await db.exec(`delete from public.finance_requests where reference in ('FR-9999','FR-10000','FR-10001')`);
    });

    await step("finance: the full chain, director then executive then paid", async () => {
        let r = await raise();
        if (r.awaiting !== "director" || r.is_editable !== false) throw new Error(`${r.awaiting}/${r.is_editable}`);
        r = await call(DIRECTOR, "finance_review", [r.id]);
        if (r.status !== "endorsed" || r.awaiting !== "executive") throw new Error(`${r.status}/${r.awaiting}`);
        r = await call(PETER, "finance_approve", [r.id]);
        if (r.status !== "approved" || r.approved_by_name !== "Peter Saunders") throw new Error(`${r.status}/${r.approved_by_name}`);
        r = await call(HIMAWAN, "finance_mark_paid", [r.id, "2026-10-08", "BCA transfer"]);
        if (r.status !== "paid" || r.paid_on !== "2026-10-08" || r.payment_note !== "BCA transfer")
            throw new Error(`${r.status}/${r.paid_on}/${r.payment_note}`);
        const log = await db.query(`select description from public.activity_logs
            where action = 'FINANCE_REQUEST_PAID' and target_id = $1`, [r.id]);
        const want = `Paid ${r.reference} (${REQUEST.title}, IDR 30,574,124) on 08 October 2026`;
        if (log.rows[0]?.description !== want) throw new Error(`log: ${log.rows[0]?.description}`);
    });

    await step("finance: with the final say handed over, the director's review approves", async () => {
        const s = await setFinal(true);
        if (s.director_final_approval !== true) throw new Error("not saved");
        let r = await raise();
        r = await call(DIRECTOR, "finance_review", [r.id]);
        if (r.status !== "approved" || r.approved_by_name !== "HR Admin") throw new Error(`${r.status}/${r.approved_by_name}`);
        const list = await call(HIMAWAN, "finance_list");
        if (list.director_final_approval !== true) throw new Error("list does not say so");
        await setFinal(false);
    });

    await step("finance: only the platform admin changes the setting", async () => {
        await expectError(call(PETER, "finance_settings_update", [true]), "PT403",
            /Only the platform administrator can change this\./);
        await expectError(call(HIMAWAN, "finance_settings_update", [true]), "PT403");
        const s = await call(PETER, "finance_settings_get");
        if (s.director_final_approval !== false) throw new Error("changed anyway");
        await expectError(call(RINA, "finance_settings_get"), "PT404");
    });

    await step("finance: the executive sends back to the director, the director to finance", async () => {
        let r = await raise();
        await call(DIRECTOR, "finance_review", [r.id]);
        let back = await call(PETER, "finance_send_back", [r.id, "Check the BPJS figure with me.", "director"]);
        if (back.status !== "submitted" || back.awaiting !== "director") throw new Error(`${back.status}/${back.awaiting}`);
        if (back.revision_note !== "Check the BPJS figure with me.") throw new Error(`note ${back.revision_note}`);
        if (back.reviewed_by_name !== null || back.reviewed_at !== null) throw new Error("review signature kept");

        back = await call(DIRECTOR, "finance_send_back", [r.id, "BPJS is August's.", "finance"]);
        if (back.status !== "changes_requested" || back.is_editable !== true) throw new Error(`${back.status}`);
        if (back.revision_by_name !== "HR Admin") throw new Error(`revision_by_name ${back.revision_by_name}`);

        const fixed = { ...REQUEST, items: REQUEST.items.slice(0, 2) };
        const upd = await call(HIMAWAN, "finance_update", [r.id, JSON.stringify(fixed)]);
        if (Math.abs(upd.total - 18_680_801) > 1e-6) throw new Error(`total ${upd.total}`);
        r = await call(HIMAWAN, "finance_submit", [r.id]);
        if (r.revision_note !== null) throw new Error("revision note survived the resubmit");
    });

    await step("finance: sending back an approved request clears both signatures", async () => {
        let r = await raise();
        await call(DIRECTOR, "finance_review", [r.id]);
        await call(PETER, "finance_approve", [r.id]);
        r = await call(PETER, "finance_send_back", [r.id, "Wrong month.", "finance"]);
        if (r.status !== "changes_requested" || r.approved_by_name !== null || r.approved_at !== null)
            throw new Error(`${r.status}/${r.approved_by_name}`);
    });

    await step("finance: send-back rules -- who, when, and a reason", async () => {
        const r = await raise();
        // Submitted: the executive is not who it waits on.
        await expectError(call(PETER, "finance_send_back", [r.id, "Not yet.", "finance"]), "PT403",
            /Only whoever it is waiting on can send it back\./);
        // Only the executive sends back to the director, and only once reviewed.
        await expectError(call(DIRECTOR, "finance_send_back", [r.id, "To me.", "director"]), "PT403",
            /Only the executive sends a request back to the director, once reviewed\./);
        await expectError(call(PETER, "finance_send_back", [r.id, "To her.", "director"]), "PT403");
        await expectError(call(HIMAWAN, "finance_send_back", [r.id, "Mine.", "finance"]), "PT403");
        await expectError(call(DIRECTOR, "finance_send_back", [r.id, "no", "finance"]), "PT422");
    });

    await step("finance: nobody acts out of turn", async () => {
        const r = await raise();
        await expectError(call(PETER, "finance_approve", [r.id]), "PT409",
            new RegExp(`${r.reference} is submitted; it cannot be approved now\\.`));
        await expectError(call(HIMAWAN, "finance_update", [r.id, JSON.stringify(REQUEST)]), "PT409",
            /is submitted; it cannot be edited now\./);
        await expectError(create(DIRECTOR), "PT403", /Only finance raises a request\./);
        await expectError(call(DIRECTOR, "finance_approve", [r.id]), "PT403", /Only the executive approves a request\./);
        await expectError(call(PETER, "finance_review", [r.id]), "PT403", /Only the director reviews a request\./);
        await expectError(call(HIMAWAN, "finance_mark_paid", [r.id, "2026-10-01", null]), "PT409",
            /cannot be marked paid now/);
        await expectError(call(HIMAWAN, "finance_delete", [r.id]), "PT409", /cannot be discarded now/);
    });

    await step("finance: staff see nothing (404)", async () => {
        await expectError(call(RINA, "finance_list"), "PT404", /^Not found$/);
        const r = await create();
        await expectError(call(RINA, "finance_get", [r.id]), "PT404");
        await expectError(create(RINA), "PT404");
        const d = await call(PETER, "finance_get", [r.id]);
        if (d.id !== r.id) throw new Error("executive cannot read it");
        await expectError(call(PETER, "finance_get", ["00000000-0000-0000-0000-00000000f000"]), "PT404");
    });

    await step("finance: can_create is finance's alone", async () => {
        const h = await call(HIMAWAN, "finance_list");
        const p = await call(PETER, "finance_list");
        if (h.can_create !== true || p.can_create !== false) throw new Error(`${h.can_create}/${p.can_create}`);
        if (!Array.isArray(h.items) || h.items.length < 1) throw new Error("no items");
        const times = h.items.map((x) => x.created_at);
        if ([...times].sort().reverse().join() !== times.join()) throw new Error("not newest first");
    });

    await step("finance: a discarded draft frees no number behind the highest", async () => {
        const a = await create();
        const b = await create();
        const paths = await call(HIMAWAN, "finance_delete", [a.id]);
        if (!Array.isArray(paths)) throw new Error("no path list");
        await expectError(call(HIMAWAN, "finance_get", [a.id]), "PT404");
        const next = await create();
        const n = (ref) => Number(ref.split("-")[1]);
        if (n(next.reference) !== n(b.reference) + 1) throw new Error(`${b.reference} -> ${next.reference}`);
        await expectError(call(DIRECTOR, "finance_delete", [next.id]), "PT403", /Only finance discards a request\./);
    });

    await step("finance: validation of the body", async () => {
        await expectError(create(HIMAWAN, { ...REQUEST, title: "ab" }), "PT422");
        await expectError(create(HIMAWAN, { ...REQUEST, items: [] }), "PT422");
        await expectError(create(HIMAWAN, { ...REQUEST, items: [{ category: "tax", description: "x", amount: 0 }] }), "PT422");
        await expectError(create(HIMAWAN, { ...REQUEST, items: [{ category: "bribes", description: "x", amount: 1 }] }), "PT422");
        await expectError(create(HIMAWAN, { ...REQUEST, extra: 1 }), "PT422");
        const r = await create(HIMAWAN, { title: "  Petty cash  ", notes: "   ", items: [
            { category: "other", description: "  Stamps ", amount: 10.005 },
            { category: "other", description: "Paper", amount: 20.1 }] });
        if (r.title !== "Petty cash" || r.notes !== null || r.due_date !== null) throw new Error(JSON.stringify(r));
        if (r.items[0].description !== "Stamps") throw new Error("description not stripped");
        if (Math.abs(r.total - 30.11) > 1e-9) throw new Error(`total ${r.total}`);
    });

    await step("finance: documents are kept on the request, removable while editable", async () => {
        const r = await create();
        const path = `${r.id}/doc/pph21.pdf`;
        let out = await call(HIMAWAN, "finance_document_add", [r.id, "pph21.pdf", "application/pdf", 17, path]);
        if (out.documents.length !== 1) throw new Error("not attached");
        const doc = out.documents[0];
        if (doc.filename !== "pph21.pdf" || doc.byte_size !== 17 || "storage_path" in doc) throw new Error(JSON.stringify(doc));
        const info = await call(PETER, "finance_document_get", [r.id, doc.id]);
        if (info.storage_path !== path || info.content_type !== "application/pdf") throw new Error(JSON.stringify(info));
        await expectError(call(RINA, "finance_document_get", [r.id, doc.id]), "PT404");
        await expectError(call(PETER, "finance_document_get", [DIRECTOR, doc.id]), "PT404");
        await expectError(call(PETER, "finance_document_add", [r.id, "x.pdf", "application/pdf", 5, "p"]), "PT403",
            /Only finance attaches documents\./);

        await expectError(call(HIMAWAN, "finance_document_add", [r.id, "x.exe", "application/x-msdownload", 5, "p"]),
            "PT415", /Upload a PDF, an image, or a Word document\./);
        await expectError(call(HIMAWAN, "finance_document_add", [r.id, "x.pdf", "application/pdf", 0, "p"]),
            "PT400", /That file is empty\./);
        await expectError(call(HIMAWAN, "finance_document_add", [r.id, "x.pdf", "application/pdf", 12 * 1024 * 1024, "p"]),
            "PT413", /That file is 12 MB\. The limit is 10 MB\./);

        // Submitted: still attachable, no longer removable.
        await call(HIMAWAN, "finance_submit", [r.id]);
        out = await call(HIMAWAN, "finance_document_add", [r.id, "receipt.png", "image/png", 3, `${r.id}/doc2/receipt.png`]);
        if (out.documents.length !== 2) throw new Error("second not attached");
        await expectError(call(HIMAWAN, "finance_document_delete", [r.id, doc.id]), "PT409", /cannot be changed now/);

        await call(DIRECTOR, "finance_send_back", [r.id, "Attach the tax slip.", "finance"]);
        const del = await call(HIMAWAN, "finance_document_delete", [r.id, doc.id]);
        if (del.storage_path !== path || del.request.documents.length !== 1) throw new Error(JSON.stringify(del));
        await expectError(call(HIMAWAN, "finance_document_delete", [r.id, doc.id]), "PT404");
    });

    await step("finance: tables are closed to direct reads", async () => {
        // No policies: either no privilege at all, or RLS hides every row.
        try {
            const r = await tx(HIMAWAN, `select count(*)::int n from public.finance_requests`);
            if (r.rows[0].n !== 0) throw new Error(`saw ${r.rows[0].n} rows`);
        } catch (e) {
            if (!/permission denied/.test(e.message)) throw e;
        }
    });
};
