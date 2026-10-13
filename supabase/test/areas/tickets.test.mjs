// IT support tickets: ported from backend tests/test_tickets.py, plus the
// rules the routes carry (internal notes, resolving, reopening, the trail).
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, RINA } = people;

    // Our own people. Lintang manages Bintang, who holds the IT support flag;
    // Nessy is ordinary staff. Peter (executive) is the administrator with an
    // employee record; the director stand-in has none.
    const LINTANG = "7a000000-0000-0000-0000-000000000001";
    const BINTANG = "7a000000-0000-0000-0000-000000000002";
    const NESSY = "7a000000-0000-0000-0000-000000000003";
    const E_LINTANG = "7b000000-0000-0000-0000-000000000001";
    const E_BINTANG = "7b000000-0000-0000-0000-000000000002";
    const E_NESSY = "7b000000-0000-0000-0000-000000000003";

    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
          ('00000000-0000-0000-0000-000000000000','${LINTANG}','authenticated','authenticated',
           'lintang.t@dtgeotech.com','x', now(), '{"provider":"email"}'::jsonb,
           '{"full_name":"Lintang Test"}'::jsonb, now(), now(), '', '', '', ''),
          ('00000000-0000-0000-0000-000000000000','${BINTANG}','authenticated','authenticated',
           'bintang.t@dtgeotech.com','x', now(), '{"provider":"email"}'::jsonb,
           '{"full_name":"Bintang Test"}'::jsonb, now(), now(), '', '', '', ''),
          ('00000000-0000-0000-0000-000000000000','${NESSY}','authenticated','authenticated',
           'nessy.t@dtgeotech.com','x', now(), '{"provider":"email"}'::jsonb,
           '{"full_name":"Nessy Test"}'::jsonb, now(), now(), '', '', '', '');

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, user_id) values
          ('${E_LINTANG}','TKT-001','Lintang','Test','lintang.t@dtgeotech.com','Ops','Staff','2024-01-01',0,'${LINTANG}'),
          ('${E_BINTANG}','TKT-002','Bintang','Test','bintang.t@dtgeotech.com','Ops','IT','2024-01-01',0,'${BINTANG}'),
          ('${E_NESSY}','TKT-003','Nessy','Test','nessy.t@dtgeotech.com','Ops','Staff','2024-01-01',0,'${NESSY}');

        update public.employees set is_it_support = true, manager_id = '${E_LINTANG}'
         where id = '${E_BINTANG}';
    `);

    const j = async (uid, sql, params) => (await tx(uid, `select ${sql} j`, params)).rows[0].j;
    const raise = (uid, subject = "Laptop will not charge", category = "hardware", location = null) =>
        j(uid, `public.tickets_raise($1, 'Dead', $2, 'normal', $3)`, [subject, category, location]);
    const setStatus = (uid, id, status, note = null) =>
        j(uid, `public.tickets_set_status($1::uuid, $2, $3)`, [id, status, note]);
    const comment = (uid, id, body, internal = false) =>
        j(uid, `public.tickets_comment($1::uuid, $2, $3)`, [id, body, internal]);
    const resolve = async (uid, id) => {
        await comment(uid, id, "Suspect the charger", true);
        return setStatus(uid, id, "resolved", "Replaced the charger");
    };
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
    const cats = (body) => Object.fromEntries(body.categories.map((c) => [c.category, c]));
    const reset = () => db.exec(`
        delete from public.support_tickets;
        update public.employees set is_active = true where id = '${E_BINTANG}';
    `);

    await step("tickets: raising needs an employee record", async () => {
        await reset();
        await fails(() => raise(DIRECTOR), "PT403", /Only staff with an employee record can raise a ticket\./);
    });

    await step("tickets: a new ticket goes to the first IT-support holder, trail starts at raised", async () => {
        await reset();
        const t = await raise(NESSY);
        const first = await db.query(`select id from public.employees
            where is_it_support and is_active order by employee_id limit 1`);
        if (t.assignee_id !== first.rows[0].id) throw new Error(`assignee ${t.assignee_id}`);
        if (t.status !== "open" || t.reporter_name !== "Nessy Test") throw new Error(JSON.stringify(t));
        if (t.can_work !== false) throw new Error("reporter cannot work it");
        if (t.events.length !== 1 || t.events[0].kind !== "raised" || t.events[0].to_status !== "open")
            throw new Error(JSON.stringify(t.events));
        const log = await db.query(`select count(*)::int n from public.activity_logs
            where action = 'TICKET_RAISED' and target_id = $1`, [t.id]);
        if (log.rows[0].n !== 1) throw new Error("not logged");
    });

    await step("tickets: administrators do not get the live queue", async () => {
        await reset();
        await raise(NESSY);
        const body = await j(PETER, `public.tickets_list(false, false)`);
        if (body.items.length !== 0) throw new Error(`saw ${body.items.length}`);
        if (body.is_support !== false || body.can_view_history !== true) throw new Error(JSON.stringify(body));
    });

    await step("tickets: administrators cannot work a ticket, nor read an open one not theirs", async () => {
        await reset();
        const t = await raise(NESSY);
        await fails(() => setStatus(PETER, t.id, "in_progress"), "PT403", /Only IT support can do that\./);
        await fails(() => j(PETER, `public.tickets_get($1::uuid)`, [t.id]), "PT404", /Not found/);
    });

    await step("tickets: administrators still see tickets they raised", async () => {
        await reset();
        await raise(PETER, "My VPN is down", "connection");
        const body = await j(PETER, `public.tickets_list(false, false)`);
        if (JSON.stringify(body.items.map((t) => t.subject)) !== '["My VPN is down"]')
            throw new Error(JSON.stringify(body.items));
    });

    await step("tickets: IT support works the whole queue", async () => {
        await reset();
        const t = await raise(NESSY);
        const body = await j(BINTANG, `public.tickets_list(false, false)`);
        if (body.is_support !== true || body.can_view_history !== true) throw new Error(JSON.stringify(body));
        if (body.items.length !== 1 || body.items[0].id !== t.id) throw new Error("queue");
        if (body.items[0].events.length !== 0) throw new Error("list carries no events");
        if (body.open_count !== 1) throw new Error(`open_count ${body.open_count}`);
        const mine = await j(BINTANG, `public.tickets_list(true, false)`);
        if (mine.items.length !== 0) throw new Error("mine_only");
        const r = await resolve(BINTANG, t.id);
        if (r.status !== "resolved" || r.resolved_by !== "Bintang Test") throw new Error(JSON.stringify(r));
    });

    await step("tickets: the manager of IT support works the queue too", async () => {
        await reset();
        const t = await raise(NESSY);
        const body = await j(LINTANG, `public.tickets_list(false, false)`);
        if (body.is_support !== true || body.items[0]?.id !== t.id) throw new Error(JSON.stringify(body));
        await resolve(LINTANG, t.id);
    });

    await step("tickets: the manager loses the queue when IT support leaves", async () => {
        await reset();
        await db.exec(`update public.employees set is_active = false where id = '${E_BINTANG}'`);
        const body = await j(LINTANG, `public.tickets_list(false, false)`);
        await db.exec(`update public.employees set is_active = true where id = '${E_BINTANG}'`);
        if (body.is_support !== false) throw new Error("still support");
    });

    await step("tickets: ordinary staff see only their own and no history", async () => {
        await reset();
        await raise(PETER, "Printer jammed");
        const mine = await raise(NESSY);
        const body = await j(NESSY, `public.tickets_list(false, false)`);
        if (body.items.length !== 1 || body.items[0].id !== mine.id) throw new Error(JSON.stringify(body.items));
        if (body.can_view_history !== false || body.is_support !== false) throw new Error("flags");
        await fails(() => j(NESSY, `public.tickets_history()`), "PT403",
            /The IT support history is for administrators and IT support\./);
        const other = (await db.query(`select id from public.support_tickets where subject = 'Printer jammed'`)).rows[0].id;
        await fails(() => j(NESSY, `public.tickets_get($1::uuid)`, [other]), "PT404");
        await fails(() => comment(NESSY, other, "me too"), "PT404");
    });

    await step("tickets: reporters comment but never internally, and never read internal notes", async () => {
        await reset();
        const t = await raise(NESSY);
        await fails(() => comment(NESSY, t.id, "psst", true), "PT403",
            /Only IT support can leave an internal note\./);
        await comment(NESSY, t.id, "Still dead");
        await comment(BINTANG, t.id, "Suspect the ISP", true);
        const seen = await j(NESSY, `public.tickets_get($1::uuid)`, [t.id]);
        if (seen.events.some((e) => e.is_internal)) throw new Error("reporter saw an internal note");
        if (seen.events.length !== 2) throw new Error(`events ${seen.events.length}`);
        const it = await j(BINTANG, `public.tickets_get($1::uuid)`, [t.id]);
        if (!it.events.some((e) => e.is_internal) || it.can_work !== true) throw new Error("IT sees all");
    });

    await step("tickets: resolving needs a note; same status is a conflict; reopening clears resolution", async () => {
        await reset();
        const t = await raise(NESSY);
        await fails(() => setStatus(BINTANG, t.id, "resolved", "  "), "PT422", /^Say what fixed it\./);
        await fails(() => setStatus(BINTANG, t.id, "open"), "PT409", /is already open\.$/);
        await fails(() => setStatus(BINTANG, t.id, "fixed"), "PT422");
        const w = await setStatus(BINTANG, t.id, "in_progress");
        const ev = w.events[w.events.length - 1];
        if (ev.kind !== "status" || ev.body !== "open → in progress" || ev.from_status !== "open")
            throw new Error(JSON.stringify(ev));
        const r = await setStatus(BINTANG, t.id, "resolved", "Replaced the charger");
        if (r.resolution !== "Replaced the charger" || !r.resolved_at) throw new Error(JSON.stringify(r));
        const o = await setStatus(BINTANG, t.id, "open");
        if (o.resolution !== null || o.resolved_at !== null || o.resolved_by !== null) throw new Error(JSON.stringify(o));
    });

    await step("tickets: the trail is append-only", async () => {
        await reset();
        const t = await raise(NESSY);
        await fails(() => db.query(`update public.ticket_events set body = 'x' where ticket_id = $1`, [t.id]),
            null, /append-only/);
        await fails(() => db.query(`delete from public.ticket_events where ticket_id = $1`, [t.id]),
            null, /append-only/);
    });

    await step("tickets: an administrator reads a finished ticket in full", async () => {
        await reset();
        const t = await raise(NESSY);
        await resolve(BINTANG, t.id);
        const body = await j(PETER, `public.tickets_get($1::uuid)`, [t.id]);
        if (body.can_work !== false) throw new Error("admin cannot work");
        if (!body.events.some((e) => e.is_internal)) throw new Error("internal notes hidden");
    });

    await step("tickets: an access request is raised like any ticket", async () => {
        await reset();
        const t = await raise(NESSY, "Read and write access to the Monitoring folder", "access_request", "NAS");
        if (t.category !== "access_request" || t.location !== "NAS" || t.reference !== "REQ-0001")
            throw new Error(JSON.stringify(t));
        const body = await j(BINTANG, `public.tickets_list(false, false)`);
        if (body.items[0]?.subject !== "Read and write access to the Monitoring folder") throw new Error("not queued");
    });

    await step("tickets: each category numbers its own tickets, by the highest number", async () => {
        await reset();
        const refs = [];
        for (const c of ["connection", "hardware", "connection", "access_request", "other"])
            refs.push((await raise(NESSY, "Something", c)).reference);
        if (refs.join() !== "NET-0001,HW-0001,NET-0002,REQ-0001,GEN-0001") throw new Error(refs.join());
        await db.exec(`update public.support_tickets set reference = 'NET-9999' where reference = 'NET-0002'`);
        await db.exec(`insert into public.support_tickets (reference, subject, description, category)
                       values ('NET-LEGACY', 'Old', 'Old', 'connection')`);
        const a = await raise(NESSY, "Something", "connection");
        const b = await raise(NESSY, "Something", "connection");
        if (a.reference !== "NET-10000" || b.reference !== "NET-10001") throw new Error(`${a.reference} ${b.reference}`);
    });

    await step("tickets: history credits whoever resolved it", async () => {
        await reset();
        const first = await raise(NESSY, "Laptop will not charge");
        const second = await raise(NESSY, "Excel export will not open", "software");
        const open = await raise(NESSY, "Mouse is dead");
        await resolve(BINTANG, first.id);
        await resolve(LINTANG, second.id);
        const body = await j(PETER, `public.tickets_history()`);
        const listed = Object.fromEntries(body.items.map((t) => [t.id, t]));
        if (Object.keys(listed).length !== 2 || listed[open.id]) throw new Error("items");
        if (listed[first.id].resolved_by !== "Bintang Test") throw new Error("first");
        if (listed[second.id].resolved_by !== "Lintang Test") throw new Error("second");
        if (listed[first.id].events.length !== 0 || listed[first.id].can_work !== false) throw new Error("item shape");
        const tally = Object.fromEntries(body.resolvers.map((r) => [r.name, r.resolved]));
        if (JSON.stringify(tally) !== JSON.stringify({ "Bintang Test": 1, "Lintang Test": 1 }))
            throw new Error(JSON.stringify(body.resolvers));
        // IT support reads it too.
        await j(BINTANG, `public.tickets_history()`);
    });

    await step("tickets: history counts and times each category", async () => {
        await reset();
        const net = await raise(NESSY, "Something", "connection");
        await raise(NESSY, "Something", "connection");
        const net2 = await raise(NESSY, "Something", "connection");
        const hw = await raise(NESSY, "Something", "hardware");
        await resolve(BINTANG, net.id);
        await resolve(BINTANG, net2.id);
        await resolve(BINTANG, hw.id);
        // Raised 2h and 5h before they were resolved.
        await db.query(`update public.support_tickets
                           set created_at = (resolved_at at time zone 'UTC') - interval '2 hours'
                         where id = $1`, [net.id]);
        await db.query(`update public.support_tickets
                           set created_at = (resolved_at at time zone 'UTC') - interval '5 hours'
                         where id = $1`, [net2.id]);
        const body = await j(PETER, `public.tickets_history()`);
        const cats = Object.fromEntries(body.categories.map((c) => [c.category, c]));
        if (body.categories.length !== 6) throw new Error(`${body.categories.length} categories`);
        if (body.categories.map((c) => c.prefix).join() !== "NET,HW,SW,ACC,REQ,GEN") throw new Error("prefixes");
        const c = cats.connection;
        if (`${c.raised},${c.open},${c.resolved},${c.closed}` !== "3,1,2,0") throw new Error(JSON.stringify(c));
        if (c.average_hours !== 3.5 || c.longest_hours !== 5) throw new Error(JSON.stringify(c));
        if (cats.software.raised !== 0 || cats.software.average_hours !== null || cats.software.longest_hours !== null)
            throw new Error(JSON.stringify(cats.software));
        const b = body.resolvers.find((r) => r.name === "Bintang Test");
        if (b.resolved !== 3 || typeof b.average_hours !== "number") throw new Error(JSON.stringify(b));
    });

    await step("tickets: closed is listed in history but not credited as a fix", async () => {
        await reset();
        const t = await raise(NESSY);
        await setStatus(BINTANG, t.id, "closed");
        const body = await j(PETER, `public.tickets_history()`);
        if (body.items.length !== 1 || body.items[0].resolved_by !== null) throw new Error("item");
        if (body.resolvers.length !== 0) throw new Error("credited");
        if (cats(body).hardware.closed !== 1) throw new Error("closed count");
        const live = await j(BINTANG, `public.tickets_list(false, false)`);
        if (live.items.length !== 0) throw new Error("closed on the live list");
        const all = await j(BINTANG, `public.tickets_list(false, true)`);
        if (all.items.length !== 1 || all.open_count !== 0) throw new Error("include_closed");
    });

    await step("tickets: the reporter may close their own live ticket, and do nothing else", async () => {
        await reset();
        const t = await raise(NESSY);
        await fails(() => setStatus(NESSY, t.id, "resolved", "Restarted it"), "PT403", /Only IT support/);
        await fails(() => setStatus(NESSY, t.id, "in_progress"), "PT403", /Only IT support/);
        await fails(() => setStatus(PETER, t.id, "closed", "Not mine"), "PT403", /Only IT support/);
        const c = await setStatus(NESSY, t.id, "closed", "Fixed it myself");
        if (c.status !== "closed") throw new Error("not closed");
        const last = c.events[c.events.length - 1];
        if (last.to_status !== "closed" || last.body !== "Fixed it myself") throw new Error("trail");
        await fails(() => setStatus(NESSY, t.id, "closed", "Again"), "PT409", /already closed/);
    });

    await step("tickets: assigning is IT support's, and only to somebody who works the queue", async () => {
        await reset();
        const t = await raise(NESSY);
        await fails(() => j(NESSY, `public.tickets_assign($1::uuid, $2::uuid)`, [t.id, E_LINTANG]), "PT403");
        await fails(() => j(BINTANG, `public.tickets_assign($1::uuid, $2::uuid)`, [t.id, E_NESSY]), "PT422",
            /That person is not set up for IT support\./);
        const a = await j(BINTANG, `public.tickets_assign($1::uuid, $2::uuid)`, [t.id, E_LINTANG]);
        if (a.assignee_id !== E_LINTANG || a.events.at(-1).body !== "Assigned to Lintang Test")
            throw new Error(JSON.stringify(a));
        const u = await j(BINTANG, `public.tickets_assign($1::uuid, null)`, [t.id]);
        if (u.assignee_id !== null || u.events.at(-1).body !== "Unassigned") throw new Error("unassign");
    });

    await step("tickets: clients cannot read or write the tables directly", async () => {
        const r = await tx(RINA, `select count(*)::int n from public.support_tickets`).catch((e) => ({ err: e }));
        if (!r.err && r.rows[0].n !== 0) throw new Error("rows visible");
    });

    // --- the reporter loop (20261014000100) ----------------------------------

    const reopen = (uid, id, reason) => j(uid, `public.tickets_reopen($1::uuid, $2)`, [id, reason]);
    const extend = (uid, id, days, reason = null) =>
        j(uid, `public.tickets_extend($1::uuid, now() + make_interval(days => $2::int), $3)`, [id, days, reason]);
    const triage = (uid, id, priority, category) =>
        j(uid, `public.tickets_triage($1::uuid, $2, $3)`, [id, priority, category]);
    const link = (uid, id, related) => j(uid, `public.tickets_link($1::uuid, $2::uuid)`, [id, related]);
    const raiseFor = (uid, reporter, channel, related = null, subject = "VPN keeps dropping") =>
        j(uid, `public.tickets_raise($1, 'Drops', 'connection', 'normal', null, $2::uuid, $3, $4::uuid)`,
          [subject, reporter, channel, related]);
    const run = async () => (await db.query(`select public.tickets_auto_close_run() j`)).rows[0].j;
    const row = async (id) => (await db.query(`select *,
            extract(epoch from (auto_close_at - now())) / 86400.0 as days_left
          from public.support_tickets where id = $1`, [id])).rows[0];
    const daysLeft = async (id) => Number((await row(id)).days_left);
    const notes = async (id, kind) => (await db.query(`select kind, user_id, needs_action, resolved_at, payload
          from public.notifications where source_id = $1 and kind = $2 order by created_at`, [id, kind])).rows;
    const near = (x, want, what) => {
        if (Math.abs(x - want) > 0.01) throw new Error(`${what}: ${x}, expected about ${want}`);
    };
    const resolved = async (id) => {
        await setStatus(BINTANG, id, "in_progress");
        return setStatus(BINTANG, id, "resolved", "Replaced the charger");
    };

    await step("tickets: confirming a fix closes it and keeps the fix, and history still credits it", async () => {
        await reset();
        const t = await raise(NESSY);
        const r = await resolved(t.id);
        const c = await setStatus(NESSY, t.id, "closed");
        if (c.status !== "closed" || !c.closed_at) throw new Error("not closed");
        if (c.resolution !== "Replaced the charger" || c.resolved_at !== r.resolved_at || c.resolved_by !== "Bintang Test")
            throw new Error(JSON.stringify(c));
        if (c.events.at(-1).body !== "Confirmed fixed") throw new Error(c.events.at(-1).body);
        const h = await j(PETER, `public.tickets_history()`);
        if (h.resolvers[0]?.name !== "Bintang Test" || h.resolvers[0].resolved !== 1) throw new Error("resolvers");
        const hw = cats(h).hardware;
        if (`${hw.resolved},${hw.closed}` !== "1,0") throw new Error(JSON.stringify(hw));
    });

    await step("tickets: the migration re-runs, restores a lost fix, and gives waiting tickets a fresh 5 days", async () => {
        await reset();
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        // Closed the old way: the resolution was cleared on closing.
        const lost = await raise(NESSY);
        await resolved(lost.id);
        await setStatus(BINTANG, lost.id, "closed");
        await db.query(`update public.support_tickets set resolution = null, resolved_at = null, closed_at = null
                         where id = $1`, [lost.id]);
        // Closed without a fix: stays unfixed.
        const dup = await raise(NESSY);
        await setStatus(BINTANG, dup.id, "closed", "Duplicate");
        // Waiting since long before the change.
        const old = await raise(NESSY);
        await setStatus(BINTANG, old.id, "waiting", "Which site?");
        await db.query(`update public.support_tickets set auto_close_at = null where id = $1`, [old.id]);

        // Both, as live has them: the second redefines what the first does.
        for (const f of ["20261014000100_ticket_reporter_loop.sql", "20261015000100_ticket_trail_order.sql"])
            await db.exec(readFileSync(join(import.meta.dirname, "..", "..", "migrations", f), "utf8"));

        const l = await row(lost.id);
        if (l.resolution !== "Replaced the charger" || !l.resolved_at || !l.closed_at) throw new Error(JSON.stringify(l));
        const d = await row(dup.id);
        if (d.resolution !== null || d.resolved_at !== null) throw new Error("duplicate gained a fix");
        near(await daysLeft(old.id), 5, "fresh deadline");
        const ran = await run();
        if (ran.closed !== 0) throw new Error("closed on deploy");
    });

    await step("tickets: a reporter's reply hands a waiting ticket back to IT", async () => {
        await reset();
        const t = await raise(NESSY);
        await setStatus(BINTANG, t.id, "waiting", "Can you send the error message?");
        const it = await comment(BINTANG, t.id, "Any news?");
        if (it.status !== "waiting") throw new Error("IT reply moved it");
        const r = await comment(NESSY, t.id, "Here is the error message");
        const last2 = r.events.slice(-2).map((e) => `${e.kind}:${e.body}`);
        if (r.status !== "in_progress" || r.auto_close_at !== null) throw new Error(JSON.stringify(r));
        if (last2.join("|") !== "commented:Here is the error message|status:Reply received") throw new Error(last2.join("|"));
        const before = (await row(t.id)).updated_at;
        await comment(NESSY, t.id, "And a screenshot");
        const after = await row(t.id);
        if (after.status !== "in_progress" || !(after.updated_at > before)) throw new Error("reply on in progress");
    });

    await step("tickets: still broken reopens a resolved ticket, with a reason, and only for its reporter", async () => {
        await reset();
        const t = await raise(NESSY);
        await resolved(t.id);
        await fails(() => reopen(NESSY, t.id, "  "), "PT422", /^reason:/);
        await fails(() => reopen(PETER, t.id, "Me too"), "PT404");
        await fails(() => setStatus(NESSY, t.id, "open"), "PT403");
        const o = await reopen(NESSY, t.id, "VPN dropped again this morning");
        if (o.status !== "open" || o.resolution !== null || o.resolved_at !== null || o.auto_close_at !== null)
            throw new Error(JSON.stringify(o));
        const e = o.events.at(-1);
        if (e.kind !== "reopened" || e.body !== "VPN dropped again this morning" || e.from_status !== "resolved")
            throw new Error(JSON.stringify(e));
        await fails(() => reopen(NESSY, t.id, "Again"), "PT409", /still open/);
    });

    await step("tickets: waiting and resolved tickets close themselves after 5 quiet days", async () => {
        await reset();
        const w = await raise(NESSY, "Printer offline");
        await setStatus(BINTANG, w.id, "waiting", "Which floor?");
        near(await daysLeft(w.id), 5, "set on entering waiting");
        const s = await raise(NESSY);
        await resolved(s.id);
        near(await daysLeft(s.id), 5, "set on resolving");
        const p = await raise(NESSY, "Slow laptop");
        await setStatus(BINTANG, p.id, "in_progress");
        if ((await row(p.id)).auto_close_at !== null) throw new Error("in progress has a deadline");

        // An internal note is no update; a public reply restarts the 5 days.
        await db.query(`update public.support_tickets set auto_close_at = now() + interval '2 days' where id = $1`, [s.id]);
        await comment(BINTANG, s.id, "Check the cable next time", true);
        near(await daysLeft(s.id), 2, "internal note");
        await comment(NESSY, s.id, "Seems fine for now");
        near(await daysLeft(s.id), 5, "public reply");
        const back = await row(s.id);
        if (back.status !== "resolved") throw new Error("reply on resolved changed status");

        // The day before: one reminder, never two.
        await db.query(`update public.support_tickets set auto_close_at = now() + interval '12 hours'
                         where id in ($1, $2)`, [w.id, s.id]);
        await db.query(`update public.support_tickets set updated_at = now() - interval '30 days' where id = $1`, [p.id]);
        let ran = await run();
        if (ran.reminded !== 2 || ran.closed !== 0) throw new Error(JSON.stringify(ran));
        ran = await run();
        if (ran.reminded !== 0) throw new Error("reminded twice");

        await db.query(`update public.support_tickets set auto_close_at = now() - interval '1 minute'
                         where id in ($1, $2)`, [w.id, s.id]);
        ran = await run();
        if (ran.closed !== 2) throw new Error(JSON.stringify(ran));
        const wc = await j(BINTANG, `public.tickets_get($1::uuid)`, [w.id]);
        const we = wc.events.at(-1);
        if (wc.status !== "closed" || wc.resolved_at !== null || !wc.closed_at) throw new Error(JSON.stringify(wc));
        if (we.actor_name !== "Automatic" || we.body !== "Closed automatically: no reply before the deadline.")
            throw new Error(JSON.stringify(we));
        if (wc.last_public_actor !== "system") throw new Error(wc.last_public_actor);
        const sc = await j(BINTANG, `public.tickets_get($1::uuid)`, [s.id]);
        if (sc.status !== "closed" || sc.resolution !== "Replaced the charger" || !sc.resolved_at)
            throw new Error(JSON.stringify(sc));
        if ((await row(p.id)).status !== "in_progress") throw new Error("in progress was closed");
    });

    await step("tickets: either side extends the deadline, later and within 30 days", async () => {
        await reset();
        const t = await raise(NESSY);
        await resolved(t.id);
        const x = await extend(NESSY, t.id, 10, "On site until the 20th");
        near(await daysLeft(t.id), 10, "extended");
        const e = x.events.at(-1);
        if (e.kind !== "extended" || !/^Auto-close moved to \d+ \w+ \d{4}: On site until the 20th$/.test(e.body))
            throw new Error(e.body);
        await fails(() => extend(NESSY, t.id, 45), "PT422", /30 days/);
        await fails(() => extend(BINTANG, t.id, 3), "PT422", /later than the current deadline/);
        await extend(BINTANG, t.id, 12);
        await fails(() => extend(PETER, t.id, 14), "PT404");
        const p = await raise(NESSY);
        await setStatus(BINTANG, p.id, "in_progress");
        await fails(() => extend(NESSY, p.id, 7), "PT409", /waiting or resolved/);
    });

    await step("tickets: a closed ticket reopens for 14 days for its reporter, any time for IT", async () => {
        await reset();
        const t = await raise(NESSY);
        await setStatus(BINTANG, t.id, "closed", "No reply");
        await db.query(`update public.support_tickets set closed_at = now() - interval '6 days' where id = $1`, [t.id]);
        const o = await reopen(NESSY, t.id, "It came back");
        if (o.status !== "open" || o.closed_at !== null) throw new Error(JSON.stringify(o));
        await setStatus(BINTANG, t.id, "closed", "No reply");
        await db.query(`update public.support_tickets set closed_at = now() - interval '20 days' where id = $1`, [t.id]);
        await fails(() => reopen(NESSY, t.id, "Again"), "PT409", /more than 14 days ago\. Raise it again instead\./);
        const it = await reopen(BINTANG, t.id, "Found the cause");
        if (it.status !== "open") throw new Error("IT reopen");
    });

    await step("tickets: each side hears about the other's moves, and items settle per side", async () => {
        await reset();
        const t = await raise(NESSY);
        const raised = await notes(t.id, "ticket_raised");
        const mine = raised.find((n) => n.user_id === BINTANG);
        if (!mine || !mine.needs_action) throw new Error("IT not told");

        await comment(BINTANG, t.id, "Restarting the router remotely", true);
        await setStatus(BINTANG, t.id, "in_progress");
        const quiet = (await db.query(`select count(*)::int n from public.notifications
            where source_id = $1 and user_id = $2`, [t.id, NESSY])).rows[0].n;
        if (quiet !== 0) throw new Error("internal note or in progress notified the reporter");

        await comment(BINTANG, t.id, "Try again now?");
        const replied = await notes(t.id, "ticket_replied");
        if (replied.length !== 1 || replied[0].user_id !== NESSY || replied[0].needs_action) throw new Error("replied");

        await setStatus(BINTANG, t.id, "waiting", "Which site are you at?");
        const [w] = await notes(t.id, "ticket_waiting");
        if (w.user_id !== NESSY || !w.needs_action || w.payload.note?.text !== "Which site are you at?")
            throw new Error(JSON.stringify(w));

        await comment(NESSY, t.id, "Site office");
        if ((await notes(t.id, "ticket_waiting"))[0].resolved_at === null) throw new Error("reporter's item open");
        if ((await notes(t.id, "ticket_raised")).find((n) => n.user_id === BINTANG).resolved_at !== null)
            throw new Error("IT's item settled by the reporter's reply");
        const back = await notes(t.id, "ticket_reporter_replied");
        if (!back.some((n) => n.user_id === BINTANG)) throw new Error("IT not told of the reply");
        if (back.some((n) => n.user_id === NESSY)) throw new Error("reporter told of their own reply");

        await setStatus(BINTANG, t.id, "resolved", "Replaced the charger");
        const [r] = await notes(t.id, "ticket_resolved");
        if (r.needs_action || r.payload.tone !== "success" || r.payload.note?.text !== "Replaced the charger")
            throw new Error(JSON.stringify(r));
        if ((await notes(t.id, "ticket_raised")).find((n) => n.user_id === BINTANG).resolved_at === null)
            throw new Error("IT's item open after resolving");

        await db.query(`update public.support_tickets set auto_close_at = now() + interval '6 hours' where id = $1`, [t.id]);
        await run();
        const [soon] = await notes(t.id, "ticket_closing_soon");
        if (!soon || soon.user_id !== NESSY || !soon.needs_action) throw new Error("no reminder");
        await extend(NESSY, t.id, 5);
        if ((await notes(t.id, "ticket_closing_soon"))[0].resolved_at === null) throw new Error("reminder not settled");

        await reopen(NESSY, t.id, "Still broken");
        const re = await notes(t.id, "ticket_reopened");
        if (!re.some((n) => n.user_id === BINTANG && n.needs_action)) throw new Error("reopen not sent to IT");

        await setStatus(NESSY, t.id, "closed", "Sorted it myself");
        if (!(await notes(t.id, "ticket_closed_by_reporter")).some((n) => n.user_id === BINTANG))
            throw new Error("close not sent to IT");
        if ((await notes(t.id, "ticket_reopened")).some((n) => n.resolved_at === null)) throw new Error("reopen item open");
    });

    await step("tickets: IT raises a ticket for someone, saying how it arrived", async () => {
        await reset();
        const t = await raiseFor(BINTANG, E_NESSY, "whatsapp");
        if (t.reporter_id !== E_NESSY || t.channel !== "whatsapp") throw new Error(JSON.stringify(t));
        const e = t.events[0];
        if (e.actor_name !== "Bintang Test" || e.body !== "Logged for Nessy Test from WhatsApp: VPN keeps dropping")
            throw new Error(JSON.stringify(e));
        const told = await notes(t.id, "ticket_logged_for_you");
        if (told.length !== 1 || told[0].user_id !== NESSY) throw new Error("reporter not told");
        if ((await notes(t.id, "ticket_raised")).some((n) => n.user_id === BINTANG || n.user_id === NESSY))
            throw new Error("raiser or reporter got ticket_raised");
        const seen = await j(NESSY, `public.tickets_list(false, false)`);
        if (seen.items[0]?.id !== t.id) throw new Error("reporter cannot see it");

        await fails(() => raiseFor(NESSY, E_LINTANG, "whatsapp"), "PT403", /Only IT support/);
        await fails(() => raiseFor(BINTANG, E_NESSY, "portal"), "PT422", /^channel:/);
        await fails(() => raiseFor(BINTANG, E_NESSY, null), "PT422", /^channel:/);
        await fails(() => raiseFor(NESSY, null, "phone"), "PT422", /^channel:/);
        const own = await raise(NESSY);
        if (own.channel !== "portal") throw new Error("own ticket not portal");
    });

    await step("tickets: raise it again links back; IT links and unlinks; colleagues see only the reference", async () => {
        await reset();
        const old = await raise(NESSY, "VPN disconnects", "connection");
        await resolved(old.id);
        await setStatus(NESSY, old.id, "closed");
        const again = await j(NESSY, `public.tickets_raise('VPN disconnects again', 'Again', 'connection',
            'normal', null, null, null, $1::uuid)`, [old.id]);
        if (again.related?.reference !== old.reference || again.related.resolution !== "Replaced the charger")
            throw new Error(JSON.stringify(again.related));
        const o = await j(NESSY, `public.tickets_get($1::uuid)`, [old.id]);
        if (o.recurrences.length !== 1 || o.recurrences[0].id !== again.id) throw new Error(JSON.stringify(o.recurrences));

        const lintangs = await raise(LINTANG, "Monitor flickers");
        await fails(() => j(NESSY, `public.tickets_raise('Mine flickers too', 'Same', 'hardware',
            'normal', null, null, null, $1::uuid)`, [lintangs.id]), "PT403", /only link a ticket you raised/);

        const fresh = await raise(NESSY, "Monitor flickers");
        await fails(() => link(NESSY, fresh.id, lintangs.id), "PT403");
        await fails(() => link(BINTANG, lintangs.id, fresh.id), "PT422", /raised before this one/);
        await fails(() => link(BINTANG, fresh.id, fresh.id), "PT422", /raised before this one/);
        const l = await link(BINTANG, fresh.id, lintangs.id);
        if (l.events.at(-1).body !== `Comes back to ${lintangs.reference}`) throw new Error(l.events.at(-1).body);
        const seen = await j(NESSY, `public.tickets_get($1::uuid)`, [fresh.id]);
        const r = seen.related;
        if (r.reference !== lintangs.reference || r.status !== "open" || r.subject !== null || r.id !== null)
            throw new Error(JSON.stringify(r));
        await fails(() => link(BINTANG, fresh.id, lintangs.id), "PT422", /Nothing to change/);
        const u = await link(BINTANG, fresh.id, null);
        if (u.related !== null || u.events.at(-1).body !== `No longer linked to ${lintangs.reference}`)
            throw new Error(JSON.stringify(u.related));
    });

    await step("tickets: IT changes priority and category; the reference stays", async () => {
        await reset();
        const t = await raise(NESSY, "No internet", "connection");
        const x = await triage(BINTANG, t.id, "high", "hardware");
        if (x.reference !== t.reference || x.category !== "hardware" || x.priority !== "high") throw new Error(JSON.stringify(x));
        if (x.events.at(-1).body !== "Priority: Normal → High · Category: Connectivity → Hardware")
            throw new Error(x.events.at(-1).body);
        const y = await triage(BINTANG, t.id, "urgent", null);
        if (y.events.at(-1).body !== "Priority: High → Urgent") throw new Error(y.events.at(-1).body);
        await fails(() => triage(BINTANG, t.id, "urgent", "hardware"), "PT422", /Nothing to change/);
        await fails(() => triage(NESSY, t.id, "low", null), "PT403");
    });

    await step("tickets: who spoke last ignores internal notes; history counts channels and recurrences", async () => {
        await reset();
        const t = await raise(NESSY, "No internet", "connection");
        let g = await j(BINTANG, `public.tickets_get($1::uuid)`, [t.id]);
        if (g.last_public_actor !== "reporter" || g.last_public_kind !== "raised") throw new Error("raised");
        await comment(BINTANG, t.id, "Looking", false);
        await comment(NESSY, t.id, "Thanks");
        await comment(BINTANG, t.id, "Router is old", true);
        const list = await j(BINTANG, `public.tickets_list(false, false)`);
        g = list.items.find((x) => x.id === t.id);
        if (g.last_public_actor !== "reporter" || g.last_public_kind !== "commented" || !g.last_public_at)
            throw new Error(JSON.stringify(g));

        await raiseFor(BINTANG, E_NESSY, "whatsapp");
        await raiseFor(BINTANG, E_NESSY, "phone");
        await j(NESSY, `public.tickets_raise('Again', 'Again', 'connection', 'normal', null, null, null, $1::uuid)`, [t.id]);
        const h = await j(PETER, `public.tickets_history()`);
        if (h.channels.length !== 6) throw new Error(`${h.channels.length} months`);
        const now = h.channels.at(-1);
        if (`${now.total},${now.portal},${now.whatsapp},${now.phone}` !== "4,2,1,1") throw new Error(JSON.stringify(now));
        if (cats(h).connection.recurrences !== 1) throw new Error(JSON.stringify(cats(h).connection));
    });

    await step("tickets: the trail keeps the order events were written in, even within one clock tick", async () => {
        await reset();
        const t = await raise(NESSY);
        // Twenty events sharing one timestamp: ordered by the random id, as
        // before 20261015000100, they would almost never come back in order.
        await db.query(`insert into public.ticket_events (ticket_id, actor_name, kind, body, created_at)
                        select $1, 'Test', 'commented', n::text, timestamp '2030-01-01 00:00:00'
                          from generate_series(1, 20) n`, [t.id]);
        const g = await j(BINTANG, `public.tickets_get($1::uuid)`, [t.id]);
        const bodies = g.events.slice(1).map((e) => e.body).join(",");
        if (bodies !== Array.from({ length: 20 }, (_, i) => i + 1).join(",")) throw new Error(bodies);
        if (g.last_public_kind !== "commented" || g.last_public_at !== g.events.at(-1).created_at)
            throw new Error("last public event");

        // Raise it again: raised, then linked.
        await resolved(t.id);
        await setStatus(NESSY, t.id, "closed");
        const again = await j(NESSY, `public.tickets_raise('Again', 'Again', 'hardware',
            'normal', null, null, null, $1::uuid)`, [t.id]);
        if (again.events.map((e) => e.kind).join() !== "raised,linked") throw new Error(again.events.map((e) => e.kind).join());
    });

    await step("tickets: the hourly run is not for clients", async () => {
        await fails(() => tx(BINTANG, `select public.tickets_auto_close_run()`), null, /permission denied/);
        await fails(() => tx(BINTANG, `select public.notifications_resolve_kinds('support_tickets', null, '{}', null)`),
            null, /permission denied/);
    });

    await reset();
};
