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

    await reset();
};
