// Office asset register (20261016000100): tags, the moves between statuses,
// the holder's confirmation, who sees what, the history, the ticket link,
// check-in rounds, leavers, and the notifications each of them writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export default async ({ db, step, tx, people }) => {
    const { PETER, HIMAWAN } = people;

    // Our own people. Ira holds the IT support flag; Ana, Budi and Cici are
    // staff. Cici is the leaver.
    const U = {
        IRA: "8a000000-0000-0000-0000-000000000001",
        ANA: "8a000000-0000-0000-0000-000000000002",
        BUDI: "8a000000-0000-0000-0000-000000000003",
        CICI: "8a000000-0000-0000-0000-000000000004",
    };
    const E = {
        IRA: "8b000000-0000-0000-0000-000000000001",
        ANA: "8b000000-0000-0000-0000-000000000002",
        BUDI: "8b000000-0000-0000-0000-000000000003",
        CICI: "8b000000-0000-0000-0000-000000000004",
    };
    const { IRA, ANA, BUDI, CICI } = U;

    const authRows = Object.entries(U).map(([k, id]) => `('00000000-0000-0000-0000-000000000000','${id}',
        'authenticated','authenticated','${k.toLowerCase()}.a@dtgeotech.com','x', now(), '{"provider":"email"}'::jsonb,
        '{"full_name":"${k[0] + k.slice(1).toLowerCase()} Asset"}'::jsonb, now(), now(), '', '', '', '')`).join(",\n");
    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values ${authRows};

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, user_id) values
          ('${E.IRA}','AST-001','Ira','Asset','ira.a@dtgeotech.com','Ops','IT','2024-01-01',0,'${IRA}'),
          ('${E.ANA}','AST-002','Ana','Asset','ana.a@dtgeotech.com','Ops','Staff','2024-01-01',0,'${ANA}'),
          ('${E.BUDI}','AST-003','Budi','Asset','budi.a@dtgeotech.com','Ops','Staff','2024-01-01',0,'${BUDI}'),
          ('${E.CICI}','AST-004','Cici','Asset','cici.a@dtgeotech.com','Ops','Staff','2024-01-01',0,'${CICI}');

        update public.employees set is_it_support = true where id = '${E.IRA}';
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
    const cat = async (code) =>
        (await db.query(`select id from public.asset_categories where code = $1`, [code])).rows[0].id;
    const register = async (code, name, extra = {}) =>
        j(IRA, `public.assets_register($1::jsonb)`, [JSON.stringify({ category_id: await cat(code), name, ...extra })]);
    const get = (uid, id) => j(uid, `public.assets_get($1::uuid)`, [id]);
    const assign = (id, emp, note = null) => j(IRA, `public.assets_assign($1::uuid, $2::uuid, $3)`, [id, emp, note]);
    const respond = (uid, id, accept, note = null) =>
        j(uid, `public.assets_respond_handover($1::uuid, $2, $3)`, [id, accept, note]);
    const kinds = (a) => a.events.map((e) => e.kind).join(",");
    const notes = async (kind, user = null) =>
        (await db.query(`select n.*, n.payload->'link'->>'path' as path from public.notifications n
                          where n.kind = $1 and ($2::uuid is null or n.user_id = $2::uuid)
                          order by n.created_at, n.id`, [kind, user])).rows;
    const reset = () => db.exec(`
        update public.support_tickets set asset_id = null;
        delete from public.asset_checkin_rounds;
        delete from public.asset_leaver_notices;
        delete from public.asset_events;
        delete from public.assets;
        delete from public.notifications where kind like 'asset\\_%';
        delete from public.contracts where employee_id = '${E.CICI}';
        update public.asset_categories set next_number = 1;
        delete from public.asset_categories where code in ('CAM', 'DRN');
        update public.employees set is_active = true, contract_end_date = null,
                                    first_name = initcap(split_part(email, '.', 1))
         where employee_id like 'AST-%';
    `);

    // --- tags ---------------------------------------------------------------

    await step("assets: the first laptop is DTG-LAP-0001, in store, with one registered event", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad T14 Gen 4");
        if (a.tag !== "DTG-LAP-0001" || a.status !== "in_store") throw new Error(JSON.stringify(a));
        if (kinds(a) !== "registered" || a.events[0].actor_name !== "Ira Asset") throw new Error(kinds(a));
        if (a.can_manage !== true || !a.moves.includes("assign")) throw new Error(JSON.stringify(a.moves));
    });

    await step("assets: numbers run per category, in a loop as well", async () => {
        await reset();
        await register("LAP", "One");
        await register("LAP", "Two");
        const m = await register("MON", "Dell 24");
        const l = await register("LAP", "Three");
        if (m.tag !== "DTG-MON-0001" || l.tag !== "DTG-LAP-0003") throw new Error(`${m.tag} ${l.tag}`);
        const tags = [];
        for (let i = 0; i < 5; i++) tags.push((await register("ACC", `Mouse ${i}`)).tag);
        if (new Set(tags).size !== 5 || tags[4] !== "DTG-ACC-0005") throw new Error(tags.join(","));
    });

    await step("assets: the tag stays when the category is corrected", async () => {
        await reset();
        const a = await register("ACC", "Dell 24 screen");
        const b = await j(IRA, `public.assets_update($1::uuid, $2::jsonb)`,
            [a.id, JSON.stringify({ category_id: await cat("MON") })]);
        if (b.tag !== "DTG-ACC-0001" || b.category.code !== "MON") throw new Error(JSON.stringify(b));
        if (b.events.at(-1).body !== "Category: Accessory → Monitor") throw new Error(b.events.at(-1).body);
    });

    await step("assets: a serial is unique however it is typed; blank is none", async () => {
        await reset();
        await register("LAP", "One", { serial_number: "PF3X9K2" });
        await fails(() => register("LAP", "Two", { serial_number: " pf3x9k2 " }), "PT422",
            /serial_number: already registered as DTG-LAP-0001/);
        const a = await register("LAP", "Three", { serial_number: "  " });
        const b = await register("LAP", "Four", { serial_number: "" });
        if (a.serial_number !== null || b.serial_number !== null) throw new Error("blank kept");
    });

    await step("assets: only IT registers; staff, finance and management are refused", async () => {
        await reset();
        for (const who of [ANA, HIMAWAN, PETER])
            await fails(() => j(who, `public.assets_register($1::jsonb)`,
                [JSON.stringify({ name: "X" })]), "PT403", /Only IT support/);
        await fails(() => register("LAP", ""), "PT422", /name:/);
        await fails(() => register("LAP", "X", { purchase_value: -1 }), "PT422", /purchase_value: must not be negative/);
        await fails(() => register("LAP", "X", { purchase_date: "soon" }), "PT422", /purchase_date: must be a date/);
    });

    // --- categories ---------------------------------------------------------

    await step("assets: categories are seeded, a new one numbers from 1, a used code is fixed", async () => {
        await reset();
        const list = await j(ANA, `public.assets_categories()`);
        const codes = list.map((c) => c.code).sort().join(",");
        if (codes !== "ACC,DSK,FUR,LAP,MON,NET,OTH,PHN,PRN,SEN") throw new Error(codes);
        if (!list.find((c) => c.code === "SEN").tracks_calibration) throw new Error("sensor calibration");
        await j(IRA, `public.assets_category_save($1::jsonb)`, [JSON.stringify({ code: "cam", name: "Camera" })]);
        const c = await register("CAM", "Sony A7");
        if (c.tag !== "DTG-CAM-0001") throw new Error(c.tag);
        const lap = list.find((x) => x.code === "LAP");
        await register("LAP", "One");
        await fails(() => j(IRA, `public.assets_category_save($1::jsonb)`,
            [JSON.stringify({ id: lap.id, code: "NBK", name: "Laptop" })]), "PT422", /cannot change/);
        await fails(() => j(ANA, `public.assets_category_save($1::jsonb)`,
            [JSON.stringify({ code: "DRN", name: "Drone" })]), "PT403");
    });

    await step("assets: an inactive category takes no new items, and still shows on old ones", async () => {
        await reset();
        const old = await register("FUR", "Desk");
        const fur = (await j(IRA, `public.assets_categories()`)).find((c) => c.code === "FUR");
        await j(IRA, `public.assets_category_save($1::jsonb)`,
            [JSON.stringify({ id: fur.id, code: "FUR", name: "Furniture", is_active: false })]);
        await fails(() => register("FUR", "Chair"), "PT422", /no longer in use/);
        if ((await get(IRA, old.id)).category.name !== "Furniture") throw new Error("lost its category");
        await db.exec(`update public.asset_categories set is_active = true where code = 'FUR'`);
    });

    // --- the handover ---------------------------------------------------------

    await step("assets: register and assign is one action, registered before assigned", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad", { assign_to: E.BUDI });
        if (a.status !== "assigned" || a.holder.employee_id !== E.BUDI || a.handover_pending !== true)
            throw new Error(JSON.stringify(a));
        if (kinds(a) !== "registered,assigned") throw new Error(kinds(a));
        if (a.events[1].to_holder_name !== "Budi Asset") throw new Error(JSON.stringify(a.events[1]));
        const n = await notes("asset_assigned", BUDI);
        if (n.length !== 1 || !n[0].needs_action || n[0].path !== `/equipment?open=${a.id}`) throw new Error(JSON.stringify(n));
        if ((await notes("asset_assigned", IRA)).length !== 0) throw new Error("IT told about its own action");
    });

    await step("assets: the holder confirms, and their action item is settled", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        const r = await respond(BUDI, a.id, true);
        if (r.handover_pending !== false || !r.holder.confirmed_at) throw new Error(JSON.stringify(r));
        if (r.events.at(-1).kind !== "confirmed" || r.events.at(-1).actor_name !== "Budi Asset")
            throw new Error(JSON.stringify(r.events.at(-1)));
        if (!(await notes("asset_assigned", BUDI))[0].resolved_at) throw new Error("not settled");
        await fails(() => respond(BUDI, a.id, true), "PT409", /already confirmed/);
    });

    await step("assets: 'didn't receive it' needs a note, flags IT, and keeps the holder", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        await fails(() => respond(BUDI, a.id, false, " "), "PT422", /note:/);
        const r = await respond(BUDI, a.id, false, "Still with Rina");
        if (r.status !== "assigned" || r.holder.employee_id !== E.BUDI) throw new Error(JSON.stringify(r));
        const full = await get(IRA, a.id);
        if (full.flag?.kind !== "handover_declined" || full.flag.note !== "Still with Rina") throw new Error(JSON.stringify(full.flag));
        if (full.events.at(-1).kind !== "declined") throw new Error(kinds(full));
        const it = await notes("asset_handover_declined", IRA);
        if (it.length !== 1 || !it[0].needs_action || it[0].payload.note.text !== "Still with Rina") throw new Error(JSON.stringify(it));
        // Any IT move settles it and clears the flag.
        const back = await j(IRA, `public.assets_return($1::uuid, 'Store room', null)`, [a.id]);
        if (back.flag !== null || !back.events.at(-1).body.endsWith("· Flag cleared")) throw new Error(JSON.stringify(back));
        if (!(await notes("asset_handover_declined", IRA))[0].resolved_at) throw new Error("not settled");
    });

    await step("assets: only the holder answers the handover; anyone else gets not found", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        await fails(() => respond(ANA, a.id, true), "PT404", /Not found/);
        await fails(() => respond(IRA, a.id, true), "PT404", /Not found/);
    });

    await step("assets: a transfer asks the new holder again and releases the old one", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        const t = await assign(a.id, E.ANA);
        if (t.holder.employee_id !== E.ANA || t.handover_pending !== true) throw new Error(JSON.stringify(t));
        if (t.events.at(-1).kind !== "transferred" || t.events.at(-1).body !== "Transferred to Ana Asset")
            throw new Error(JSON.stringify(t.events.at(-1)));
        if (!(await notes("asset_assigned", BUDI))[0].resolved_at) throw new Error("Budi's item not settled");
        if ((await notes("asset_assigned", ANA)).length !== 1) throw new Error("Ana not asked");
        if ((await notes("asset_released", BUDI)).length !== 1) throw new Error("Budi not told");
        await fails(() => assign(a.id, E.ANA), "PT409", /already with Ana Asset/);
    });

    // --- moves ----------------------------------------------------------------

    await step("assets: repair keeps the holder and the confirmation, and brings it back to them", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        await respond(BUDI, a.id, true);
        const out = await j(IRA, `public.assets_send_to_repair($1::uuid, 'Keyboard')`, [a.id]);
        if (out.status !== "in_repair" || out.holder.employee_id !== E.BUDI) throw new Error(JSON.stringify(out));
        const back = await j(IRA, `public.assets_back_from_repair($1::uuid, null)`, [a.id]);
        if (back.status !== "assigned" || back.handover_pending !== false || back.holder.employee_id !== E.BUDI)
            throw new Error(JSON.stringify(back));
        if (!kinds(back).endsWith("repair_out,repair_back")) throw new Error(kinds(back));
        const s = await register("SEN", "Piezometer");
        await j(IRA, `public.assets_send_to_repair($1::uuid, null)`, [s.id]);
        if ((await j(IRA, `public.assets_back_from_repair($1::uuid, null)`, [s.id])).status !== "in_store")
            throw new Error("unheld item not back in store");
    });

    await step("assets: a held item is returned before it can be retired; retired is final", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        await fails(() => j(IRA, `public.assets_retire($1::uuid, 'Old')`, [a.id]), "PT409", /assigned; that move does not apply/);
        await j(IRA, `public.assets_return($1::uuid, null, null)`, [a.id]);
        await fails(() => j(IRA, `public.assets_retire($1::uuid, ' ')`, [a.id]), "PT422", /reason:/);
        const r = await j(IRA, `public.assets_retire($1::uuid, 'Screen cracked, beyond repair')`, [a.id]);
        if (r.status !== "retired" || !r.retired_at || r.moves.length !== 0) throw new Error(JSON.stringify(r));
        await fails(() => assign(a.id, E.ANA), "PT409", /retired; it cannot be assigned/);
        await fails(() => j(IRA, `public.assets_update($1::uuid, '{"name":"X"}'::jsonb)`, [a.id]), "PT409");
    });

    await step("assets: lost needs a note and keeps the holder; found puts it in store", async () => {
        await reset();
        const a = await register("PHN", "iPhone");
        await assign(a.id, E.BUDI);
        await fails(() => j(IRA, `public.assets_mark_lost($1::uuid, '')`, [a.id]), "PT422", /note:/);
        const l = await j(IRA, `public.assets_mark_lost($1::uuid, 'Left on the site bus')`, [a.id]);
        if (l.status !== "lost" || l.holder.employee_id !== E.BUDI) throw new Error(JSON.stringify(l));
        const f = await j(IRA, `public.assets_mark_found($1::uuid, 'Store room', null)`, [a.id]);
        if (f.status !== "in_store" || f.holder !== null || f.location !== "Store room") throw new Error(JSON.stringify(f));
        if ((await notes("asset_released", BUDI)).length !== 1) throw new Error("Budi not told");
    });

    await step("assets: staff, finance and management cannot move assets", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        for (const who of [BUDI, HIMAWAN, PETER])
            await fails(() => j(who, `public.assets_return($1::uuid, null, null)`, [a.id]), "PT403", /Only IT support/);
    });

    // --- access ---------------------------------------------------------------

    await step("assets: finance and management read values and the full history, with no moves", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad", { purchase_value: 18000000, location: "Store room" });
        for (const who of [HIMAWAN, PETER]) {
            const r = await get(who, a.id);
            if (Number(r.purchase_value) !== 18000000 || r.events.length !== 1) throw new Error(JSON.stringify(r));
            if (r.can_manage !== false || r.moves.length !== 0) throw new Error("offered moves");
            const list = await j(who, `public.assets_list(false)`);
            if (list.items.length !== 1 || list.can_manage !== false) throw new Error(JSON.stringify(list));
        }
        await fails(() => j(ANA, `public.assets_list(false)`), "PT403", /for IT, finance and management/);
    });

    await step("assets: My equipment shows what I hold, pending ones marked, without value or location", async () => {
        await reset();
        const a = await register("LAP", "One", { purchase_value: 18000000, location: "Desk 4" });
        const b = await register("LAP", "Two", { purchase_value: 18000000 });
        const m = await register("MON", "Screen");
        await assign(a.id, E.BUDI);
        await assign(b.id, E.BUDI);
        await assign(m.id, E.BUDI);
        await respond(BUDI, a.id, true);
        await respond(BUDI, b.id, true);
        const mine = await j(BUDI, `public.assets_mine()`);
        if (mine.items.length !== 3) throw new Error(`${mine.items.length} items`);
        const mon = mine.items.find((x) => x.id === m.id);
        if (mon.handover_pending !== true || mon.can_respond !== true) throw new Error(JSON.stringify(mon));
        for (const x of mine.items)
            for (const k of ["purchase_value", "location", "currency", "flag", "notes", "moves"])
                if (k in x) throw new Error(`holder sees ${k}`);
        if (mine.can_view_all !== false) throw new Error("can_view_all");
    });

    await step("assets: a holder's history starts at their assignment and names nobody before", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        await respond(BUDI, a.id, true);
        await assign(a.id, E.ANA);
        const mine = await get(ANA, a.id);
        if (kinds(mine) !== "transferred") throw new Error(kinds(mine));
        const ev = mine.events[0];
        if (ev.from_holder_name !== null || ev.to_holder_name !== "Ana Asset") throw new Error(JSON.stringify(ev));
        if (JSON.stringify(mine).includes("Budi")) throw new Error("names Budi");
        await fails(() => get(BUDI, a.id), "PT404", /Not found/);
    });

    await step("assets: a colleague's asset is not found", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        await fails(() => get(ANA, a.id), "PT404", /Not found/);
        const s = await register("LAP", "In store");
        await fails(() => get(ANA, s.id), "PT404", /Not found/);
    });

    // --- editing and the history -----------------------------------------------

    await step("assets: an edit lists what changed; value changes hide the figures; nothing is refused", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad", { purchase_value: 18000000 });
        const s = await j(IRA, `public.assets_update($1::uuid, $2::jsonb)`,
            [a.id, JSON.stringify({ serial_number: "PF3X9K2" })]);
        if (s.events.at(-1).body !== "Serial: — → PF3X9K2") throw new Error(s.events.at(-1).body);
        const v = await j(IRA, `public.assets_update($1::uuid, $2::jsonb)`,
            [a.id, JSON.stringify({ purchase_value: 18500000 })]);
        const body = v.events.at(-1).body;
        if (body !== "Purchase value changed" || /18/.test(body)) throw new Error(body);
        await fails(() => j(IRA, `public.assets_update($1::uuid, $2::jsonb)`,
            [a.id, JSON.stringify({ serial_number: "PF3X9K2", name: "ThinkPad" })]), "PT422", /Nothing to change/);
    });

    await step("assets: the history keeps a holder's name as it was", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        await db.exec(`update public.employees set first_name = 'Bud', is_active = false where id = '${E.BUDI}'`);
        const r = await get(IRA, a.id);
        if (r.events.at(-1).to_holder_name !== "Budi Asset") throw new Error(JSON.stringify(r.events.at(-1)));
        if (r.holder.name !== "Bud Asset") throw new Error(r.holder.name);
    });

    await step("assets: history rows cannot be read or written by clients", async () => {
        await reset();
        await register("LAP", "ThinkPad");
        // Row-level security with no policies: clients see and touch nothing,
        // whether or not the table grants would let them try.
        const tryAs = async (sql) => { try { return await tx(IRA, sql); } catch { return null; } };
        const seen = await tryAs(`select count(*)::int n from public.asset_events`);
        if (seen && seen.rows[0].n !== 0) throw new Error(`client read ${seen.rows[0].n} events`);
        await tryAs(`delete from public.asset_events`);
        await tryAs(`update public.assets set status = 'lost'`);
        const after = await db.query(`select (select count(*)::int from public.asset_events) e,
                                             (select status from public.assets limit 1) s`);
        if (after.rows[0].e !== 1 || after.rows[0].s !== "in_store") throw new Error(JSON.stringify(after.rows[0]));
    });

    // --- tickets ---------------------------------------------------------------

    await step("assets: IT links a ticket to an asset; both sides record it; the reporter cannot", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.BUDI);
        const t = await j(BUDI, `public.tickets_raise('Laptop will not charge', 'Dead', 'hardware', 'normal', null)`);
        await fails(() => j(BUDI, `public.tickets_link_asset($1::uuid, $2::uuid)`, [t.id, a.id]), "PT403");
        const l = await j(IRA, `public.tickets_link_asset($1::uuid, $2::uuid)`, [t.id, a.id]);
        if (l.asset?.tag !== "DTG-LAP-0001" || l.events.at(-1).body !== "Linked to DTG-LAP-0001")
            throw new Error(JSON.stringify(l.asset) + l.events.at(-1).body);
        const seen = await j(BUDI, `public.tickets_get($1::uuid)`, [t.id]);
        if (seen.asset?.name !== "ThinkPad") throw new Error("reporter does not see the asset");
        let r = await get(IRA, a.id);
        if (r.events.at(-1).kind !== "ticket_linked" || r.events.at(-1).ticket_reference !== t.reference)
            throw new Error(JSON.stringify(r.events.at(-1)));
        if (r.tickets.length !== 1 || r.tickets[0].reference !== t.reference) throw new Error(JSON.stringify(r.tickets));
        await fails(() => j(IRA, `public.tickets_link_asset($1::uuid, $2::uuid)`, [t.id, a.id]), "PT422", /Nothing to change/);
        const u = await j(IRA, `public.tickets_link_asset($1::uuid, null)`, [t.id]);
        if (u.asset !== null) throw new Error("still linked");
        r = await get(IRA, a.id);
        if (r.events.at(-1).kind !== "ticket_unlinked" || r.tickets.length !== 0) throw new Error(kinds(r));
    });

    await step("assets: retiring an asset keeps its ticket links", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        const t = await j(ANA, `public.tickets_raise('Old laptop', 'Slow', 'hardware', 'normal', null)`);
        await j(IRA, `public.tickets_link_asset($1::uuid, $2::uuid)`, [t.id, a.id]);
        await j(IRA, `public.assets_retire($1::uuid, 'Too slow')`, [a.id]);
        const seen = await j(IRA, `public.tickets_get($1::uuid)`, [t.id]);
        if (seen.asset?.id !== a.id) throw new Error("link lost");
    });

    // --- check-in rounds ---------------------------------------------------------

    const round = async () => {
        const a = await register("LAP", "Budi's laptop");
        const b = await register("PHN", "Budi's phone");
        const c = await register("LAP", "Ana's laptop");
        const s = await register("MON", "Shelf monitor");
        const rep = await register("LAP", "In repair");
        const lost = await register("ACC", "Lost mouse");
        const ret = await register("ACC", "Old mouse");
        for (const x of [a, b]) await assign(x.id, E.BUDI);
        await respond(BUDI, a.id, true);
        await assign(c.id, E.ANA);
        await j(IRA, `public.assets_send_to_repair($1::uuid, null)`, [rep.id]);
        await j(IRA, `public.assets_mark_lost($1::uuid, 'Gone')`, [lost.id]);
        await j(IRA, `public.assets_retire($1::uuid, 'Broken')`, [ret.id]);
        const r = await j(IRA, `public.assets_round_start('Check-in October 2026', null)`);
        return { a, b, c, s, rep, r, item: (id) => r.items.find((i) => i.asset_id === id) };
    };

    await step("check-in: a round takes assigned, in-store and in-repair items, not lost or retired", async () => {
        await reset();
        const { r } = await round();
        if (r.counts.total !== 5 || r.counts.pending !== 5) throw new Error(JSON.stringify(r.counts));
        if (r.items.filter((i) => i.holder_employee_id).length !== 3) throw new Error("holders");
        await fails(() => j(IRA, `public.assets_round_start(null, null)`), "PT422", /already open/);
        const req = await notes("asset_checkin_requested", BUDI);
        if (req.length !== 1 || !req[0].payload.details.some(([k, v]) => k === "Items" && v === "2 items"))
            throw new Error(JSON.stringify(req));
        if (req[0].path !== `/equipment?round=${r.id}`) throw new Error(req[0].path);
        if ((await notes("asset_checkin_requested", ANA)).length !== 1) throw new Error("Ana not asked");
        await fails(() => j(ANA, `public.assets_round_start(null, null)`), "PT403");
    });

    await step("check-in: 'I have it' confirms, and confirms a pending handover too", async () => {
        await reset();
        const { a, b, r, item } = await round();
        await j(BUDI, `public.assets_round_answer($1::uuid, true, null)`, [item(a.id).id]);
        const mine = await j(BUDI, `public.assets_round_answer($1::uuid, true, null)`, [item(b.id).id]);
        if (mine.round.pending !== 0) throw new Error(JSON.stringify(mine.round));
        const phone = await get(IRA, b.id);
        if (phone.handover_pending !== false) throw new Error("handover still pending");
        if (!kinds(phone).endsWith("checkin_confirmed,confirmed")) throw new Error(kinds(phone));
        if (!(await notes("asset_checkin_requested", BUDI))[0].resolved_at) throw new Error("request not settled");
        if ((await notes("asset_checkin_requested", ANA))[0].resolved_at) throw new Error("Ana's settled too");
        const rr = await j(IRA, `public.assets_round_get($1::uuid)`, [r.id]);
        if (rr.counts.confirmed !== 2) throw new Error(JSON.stringify(rr.counts));
        await fails(() => j(BUDI, `public.assets_round_answer($1::uuid, true, null)`, [item(a.id).id]), "PT409", /already answered/);
    });

    await step("check-in: 'Not with me' needs a note, flags the asset and tells IT", async () => {
        await reset();
        const { b, item } = await round();
        await fails(() => j(BUDI, `public.assets_round_answer($1::uuid, false, '')`, [item(b.id).id]), "PT422", /note:/);
        await j(BUDI, `public.assets_round_answer($1::uuid, false, 'Gave it back to IT in August')`, [item(b.id).id]);
        const p = await get(IRA, b.id);
        if (p.status !== "assigned" || p.holder.employee_id !== E.BUDI || p.flag?.kind !== "checkin_missing")
            throw new Error(JSON.stringify(p));
        const it = await notes("asset_checkin_missing", IRA);
        if (it.length !== 1 || !it[0].needs_action) throw new Error(JSON.stringify(it));
        await j(IRA, `public.assets_clear_flag($1::uuid, 'Found it in the store')`, [b.id]);
        if (!(await notes("asset_checkin_missing", IRA))[0].resolved_at) throw new Error("not settled");
    });

    await step("check-in: only the holder answers an item", async () => {
        await reset();
        const { a, s, item } = await round();
        await fails(() => j(ANA, `public.assets_round_answer($1::uuid, true, null)`, [item(a.id).id]), "PT404");
        await fails(() => j(ANA, `public.assets_round_answer($1::uuid, true, null)`, [item(s.id).id]), "PT404");
    });

    await step("check-in: IT marks shelf items seen, and an IT move during the round counts as seen", async () => {
        await reset();
        const { a, s, r, item } = await round();
        const after = await j(IRA, `public.assets_round_mark_seen($1::uuid, 'On the shelf')`, [item(s.id).id]);
        if (after.items.find((i) => i.asset_id === s.id).state !== "seen") throw new Error("not seen");
        if ((await get(IRA, s.id)).events.at(-1).kind !== "checkin_seen") throw new Error("no event");
        await j(IRA, `public.assets_return($1::uuid, null, null)`, [a.id]);
        const rr = await j(IRA, `public.assets_round_get($1::uuid)`, [r.id]);
        const ai = rr.items.find((i) => i.asset_id === a.id);
        if (ai.state !== "seen" || ai.responded_by_name !== "Ira Asset") throw new Error(JSON.stringify(ai));
    });

    await step("check-in: closing marks the rest no reply, keeps the summary, and settles requests", async () => {
        await reset();
        const { a, b, s, r, item } = await round();
        await j(BUDI, `public.assets_round_answer($1::uuid, true, null)`, [item(a.id).id]);
        await j(BUDI, `public.assets_round_answer($1::uuid, false, 'Not sure')`, [item(b.id).id]);
        await j(IRA, `public.assets_round_mark_seen($1::uuid, null)`, [item(s.id).id]);
        const c = await j(IRA, `public.assets_round_close($1::uuid)`, [r.id]);
        const want = { total: 5, confirmed: 1, missing: 1, seen: 1, no_reply: 2 };
        if (Object.entries(want).some(([k, v]) => c.summary[k] !== v)) throw new Error(JSON.stringify(c.summary));
        if (c.is_open !== false || c.closed_by_name !== "Ira Asset") throw new Error(JSON.stringify(c));
        if (!(await notes("asset_checkin_requested", ANA))[0].resolved_at) throw new Error("Ana's request open");
        await fails(() => j(ANA, `public.assets_round_answer($1::uuid, true, null)`, [item(r.items.find(
            (i) => i.holder_employee_id === E.ANA).asset_id).id]), "PT422", /has closed/);
        await fails(() => j(IRA, `public.assets_round_close($1::uuid)`, [r.id]), "PT409");
        const fin = await j(HIMAWAN, `public.assets_round_get($1::uuid)`, [r.id]);
        if (fin.items.length !== 5 || fin.can_manage !== false) throw new Error("finance cannot read the round");
        await fails(() => j(ANA, `public.assets_round_get($1::uuid)`, [r.id]), "PT404");
        const list = await j(PETER, `public.assets_rounds()`);
        if (list.items.length !== 1 || list.items[0].counts.no_reply !== 2) throw new Error(JSON.stringify(list));
    });

    // --- the daily run -------------------------------------------------------------

    const run = () => db.query(`select public.assets_daily_run() j`).then((r) => r.rows[0].j);

    await step("daily: a week into a round, holders still pending are reminded once", async () => {
        await reset();
        const { a, r, item } = await round();
        await j(BUDI, `public.assets_round_answer($1::uuid, true, null)`, [item(a.id).id]);
        let out = await run();
        if (out.reminded !== 0) throw new Error("reminded too early");
        await db.query(`update public.asset_checkin_rounds set started_at = now() - interval '7 days 1 hour' where id = $1`, [r.id]);
        out = await run();
        if (out.reminded !== 2) throw new Error(`reminded ${out.reminded}`);
        if ((await notes("asset_checkin_reminder", BUDI)).length !== 1) throw new Error("Budi not reminded");
        if ((await notes("asset_checkin_reminder", ANA)).length !== 1) throw new Error("Ana not reminded");
        out = await run();
        if (out.reminded !== 0) throw new Error("reminded twice");
    });

    await step("daily: IT is reminded six months on, not while a round is open, once a month", async () => {
        await reset();
        await register("LAP", "ThinkPad");
        await db.exec(`update public.assets set created_at = now() - interval '183 days'`);
        let out = await run();
        if (out.due !== 1 || (await notes("asset_checkin_due", IRA)).length !== 1) throw new Error("not reminded");
        out = await run();
        if (out.due !== 0) throw new Error("reminded again within 30 days");
        await j(IRA, `public.assets_round_start(null, null)`);
        if (!(await notes("asset_checkin_due", IRA))[0].resolved_at) throw new Error("not settled by the round");
        await db.exec(`update public.notifications set created_at = now() - interval '31 days' where kind = 'asset_checkin_due'`);
        out = await run();
        if (out.due !== 0) throw new Error("reminded while a round is open");
    });

    await step("daily: a holder whose contract ends within 14 days is notified once per end date", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        const p = await register("PHN", "iPhone");
        await assign(a.id, E.CICI);
        await assign(p.id, E.CICI);
        await db.exec(`update public.employees set contract_end_date = public.local_today() + 10 where id = '${E.CICI}'`);
        let out = await run();
        if (out.leavers !== 1) throw new Error(`leavers ${out.leavers}`);
        const n = await notes("asset_holder_leaving", IRA);
        if (n.length !== 1 || n[0].path !== `/equipment?holder=${E.CICI}`) throw new Error(JSON.stringify(n));
        if (!n[0].payload.details.some(([k, v]) => k === "Items" && v === "DTG-LAP-0001, DTG-PHN-0001"))
            throw new Error(JSON.stringify(n[0].payload.details));
        out = await run();
        if (out.leavers !== 0) throw new Error("notified twice");
        await db.exec(`update public.employees set contract_end_date = public.local_today() + 12 where id = '${E.CICI}'`);
        out = await run();
        if (out.leavers !== 1) throw new Error("moved date not notified");
        const live = await j(IRA, `public.assets_leavers()`);
        if (live.length !== 1 || live[0].items.length !== 2 || live[0].reason !== "contract_end") throw new Error(JSON.stringify(live));
        // Returning the last item settles IT's item.
        await j(IRA, `public.assets_return($1::uuid, null, null)`, [a.id]);
        if ((await notes("asset_holder_leaving", IRA)).some((x) => x.resolved_at)) throw new Error("settled too early");
        await j(IRA, `public.assets_return($1::uuid, null, null)`, [p.id]);
        if ((await notes("asset_holder_leaving", IRA)).some((x) => !x.resolved_at)) throw new Error("not settled");
    });

    await step("daily: a manpower contract ending counts; an inactive holder counts; no items, no notice", async () => {
        await reset();
        const a = await register("LAP", "ThinkPad");
        await assign(a.id, E.CICI);
        await db.exec(`
            insert into public.contracts (kind, title, employee_id, end_date, status)
            values ('manpower', 'Cici PKWT', '${E.CICI}', public.local_today() + 5, 'active')`);
        let live = await j(IRA, `public.assets_leavers()`);
        if (live.length !== 1 || live[0].reason !== "contract_end") throw new Error(JSON.stringify(live));
        await db.exec(`update public.employees set is_active = false where id = '${E.ANA}'`);
        // Ana is inactive too, but holds nothing.
        const o = await run();
        if (o.leavers !== 1) throw new Error(`leavers ${o.leavers}`);
        await db.exec(`update public.employees set is_active = false where id = '${E.CICI}'`);
        live = await j(IRA, `public.assets_leavers()`);
        if (live.length !== 1 || live[0].reason !== "inactive" || live[0].end_date !== null) throw new Error(JSON.stringify(live));
        if ((await run()).leavers !== 1) throw new Error("inactive not notified");
    });

    // --- re-running --------------------------------------------------------------

    await step("assets: the migration is safe to re-run", async () => {
        await reset();
        await register("LAP", "ThinkPad");
        await db.exec(readFileSync(join(import.meta.dirname, "..", "..", "migrations",
            "20261016000100_office_asset_register.sql"), "utf8"));
        const n = await db.query(`select count(*)::int n from public.asset_categories`);
        if (n.rows[0].n !== 10) throw new Error(`${n.rows[0].n} categories`);
        if ((await register("LAP", "Second")).tag !== "DTG-LAP-0002") throw new Error("numbering reset");
    });

    // Leave nothing that changes who IT is for the suites after this one.
    await reset();
    await db.exec(`update public.employees set is_it_support = false, is_active = false where employee_id like 'AST-%'`);
};
