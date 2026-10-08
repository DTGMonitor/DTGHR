// Notifications (20260926001300, 20261007000100): who gets an in-app
// notification and who also an outbox row, on which status change, with which
// payload and link -- who never does -- and when an action item is settled.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN } = people;

    // --- our own people -----------------------------------------------------
    const U = {
        MARK: "0e0e0000-0000-0000-0000-000000000001",     // executive, opted out
        OLDEXEC: "0e0e0000-0000-0000-0000-000000000002",  // executive, account inactive
        MANAGER: "0e0e0000-0000-0000-0000-000000000003",
        STAFF: "0e0e0000-0000-0000-0000-000000000004",    // managed by MANAGER
        LONER: "0e0e0000-0000-0000-0000-000000000005",    // no manager
        ITGUY: "0e0e0000-0000-0000-0000-000000000006",    // IT support
        ITGONE: "0e0e0000-0000-0000-0000-000000000007",   // IT support, employee inactive
        REPORTER: "0e0e0000-0000-0000-0000-000000000008",
    };
    const E = {
        MARK: "0e0e0000-0000-0000-0000-0000000000e1",
        MANAGER: "0e0e0000-0000-0000-0000-0000000000e3",
        STAFF: "0e0e0000-0000-0000-0000-0000000000e4",
        LONER: "0e0e0000-0000-0000-0000-0000000000e5",
        ITGUY: "0e0e0000-0000-0000-0000-0000000000e6",
        ITGONE: "0e0e0000-0000-0000-0000-0000000000e7",
        REPORTER: "0e0e0000-0000-0000-0000-0000000000e8",
        DIRECTOR: "0e0e0000-0000-0000-0000-0000000000e9", // only if the director has none
    };
    const MAIL = {
        MARK: "mark.n@dtgeotech.com", OLDEXEC: "oldexec.n@dtgeotech.com", MANAGER: "manager.n@dtgeotech.com",
        STAFF: "staff.n@dtgeotech.com", LONER: "loner.n@dtgeotech.com", ITGUY: "itguy.n@dtgeotech.com",
        ITGONE: "itgone.n@dtgeotech.com", REPORTER: "reporter.n@dtgeotech.com",
    };
    const NAME = {
        MARK: "Mark Notify", OLDEXEC: "Oldexec Notify", MANAGER: "Manager Notify", STAFF: "Staff Notify",
        LONER: "Loner Notify", ITGUY: "Itguy Notify", ITGONE: "Itgone Notify", REPORTER: "Reporter Notify",
    };

    const authRows = Object.keys(U).map((k) => `('00000000-0000-0000-0000-000000000000','${U[k]}',
        'authenticated','authenticated','${MAIL[k]}','x', now(), '{"provider":"email"}'::jsonb,
        '{"full_name":"${NAME[k]}"}'::jsonb, now(), now(), '', '', '', '')`).join(",\n");
    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values ${authRows};

        update public.users set role = 'executive', email_notifications = false where id = '${U.MARK}';
        update public.users set role = 'executive', is_active = false where id = '${U.OLDEXEC}';

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, user_id) values
          ('${E.MARK}','NTF-001','Mark','Notify','${MAIL.MARK}','Management','Director','2024-01-01',0,'${U.MARK}'),
          ('${E.MANAGER}','NTF-003','Manager','Notify','${MAIL.MANAGER}','Ops','Lead','2024-01-01',20,'${U.MANAGER}'),
          ('${E.STAFF}','NTF-004','Staff','Notify','${MAIL.STAFF}','Ops','Staff','2024-01-01',20,'${U.STAFF}'),
          ('${E.LONER}','NTF-005','Loner','Notify','${MAIL.LONER}','Ops','Staff','2024-01-01',20,'${U.LONER}'),
          ('${E.ITGUY}','NTF-006','Itguy','Notify','${MAIL.ITGUY}','Ops','IT','2024-01-01',0,'${U.ITGUY}'),
          ('${E.ITGONE}','NTF-007','Itgone','Notify','${MAIL.ITGONE}','Ops','IT','2024-01-01',0,'${U.ITGONE}'),
          ('${E.REPORTER}','NTF-008','Reporter','Notify','${MAIL.REPORTER}','Ops','Staff','2024-01-01',0,'${U.REPORTER}');

        update public.employees set manager_id = '${E.MANAGER}' where id = '${E.STAFF}';
        update public.employees set is_it_support = true where id in ('${E.ITGUY}', '${E.ITGONE}');
        update public.employees set is_active = false where id = '${E.ITGONE}';
        update public.employees set kpi_template_id =
               (select id from public.kpi_role_templates where code = 'monitoring_engineer')
         where id = '${E.STAFF}';

        -- The director needs an employee record to book leave; the KPI suite
        -- gives it one, but do not lean on that.
        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, user_id)
        select '${E.DIRECTOR}','NTF-009','Director','Notify','director.n@dtgeotech.com','Management',
               'Director','2024-01-01',20,'${DIRECTOR}'
         where not exists (select 1 from public.employees where user_id = '${DIRECTOR}');
    `);

    // --- helpers ------------------------------------------------------------
    const emailOf = async (uid) => (await db.query(`select email from public.users where id = $1`, [uid])).rows[0].email;
    const PETER_MAIL = await emailOf(PETER);
    const DIRECTOR_MAIL = await emailOf(DIRECTOR);
    const HIMAWAN_MAIL = await emailOf(HIMAWAN);
    const emailsWhere = async (sql) => (await db.query(sql)).rows.map((r) => r.email).sort();
    // Whoever holds the role, active, flag on: what "the executive" means.
    const roleMails = (role) => emailsWhere(`select u.email from public.users u
        where u.role::text = '${role}' and u.is_active and u.email_notifications
          and not exists (select 1 from public.employees e where e.user_id = u.id and not e.is_active)`);

    const call = async (uid, fn, args = [], casts = []) => {
        const ph = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ""}`).join(", ");
        return (await tx(uid, `select public.${fn}(${ph}) j`, args)).rows[0].j;
    };
    const outbox = async (source) =>
        (await db.query(`select * from public.email_outbox where source_id = $1 order by to_email`, [source])).rows;
    // In-app rows for a source, with the recipient's email alongside.
    const inbox = async (source, kind) =>
        (await db.query(`select n.*, u.email from public.notifications n join public.users u on u.id = n.user_id
                          where n.source_id = $1 and ($2::text is null or n.kind = $2) order by u.email`,
                        [source, kind ?? null])).rows;
    const clear = () => db.exec(`delete from public.email_outbox; delete from public.notifications;`);
    const count = async () => (await db.query(`select count(*)::int n from public.email_outbox`)).rows[0].n;
    const eq = (got, want, what) => {
        const g = JSON.stringify(got), w = JSON.stringify(want);
        if (g !== w) throw new Error(`${what}: got ${g}, expected ${w}`);
    };
    // Exactly one email per expected recipient, of this kind, with this link,
    // each pointing at that recipient's notification -- rendered later by the
    // Edge Function, so no body yet. Every emailed person also has the
    // in-app row; `alsoInApp` names those who have only that (opted out).
    const ITEM_LINK = { "/leaves": "/leaves?open=", "/support": "/support?open=",
                        "/finance-requests": "/finance-requests?open=", "/payroll": "/payroll?month=",
                        "/salary": "/salary?open=" };
    const expectSent = async (source, kind, mails, link, alsoInApp = []) => {
        if (ITEM_LINK[link]) link = ITEM_LINK[link] + source;
        const rows = (await outbox(source)).filter((r) => r.kind === kind);
        eq(rows.map((r) => r.to_email).sort(), [...mails].sort(), `${kind} recipients`);
        const notes = await inbox(source, kind);
        eq(notes.map((n) => n.email).sort(), [...mails, ...alsoInApp].sort(), `${kind} in-app recipients`);
        for (const r of rows) {
            eq(r.link_path, link, `${kind} link`);
            const n = notes.find((x) => x.id === r.notification_id);
            if (!n) throw new Error(`${kind}: email not tied to its notification`);
            if (n.email !== r.to_email) throw new Error(`${kind}: email tied to someone else's notification`);
            eq(n.payload.link.path, link, `${kind} payload link`);
            if (r.body_html !== null || r.body_text !== null) throw new Error(`${kind}: body rendered in SQL`);
            if (r.sent_at !== null || r.attempts !== 0) throw new Error("not fresh");
        }
        for (const n of notes) if (n.read_at !== null || n.resolved_at !== null) throw new Error(`${kind}: not fresh`);
        rows.payload = notes[0]?.payload;
        return rows;
    };
    const open = async (source, kind) => (await inbox(source, kind)).filter((n) => n.resolved_at === null);
    const never = (rows, ...mails) => {
        for (const m of mails) if (rows.some((r) => r.to_email === m)) throw new Error(`${m} was emailed`);
    };

    // =======================================================================

    await step("notifications: the migrations re-run cleanly and keep the site URL", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        await db.query(`update public.app_settings set value = 'https://hr.example.test/' where key = 'public_site_url'`);
        // The in-app migration and the finance rules after it, as the live
        // database has them. 20260926001300 can no longer be replayed on top
        // (notifications_recipients changed shape).
        for (const f of ["20261007000100_in_app_notifications.sql", "20261008000100_finance_cc_in_app.sql",
                         "20261009000100_notifications_phase_3.sql"])
            await db.exec(readFileSync(join(import.meta.dirname, "..", "..", "migrations", f), "utf8"));
        const old = await db.query(`select count(*)::int n from pg_proc
            where proname = 'notifications_enqueue' and pg_get_function_identity_arguments(oid) like '%text[]%'`);
        eq(old.rows[0].n, 0, "the paragraphs overload is gone");
        const r = await db.query(`select public.notifications_site_url() u`);
        await db.query(`update public.app_settings set value = 'https://dtghr-fe.vercel.app' where key = 'public_site_url'`);
        eq(r.rows[0].u, "https://hr.example.test", "site url");
    });

    await step("notifications: the site URL comes from app_settings", async () => {
        await clear();
        await db.query(`update public.app_settings set value = 'https://hr.dtgeotech.com' where key = 'public_site_url'`);
        try {
            // Read by the Edge Function at send time; the payload holds paths only.
            const t = await call(U.REPORTER, "tickets_raise", ["Monitor flickers", "It flickers", "hardware"]);
            const [row] = await outbox(t.id);
            eq(row.link_path, `/support?open=${t.id}`, "path only");
            eq((await db.query(`select value from public.app_settings where key = 'public_site_url'`)).rows[0].value,
               "https://hr.dtgeotech.com", "setting");
        } finally {
            await db.query(`update public.app_settings set value = 'https://dtghr-fe.vercel.app' where key = 'public_site_url'`);
        }
    });

    await step("notifications: the outbox is closed to the browser", async () => {
        for (const sql of [`select * from public.email_outbox`, `select public.notifications_claim(1)`,
                           `select public.notifications_mark('${U.MARK}'::uuid, null)`,
                           `select public.notifications_enqueue(array['${PETER}'::uuid], '{}', 'x', 'x',
                                '{"tone":"action","headline":"x","link":{"label":"x","path":"/"}}', null, null)`,
                           `insert into public.notifications (user_id, kind, payload)
                                values ('${PETER}', 'x', '{"tone":"action","headline":"x"}')`]) {
            try {
                await tx(PETER, sql);
            } catch (e) {
                if (!/permission denied/.test(e.message)) throw new Error(`${sql}: ${e.message}`);
                continue;
            }
            throw new Error(`${sql} was allowed`);
        }
    });

    await step("notifications: recipient filter drops inactive and excluded people, and flags who takes email", async () => {
        const r = await db.query(`select email, email_notifications e from public.notifications_recipients($1::uuid[], $2::uuid[])`,
            [[PETER, U.MARK, U.OLDEXEC, U.ITGONE, U.STAFF, U.LONER], [U.LONER]]);
        eq(r.rows.map((x) => [x.email, x.e]).sort(), [[PETER_MAIL, true], [MAIL.MARK, false], [MAIL.STAFF, true]].sort(), "recipients");
    });

    await step("notifications: the payload helper drops empty parts and refuses an unknown tone", async () => {
        const r = await db.query(`select public.notifications_payload('success', 'Leave approved', '  Your leave  ', '',
            array['Type', 'Annual', 'Location', null, 'Days', ' '], null, 'Nobody', '/leaves', 'Open') p`);
        const p = r.rows[0].p;
        eq(Object.keys(p).sort(), ["details", "eyebrow", "headline", "link", "tone"], "keys");
        eq([p.tone, p.eyebrow, p.headline, p.link.label, p.link.path], ["success", "Leave approved", "Your leave", "Open", "/leaves"], "values");
        eq(p.details, [["Type", "Annual"]], "details");
        try {
            await db.query(`select public.notifications_payload('loud', 'x', 'x', null, null, null, null, '/', 'x')`);
        } catch (e) {
            if (!/unknown tone/.test(e.message)) throw e;
            return;
        }
        throw new Error("accepted an unknown tone");
    });

    await step("notifications: escaping", async () => {
        const r = await db.query(`select public.notifications_escape($1) s`, [`<b>"Tom" & 'Jerry'</b>`]);
        eq(r.rows[0].s, "&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;", "escaped");
    });

    // --- IT support ----------------------------------------------------------

    await step("notifications: a new ticket goes to active IT support, once each", async () => {
        await clear();
        const t = await call(U.REPORTER, "tickets_raise", ["VPN <down> & out", "Cannot connect", "connection", "normal", "Site office"]);
        const itMails = await emailsWhere(`select u.email from public.employees e join public.users u on u.id = e.user_id
            where e.is_it_support and e.is_active and u.is_active and u.email_notifications`);
        if (!itMails.includes(MAIL.ITGUY)) throw new Error("ITGUY not support?");
        const rows = await expectSent(t.id, "ticket_raised", itMails.filter((m) => m !== MAIL.REPORTER), "/support");
        never(rows, MAIL.ITGONE, MAIL.REPORTER);
        const mine = rows.find((r) => r.to_email === MAIL.ITGUY);
        eq(mine.subject, `New IT ticket ${t.reference}: VPN <down> & out`, "subject");
        // Raw in the payload: the renderer and React escape when they draw it.
        const p = rows.payload;
        eq([p.tone, p.headline, p.note], ["action", "VPN <down> & out", { by: "Reporter Notify", text: "Cannot connect" }], "payload");
        eq(p.details, [["Reference", t.reference], ["Priority", "Normal"], ["Location", "Site office"]], "details");
    });

    await step("notifications: IT support raising their own ticket is not emailed about it", async () => {
        await clear();
        const t = await call(U.ITGUY, "tickets_raise", ["My own laptop", "Broken", "hardware"]);
        never(await outbox(t.id), MAIL.ITGUY);
    });

    await step("notifications: working a ticket enqueues nothing and keeps it open; closing settles it", async () => {
        await clear();
        const t = await call(U.REPORTER, "tickets_raise", ["Printer", "Jammed", "hardware"]);
        const before = (await open(t.id, "ticket_raised")).length;
        if (!before) throw new Error("no in-app item");
        await db.exec(`delete from public.email_outbox`);
        await call(U.ITGUY, "tickets_set_status", [t.id, "in_progress", null], ["uuid", "text", "text"]);
        await call(U.ITGUY, "tickets_comment", [t.id, "On it", false], ["uuid", "text", "boolean"]);
        eq(await count(), 0, "outbox rows");
        eq((await open(t.id, "ticket_raised")).length, before, "still IT's to do while in progress");
        await call(U.ITGUY, "tickets_set_status", [t.id, "resolved", "Cleared"], ["uuid", "text", "text"]);
        eq((await open(t.id, "ticket_raised")).length, 0, "settled when resolved");
    });

    // --- payroll -------------------------------------------------------------

    let monthId;
    await step("notifications: payroll submitted by finance goes to the director", async () => {
        await db.exec(`delete from public.payroll_months where year = 2041`);
        const m = await call(HIMAWAN, "payroll_create_month", [2041, 9, false], ["int", "int", "boolean"]);
        monthId = m.id;
        await call(HIMAWAN, "payroll_add_line", [monthId, JSON.stringify({ labour_group: "admin", person_name: "NOTIFY TEST", base: 1_000_000 })], ["uuid", "jsonb"]);
        await clear();
        await call(HIMAWAN, "payroll_update_month", [monthId, JSON.stringify({ notes: "just a note" })], ["uuid", "jsonb"]);
        eq(await count(), 0, "an edit enqueues nothing");
        await call(HIMAWAN, "payroll_submit_month", [monthId], ["uuid"]);
        const rows = await expectSent(monthId, "payroll_submitted", await roleMails("director"), "/payroll");
        eq(rows[0].subject, "Payroll for September 2041 is waiting for your review", "subject");
        never(rows, HIMAWAN_MAIL, PETER_MAIL);
        eq(await count(), rows.length, "nothing else");
    });

    await step("notifications: payroll endorsed goes to the executive, not Mark, not the inactive", async () => {
        await db.exec(`delete from public.email_outbox`);
        if (!(await open(monthId, "payroll_submitted")).length) throw new Error("no open review item");
        await call(DIRECTOR, "payroll_endorse_month", [monthId], ["uuid"]);
        eq((await open(monthId, "payroll_submitted")).length, 0, "the director's review item is settled");
        const execs = await roleMails("executive");
        if (!execs.includes(PETER_MAIL) || execs.includes(MAIL.MARK)) throw new Error(JSON.stringify(execs));
        // Mark has email off: he gets the in-app item only.
        const rows = await expectSent(monthId, "payroll_endorsed", execs, "/payroll", [MAIL.MARK]);
        never(rows, MAIL.MARK, MAIL.OLDEXEC, DIRECTOR_MAIL);
        eq(rows[0].subject, "Payroll for September 2041 is waiting for your approval", "subject");
    });

    await step("notifications: payroll sent back to the director reaches the director, with the reason", async () => {
        await clear();
        await call(PETER, "payroll_request_changes", [monthId, "Check <Nessa's> shifts", "director"], ["uuid", "text", "text"]);
        const rows = await expectSent(monthId, "payroll_returned", await roleMails("director"), "/payroll");
        never(rows, PETER_MAIL, HIMAWAN_MAIL);
        eq(rows.payload.tone, "danger", "tone");
        eq(rows.payload.note.text, "Check <Nessa's> shifts", "the reason, raw");
    });

    await step("notifications: payroll sent back to finance reaches finance", async () => {
        await clear();
        await call(DIRECTOR, "payroll_request_changes", [monthId, "Wrong markup", "finance"], ["uuid", "text", "text"]);
        const fin = await roleMails("finance");
        if (!fin.includes(HIMAWAN_MAIL)) throw new Error("Himawan is finance");
        const rows = await expectSent(monthId, "payroll_changes_requested", fin, "/payroll");
        never(rows, DIRECTOR_MAIL, PETER_MAIL);
        // And resubmitting goes to the director again, once.
        await clear();
        await call(HIMAWAN, "payroll_submit_month", [monthId], ["uuid"]);
        await expectSent(monthId, "payroll_submitted", await roleMails("director"), "/payroll");
    });

    await step("notifications: sent back then resubmitted leaves exactly one open review item", async () => {
        await call(DIRECTOR, "payroll_request_changes", [monthId, "Once more", "finance"], ["uuid", "text", "text"]);
        await call(HIMAWAN, "payroll_submit_month", [monthId], ["uuid"]);
        const mine = (await inbox(monthId, "payroll_submitted")).filter((n) => n.user_id === DIRECTOR);
        eq(mine.length, 2, "two review items over time");
        eq(mine.filter((n) => n.resolved_at === null).length, 1, "one open");
    });

    await step("notifications: the executive's final approval notifies nobody and settles their item", async () => {
        await call(DIRECTOR, "payroll_endorse_month", [monthId], ["uuid"]);
        if (!(await open(monthId, "payroll_endorsed")).length) throw new Error("no approval item");
        await db.exec(`delete from public.email_outbox`);
        await call(PETER, "payroll_approve_month", [monthId], ["uuid"]);
        eq(await count(), 0, "no email");
        eq((await open(monthId, "payroll_endorsed")).length, 0, "settled");
        eq((await open(monthId)).filter((n) => n.payload.tone === "action").length, 0, "nothing open on this month");
    });

    // --- finance requests ----------------------------------------------------

    let requestId;
    await step("notifications: a finance request submitted goes to the executive", async () => {
        await clear();
        const body = {
            title: "Notify petty cash", due_date: "2026-10-10",
            items: [{ category: "petty_cash", description: "Office", amount: 2_500_000 }],
        };
        const r = await call(HIMAWAN, "finance_create", [JSON.stringify(body)]);
        requestId = r.id;
        await call(HIMAWAN, "finance_update", [r.id, JSON.stringify({ ...body, title: "Notify petty cash (Oct)" })]);
        eq(await count(), 0, "drafting enqueues nothing");
        await call(HIMAWAN, "finance_submit", [r.id]);
        const rows = await expectSent(r.id, "finance_submitted", await roleMails("executive"), "/finance-requests", [MAIL.MARK]);
        never(rows, MAIL.MARK, MAIL.OLDEXEC, HIMAWAN_MAIL, DIRECTOR_MAIL);
        eq(rows[0].subject, `Finance request ${r.reference} has been submitted for approval`, "subject");
        if (!rows.payload.details.some(([k, v]) => k === "Total" && v === "IDR 2,500,000"))
            throw new Error(JSON.stringify(rows.payload.details));
        // The director is copied in, for information only: not an action item.
        const cc = await expectSent(r.id, "finance_submitted_cc", await roleMails("director"), "/finance-requests");
        if (!cc[0].subject.endsWith("has been sent to Peter (for your information)")) throw new Error(cc[0].subject);
        eq([cc.payload.tone, cc.payload.eyebrow], ["reminder", "For your information"], "cc payload");
        if (!cc.payload.intro.includes("No action is needed from you.")) throw new Error(cc.payload.intro);
    });

    await step("notifications: approving enqueues nothing; a send-back reaches finance", async () => {
        await clear();
        await call(PETER, "finance_send_back", [requestId, "Attach the receipt", "finance"]);
        const rows = await expectSent(requestId, "finance_sent_back", await roleMails("finance"), "/finance-requests");
        never(rows, PETER_MAIL);
    });

    await step("notifications: approving a finance request enqueues nothing", async () => {
        await call(HIMAWAN, "finance_submit", [requestId]);
        await clear();
        await call(PETER, "finance_approve", [requestId]);
        eq(await count(), 0, "approve");
        eq((await open(requestId, "finance_submitted")).length, 0, "and settles Peter's item");
    });

    // --- leave ---------------------------------------------------------------

    const leave = (uid, start, end = start, days = 1, reason = "Family") =>
        call(uid, "submit_leave_request", [JSON.stringify({
            leave_type: "annual", start_date: start, end_date: end, days_requested: days, reason,
        })], ["jsonb"]);
    const cleanLeave = () => db.exec(`delete from public.leave_requests where employee_id in
        (select id from public.employees where employee_id like 'NTF-%' or user_id = '${DIRECTOR}')`);

    await step("notifications: approver helper follows the leaves rule", async () => {
        const ap = async (emp) => (await db.query(`select public.notifications_leave_approvers($1) a`, [emp])).rows[0].a;
        eq(await ap(E.STAFF), [U.MANAGER], "managed staff -> manager");
        const directors = (await db.query(`select public.notifications_role_users('director') a`)).rows[0].a;
        eq(await ap(E.LONER), directors, "no manager -> director");
        const dirEmp = (await db.query(`select id from public.employees where user_id = $1`, [DIRECTOR])).rows[0].id;
        const d = await ap(dirEmp);
        if (d.includes(DIRECTOR) || !d.includes(PETER)) throw new Error(`director's own: ${JSON.stringify(d)}`);
    });

    await step("notifications: leave goes to the named manager only; the decision to the requester", async () => {
        await cleanLeave();
        await clear();
        const r = await leave(U.STAFF, "2026-11-02", "2026-11-03", 2, "Wedding <3");
        const rows = await expectSent(r.id, "leave_submitted", [MAIL.MANAGER], "/leaves");
        eq(rows[0].subject, "Leave request from Staff Notify is waiting for your approval", "subject");
        if (!rows.payload.details.some(([k, v]) => k === "Dates" && v === "2 November 2026 to 3 November 2026"))
            throw new Error(JSON.stringify(rows.payload.details));
        eq(rows.payload.note, { by: "Staff Notify", text: "Wedding <3" }, "reason, raw");
        await db.exec(`delete from public.email_outbox`);
        await call(U.MANAGER, "approve_leave_request", [r.id, "Enjoy"], ["uuid", "text"]);
        const done = await expectSent(r.id, "leave_approved", [MAIL.STAFF], "/leaves");
        eq(done[0].subject, "Your leave request has been approved", "subject");
        eq([done.payload.tone, done.payload.note.text], ["success", "Enjoy"], "approved payload");
        eq(await count(), 1, "only the requester");
        eq((await open(r.id, "leave_submitted")).length, 0, "the manager's item is settled");
        await db.exec(`delete from public.email_outbox`);
        await call(U.STAFF, "cancel_leave_request", [r.id], ["uuid"]);
        eq(await count(), 0, "cancelling enqueues nothing");
        eq((await inbox(r.id, "leave_approved"))[0].resolved_at, null, "an outcome is never settled");
    });

    await step("notifications: cancelling a pending request settles the approver's item", async () => {
        await cleanLeave();
        await clear();
        const r = await leave(U.STAFF, "2026-11-20");
        eq((await open(r.id, "leave_submitted")).length, 1, "open");
        await call(U.STAFF, "cancel_leave_request", [r.id], ["uuid"]);
        eq((await open(r.id, "leave_submitted")).length, 0, "settled");
    });

    await step("notifications: no manager -> the director; a rejection -> the requester", async () => {
        await cleanLeave();
        await clear();
        const r = await leave(U.LONER, "2026-11-10");
        const rows = await expectSent(r.id, "leave_submitted", await roleMails("director"), "/leaves");
        never(rows, MAIL.LONER, PETER_MAIL);
        await clear();
        await call(DIRECTOR, "reject_leave_request", [r.id, "Short-staffed"], ["uuid", "text"]);
        const done = await expectSent(r.id, "leave_rejected", [MAIL.LONER], "/leaves");
        eq(done[0].subject, "Your leave request has been rejected", "subject");
        eq([done.payload.tone, done.payload.note.text], ["danger", "Short-staffed"], "rejected payload");
    });

    await step("notifications: an inactive manager is passed over for the director", async () => {
        await cleanLeave();
        await clear();
        await db.exec(`update public.employees set is_active = false where id = '${E.MANAGER}'`);
        try {
            const r = await leave(U.STAFF, "2026-11-12");
            const rows = await expectSent(r.id, "leave_submitted", await roleMails("director"), "/leaves");
            never(rows, MAIL.MANAGER);
        } finally {
            await db.exec(`update public.employees set is_active = true where id = '${E.MANAGER}'`);
        }
    });

    await step("notifications: the director's own leave goes to the executive, not the director", async () => {
        await cleanLeave();
        await clear();
        const r = await leave(DIRECTOR, "2026-11-16");
        const rows = await expectSent(r.id, "leave_submitted", await roleMails("executive"), "/leaves", [MAIL.MARK]);
        never(rows, DIRECTOR_MAIL, MAIL.MARK, MAIL.OLDEXEC);
        if (!rows.some((x) => x.to_email === PETER_MAIL)) throw new Error("Peter missing");
        await cleanLeave();
    });

    // --- KPI -----------------------------------------------------------------

    await step("notifications: a KPI scorecard submitted goes to its approver", async () => {
        await db.exec(`delete from public.kpi_reviews where employee_id = '${E.STAFF}'`);
        let r = await call(DIRECTOR, "kpi_create_review", [JSON.stringify({
            employee_id: E.STAFF, period_type: "quarterly", period_label: "NTF Q3",
            period_start: "2026-07-01", period_end: "2026-09-30",
        })], ["jsonb"]);
        await clear();
        for (const item of r.items)
            await call(DIRECTOR, "kpi_update_item", [r.id, item.id, JSON.stringify({ rating: 3 })], ["uuid", "uuid", "jsonb"]);
        eq(await count(), 0, "rating enqueues nothing");
        const approver = (await db.query(`select approver_id from public.kpi_reviews where id = $1`, [r.id])).rows[0].approver_id;
        eq(approver, PETER, "approver");
        await call(DIRECTOR, "kpi_submit_review", [r.id], ["uuid"]);
        const rows = await expectSent(r.id, "kpi_submitted", [PETER_MAIL], `/kpi?employee=${E.STAFF}`);
        eq(rows[0].subject, "KPI scorecard for Staff Notify (NTF Q3) is waiting for your approval", "subject");
        eq(await count(), 1, "only the approver");
        await call(PETER, "kpi_approve_review", [r.id, null], ["uuid", "text"]);
        eq((await open(r.id, "kpi_submitted")).length, 0, "approving settles it");
    });

    await step("notifications: a scorecard whose approver has opted out goes to the executives who take email", async () => {
        await db.exec(`delete from public.kpi_reviews where employee_id = '${E.LONER}'`);
        const id = "0e0e0000-0000-0000-0000-0000000000a1";
        await db.exec(`insert into public.kpi_reviews (id, employee_id, period_label, period_start, period_end,
                                                      status, assessor_id, approver_id)
                       values ('${id}', '${E.LONER}', 'NTF Q3', '2026-07-01', '2026-09-30', 'draft',
                               '${DIRECTOR}', '${U.MARK}')`);
        await clear();
        await db.exec(`update public.kpi_reviews set status = 'submitted' where id = '${id}'`);
        // Mark still gets the in-app item; the executives who take email get both.
        const rows = await expectSent(id, "kpi_submitted", await roleMails("executive"), `/kpi?employee=${E.LONER}`, [MAIL.MARK]);
        never(rows, MAIL.MARK);
        await db.exec(`delete from public.kpi_reviews where id = '${id}'`);
    });

    // --- salary --------------------------------------------------------------

    await step("notifications: a salary review submitted goes to the executive", async () => {
        const draft = await call(DIRECTOR, "salary_create_review", [JSON.stringify({
            employee_id: E.STAFF, effective_date: "2027-01-01",
            current_amount: 10_000_000, proposed_amount: 10_500_000, rationale: "Band 2M",
        })], ["jsonb"]);
        await clear();
        await call(DIRECTOR, "salary_update_review", [draft.id, JSON.stringify({ rationale: "Band 2" })], ["uuid", "jsonb"]);
        eq(await count(), 0, "editing enqueues nothing");
        await call(DIRECTOR, "salary_submit_review", [draft.id], ["uuid"]);
        const rows = await expectSent(draft.id, "salary_submitted", await roleMails("executive"), "/salary", [MAIL.MARK]);
        never(rows, MAIL.MARK, MAIL.OLDEXEC, DIRECTOR_MAIL, MAIL.STAFF);
        eq(rows[0].subject, "Salary review for Staff Notify is waiting for your approval", "subject");
        await db.exec(`delete from public.email_outbox`);
        await call(PETER, "salary_decline_review", [draft.id, "Not this year"], ["uuid", "text"]);
        eq(await count(), 0, "a decline enqueues nothing");
        eq((await open(draft.id, "salary_submitted")).length, 0, "and settles the executives' items");
    });

    await step("notifications: nobody is emailed about their own salary review", async () => {
        const peterEmp = (await db.query(`select id from public.employees where user_id = $1`, [PETER])).rows[0].id;
        const draft = await call(DIRECTOR, "salary_create_review", [JSON.stringify({
            employee_id: peterEmp, effective_date: "2027-01-01",
            current_amount: 10_000_000, proposed_amount: 10_000_000,
        })], ["jsonb"]);
        await clear();
        await call(DIRECTOR, "salary_submit_review", [draft.id], ["uuid"]);
        never(await outbox(draft.id), PETER_MAIL);
        await db.query(`delete from public.salary_reviews where id = $1`, [draft.id]);
    });

    // --- the inbox, from the browser ------------------------------------------

    // A notification written straight in; `extra` sets created_at, read_at, resolved_at.
    const seed = async (uid, kind, tone, extra = null) => (await db.query(
        `insert into public.notifications (user_id, kind, source_table, source_id, payload, created_at, read_at, resolved_at, needs_action)
         select $1, $2::text, 'test_source', gen_random_uuid(), p,
                coalesce($4::timestamptz, now()), $5::timestamptz, $6::timestamptz,
                public.notifications_needs_action($2::text, p)
           from (select jsonb_build_object('tone', $3::text, 'headline', $2::text,
                                           'link', jsonb_build_object('label','x','path','/')) p) x
         returning id`,
        [uid, kind, tone, extra?.created ?? null, extra?.read ?? null, extra?.resolved ?? null])).rows[0].id;
    const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
    const NOW = () => new Date().toISOString();

    await step("notifications: each user reads only their own, and cannot rewrite them", async () => {
        await clear();
        await seed(U.STAFF, "t_mine", "action");
        await seed(U.LONER, "t_theirs", "action");
        const r = await tx(U.STAFF, `select kind from public.notifications`);
        eq(r.rows.map((x) => x.kind), ["t_mine"], "own rows only");
        for (const sql of [`update public.notifications set payload = '{}'`, `delete from public.notifications`]) {
            try {
                await tx(U.STAFF, sql);
            } catch (e) {
                if (!/permission denied/.test(e.message)) throw new Error(`${sql}: ${e.message}`);
                continue;
            }
            throw new Error(`${sql} was allowed`);
        }
    });

    await step("notifications: mark read touches only the caller's rows; mark all read clears the count", async () => {
        await clear();
        const a = await seed(U.STAFF, "t1", "action");
        await seed(U.STAFF, "t2", "success");
        const theirs = await seed(U.LONER, "t3", "action");
        eq(await call(U.STAFF, "notifications_mark_read", [[a, theirs]], ["uuid[]"]), 1, "only mine");
        eq((await db.query(`select read_at from public.notifications where id = $1`, [theirs])).rows[0].read_at, null, "theirs untouched");
        eq(await call(U.STAFF, "notifications_mark_all_read"), 1, "the rest");
        eq((await tx(U.STAFF, `select count(*)::int n from public.notifications where read_at is null`)).rows[0].n, 0, "unread");
        eq(await call(U.STAFF, "notifications_mark_all_read"), 0, "idempotent");
    });

    await step("notifications: open actions include read items, honour exclusions, and are the caller's", async () => {
        await clear();
        await seed(U.STAFF, "ticket_raised", "action", { read: NOW() });       // read, open
        await seed(U.STAFF, "leave_submitted", "action");                      // open
        await seed(U.STAFF, "kpi_submitted", "action", { resolved: NOW() });   // settled
        await seed(U.STAFF, "leave_approved", "success");                      // not an action
        await seed(U.LONER, "ticket_raised", "action");                        // someone else's
        const kinds = async (ex) => (await tx(U.STAFF,
            `select kind from public.notifications_open_actions($1::text[]) order by kind`, [ex])).rows.map((x) => x.kind);
        eq(await kinds([]), ["leave_submitted", "ticket_raised"], "open");
        eq(await kinds(["leave_submitted"]), ["ticket_raised"], "excluded");
    });

    await step("notifications: the email preference is the user's own to change", async () => {
        eq(await call(U.STAFF, "notifications_get_email"), true, "on");
        eq(await call(U.STAFF, "notifications_set_email", [false], ["boolean"]), false, "set");
        eq((await db.query(`select email_notifications e from public.users where id = $1`, [U.STAFF])).rows[0].e, false, "saved");
        eq((await db.query(`select email_notifications e from public.users where id = $1`, [U.LONER])).rows[0].e, true, "nobody else");
        // Off: the next notification is in-app only.
        await cleanLeave();
        await clear();
        await db.exec(`update public.employees set manager_id = '${E.STAFF}' where id = '${E.LONER}'`);
        try {
            const r = await leave(U.LONER, "2026-11-24");
            eq((await inbox(r.id, "leave_submitted")).map((n) => n.email), [MAIL.STAFF], "in-app");
            eq((await outbox(r.id)).length, 0, "no email");
        } finally {
            await db.exec(`update public.employees set manager_id = null where id = '${E.LONER}'`);
            await call(U.STAFF, "notifications_set_email", [true], ["boolean"]);
            await cleanLeave();
        }
    });

    await step("notifications: retention deletes old read or settled items and keeps old open ones", async () => {
        await clear();
        const oldRead = await seed(U.STAFF, "t_old_read", "action", { created: daysAgo(200), read: NOW() });
        const oldDone = await seed(U.STAFF, "t_old_done", "action", { created: daysAgo(200), resolved: NOW() });
        const oldOpen = await seed(U.STAFF, "t_old_open", "action", { created: daysAgo(200) });
        const newRead = await seed(U.STAFF, "t_new_read", "success", { created: daysAgo(10), read: NOW() });
        // The statement the cron job runs.
        await db.exec(`delete from public.notifications
                        where created_at < now() - interval '180 days'
                          and (read_at is not null or resolved_at is not null)`);
        const left = (await db.query(`select id from public.notifications`)).rows.map((x) => x.id).sort();
        eq(left, [oldOpen, newRead].sort(), "kept");
        if (left.includes(oldRead) || left.includes(oldDone)) throw new Error("not deleted");
    });

    await step("notifications: every table that gets action items carries the resolve trigger", async () => {
        const want = ["finance_requests", "investigation_outcomes", "investigations", "kpi_reviews", "leave_requests",
                      "payroll_months", "profile_change_requests", "salary_reviews", "shift_change_requests",
                      "support_tickets"];
        const r = await db.query(`select c.relname t from pg_trigger g join pg_class c on c.oid = g.tgrelid
                                   where g.tgname = 'trg_notifications_resolve' and not g.tgisinternal order by 1`);
        eq(r.rows.map((x) => x.t), want, "tables");
        // And every 'action' payload in the migration names one of them as its source.
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const src = ["20261007000100_in_app_notifications.sql", "20261009000100_notifications_phase_3.sql"]
            .map((f) => readFileSync(join(import.meta.dirname, "..", "..", "migrations", f), "utf8")).join("\n");
        const calls = src.split("public.notifications_payload(").slice(1);
        let checked = 0;
        for (const c of calls) {
            if (!/^\s*'action'/.test(c)) continue;
            const m = c.match(/\),\s*'([a-z_]+)',\s*[a-z_.]+\);/);
            if (!m) throw new Error(`no source after: ${c.slice(0, 80)}`);
            if (!want.includes(m[1])) throw new Error(`${m[1]} has action items but no trigger`);
            checked++;
        }
        if (checked < 8) throw new Error(`only ${checked} action payloads found`);
    });


    // --- phase 3: item links, needs_action, who resolved, new sources ---------

    const one = async (sql, params) => (await db.query(sql, params)).rows[0];

    await step("notifications: a settled item records who settled it and how", async () => {
        await cleanLeave();
        await clear();
        const r = await leave(U.STAFF, "2026-12-01");
        const [mine] = await inbox(r.id, "leave_submitted");
        eq([mine.needs_action, mine.payload.link.path], [true, `/leaves?open=${r.id}`], "action item with the item link");
        await call(U.MANAGER, "approve_leave_request", [r.id, "Fine"], ["uuid", "text"]);
        const [after] = await inbox(r.id, "leave_submitted");
        eq([after.resolved_status, after.resolved_by, after.resolved_by_name], ["approved", U.MANAGER, NAME.MANAGER], "who and how");
        const [done] = await inbox(r.id, "leave_approved");
        eq(done.needs_action, false, "an outcome is not work");
        await cleanLeave();
    });

    await step("notifications: sent back to finance is work, and resubmitting settles it", async () => {
        await clear();
        const body = { title: "Phase 3 petty cash", due_date: "2026-12-10",
                       items: [{ category: "petty_cash", description: "Office", amount: 1_000_000 }] };
        const f = await call(HIMAWAN, "finance_create", [JSON.stringify(body)]);
        await call(HIMAWAN, "finance_submit", [f.id]);
        const cc = (await inbox(f.id, "finance_submitted_cc"))[0];
        if (cc) eq(cc.needs_action, false, "the director's copy is for information");
        await call(PETER, "finance_send_back", [f.id, "Attach the receipt", "finance"]);
        const back = (await inbox(f.id, "finance_sent_back")).find((n) => n.user_id === HIMAWAN);
        eq([back.payload.tone, back.needs_action], ["danger", true], "red but work");
        const open = (await tx(HIMAWAN, `select kind from public.notifications_open_actions('{}'::text[])`)).rows.map((x) => x.kind);
        if (!open.includes("finance_sent_back")) throw new Error(`open actions: ${open}`);
        await call(HIMAWAN, "finance_submit", [f.id]);
        const settled = (await inbox(f.id, "finance_sent_back")).find((n) => n.user_id === HIMAWAN);
        eq([settled.resolved_status, settled.resolved_by], ["submitted", HIMAWAN], "settled on resubmit");
        await db.query(`delete from public.finance_requests where id = $1`, [f.id]);
    });

    await step("notifications: existing rows are backfilled with needs_action", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        await clear();
        const id = (await one(`insert into public.notifications (user_id, kind, source_table, source_id, payload, needs_action)
            values ($1, 'investigation_sent_back', 'investigations', gen_random_uuid(),
                    '{"tone":"danger","headline":"x","link":{"label":"x","path":"/"}}', false) returning id`, [U.STAFF])).id;
        await db.exec(readFileSync(join(import.meta.dirname, "..", "..", "migrations",
            "20261009000100_notifications_phase_3.sql"), "utf8"));
        eq((await one(`select needs_action from public.notifications where id = $1`, [id])).needs_action, true, "backfilled");
    });

    await step("notifications: the old Vercel address moves to people.digitaltwingeotechnical.com; a chosen one stays", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const rerun = () => db.exec(readFileSync(join(import.meta.dirname, "..", "..", "migrations",
            "20261009000100_notifications_phase_3.sql"), "utf8"));
        const url = async () => (await one(`select public.notifications_site_url() u`)).u;
        try {
            await db.query(`update public.app_settings set value = 'https://dtghr-fe.vercel.app/' where key = 'public_site_url'`);
            await rerun();
            eq(await url(), "https://people.digitaltwingeotechnical.com", "moved");
            await db.query(`update public.app_settings set value = 'https://hr.example.test' where key = 'public_site_url'`);
            await rerun();
            eq(await url(), "https://hr.example.test", "a chosen address is kept");
        } finally {
            await db.query(`update public.app_settings set value = 'https://dtghr-fe.vercel.app' where key = 'public_site_url'`);
        }
    });

    await step("notifications: profile change requests reach the reviewers; the decision reaches the requester", async () => {
        await clear();
        await db.exec(`delete from public.profile_change_requests where employee_id = '${E.STAFF}'`);
        const req = await call(U.STAFF, "people_raise_profile_request", ["bank_account_number", "1234567890", "New bank"],
                               ["text", "text", "text"]);
        const reqId = req.id ?? (await one(`select id from public.profile_change_requests
                                             where employee_id = $1 and status = 'pending'`, [E.STAFF])).id;
        const want = (await db.query(`select email from public.notifications_recipients(
                                          public.notifications_profile_reviewers(), array[$1::uuid])`, [U.STAFF]))
            .rows.map((x) => x.email).sort();
        const got = await inbox(reqId, "profile_request_submitted");
        eq(got.map((n) => n.email).sort(), want, "reviewers");
        if (!got.length) throw new Error("no reviewers");
        const p = got[0].payload;
        eq([got[0].needs_action, p.link.path, p.note.text], [true, "/settings", "New bank"], "submitted payload");
        if (JSON.stringify(p).includes("1234567890")) throw new Error("the account number is in the notification");

        await call(DIRECTOR, "people_decline_profile_request", [reqId, "Attach the bank letter"], ["uuid", "text"]);
        const [decided] = await inbox(reqId, "profile_request_declined");
        eq([decided.email, decided.payload.tone, decided.payload.note.text], [MAIL.STAFF, "danger", "Attach the bank letter"], "declined");
        const left = (await inbox(reqId, "profile_request_submitted")).filter((n) => n.resolved_at === null);
        eq(left.length, 0, "reviewers' items settled");
        eq((await inbox(reqId, "profile_request_submitted"))[0].resolved_status, "declined", "how");
        await db.exec(`delete from public.profile_change_requests where employee_id = '${E.STAFF}'`);
    });

    await step("notifications: a roster proposal lists its days; a partial decision reaches the proposer", async () => {
        await clear();
        const REQ = "0e0e0000-0000-0000-0000-0000000000c1";
        const SCHED = "bbbbbbbb-0000-0000-0000-000000000001";
        const items = ["0e0e0000-0000-0000-0000-0000000000c2", "0e0e0000-0000-0000-0000-0000000000c3",
                       "0e0e0000-0000-0000-0000-0000000000c4"];
        await db.exec(`delete from public.shift_change_requests where id = '${REQ}'`);
        await db.exec(`
            begin;
            select set_config('request.jwt.claim.sub', '${U.STAFF}', true);
            insert into public.shift_change_requests (id, schedule_id, status, reason, requested_by_id)
            values ('${REQ}', '${SCHED}', 'pending', 'Family visit', '${U.STAFF}');
            insert into public.shift_change_items (id, request_id, employee_id, date, current_code, requested_code, status)
            values ('${items[0]}', '${REQ}', '${E.STAFF}', '2026-09-20', 'DS', 'AL', 'pending'),
                   ('${items[1]}', '${REQ}', '${E.STAFF}', '2026-09-21', 'DS', 'AL', 'pending'),
                   ('${items[2]}', '${REQ}', '${E.STAFF}', '2026-09-22', 'NS', 'B', 'pending');
            commit;`);
        const proposed = await inbox(REQ, "shift_change_proposed");
        const approvers = (await db.query(`select email from public.notifications_recipients(
                public.notifications_role_users('director') || public.notifications_role_users('executive'),
                array[$1::uuid])`, [U.STAFF])).rows.map((x) => x.email).sort();
        eq(proposed.map((n) => n.email).sort(), approvers, "approvers");
        const p = proposed[0].payload;
        eq([proposed[0].needs_action, p.details.length, p.note.text], [true, 3, "Family visit"], "three days listed");
        if (!p.headline.includes("3 days")) throw new Error(p.headline);

        await db.exec(`
            begin;
            select set_config('request.jwt.claim.sub', '${DIRECTOR}', true);
            update public.shift_change_items set status = 'approved' where id in ('${items[0]}', '${items[1]}');
            update public.shift_change_items set status = 'rejected' where id = '${items[2]}';
            update public.shift_change_requests set status = 'partially_approved', review_note = 'Not the night'
             where id = '${REQ}';
            commit;`);
        const [decided] = await inbox(REQ, "shift_change_decided");
        eq([decided.email, decided.payload.tone, decided.payload.details],
           [MAIL.STAFF, "reminder", [["Approved", "2 days"], ["Rejected", "1 day"]]], "partly approved");
        const settled = await inbox(REQ, "shift_change_proposed");
        eq(settled.every((n) => n.resolved_status === "partially_approved" && n.resolved_by === DIRECTOR), true, "settled");
        await db.exec(`delete from public.shift_change_requests where id = '${REQ}'`);
    });

    await step("notifications: a payslip notifies its employee once, not on regeneration", async () => {
        await clear();
        const line = (await one(`select id from public.payroll_lines where month_id = $1 limit 1`, [monthId])).id;
        const upsert = `insert into public.payslips (month_id, payroll_line_id, employee_id, year, month, issue_date, data)
                        values ($1, $2, $3, 2041, 9, '2041-09-28', '{}'::jsonb)
                        on conflict (month_id, payroll_line_id) do update set data = excluded.data
                        returning id`;
        const slip = (await one(upsert, [monthId, line, E.STAFF])).id;
        const got = await inbox(slip, "payslip_ready");
        eq(got.map((n) => n.email), [MAIL.STAFF], "the employee");
        eq([got[0].needs_action, got[0].payload.link.path, got[0].payload.tone],
           [false, `/employees/${E.STAFF}?tab=payslips`, "success"], "payload");
        if (!got[0].payload.headline.includes("September 2041")) throw new Error(got[0].payload.headline);
        await one(upsert, [monthId, line, E.STAFF]);
        eq((await inbox(slip, "payslip_ready")).length, 1, "regenerating notifies nobody");
        await db.query(`delete from public.payslips where id = $1`, [slip]);
    });

    await step("notifications: leaves_get serves the requester and the reviewers, and says what each may do", async () => {
        await cleanLeave();
        const r = await leave(U.STAFF, "2026-12-08");
        const as = async (uid) => (await tx(uid, `select public.leaves_get($1::uuid) j`, [r.id])).rows[0].j;
        const own = await as(U.STAFF);
        eq([own.is_mine, own.can_review, own.can_cancel], [true, false, true], "requester");
        const mgr = await as(U.MANAGER);
        eq([mgr.is_mine, mgr.can_review, mgr.can_cancel], [false, true, false], "named manager");
        eq((await as(DIRECTOR)).can_review, true, "director");
        try {
            await as(U.LONER);
            throw new Error("a colleague read it");
        } catch (e) {
            if (!/Access denied/.test(e.message)) throw e;
        }
        await call(U.MANAGER, "approve_leave_request", [r.id, "Ok"], ["uuid", "text"]);
        const after = await as(DIRECTOR);
        eq([after.status, after.can_review, after.reviewed_by_name], ["approved", false, NAME.MANAGER], "decided, still readable");
        await cleanLeave();
    });

    // --- delivery bookkeeping ------------------------------------------------

    await step("notifications: claim takes the oldest unsent, counts attempts, stops at five", async () => {
        await clear();
        await db.exec(`
            insert into public.email_outbox (id, to_email, subject, body_html, body_text, kind, created_at, attempts, sent_at)
            values ('0e0e0000-0000-0000-0000-0000000000b1','a@x','A','a','a','t', now() - interval '3 min', 0, null),
                   ('0e0e0000-0000-0000-0000-0000000000b2','b@x','B','b','b','t', now() - interval '2 min', 4, null),
                   ('0e0e0000-0000-0000-0000-0000000000b3','c@x','C','c','c','t', now() - interval '1 min', 5, null),
                   ('0e0e0000-0000-0000-0000-0000000000b4','d@x','D','d','d','t', now() - interval '4 min', 0, now());
        `);
        const first = (await db.query(`select id, attempts from public.notifications_claim(1)`)).rows;
        eq(first.map((r) => [r.id.slice(-2), r.attempts]), [["b1", 1]], "oldest first");
        const rest = (await db.query(`select id from public.notifications_claim(25) order by id`)).rows;
        eq(rest.map((r) => r.id.slice(-2)), ["b2"], "held rows, sent rows and spent rows are skipped");
        await db.query(`select public.notifications_mark($1, null)`, ["0e0e0000-0000-0000-0000-0000000000b1"]);
        await db.query(`select public.notifications_mark($1, 'Graph 500')`, ["0e0e0000-0000-0000-0000-0000000000b2"]);
        const r = (await db.query(`select id, sent_at is not null sent, last_error, claimed_at from public.email_outbox
                                    where id in ('0e0e0000-0000-0000-0000-0000000000b1','0e0e0000-0000-0000-0000-0000000000b2')
                                    order by id`)).rows;
        eq(r.map((x) => [x.sent, x.last_error, x.claimed_at]), [[true, null, null], [false, "Graph 500", null]], "marked");
        // b2 has now had five goes: it is not taken again.
        eq((await db.query(`select count(*)::int n from public.notifications_claim(25)`)).rows[0].n, 0, "spent");
        await clear();
    });

    // --- leave nothing behind for the suites that follow ---------------------
    await step("notifications: clean up", async () => {
        const mine = Object.values(U).map((id) => `'${id}'`).join(",");
        await db.exec(`
            delete from public.email_outbox;
            delete from public.notifications;
            delete from public.payslips where year = 2041;
            delete from public.payroll_months where year = 2041;
            delete from public.finance_requests where id = '${requestId}';
            delete from public.salary_reviews where employee_id in (select id from public.employees where employee_id like 'NTF-%');
            delete from public.kpi_reviews where employee_id in (select id from public.employees where employee_id like 'NTF-%');
            delete from public.leave_requests where employee_id in (select id from public.employees where employee_id like 'NTF-%');
            delete from public.support_tickets where reporter_id in (select id from public.employees where employee_id like 'NTF-%');
            delete from public.leave_balances where employee_id in (select id from public.employees where employee_id like 'NTF-%');
            update public.employees set manager_id = null where employee_id like 'NTF-%';
        `);
        try {
            await db.exec(`
                delete from public.employees where employee_id like 'NTF-%';
                delete from auth.users where id in (${mine});
            `);
        } catch {
            // Something still points at them (the activity log): retire them instead.
            await db.exec(`
                update public.employees set is_active = false, is_it_support = false where employee_id like 'NTF-%';
                update public.users set role = 'employee', is_active = false where id in (${mine});
            `);
        }
    });
};
