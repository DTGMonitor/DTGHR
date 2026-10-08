// Contracts & POs under Finance (20260929000100): finance reads and manages,
// purchase orders and their documents, the "coming up" windows, linking a PO
// to a contract, and the once-per-threshold renewal emails.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, HIMAWAN, RINA } = people;

    const plus = async (n) =>
        (await db.query(`select (public.local_today() + $1::int)::text d`, [n])).rows[0].d;

    const expectRaise = async (fn, code, pattern) => {
        try {
            await fn();
        } catch (e) {
            if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
            if (pattern && !pattern.test(e.message)) throw new Error(`wrong message: ${e.message}`);
            return;
        }
        throw new Error("expected a raise");
    };

    const j = (r) => r.rows[0].j;
    const createContract = (uid, body) =>
        tx(uid, `select public.contracts_create($1::jsonb) j`, [JSON.stringify(body)]).then(j);
    const createPo = (uid, body) =>
        tx(uid, `select public.purchase_orders_create($1::jsonb) j`, [JSON.stringify(body)]).then(j);
    const updatePo = (uid, id, body) =>
        tx(uid, `select public.purchase_orders_update($1::uuid, $2::jsonb) j`, [id, JSON.stringify(body)]).then(j);
    const list = (uid, args = {}) =>
        tx(uid, `select public.purchase_orders_list($1, $2::uuid, $3, $4::date, $5::date, $6) j`, [
            args.client ?? null, args.contract_id ?? null, args.status ?? null,
            args.from ?? null, args.to ?? null, args.sort ?? null,
        ]).then(j);
    const comingUp = (uid) => tx(uid, `select public.contracts_coming_up() j`).then((r) => j(r).items);

    let harmony; // a client contract, the account
    let po1;

    await step("po: a plain employee gets 404 on POs and on what is coming up", async () => {
        await expectRaise(() => list(RINA), "PT404", /^Not found$/);
        await expectRaise(() => comingUp(RINA), "PT404", /^Not found$/);
        await expectRaise(() => tx(RINA, `select public.purchase_orders_get(gen_random_uuid())`), "PT404", /^Not found$/);
        await expectRaise(() => createPo(RINA, { po_number: "X", client_name: "X", po_date: "2026-01-01" }),
            "PT403", /You are not set up to manage contracts\./);
    });

    await step("po: finance manages contracts and POs", async () => {
        harmony = await createContract(HIMAWAN, {
            kind: "client", title: "Harmony site monitoring", counterparty: "PT Harmony",
            end_date: await plus(21), currency: "USD",
        });
        const l = await list(HIMAWAN);
        if (l.can_manage !== true) throw new Error("finance cannot manage POs");
        po1 = await createPo(HIMAWAN, {
            contract_id: harmony.id, po_number: "4500123", po_date: "2026-07-01",
            start_date: "2026-07-01", end_date: await plus(14), value: 15000.5,
            description: "Monitoring Q3",
        });
        if (po1.client_name !== "PT Harmony") throw new Error(`client from contract: ${po1.client_name}`);
        if (po1.currency !== "USD") throw new Error(`currency from contract: ${po1.currency}`);
        if (po1.contract_title !== "Harmony site monitoring") throw new Error(`contract_title ${po1.contract_title}`);
        if (po1.status !== "active" || po1.value !== 15000.5 || po1.days_remaining !== 14) throw new Error(JSON.stringify(po1));
        if (po1.po_date !== "2026-07-01") throw new Error(`po_date ${po1.po_date}`);
        const log = await db.query(`select description from public.activity_logs
            where action = 'PO_CREATED' and target_id = $1`, [po1.id]);
        if (log.rows[0]?.description !== "Recorded PO 4500123 for PT Harmony") throw new Error(`log ${log.rows[0]?.description}`);
    });

    await step("po: management reads without managing; the flag manages", async () => {
        await db.exec(`update public.employees set is_management_role = true where user_id = '${RINA}'`);
        try {
            const l = await list(RINA);
            if (l.can_manage !== false) throw new Error("management can manage");
            if (!l.items.some((p) => p.id === po1.id)) throw new Error("not listed");
            await expectRaise(() => updatePo(RINA, po1.id, { notes: "x" }), "PT403");
        } finally {
            await db.exec(`update public.employees set is_management_role = false where user_id = '${RINA}'`);
        }
        await db.exec(`update public.employees set can_manage_contracts = true where user_id = '${RINA}'`);
        try {
            const p = await updatePo(RINA, po1.id, { notes: "Invoice monthly" });
            if (p.notes !== "Invoice monthly") throw new Error(`notes ${p.notes}`);
        } finally {
            await db.exec(`update public.employees set can_manage_contracts = false where user_id = '${RINA}'`);
        }
    });

    await step("po: required fields, dates and values answer 422", async () => {
        await expectRaise(() => createPo(DIRECTOR, { client_name: "A", po_date: "2026-01-01" }), "PT422", /po_number: Field required/);
        await expectRaise(() => createPo(DIRECTOR, { po_number: "  ", client_name: "A", po_date: "2026-01-01" }), "PT422", /po_number/);
        await expectRaise(() => createPo(DIRECTOR, { po_number: "1", po_date: "2026-01-01" }), "PT422", /client_name: Field required/);
        await expectRaise(() => createPo(DIRECTOR, { po_number: "1", client_name: "A" }), "PT422", /po_date: Field required/);
        await expectRaise(() => createPo(DIRECTOR, { po_number: "1", client_name: "A", po_date: "nope" }), "PT422", /po_date/);
        await expectRaise(() => createPo(DIRECTOR, { po_number: "1", client_name: "A", po_date: "2026-01-01",
            start_date: "2026-03-01", end_date: "2026-02-28" }), "PT422", /A PO cannot end before it starts\./);
        await expectRaise(() => createPo(DIRECTOR, { po_number: "1", client_name: "A", po_date: "2026-01-01", value: -1 }), "PT422");
        await expectRaise(() => createPo(DIRECTOR, { po_number: "1", client_name: "A", po_date: "2026-01-01", status: "open" }), "PT422");
        await expectRaise(() => createPo(DIRECTOR, { po_number: "1", client_name: "A", po_date: "2026-01-01", currency: "RP" }), "PT422");
        await expectRaise(() => createPo(DIRECTOR, { po_number: "1", po_date: "2026-01-01",
            contract_id: "99999999-9999-9999-9999-999999999999" }), "PT422", /That contract does not exist\./);
        const sub = await createContract(DIRECTOR, { kind: "subscription", title: "Zoom", end_date: await plus(300) });
        try {
            await expectRaise(() => createPo(DIRECTOR, { po_number: "1", client_name: "A", po_date: "2026-01-01", contract_id: sub.id }),
                "PT422", /A PO sits under a client contract\./);
        } finally {
            await tx(DIRECTOR, `select public.contracts_delete($1::uuid)`, [sub.id]);
        }
        // An edit that ends it before it starts is refused too.
        await expectRaise(() => updatePo(DIRECTOR, po1.id, { end_date: "2026-06-30" }), "PT422", /cannot end before it starts/);
    });

    let standalone;
    await step("po: the number is unique per client, whatever the case", async () => {
        await expectRaise(() => createPo(DIRECTOR, { po_number: " 4500123 ", client_name: "pt harmony", po_date: "2026-08-01" }),
            "PT409", /PO 4500123 is already recorded for pt harmony\./);
        standalone = await createPo(DIRECTOR, { po_number: "4500123", client_name: "Newmont Telfer", po_date: "2026-08-01" });
        if (standalone.contract_id !== null || standalone.currency !== "IDR") throw new Error(JSON.stringify(standalone));
        await expectRaise(() => updatePo(DIRECTOR, standalone.id, { client_name: "PT HARMONY" }), "PT409");
        // Keeping its own number is not a clash with itself.
        const same = await updatePo(DIRECTOR, standalone.id, { po_number: "4500123", description: "Ad hoc survey" });
        if (same.description !== "Ad hoc survey") throw new Error("update");
    });

    await step("po: list filters and sorts", async () => {
        const byClient = await list(DIRECTOR, { client: "telfer" });
        if (byClient.items.length !== 1 || byClient.items[0].id !== standalone.id) throw new Error("client filter");
        const byContract = await list(DIRECTOR, { contract_id: harmony.id });
        if (byContract.items.length !== 1 || byContract.items[0].id !== po1.id) throw new Error("contract filter");
        const byDate = await list(DIRECTOR, { from: "2026-07-15", to: "2026-08-15" });
        if (!byDate.items.some((p) => p.id === standalone.id) || byDate.items.some((p) => p.id === po1.id))
            throw new Error("date range");
        const newest = (await list(DIRECTOR, { client: "" })).items.filter((p) => [po1.id, standalone.id].includes(p.id));
        if (newest[0].id !== standalone.id) throw new Error("po_date sort: newest first");
        // By end date: po1 ends in 14 days, the standalone PO has no end -- last.
        const soonest = (await list(DIRECTOR, { sort: "end_date" })).items.filter((p) => [po1.id, standalone.id].includes(p.id));
        if (soonest[0].id !== po1.id) throw new Error("end_date sort");
        await expectRaise(() => list(DIRECTOR, { status: "open" }), "PT422");
        await expectRaise(() => list(DIRECTOR, { sort: "value" }), "PT422");
        const completed = await list(DIRECTOR, { status: "completed" });
        if (completed.items.some((p) => p.id === po1.id)) throw new Error("status filter");
    });

    await step("po: the contract lists its POs", async () => {
        const c = (await tx(HIMAWAN, `select public.contracts_list('client') j`).then(j)).items.find((x) => x.id === harmony.id);
        if (!c || c.purchase_orders.length !== 1 || c.purchase_orders[0].po_number !== "4500123")
            throw new Error(JSON.stringify(c?.purchase_orders));
    });

    // --- documents ----------------------------------------------------------
    const PDF = "application/pdf";
    const check = (uid, id, type, size) =>
        tx(uid, `select public.purchase_orders_check_document($1::uuid, $2, $3::bigint)`, [id, type, size]);
    const DOC = "d0d0d0d0-0000-0000-0000-000000000001";

    await step("po: documents are PDFs, images or Word, up to 10 MB, not empty", async () => {
        await expectRaise(() => check(HIMAWAN, po1.id, "text/plain", 1000), "PT415", /Upload a PDF, an image, or a Word document\./);
        await expectRaise(() => check(HIMAWAN, po1.id, PDF, 11 * 1024 * 1024 + 1), "PT413", /^That file is 11 MB\. The limit is 10 MB\.$/);
        await expectRaise(() => check(HIMAWAN, po1.id, PDF, 0), "PT400", /That file is empty\./);
        await expectRaise(() => check(RINA, po1.id, PDF, 1000), "PT403");
        await expectRaise(() => check(HIMAWAN, "99999999-9999-9999-9999-999999999999", PDF, 1000), "PT404");
        await check(HIMAWAN, po1.id, "image/png", 10 * 1024 * 1024);
    });

    await step("po: a document is recorded, fetched by a reader, and removed", async () => {
        const p = await tx(HIMAWAN, `select public.purchase_orders_add_document($1::uuid, $2::uuid, 'po-4500123.pdf', $3, 2048, $4) j`,
            [po1.id, DOC, PDF, `${po1.id}/${DOC}`]).then(j);
        if (p.documents.length !== 1 || p.documents[0].id !== DOC || p.documents[0].byte_size !== 2048) throw new Error(JSON.stringify(p.documents));
        const g = await tx(DIRECTOR, `select public.purchase_orders_get_document($1::uuid, $2::uuid) j`, [po1.id, DOC]).then(j);
        if (g.storage_path !== `${po1.id}/${DOC}` || g.content_type !== PDF) throw new Error(JSON.stringify(g));
        await expectRaise(() => tx(RINA, `select public.purchase_orders_get_document($1::uuid, $2::uuid)`, [po1.id, DOC]), "PT404");
        await expectRaise(() => tx(DIRECTOR, `select public.purchase_orders_get_document($1::uuid, $2::uuid)`, [standalone.id, DOC]), "PT404");
        await expectRaise(() => tx(RINA, `select public.purchase_orders_delete_document($1::uuid, $2::uuid)`, [po1.id, DOC]), "PT403");
        const d = await tx(HIMAWAN, `select public.purchase_orders_delete_document($1::uuid, $2::uuid) j`, [po1.id, DOC]).then(j);
        if (d.storage_path !== `${po1.id}/${DOC}` || d.purchase_order.documents.length !== 0) throw new Error(JSON.stringify(d));
        await expectRaise(() => tx(HIMAWAN, `select public.purchase_orders_delete_document($1::uuid, $2::uuid)`, [po1.id, DOC]), "PT404");
    });

    // --- coming up ------------------------------------------------------------
    const made = { contracts: [], pos: [] };
    await step("po: coming up -- contracts within 90 days, POs within 60, overdue unacknowledged", async () => {
        const c = async (title, days, extra = {}) => {
            const x = await createContract(DIRECTOR, { kind: "client", title, end_date: await plus(days), ...extra });
            made.contracts.push(x);
            return x;
        };
        const p = async (num, days, extra = {}) => {
            const x = await createPo(DIRECTOR, { po_number: num, client_name: "Window Co", po_date: "2026-01-01",
                end_date: days === null ? null : await plus(days), ...extra });
            made.pos.push(x);
            return x;
        };
        const c90 = await c("CU in 90", 90);
        const c91 = await c("CU in 91", 91);
        const cOver = await c("CU overdue", -5);
        const cAck = await c("CU overdue acknowledged", -5, { reminder_days: [30] });
        await tx(DIRECTOR, `select public.contracts_acknowledge($1::uuid, $2::uuid, 'Lapsed on purpose')`, [cAck.id, cAck.reminders[0].id]);
        const cRenewed = await c("CU renewed", 10);
        await tx(DIRECTOR, `select public.contracts_update($1::uuid, '{"status":"renewed"}'::jsonb)`, [cRenewed.id]);
        const p60 = await p("CU-60", 60);
        const p61 = await p("CU-61", 61);
        const pDone = await p("CU-DONE", 10, { status: "completed" });
        const pPast = await p("CU-PAST", -1);
        const pOpen = await p("CU-OPEN", null);

        const items = await comingUp(HIMAWAN);
        const ids = items.map((i) => i.id);
        for (const x of [c90, cOver, p60, po1]) if (!ids.includes(x.id)) throw new Error(`missing ${x.title ?? x.po_number}`);
        for (const x of [c91, cAck, cRenewed, p61, pDone, pPast, pOpen])
            if (ids.includes(x.id)) throw new Error(`should not list ${x.title ?? x.po_number}`);
        // Harmony itself (21 days) is there as a contract.
        const h = items.find((i) => i.id === harmony.id);
        if (!h || h.kind !== "contract" || h.days_remaining !== 21 || h.client !== "PT Harmony") throw new Error(JSON.stringify(h));
        const over = items.find((i) => i.id === cOver.id);
        if (over.overdue !== true || over.days_remaining !== -5) throw new Error(JSON.stringify(over));
        const po = items.find((i) => i.id === po1.id);
        if (po.kind !== "purchase_order" || po.label !== "4500123" || po.contract_id !== harmony.id || po.days_remaining !== 14)
            throw new Error(JSON.stringify(po));
        // Soonest first.
        const days = items.map((i) => i.days_remaining);
        if (days.some((d, i) => i > 0 && d < days[i - 1])) throw new Error(`order ${days}`);
    });

    // --- renewal emails ---------------------------------------------------------
    await step("po: renewal emails go once per item per threshold, to managers and finance", async () => {
        const recips = (await db.query(`select count(*)::int n from public.notifications_recipients(public.contracts_renewal_recipients(), '{}') where email_notifications`)).rows[0].n;
        if (recips < 1) throw new Error("nobody to email");
        const finance = (await db.query(`select $1::uuid = any(public.contracts_renewal_recipients()) f`, [HIMAWAN])).rows[0].f;
        if (!finance) throw new Error("finance not among the recipients");
        const rinaIn = (await db.query(`select $1::uuid = any(public.contracts_renewal_recipients()) f`, [RINA])).rows[0].f;
        if (rinaIn) throw new Error("a plain employee is emailed");

        const rows = async (id) =>
            (await db.query(`select subject, kind from public.email_outbox where source_id = $1`, [id])).rows;
        await db.query(`select public.contracts_send_renewal_notices()`);
        const first = await rows(po1.id);
        if (first.length !== recips) throw new Error(`po1 emails ${first.length}, expected ${recips}`);
        if (first[0].subject !== "PO 4500123 (PT Harmony) ends in 14 days" || first[0].kind !== "po_ending")
            throw new Error(first[0].subject);
        const h = await rows(harmony.id);
        if (h.length !== recips || h[0].subject !== "Contract with PT Harmony ends in 21 days") throw new Error(h[0]?.subject);
        // Nothing for the overdue, the 90-day one, or the one beyond 60 days.
        for (const x of made.contracts.filter((c) => ["CU overdue", "CU in 90"].includes(c.title)))
            if ((await rows(x.id)).length) throw new Error(`emailed ${x.title}`);

        await db.query(`select public.contracts_send_renewal_notices()`);
        if ((await rows(po1.id)).length !== recips) throw new Error("emailed twice at the same threshold");

        // A week later the PO crosses 7 days: one more.
        await db.query(`select public.contracts_send_renewal_notices(public.local_today() + 8)`);
        if ((await rows(po1.id)).length !== 2 * recips) throw new Error("not emailed at 7 days");
        await db.query(`select public.contracts_send_renewal_notices(public.local_today() + 9)`);
        if ((await rows(po1.id)).length !== 2 * recips) throw new Error("emailed again inside 7 days");

        await db.exec(`delete from public.email_outbox where source_table in ('contracts', 'purchase_orders')`);
        await db.exec(`delete from public.renewal_notices`);
    });

    // --- linking --------------------------------------------------------------
    await step("po: unlinking keeps the client; deleting the contract sets the link null", async () => {
        const un = await updatePo(HIMAWAN, po1.id, { contract_id: null });
        if (un.contract_id !== null || un.contract_title !== null || un.client_name !== "PT Harmony") throw new Error(JSON.stringify(un));
        const re = await updatePo(HIMAWAN, po1.id, { contract_id: harmony.id });
        if (re.contract_id !== harmony.id) throw new Error("relink");
        const del = await tx(HIMAWAN, `select public.contracts_delete($1::uuid) j`, [harmony.id]).then(j);
        if (!Array.isArray(del.storage_paths)) throw new Error("contract delete");
        const after = await tx(HIMAWAN, `select public.purchase_orders_get($1::uuid) j`, [po1.id]).then(j);
        if (after.contract_id !== null || after.po_number !== "4500123") throw new Error(JSON.stringify(after));
    });

    await step("po: deleting a PO answers its storage paths; managers only", async () => {
        await tx(HIMAWAN, `select public.purchase_orders_add_document($1::uuid, gen_random_uuid(), 'a.png', 'image/png', 10, 'po/a')`, [po1.id]);
        await expectRaise(() => tx(RINA, `select public.purchase_orders_delete($1::uuid)`, [po1.id]), "PT403");
        const r = await tx(HIMAWAN, `select public.purchase_orders_delete($1::uuid) j`, [po1.id]).then(j);
        if (JSON.stringify(r.storage_paths) !== '["po/a"]') throw new Error(JSON.stringify(r));
        const left = await db.query(`select count(*)::int n from public.purchase_order_documents where purchase_order_id = $1`, [po1.id]);
        if (left.rows[0].n !== 0) throw new Error("documents left");
        await expectRaise(() => tx(HIMAWAN, `select public.purchase_orders_delete($1::uuid)`, [po1.id]), "PT404");
        for (const p of [standalone, ...made.pos]) await tx(DIRECTOR, `select public.purchase_orders_delete($1::uuid)`, [p.id]);
        for (const c of made.contracts) await tx(DIRECTOR, `select public.contracts_delete($1::uuid)`, [c.id]);
    });

    await step("po: row level security is on for the new tables", async () => {
        const r = await db.query(`select relname, relrowsecurity from pg_class
            where relname in ('purchase_orders','purchase_order_documents','renewal_notices') and relkind = 'r'`);
        if (r.rows.length !== 3 || r.rows.some((x) => !x.relrowsecurity)) throw new Error(JSON.stringify(r.rows));
    });
};
