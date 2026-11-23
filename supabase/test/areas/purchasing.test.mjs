// Purchasing flow (20261017000100): the request, the register, routing by
// value per vendor per month, the evidence by tier, Peter's approval, urgent
// purchases, the order and the checker, the GRN, the three-way match and the
// linked finance request, vendors, assets from purchase lines, and the
// notifications each step writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export default async ({ db, step, tx, people }) => {
    const { PETER, HIMAWAN, DIRECTOR } = people;
    const FIN = HIMAWAN;

    // Our own people: Reza asks, Cahya and Dewi check, Tono is IT.
    const U = {
        REZA: "9a000000-0000-0000-0000-000000000001",
        CAHYA: "9a000000-0000-0000-0000-000000000002",
        DEWI: "9a000000-0000-0000-0000-000000000003",
        TONO: "9a000000-0000-0000-0000-000000000004",
    };
    const E = {
        REZA: "9b000000-0000-0000-0000-000000000001",
        CAHYA: "9b000000-0000-0000-0000-000000000002",
        DEWI: "9b000000-0000-0000-0000-000000000003",
        TONO: "9b000000-0000-0000-0000-000000000004",
    };
    const { REZA, CAHYA, DEWI, TONO } = U;
    const authRows = Object.entries(U).map(([k, id]) => `('00000000-0000-0000-0000-000000000000','${id}',
        'authenticated','authenticated','${k.toLowerCase()}.p@dtgeotech.com','x', now(), '{"provider":"email"}'::jsonb,
        '{"full_name":"${k[0] + k.slice(1).toLowerCase()} Buy"}'::jsonb, now(), now(), '', '', '', '')`).join(",\n");
    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values ${authRows};
        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, user_id) values
          ('${E.REZA}','PUR-001','Reza','Buy','reza.p@dtgeotech.com','Ops','Engineer','2024-01-01',0,'${REZA}'),
          ('${E.CAHYA}','PUR-002','Cahya','Buy','cahya.p@dtgeotech.com','Ops','Technician','2024-01-01',0,'${CAHYA}'),
          ('${E.DEWI}','PUR-003','Dewi','Buy','dewi.p@dtgeotech.com','Ops','Technician','2024-01-01',0,'${DEWI}'),
          ('${E.TONO}','PUR-004','Tono','Buy','tono.p@dtgeotech.com','IT','IT support','2024-01-01',0,'${TONO}');
        update public.employees set is_it_support = true where id = '${E.TONO}';
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
        if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    };
    const cat = async (code) =>
        (await db.query(`select id from public.asset_categories where code = $1`, [code])).rows[0].id;

    const reset = () => db.exec(`
        delete from public.assets where purchase_line_id is not null;
        delete from public.finance_requests where purchase_id is not null;
        delete from public.purchases;
        delete from public.vendors;
        delete from public.notifications where kind like 'purchase\\_%' or kind = 'finance_submitted';
        update public.purchase_settings
           set petty_cash_limit = 500000, simple_limit = 5000000, quotation_limit = 50000000,
               next_pr = 1, next_po = 1;
    `);

    // --- building blocks ----------------------------------------------------
    const vendor = (name, extra = {}) =>
        j(FIN, `public.vendors_create($1::jsonb)`, [JSON.stringify({
            name, npwp: null, is_pkp: true, phone: "021-555-0101",
            bank_name: "BCA", bank_account_number: "123", bank_account_holder: name, ...extra })]);
    // Finance's line, and the requester's generic item.
    const line = (extra = {}) => ({ line_type: "expense", description: "Cable ties", quantity: 1, unit_price: 1000000, ...extra });
    const item = (extra = {}) => ({ description: "cable ties", quantity: 1, ...extra });
    const draft = (uid, body = {}) =>
        j(uid, `public.purchases_create($1::jsonb)`, [JSON.stringify({ title: "Site kit", items: [item()], ...body })]);
    const submit = (uid, id) => j(uid, `public.purchases_submit($1::uuid)`, [id]);
    const register = (id, body = {}) =>
        j(FIN, `public.purchases_register($1::uuid, $2::jsonb)`, [id, JSON.stringify({ budget_confirmed: true, ...body })]);
    const source = (id, body) => j(FIN, `public.purchases_source($1::uuid, $2::jsonb)`, [id, JSON.stringify(body)]);
    const doc = (uid, id, kind, type = "application/pdf") =>
        j(uid, `public.purchases_document_add($1::uuid, $2, $3, $4, $5, $6)`,
            [id, kind, `${kind}.pdf`, type, 1000, `${id}/${randomUUID()}/${kind}.pdf`]);
    const send = (id) => j(FIN, `public.purchases_send_for_approval($1::uuid)`, [id]);
    const approve = (id, who = PETER) => j(who, `public.purchases_approve($1::uuid, null)`, [id]);
    const order = (id, checker) => j(FIN, `public.purchases_issue_order($1::uuid, $2::uuid)`, [id, checker]);
    const receive = (uid, id, lines, matches = true, note = null) =>
        j(uid, `public.purchases_receive($1::uuid, $2::jsonb, $3, $4)`, [id, JSON.stringify(lines), matches, note]);
    const match = (id, inv) => j(FIN, `public.purchases_match($1::uuid, $2::jsonb)`, [id, JSON.stringify(inv)]);
    const get = (uid, id) => j(uid, `public.purchases_get($1::uuid)`, [id]);
    const kinds = (p) => p.events.map((e) => e.kind);
    const notes = async (kind, user = null) =>
        (await db.query(`select * from public.notifications
                          where kind = $1 and ($2::uuid is null or user_id = $2::uuid) order by created_at, id`,
            [kind, user])).rows;

    // A purchase up to sourcing, with finance's lines, a vendor, an amount and quotes.
    const sourced = async (amount, v, extra = {}) => {
        let p = await draft(REZA, extra.body ?? {});
        await submit(REZA, p.id);
        p = await register(p.id);
        await source(p.id, { vendor_id: v.id, approval_amount: amount, related_party: false,
                             lines: extra.lines ?? [line({ unit_price: amount })], ...(extra.source ?? {}) });
        for (let i = 0; i < (extra.quotes ?? 1); i++) await doc(FIN, p.id, "quote");
        if (extra.comparison) await doc(FIN, p.id, "comparison");
        return p;
    };
    // ... and on to received.
    const received = async (amount, v, extra = {}) => {
        const p = await sourced(amount, v, extra);
        await send(p.id);
        await approve(p.id);
        await order(p.id, CAHYA);
        await doc(CAHYA, p.id, "delivery_photo", "image/jpeg");
        const g = await get(CAHYA, p.id);
        return receive(CAHYA, p.id, g.lines.map((l) => ({ line_id: l.id, qty_received: l.quantity })));
    };

    // --- request ------------------------------------------------------------

    await step("purchasing: anyone asks in general terms, with notes, and no prices", async () => {
        await reset();
        const p = await draft(REZA, {
            title: "Site kit",
            items: [item({ description: "laptop", note: "at least 16 GB RAM" }),
                    item({ description: "peripherals", note: "Logitech wireless mouse and keyboard" })],
        });
        eq([p.status, p.reference, p.shape], ["draft", null, "requester"], "draft");
        eq(p.items.map((i) => [i.description, i.quantity, i.note]),
            [["laptop", 1, "at least 16 GB RAM"], ["peripherals", 1, "Logitech wireless mouse and keyboard"]], "items");
        for (const k of ["lines", "estimated_total", "vendor", "checker"]) if (k in p) throw new Error(`requester sees ${k}`);
        const s = await submit(REZA, p.id);
        eq([s.status, s.milestone.current], ["submitted", "submitted"], "submitted");
        eq(kinds(await get(FIN, p.id)), ["created", "submitted"], "events");
        eq((await get(FIN, p.id)).lines.length, 0, "no lines before registration");
    });

    await step("purchasing: finance's lines need a category for an asset; a draft is the requester's alone", async () => {
        await reset();
        const v = await vendor("PT Kategori");
        const a = await sourced(2000000, v);
        await fails(() => source(a.id, { lines: [line({ line_type: "asset" })] }), "PT422", /asset_category_id/);
        await fails(() => draft(REZA, { items: [{ description: "", quantity: 1 }] }), "PT422", /items\[1\]\.description/);
        const p = await draft(REZA);
        await fails(() => j(CAHYA, `public.purchases_update($1::uuid, '{"title":"x"}'::jsonb)`, [p.id]), "PT404");
        await fails(() => get(CAHYA, p.id), "PT404");
        const empty = await draft(REZA, { items: [] });
        await fails(() => submit(REZA, empty.id), "PT422", /at least one item/);
    });

    // --- register -----------------------------------------------------------

    await step("purchasing: finance registers PR-0001 with budget and cost code; numbers run on", async () => {
        await reset();
        const a = await draft(REZA);
        await submit(REZA, a.id);
        await fails(() => j(FIN, `public.purchases_register($1::uuid, '{}'::jsonb)`, [a.id]), "PT422", /budget/);
        const r = await register(a.id, { cost_code: "OPS-2026" });
        eq([r.reference, r.status, r.cost_code, r.budget_confirmed], ["PR-0001", "sourcing", "OPS-2026", true], "registered");
        const b = await draft(REZA);
        await submit(REZA, b.id);
        eq((await register(b.id)).reference, "PR-0002", "second");
        await fails(() => j(REZA, `public.purchases_register($1::uuid, '{"budget_confirmed":true}'::jsonb)`, [b.id]), "PT403");
    });

    await step("purchasing: registering seeds finance's lines from the items; finance splits them, the items stay", async () => {
        await reset();
        const p = await draft(REZA, { items: [item({ description: "peripherals", note: "Logitech wireless" })] });
        await submit(REZA, p.id);
        const r = await register(p.id);
        eq(r.lines.map((l) => [l.description, l.specification, l.quantity, l.line_type, l.unit_price]),
            [["peripherals", "Logitech wireless", 1, "expense", 0]], "seeded");
        const s = await source(p.id, { lines: [
            line({ description: "Logitech MK270 keyboard and mouse", unit_price: 350000 }),
            line({ description: "USB-C hub", unit_price: 450000 }),
        ] });
        eq([s.lines.length, s.estimated_total], [2, 800000], "split");
        eq((await get(REZA, p.id)).items.map((i) => [i.description, i.note]), [["peripherals", "Logitech wireless"]], "items stay");
        eq(s.items.length, 1, "finance sees the items too");
    });

    await step("purchasing: return goes back to draft; petty cash only at or below the limit", async () => {
        await reset();
        const a = await draft(REZA);
        await submit(REZA, a.id);
        await fails(() => j(FIN, `public.purchases_return($1::uuid, '')`, [a.id]), "PT422");
        const r = await j(FIN, `public.purchases_return($1::uuid, 'Add the model number')`, [a.id]);
        eq(r.status, "draft", "returned");
        eq((await notes("purchase_returned", REZA)).length, 1, "requester told");
        await submit(REZA, a.id);
        eq((await notes("purchase_returned", REZA))[0].resolved_at !== null, true, "settled on resubmit");
        const petty = (id, estimate) => j(FIN, `public.purchases_close_petty_cash($1::uuid, $2::numeric)`, [id, estimate]);
        await fails(() => petty(a.id, 2000000), "PT422", /above the petty-cash limit/);
        await fails(() => petty(a.id, null), "PT422", /estimate/);
        const done = await petty(a.id, 350000);
        eq([done.status, done.estimated_total], ["petty_cash", 350000], "petty");
        eq((await get(REZA, a.id)).milestone.outcome, "petty_cash", "requester sees the outcome");
        await fails(() => register(a.id), "PT409");
    });

    // --- routing ------------------------------------------------------------

    await step("purchasing: the tier at each boundary", async () => {
        await reset();
        const v = await vendor("PT Batas");
        const tier = async (amount) => {
            const p = await sourced(amount, v);
            return (await get(FIN, p.id)).route.tier;
        };
        eq(await tier(5000000), "simple", "5M");
        eq(await tier(5000001), "quotation", "5M+1");
        eq(await tier(50000000), "quotation", "50M");
        eq(await tier(50000001), "contract", "50M+1");
    });

    await step("purchasing: a split order is caught by the vendor's month, and the next month starts again", async () => {
        await reset();
        const v = await vendor("PT Sinar");
        const first = await sourced(4000000, v);
        await send(first.id);
        await approve(first.id);
        const second = await sourced(3000000, v);
        const g = await get(FIN, second.id);
        eq([g.route.route_value, g.route.tier], [7000000, "quotation"], "same month");
        await fails(() => send(second.id), "PT422", /2 quotes.*comparison sheet/);
        await db.query(`update public.purchases set approved_at = now() - interval '40 days' where id = $1`, [first.id]);
        eq((await get(FIN, second.id)).route.tier, "simple", "next month");
        const sent = await send(second.id);
        eq([sent.tier, sent.route_value, sent.status], ["simple", 3000000, "awaiting_approval"], "stored");
    });

    await step("purchasing: only Peter changes the limits, and they must rise", async () => {
        await reset();
        await fails(() => j(FIN, `public.purchases_settings_update('{"simple_limit":10000000}'::jsonb)`), "PT403");
        await fails(() => j(PETER, `public.purchases_settings_update('{"simple_limit":100}'::jsonb)`), "PT422");
        const s = await j(PETER, `public.purchases_settings_update('{"simple_limit":10000000}'::jsonb)`);
        eq([s.simple_limit, s.updated_by_name], [10000000, "Peter Saunders"], "changed");
        eq((await j(REZA, `public.purchases_settings()`)).can_edit, false, "staff read");
    });

    // --- evidence -----------------------------------------------------------

    await step("purchasing: evidence by tier, the related-party declaration, and sole source", async () => {
        await reset();
        const v = await vendor("PT Bukti");
        const q = await sourced(12000000, v, { quotes: 1 });
        await fails(() => send(q.id), "PT422", /2 quotes \(1 attached\), a comparison sheet/);
        await doc(FIN, q.id, "quote");
        await doc(FIN, q.id, "comparison");
        await source(q.id, { related_party: true });
        await fails(() => send(q.id), "PT422", /related-party declaration/);
        await source(q.id, { related_party_note: "The requester's brother owns the vendor" });
        eq((await send(q.id)).status, "awaiting_approval", "sent");

        const sole = await sourced(12000000, v, { source: { sole_source: true } });
        await fails(() => send(sole.id), "PT422", /sole-source justification/);
        await source(sole.id, { sole_source_note: "Only the maker calibrates these; benchmark: last year 11.5M" });
        eq((await send(sole.id)).status, "awaiting_approval", "sole source with one quote");

        const big = await sourced(60000000, v, { quotes: 3, comparison: true });
        await fails(() => send(big.id), "PT422", /draft contract, the date the shareholders were informed/);
        await doc(FIN, big.id, "contract");
        await source(big.id, { shareholders_informed_on: "2026-11-20" });
        eq((await send(big.id)).tier, "contract", "contract tier");
    });

    // --- approval -----------------------------------------------------------

    await step("purchasing: Peter approves, sends back or rejects; finance and the director can't", async () => {
        await reset();
        const v = await vendor("PT Setuju");
        const a = await sourced(14800000, v, { quotes: 2, comparison: true });
        await send(a.id);
        await fails(() => approve(a.id, FIN), "PT403", /^Only the approver approves purchases\.$/);
        await fails(() => approve(a.id, DIRECTOR), "PT403");
        const ok = await approve(a.id);
        eq([ok.status, ok.approved_amount, ok.self_approved, ok.approved_by_name], ["approved", 14800000, false, "Peter Saunders"], "approved");

        // Another vendor: PT Setuju's month is now in the quotation tier.
        const b = await sourced(2000000, await vendor("PT Lain"));
        await send(b.id);
        await fails(() => j(PETER, `public.purchases_send_back($1::uuid, '')`, [b.id]), "PT422");
        eq((await j(PETER, `public.purchases_send_back($1::uuid, 'Get a cheaper quote')`, [b.id])).status, "sourcing", "sent back");
        await send(b.id);
        const rj = await j(PETER, `public.purchases_reject($1::uuid, 'Not needed')`, [b.id]);
        eq([rj.status, rj.cancel_reason], ["cancelled", "Not needed"], "rejected");
    });

    await step("purchasing: Peter's own purchase is approved by Peter and marked self-approved", async () => {
        await reset();
        const v = await vendor("PT Sendiri");
        let p = await draft(PETER, { title: "Director's monitor" });
        await submit(PETER, p.id);
        await register(p.id);
        await source(p.id, { vendor_id: v.id, approval_amount: 3000000, related_party: false });
        await doc(FIN, p.id, "quote");
        await send(p.id);
        p = await approve(p.id);
        eq(p.self_approved, true, "self");
        const list = await j(FIN, `public.purchases_list('{"self_approved":true}'::jsonb)`);
        eq(list.items.map((x) => x.id), [p.id], "filter");
    });

    // --- urgent -------------------------------------------------------------

    await step("purchasing: urgent needs the evidence, registers as approved, and waits for Peter before matching", async () => {
        await reset();
        const v = await vendor("PT Darurat");
        const at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        const body = { title: "Pump repair", urgent: true, urgent_channel: "whatsapp", urgent_approved_at: at };
        const p = await draft(REZA, body);
        await fails(() => submit(REZA, p.id), "PT422", /WhatsApp screenshot/);
        await doc(REZA, p.id, "approval_evidence", "image/png");
        await submit(REZA, p.id);
        eq((await get(FIN, p.id)).late_entry, false, "on time");
        await fails(() => register(p.id, { vendor_id: v.id }), "PT422", /amount/);
        const r = await register(p.id, { vendor_id: v.id, amount: 3000000,
                                         lines: [line({ description: "Pump seal kit", unit_price: 3000000 })] });
        eq([r.status, r.approved_amount, r.urgent_detail.confirmed_at, r.lines[0].description],
            ["approved", 3000000, null, "Pump seal kit"], "registered");
        eq((await notes("purchase_urgent_confirm", PETER)).length, 1, "Peter asked");
        eq((await get(REZA, p.id)).milestone.current, "approved", "the requester sees it approved");
        await order(p.id, CAHYA);
        await doc(CAHYA, p.id, "delivery_photo", "image/jpeg");
        const g = await get(CAHYA, p.id);
        await receive(CAHYA, p.id, g.lines.map((l) => ({ line_id: l.id, qty_received: l.quantity })));
        await doc(FIN, p.id, "invoice");
        const inv = { invoice_number: "INV-9", invoice_date: "2026-11-20", invoice_total: 3000000 };
        await fails(() => match(p.id, inv), "PT422", /not confirmed/);
        const c = await j(PETER, `public.purchases_confirm_urgent($1::uuid, null)`, [p.id]);
        eq(c.urgent_detail.confirmed_at !== null, true, "confirmed");
        eq((await notes("purchase_urgent_confirm", PETER))[0].resolved_at !== null, true, "settled");
        eq((await match(p.id, inv)).status, "matched", "matched");

        const late = await draft(REZA, { ...body, urgent_channel: "phone", urgent_note: "Peter said yes on the phone",
                                         urgent_approved_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() });
        await submit(REZA, late.id);
        eq((await get(FIN, late.id)).late_entry, true, "late");
    });

    // --- order and GRN ------------------------------------------------------

    await step("purchasing: the checker is never the requester or finance; only they record the GRN, with a photo", async () => {
        await reset();
        const v = await vendor("PT Kirim");
        const p = await sourced(2000000, v);
        await send(p.id);
        await approve(p.id);
        await fails(() => order(p.id, REZA), "PT422", /requester/);
        await fails(() => order(p.id, FIN), "PT422", /finance/);
        const o = await order(p.id, CAHYA);
        eq([o.status, o.order_number, o.checker.id], ["ordered", "PO-0001", CAHYA], "ordered");
        const c = await get(CAHYA, p.id);
        eq([c.shape, c.lines[0].unit_price, c.approved_amount, c.documents.length], ["checker", undefined, undefined, 0], "no prices");
        await fails(() => receive(REZA, p.id, []), "PT404");
        const lines = c.lines.map((l) => ({ line_id: l.id, qty_received: l.quantity }));
        await fails(() => receive(CAHYA, p.id, lines), "PT422", /photo/);
        await doc(CAHYA, p.id, "delivery_photo", "image/jpeg");
        await fails(() => receive(CAHYA, p.id, [{ line_id: c.lines[0].id, qty_received: 2 }]), "PT422", /between 0 and 1/);
        await fails(() => receive(CAHYA, p.id, lines, false, null), "PT422", /what is wrong/);
        const rej = await receive(CAHYA, p.id, lines, false, "Wrong RAM");
        eq([rej.status, kinds(rej).includes("delivery_rejected")], ["ordered", true], "rejected");
        eq((await notes("purchase_delivery_rejected", PETER)).length, 1, "Peter told");
        await fails(() => receive(CAHYA, p.id, lines), "PT422", /photo/);
        await doc(CAHYA, p.id, "delivery_photo", "image/jpeg");
        eq((await receive(CAHYA, p.id, lines)).status, "received", "accepted");
    });

    await step("purchasing: finance changes the checker, and the old one's item is settled", async () => {
        await reset();
        const v = await vendor("PT Ganti");
        const p = await sourced(2000000, v);
        await send(p.id);
        await approve(p.id);
        await order(p.id, CAHYA);
        await j(FIN, `public.purchases_change_checker($1::uuid, $2::uuid)`, [p.id, DEWI]);
        eq((await notes("purchase_check_needed", CAHYA))[0].resolved_at !== null, true, "Cahya settled");
        eq((await notes("purchase_check_needed", DEWI)).length, 1, "Dewi asked");
        await fails(() => get(CAHYA, p.id), "PT404");
    });

    // --- match and payment --------------------------------------------------

    await step("purchasing: a clean match creates a submitted finance request for the net payable", async () => {
        await reset();
        const v = await vendor("PT Jasa");
        const p = await received(11100000, v, { quotes: 2, comparison: true });
        await doc(FIN, p.id, "invoice");
        const inv = { invoice_number: "INV-1", invoice_date: "2026-11-20", invoice_total: 11100000,
                      ppn_amount: 1100000, pph_amount: 200000 };
        await fails(() => match(p.id, inv), "PT422", /faktur pajak/);
        await doc(FIN, p.id, "tax_invoice");
        const m = await match(p.id, inv);
        eq([m.status, m.invoice.net_payable, m.finance_request.status], ["matched", 10900000, "submitted"], "matched");
        const fr = await j(FIN, `public.finance_get($1::uuid)`, [m.finance_request.id]);
        eq([fr.total, fr.items[0].category, fr.purchase.reference], [10900000, "vendor", m.reference], "request");
        eq((await notes("finance_submitted", PETER)).length, 1, "Peter told by the finance chain");
        eq((await notes("purchase_match_needed")).every((n) => n.resolved_at !== null), true, "match item settled");
    });

    await step("purchasing: above the approved amount waits for Peter's amount review", async () => {
        await reset();
        const v = await vendor("PT Mahal");
        const p = await received(14800000, v, { quotes: 2, comparison: true });
        await doc(FIN, p.id, "invoice");
        const inv = { invoice_number: "INV-2", invoice_date: "2026-11-20", invoice_total: 15500000 };
        await fails(() => match(p.id, inv), "PT422", /above the approved amount/);
        await fails(() => j(FIN, `public.purchases_ask_amount($1::uuid, 14000000, 'x')`, [p.id]), "PT422");
        eq((await j(FIN, `public.purchases_ask_amount($1::uuid, 15500000, 'Price rose')`, [p.id])).status, "amount_review", "asked");
        const d = await j(PETER, `public.purchases_decide_amount($1::uuid, true, null)`, [p.id]);
        eq([d.status, d.approved_amount], ["received", 15500000], "approved");
        eq((await match(p.id, inv)).status, "matched", "matched");
    });

    await step("purchasing: the linked request keeps its amount, needs the transfer proof, and pays the purchase", async () => {
        await reset();
        const v = await vendor("PT Bayar");
        const p = await received(2000000, v);
        await doc(FIN, p.id, "invoice");
        const m = await match(p.id, { invoice_number: "INV-3", invoice_date: "2026-11-20", invoice_total: 2000000 });
        const frId = m.finance_request.id;
        await j(PETER, `public.finance_send_back($1::uuid, 'Which account?', 'finance')`, [frId]);
        const fr = await j(FIN, `public.finance_get($1::uuid)`, [frId]);
        const body = { title: fr.title, notes: "BCA 123", due_date: null,
                       items: fr.items.map((i) => ({ category: i.category, description: i.description, amount: i.amount })) };
        await fails(() => j(FIN, `public.finance_update($1::uuid, $2::jsonb)`,
            [frId, JSON.stringify({ ...body, items: [{ ...body.items[0], amount: 999 }] })]), "PT422", /pays a purchase/);
        eq((await j(FIN, `public.finance_update($1::uuid, $2::jsonb)`, [frId, JSON.stringify(body)])).notes, "BCA 123", "notes");
        await j(FIN, `public.finance_submit($1::uuid)`, [frId]);
        await j(PETER, `public.finance_approve($1::uuid)`, [frId]);
        await fails(() => j(FIN, `public.finance_mark_paid($1::uuid, '2026-12-03'::date, null)`, [frId]), "PT422", /transfer proof/);
        await j(FIN, `public.finance_document_add($1::uuid, 'proof.pdf', 'application/pdf', 1000, $2)`, [frId, `${frId}/x/proof.pdf`]);
        await j(FIN, `public.finance_mark_paid($1::uuid, '2026-12-03'::date, null)`, [frId]);
        const paid = await get(REZA, p.id);
        eq([paid.status, paid.milestone.current, paid.paid_on], ["paid", "done", undefined], "paid");
        eq((await get(FIN, p.id)).paid_on, "2026-12-03", "finance sees the date");
        eq((await notes("purchase_closed", REZA)).length, 1, "requester told");
        eq(kinds(await get(FIN, p.id)).filter((k) => !k.startsWith("document")),
            ["created", "submitted", "registered", "vendor_chosen", "sent_for_approval", "approved", "ordered",
             "grn_accepted", "matched", "paid"], "full trail in order");
    });

    // --- cancel and documents -----------------------------------------------

    await step("purchasing: cancel windows and document delete windows", async () => {
        await reset();
        const v = await vendor("PT Batal");
        const a = await draft(REZA);
        eq((await j(REZA, `public.purchases_cancel($1::uuid, null)`, [a.id])).status, "cancelled", "own draft");
        const b = await sourced(2000000, v);
        await fails(() => j(REZA, `public.purchases_cancel($1::uuid, 'x')`, [b.id]), "PT409");
        const q = (await get(FIN, b.id)).documents[0];
        await send(b.id);
        await fails(() => j(FIN, `public.purchases_document_delete($1::uuid, $2::uuid)`, [b.id, q.id]), "PT409", /kept/);
        await approve(b.id);
        await order(b.id, CAHYA);
        await fails(() => j(FIN, `public.purchases_cancel($1::uuid, '')`, [b.id]), "PT422");
        eq((await j(FIN, `public.purchases_cancel($1::uuid, 'Vendor can''t deliver')`, [b.id])).status, "cancelled", "ordered");
        eq((await notes("purchase_check_needed", CAHYA))[0].resolved_at !== null, true, "checker settled");
        const c = await received(2000000, v);
        await fails(() => j(FIN, `public.purchases_cancel($1::uuid, 'late')`, [c.id]), "PT409");
    });

    await step("purchasing: who sees what", async () => {
        await reset();
        const v = await vendor("PT Lihat");
        const p = await sourced(2000000, v);
        await doc(REZA, p.id, "other").catch(() => null); // too late: the requester's window is draft and submitted
        const mine = await get(REZA, p.id);
        eq(mine.shape, "requester", "shape");
        for (const k of ["vendor", "lines", "estimated_total", "approval_amount", "approved_amount", "checker",
                         "finance_request", "tier", "route", "invoice", "paid_on"])
            if (k in mine) throw new Error(`requester sees ${k}`);
        eq(mine.documents.length, 0, "no quotes");
        eq(mine.events.map((e) => [e.kind, "actor_name" in e]), [["submitted", false]], "milestones only");
        const q = (await get(FIN, p.id)).documents[0];
        await fails(() => j(REZA, `public.purchases_document_get($1::uuid, $2::uuid)`, [p.id, q.id]), "PT404");
        eq((await get(DIRECTOR, p.id)).vendor.bank_account_number, "123", "director full");
        await fails(() => get(DEWI, p.id), "PT404");
        await fails(() => j(DEWI, `public.purchases_list('{}'::jsonb)`), "PT404");
        eq((await j(REZA, `public.purchases_mine()`)).items.length, 1, "mine");
    });

    // --- vendors ------------------------------------------------------------

    await step("purchasing: vendors are unique, inactive ones can't be chosen, and only Peter changes the bank", async () => {
        await reset();
        const v = await vendor("PT Sinar", { npwp: "01.234.567.8-901.000" });
        await fails(() => vendor("pt sinar "), "PT422", /name/);
        await fails(() => vendor("PT Lain", { npwp: "012345678901000" }), "PT422", /npwp/);
        await fails(() => j(REZA, `public.vendors_list(false)`), "PT404");
        await fails(() => j(FIN, `public.vendors_update($1::uuid, '{"bank_account_number":"999"}'::jsonb)`, [v.id]), "PT403");
        await fails(() => j(FIN, `public.vendors_change_bank($1::uuid, '{}'::jsonb, 'x')`, [v.id]), "PT403");
        const bank = JSON.stringify({ bank_name: "Mandiri", bank_account_number: "999", bank_account_holder: "PT Sinar" });
        await fails(() => j(PETER, `public.vendors_change_bank($1::uuid, $2::jsonb, '  ')`, [v.id, bank]), "PT422", /callback/);
        let c = await j(PETER, `public.vendors_change_bank($1::uuid, $2::jsonb, 'Called 021-555-0101, Ibu Sari confirmed')`, [v.id, bank]);
        const ev = c.events.at(-1);
        eq([c.bank_account_number, ev.kind, ev.before.bank_account_number, ev.detail.phone_called, ev.detail.phone_changed_recently],
            ["999", "bank_changed", "123", "021-555-0101", false], "changed");
        await j(FIN, `public.vendors_update($1::uuid, '{"phone":"0812-000"}'::jsonb)`, [v.id]);
        c = await j(PETER, `public.vendors_change_bank($1::uuid, $2::jsonb, 'Called again')`,
            [v.id, JSON.stringify({ bank_name: "BNI", bank_account_number: "777", bank_account_holder: "PT Sinar" })]);
        eq([c.phone_changed_recently, c.events.at(-1).detail.phone_changed_recently], [true, true], "recent phone");

        const p = await sourced(2000000, v);
        await j(FIN, `public.vendors_set_active($1::uuid, false, null)`, [v.id]);
        const other = await draft(REZA);
        await submit(REZA, other.id);
        await register(other.id);
        await fails(() => source(other.id, { vendor_id: v.id }), "PT422", /inactive/);
        eq((await get(FIN, p.id)).vendor.name, "PT Sinar", "still shown");
    });

    // --- assets -------------------------------------------------------------

    await step("purchasing: asset lines wait for IT, register from the line, and keep the link", async () => {
        await reset();
        const v = await vendor("PT Laptop");
        const p = await received(14800000, v, {
            quotes: 2, comparison: true,
            lines: [line({ line_type: "asset", asset_category_id: await cat("LAP"), description: "ThinkPad T14",
                           quantity: 1, unit_price: 14800000 })],
        });
        await fails(() => j(REZA, `public.assets_awaiting_registration()`), "PT404");
        const waiting = await j(TONO, `public.assets_awaiting_registration()`);
        eq(waiting.map((w) => [w.reference, w.description, w.qty_received, w.registered]),
            [[p.reference, "ThinkPad T14", 1, 0]], "waiting");
        eq((await notes("purchase_assets_to_register", TONO)).length, 1, "IT told");
        const a = await j(TONO, `public.assets_register_from_line($1::uuid, '{}'::jsonb)`, [waiting[0].line_id]);
        eq([a.purchase_value, a.purchase.reference, a.purchase_date !== null], [14800000, p.reference, true], "asset");
        if (!a.events[0].body.includes(p.reference)) throw new Error(a.events[0].body);
        eq((await j(TONO, `public.assets_awaiting_registration()`)).length, 0, "off the list");
        eq((await notes("purchase_assets_to_register", TONO))[0].resolved_at !== null, true, "settled");
        await fails(() => j(TONO, `public.assets_register_from_line($1::uuid, '{}'::jsonb)`, [waiting[0].line_id]),
            "PT422", /already registered/);
    });

    // --- notifications ------------------------------------------------------

    await step("purchasing: notifications go to who acts next, never the actor, and settle", async () => {
        await reset();
        const v = await vendor("PT Kabar");
        const p = await draft(REZA);
        await submit(REZA, p.id);
        eq((await notes("purchase_submitted", FIN)).length, 1, "finance told");
        eq((await notes("purchase_submitted", REZA)).length, 0, "not the actor");
        await register(p.id);
        eq((await notes("purchase_submitted", FIN))[0].resolved_at !== null, true, "settled on register");
        await source(p.id, { vendor_id: v.id, approval_amount: 2000000, related_party: false });
        await doc(FIN, p.id, "quote");
        await send(p.id);
        const ask = await notes("purchase_approval_needed", PETER);
        eq([ask.length, ask[0].needs_action, ask[0].payload.link.path], [1, true, `/purchasing?open=${p.id}`], "Peter asked");
        await approve(p.id);
        eq((await notes("purchase_approval_needed", PETER))[0].resolved_at !== null, true, "settled on approve");
        eq((await notes("purchase_decided", FIN)).length, 1, "finance told");
        eq((await notes("purchase_decided", REZA)).length, 0, "the requester gets the milestone instead");
        eq((await notes("purchase_decided", PETER)).length, 0, "Peter not told of his own decision");
    });

    await step("purchasing: the requester hears milestones only, never the vendor, an amount or a name", async () => {
        await reset();
        const v = await vendor("PT Rahasia");
        const p = await received(2000000, v);
        await doc(FIN, p.id, "invoice");
        const m = await match(p.id, { invoice_number: "INV-7", invoice_date: "2026-11-20", invoice_total: 2000000 });
        await j(PETER, `public.finance_approve($1::uuid)`, [m.finance_request.id]);
        await j(FIN, `public.finance_document_add($1::uuid, 'proof.pdf', 'application/pdf', 1000, $2)`,
            [m.finance_request.id, `${m.finance_request.id}/x/proof.pdf`]);
        await j(FIN, `public.finance_mark_paid($1::uuid, '2026-12-03'::date, null)`, [m.finance_request.id]);
        const mine = (await db.query(`select kind, payload from public.notifications where user_id = $1 order by created_at, id`,
            [REZA])).rows;
        eq(mine.map((n) => [n.kind, n.payload.headline.split(":")[0]]),
            [["purchase_progress", "Approved"], ["purchase_progress", "Ordered"], ["purchase_progress", "Delivered"],
             ["purchase_closed", "Done"]], "milestones");
        const text = JSON.stringify(mine);
        for (const leak of ["PT Rahasia", "2.000.000", "2,000,000", "Peter", "Cahya"])
            if (text.includes(leak)) throw new Error(`leaks ${leak}`);
    });

    await step("purchasing: the milestone for every status, a rejected delivery stays ordered, and outcomes", async () => {
        await reset();
        const v = await vendor("PT Tahap");
        const ms = async (id) => (await get(REZA, id)).milestone;
        const a = await sourced(2000000, v);
        eq((await ms(a.id)).current, "submitted", "sourcing");
        await send(a.id);
        eq((await ms(a.id)).current, "submitted", "awaiting approval");
        await approve(a.id);
        eq((await ms(a.id)).current, "approved", "approved");
        await order(a.id, CAHYA);
        await doc(CAHYA, a.id, "delivery_photo", "image/jpeg");
        const g = await get(CAHYA, a.id);
        const lines = g.lines.map((l) => ({ line_id: l.id, qty_received: l.quantity }));
        await receive(CAHYA, a.id, lines, false, "Wrong item");
        eq((await ms(a.id)).current, "ordered", "rejected delivery stays ordered");
        await doc(CAHYA, a.id, "delivery_photo", "image/jpeg");
        await receive(CAHYA, a.id, lines);
        const d = await ms(a.id);
        eq([d.current, Object.keys(d.dates).filter((k) => d.dates[k]).sort()],
            ["delivered", ["approved", "delivered", "ordered", "submitted"]], "delivered with dates");

        const b = await draft(REZA);
        await submit(REZA, b.id);
        await j(FIN, `public.purchases_return($1::uuid, 'Which model?')`, [b.id]);
        eq([(await ms(b.id)).outcome, (await ms(b.id)).note], ["returned", "Which model?"], "returned");

        const c = await sourced(2000000, await vendor("PT Tolak"));
        await send(c.id);
        await j(PETER, `public.purchases_reject($1::uuid, 'Not this year')`, [c.id]);
        eq([(await ms(c.id)).outcome, (await ms(c.id)).note], ["not_approved", "Not this year"], "not approved");
        eq((await notes("purchase_closed", REZA)).at(-1).payload.headline.startsWith("Not approved"), true, "told");
    });

    await step("purchasing: refusals name the role, not a person", async () => {
        await reset();
        const v = await vendor("PT Peran");
        await fails(() => j(FIN, `public.vendors_change_bank($1::uuid, '{}'::jsonb, 'x')`, [v.id]), "PT403",
            /^Only the approver changes a vendor's bank account\.$/);
        await fails(() => j(FIN, `public.purchases_settings_update('{}'::jsonb)`), "PT403", /^Only the approver/);
        const src = readFileSync(join(import.meta.dirname, "..", "..", "migrations", "20261017000100_purchasing_flow.sql"), "utf8");
        const quoted = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").match(/'[^']*Peter[^']*'/g) ?? [];
        eq(quoted, [], "no message names Peter");
    });

    // --- re-running ---------------------------------------------------------

    await step("purchasing: the migration is safe to re-run", async () => {
        await reset();
        const a = await draft(REZA);
        await submit(REZA, a.id);
        await register(a.id);
        await db.exec(readFileSync(join(import.meta.dirname, "..", "..", "migrations",
            "20261017000100_purchasing_flow.sql"), "utf8"));
        const b = await draft(REZA);
        await submit(REZA, b.id);
        eq((await register(b.id)).reference, "PR-0002", "numbering kept");
    });

    await reset();
    await db.exec(`update public.employees set is_it_support = false, is_active = false where employee_id like 'PUR-%'`);
};
