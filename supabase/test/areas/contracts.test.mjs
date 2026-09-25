// Contracts: who reads, who manages, reminders, acknowledgement, documents.
// Ported from app/api/routes/contracts.py and its schemas.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN, RINA } = people;

    const today = (await db.query(`select current_date::text d`)).rows[0].d;
    const plus = async (n) =>
        (await db.query(`select (current_date + $1::int)::text d`, [n])).rows[0].d;

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

    const create = (uid, body) =>
        tx(uid, `select public.contracts_create($1::jsonb) j`, [JSON.stringify(body)]).then((r) => r.rows[0].j);

    let client; // the client contract most checks build on
    let sub;

    await step("staff without the flag get 404 on the list", async () => {
        await expectRaise(() => tx(RINA, `select public.contracts_list(null)`), "PT404", /^Not found$/);
        await expectRaise(() => tx(HIMAWAN, `select public.contracts_list(null)`), "PT404", /^Not found$/);
    });

    await step("a reader without the flag cannot add a contract", async () => {
        await expectRaise(
            () => create(RINA, { kind: "subscription", title: "X", end_date: today }),
            "PT403", /You are not set up to manage contracts\./);
    });

    await step("administrators manage: client contract gets 60/42/30 by default", async () => {
        client = await create(DIRECTOR, {
            kind: "client", title: "Telfer", counterparty: "Newmont Telfer",
            start_date: "2025-01-01", end_date: await plus(45),
            amount: 1250000.5, currency: "AUD", billing_period: "monthly",
        });
        if (client.kind !== "client") throw new Error(`kind ${client.kind}`);
        if (client.status !== "active") throw new Error(`status ${client.status}`);
        if (client.days_remaining !== 45) throw new Error(`days_remaining ${client.days_remaining}`);
        if (client.amount !== 1250000.5) throw new Error(`amount ${client.amount}`);
        if (client.currency !== "AUD") throw new Error(`currency ${client.currency}`);
        if (client.start_date !== "2025-01-01") throw new Error(`start_date ${client.start_date}`);
        const days = client.reminders.map((r) => r.days_before).join(",");
        if (days !== "60,42,30") throw new Error(`reminders ${days}`);
        // 60 days before is 15 days ago: due. 42 is in 3 days, 30 in 15: not yet.
        const due = client.reminders.map((r) => r.is_due).join(",");
        if (due !== "true,false,false") throw new Error(`is_due ${due}`);
        if (client.reminders[0].due_on !== (await plus(-15))) throw new Error(`due_on ${client.reminders[0].due_on}`);
        if (client.open_reminders !== 1) throw new Error(`open_reminders ${client.open_reminders}`);
        if (!Array.isArray(client.documents) || client.documents.length !== 0) throw new Error("documents");
        const log = await db.query(`select description from public.activity_logs
            where action = 'CONTRACT_CREATED' and target_id = $1`, [client.id]);
        if (log.rows[0]?.description !== "Added a client contract for Telfer")
            throw new Error(`log ${log.rows[0]?.description}`);
    });

    await step("the executive manages too; subscription defaults to 30", async () => {
        sub = await create(PETER, { kind: "subscription", title: "TeamViewer", end_date: await plus(-3), amount: 0, currency: "EUR" });
        if (sub.reminders.length !== 1 || sub.reminders[0].days_before !== 30) throw new Error(JSON.stringify(sub.reminders));
        if (sub.days_remaining !== -3) throw new Error(`days_remaining ${sub.days_remaining}`);
        if (sub.open_reminders !== 1) throw new Error(`open ${sub.open_reminders}`);
    });

    await step("an explicit schedule is de-duplicated, furthest first", async () => {
        const c = await create(DIRECTOR, {
            kind: "manpower", title: "Agus Santoso", end_date: await plus(400),
            employee_id: "aaaaaaaa-0000-0000-0000-000000000001", reminder_days: [7, 30, 7, 90],
        });
        const days = c.reminders.map((r) => r.days_before).join(",");
        if (days !== "90,30,7") throw new Error(`reminders ${days}`);
        if (c.employee_id !== "aaaaaaaa-0000-0000-0000-000000000001") throw new Error("employee_id");
        if (c.amount !== null || c.counterparty !== null) throw new Error("nulls");
        if (c.currency !== "IDR") throw new Error(`currency ${c.currency}`);
        await tx(DIRECTOR, `select public.contracts_delete($1::uuid)`, [c.id]);
    });

    await step("schema rules answer 422 with the backend's words", async () => {
        await expectRaise(() => create(DIRECTOR, { kind: "client", title: "A", start_date: "2027-01-02", end_date: "2027-01-01" }),
            "PT422", /A contract cannot end before it starts\./);
        await expectRaise(() => create(DIRECTOR, { kind: "client", title: "A", end_date: "2027-01-01", reminder_days: [-1] }),
            "PT422", /A reminder cannot be a negative number of days\./);
        await expectRaise(() => create(DIRECTOR, { kind: "client", title: "A", end_date: "2027-01-01", reminder_days: [1, 2, 3, 4, 5, 6, 7, 8, 9] }),
            "PT422", /Eight reminders is plenty for one contract\./);
        await expectRaise(() => create(DIRECTOR, { kind: "client", title: "A", end_date: "2027-01-01", amount: -5 }), "PT422");
        await expectRaise(() => create(DIRECTOR, { kind: "lease", title: "A", end_date: "2027-01-01" }), "PT422");
        await expectRaise(() => create(DIRECTOR, { kind: "client", title: "", end_date: "2027-01-01" }), "PT422");
        await expectRaise(() => create(DIRECTOR, { kind: "client", title: "A", end_date: "" }), "PT422");
    });

    await step("the flag alone lets a staff member read and manage", async () => {
        await db.exec(`update public.employees set can_manage_contracts = true where user_id = '${RINA}'`);
        try {
            const r = await tx(RINA, `select public.contracts_list(null) j`);
            const j = r.rows[0].j;
            if (j.can_manage !== true) throw new Error("can_manage false");
            if (j.items.length !== 2) throw new Error(`items ${j.items.length}`);
            // Soonest to end first: TeamViewer (-3) before Telfer (+45).
            if (j.items[0].title !== "TeamViewer") throw new Error(`order ${j.items.map((i) => i.title)}`);
            if (j.due_count !== 2) throw new Error(`due_count ${j.due_count}`);
        } finally {
            await db.exec(`update public.employees set can_manage_contracts = false where user_id = '${RINA}'`);
        }
    });

    await step("management reads without managing", async () => {
        await db.exec(`update public.employees set is_management_role = true where user_id = '${HIMAWAN}'`);
        try {
            const r = await tx(HIMAWAN, `select public.contracts_list('client') j`);
            const j = r.rows[0].j;
            if (j.can_manage !== false) throw new Error("can_manage true");
            if (j.items.length !== 1 || j.items[0].kind !== "client") throw new Error("kind filter");
            if (j.due_count !== 1) throw new Error(`due_count ${j.due_count}`);
            await expectRaise(() => tx(HIMAWAN, `select public.contracts_update($1::uuid, '{"notes":"x"}'::jsonb)`, [client.id]),
                "PT403", /not set up to manage contracts/);
        } finally {
            await db.exec(`update public.employees set is_management_role = false where user_id = '${HIMAWAN}'`);
        }
    });

    await step("an unknown kind filter is refused", async () => {
        await expectRaise(() => tx(DIRECTOR, `select public.contracts_list('lease')`), "PT422");
    });

    await step("acknowledging stops a reminder being due, once", async () => {
        const rem = client.reminders[0];
        const r = await tx(PETER, `select public.contracts_acknowledge($1::uuid, $2::uuid, 'Renewal sent') j`, [client.id, rem.id]);
        const c = r.rows[0].j;
        const a = c.reminders.find((x) => x.id === rem.id);
        if (a.is_due !== false) throw new Error("still due");
        if (!a.acknowledged_at) throw new Error("no acknowledged_at");
        if (a.acknowledgement_note !== "Renewal sent") throw new Error(`note ${a.acknowledgement_note}`);
        if (c.open_reminders !== 0) throw new Error(`open ${c.open_reminders}`);
        const by = await db.query(`select acknowledged_by from public.contract_reminders where id = $1`, [rem.id]);
        if (by.rows[0].acknowledged_by !== PETER) throw new Error("acknowledged_by");
        const log = await db.query(`select description from public.activity_logs
            where action = 'CONTRACT_REMINDER_ACKNOWLEDGED' and target_id = $1`, [client.id]);
        if (log.rows[0]?.description !== "Acknowledged the 60-day warning for Telfer")
            throw new Error(`log ${log.rows[0]?.description}`);
        await expectRaise(() => tx(PETER, `select public.contracts_acknowledge($1::uuid, $2::uuid, null)`, [client.id, rem.id]),
            "PT409", /That reminder has already been acknowledged\./);
    });

    await step("acknowledging needs the right to manage, and a reminder of that contract", async () => {
        await expectRaise(() => tx(RINA, `select public.contracts_acknowledge($1::uuid, $2::uuid, null)`,
            [client.id, client.reminders[1].id]), "PT403");
        await expectRaise(() => tx(PETER, `select public.contracts_acknowledge($1::uuid, $2::uuid, null)`,
            [sub.id, client.reminders[1].id]), "PT404", /^Not found$/);
    });

    await step("editing the schedule keeps acknowledgements that survive it", async () => {
        const r = await tx(DIRECTOR, `select public.contracts_update($1::uuid, '{"reminder_days":[60,14]}'::jsonb) j`, [client.id]);
        const c = r.rows[0].j;
        const days = c.reminders.map((x) => x.days_before).join(",");
        if (days !== "60,14") throw new Error(`reminders ${days}`);
        if (!c.reminders[0].acknowledged_at) throw new Error("60-day acknowledgement lost");
        if (c.reminders[0].id !== client.reminders[0].id) throw new Error("60-day row replaced");
        if (c.reminders[1].acknowledged_at !== null) throw new Error("new reminder acknowledged");
    });

    await step("a partial edit touches only what was sent", async () => {
        const r = await tx(DIRECTOR, `select public.contracts_update($1::uuid, '{"notes":"Renewal in legal","amount":null}'::jsonb) j`, [client.id]);
        const c = r.rows[0].j;
        if (c.notes !== "Renewal in legal") throw new Error(`notes ${c.notes}`);
        if (c.amount !== null) throw new Error(`amount ${c.amount}`);
        if (c.title !== "Telfer" || c.currency !== "AUD" || c.counterparty !== "Newmont Telfer") throw new Error("other fields changed");
        if (c.reminders.length !== 2) throw new Error("schedule changed without reminder_days");
    });

    await step("a contract that is no longer active has nothing due", async () => {
        const r = await tx(DIRECTOR, `select public.contracts_update($1::uuid, '{"status":"renewed"}'::jsonb) j`, [sub.id]);
        const c = r.rows[0].j;
        if (c.status !== "renewed") throw new Error(`status ${c.status}`);
        if (c.open_reminders !== 0 || c.reminders[0].is_due !== false) throw new Error("still due");
        await expectRaise(() => tx(DIRECTOR, `select public.contracts_update($1::uuid, '{"status":"paused"}'::jsonb)`, [sub.id]), "PT422");
        await expectRaise(() => tx(DIRECTOR, `select public.contracts_update(gen_random_uuid(), '{}'::jsonb)`), "PT404");
    });

    // --- documents ----------------------------------------------------------
    const PDF = "application/pdf";
    const check = (uid, id, type, size) =>
        tx(uid, `select public.contracts_check_document($1::uuid, $2, $3::bigint)`, [id, type, size]);

    await step("documents are kept on client contracts only", async () => {
        await expectRaise(() => check(DIRECTOR, sub.id, PDF, 1000), "PT409", /Documents are kept on client contracts only\./);
    });

    await step("only PDFs, images and Word documents, up to 10 MB, not empty", async () => {
        await expectRaise(() => check(DIRECTOR, client.id, "text/plain", 1000), "PT415", /Upload a PDF, an image, or a Word document\./);
        await expectRaise(() => check(DIRECTOR, client.id, PDF, 12 * 1024 * 1024 + 5), "PT413", /^That file is 12 MB\. The limit is 10 MB\.$/);
        await expectRaise(() => check(DIRECTOR, client.id, PDF, 0), "PT400", /That file is empty\./);
        await expectRaise(() => check(RINA, client.id, PDF, 1000), "PT403");
        await check(DIRECTOR, client.id, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 10 * 1024 * 1024);
    });

    const DOC = "c0c0c0c0-0000-0000-0000-000000000001";
    await step("a document is recorded, listed and fetched by a reader", async () => {
        const r = await tx(DIRECTOR, `select public.contracts_add_document($1::uuid, $2::uuid, 'telfer-signed.pdf', $3, 204800, $4) j`,
            [client.id, DOC, PDF, `${client.id}/${DOC}`]);
        const c = r.rows[0].j;
        if (c.documents.length !== 1) throw new Error(`documents ${c.documents.length}`);
        const d = c.documents[0];
        if (d.id !== DOC || d.filename !== "telfer-signed.pdf" || d.content_type !== PDF || d.byte_size !== 204800 || !d.uploaded_at)
            throw new Error(JSON.stringify(d));
        await expectRaise(() => tx(DIRECTOR, `select public.contracts_add_document($1::uuid, gen_random_uuid(), 'x.pdf', $2, 10, 'x')`,
            [sub.id, PDF]), "PT409");

        await db.exec(`update public.employees set is_management_role = true where user_id = '${HIMAWAN}'`);
        try {
            const g = await tx(HIMAWAN, `select public.contracts_get_document($1::uuid, $2::uuid) j`, [client.id, DOC]);
            if (g.rows[0].j.storage_path !== `${client.id}/${DOC}`) throw new Error("storage_path");
            if (g.rows[0].j.content_type !== PDF) throw new Error("content_type");
        } finally {
            await db.exec(`update public.employees set is_management_role = false where user_id = '${HIMAWAN}'`);
        }
        await expectRaise(() => tx(RINA, `select public.contracts_get_document($1::uuid, $2::uuid)`, [client.id, DOC]), "PT404");
        await expectRaise(() => tx(DIRECTOR, `select public.contracts_get_document($1::uuid, $2::uuid)`, [sub.id, DOC]), "PT404");
    });

    await step("removing a document answers the contract and names the object", async () => {
        await expectRaise(() => tx(RINA, `select public.contracts_delete_document($1::uuid, $2::uuid)`, [client.id, DOC]), "PT403");
        const r = await tx(DIRECTOR, `select public.contracts_delete_document($1::uuid, $2::uuid) j`, [client.id, DOC]);
        const j = r.rows[0].j;
        if (j.storage_path !== `${client.id}/${DOC}`) throw new Error(`path ${j.storage_path}`);
        if (j.contract.documents.length !== 0) throw new Error("still listed");
        await expectRaise(() => tx(DIRECTOR, `select public.contracts_delete_document($1::uuid, $2::uuid)`, [client.id, DOC]), "PT404");
    });

    await step("deleting a contract takes its reminders and documents with it", async () => {
        await tx(DIRECTOR, `select public.contracts_add_document($1::uuid, gen_random_uuid(), 'a.png', 'image/png', 10, 'p/a')`, [client.id]);
        await expectRaise(() => tx(RINA, `select public.contracts_delete($1::uuid)`, [client.id]), "PT403");
        const r = await tx(DIRECTOR, `select public.contracts_delete($1::uuid) j`, [client.id]);
        if (JSON.stringify(r.rows[0].j.storage_paths) !== '["p/a"]') throw new Error(JSON.stringify(r.rows[0].j));
        const left = await db.query(`select
            (select count(*) from public.contract_reminders where contract_id = $1)::int r,
            (select count(*) from public.contract_documents where contract_id = $1)::int d`, [client.id]);
        if (left.rows[0].r !== 0 || left.rows[0].d !== 0) throw new Error(JSON.stringify(left.rows[0]));
        await expectRaise(() => tx(DIRECTOR, `select public.contracts_delete($1::uuid)`, [client.id]), "PT404");
        await tx(DIRECTOR, `select public.contracts_delete($1::uuid)`, [sub.id]);
    });

    await step("row level security is on for every contracts table", async () => {
        const r = await db.query(`select relname, relrowsecurity from pg_class
            where relname in ('contracts','contract_reminders','contract_documents') and relkind = 'r'`);
        if (r.rows.length !== 3 || r.rows.some((x) => !x.relrowsecurity)) throw new Error(JSON.stringify(r.rows));
    });
};
