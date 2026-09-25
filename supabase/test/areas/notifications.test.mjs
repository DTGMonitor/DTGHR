// Email notifications (20260926001300): who gets an outbox row, on which
// status change, with which link -- and who never does.
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
    const clear = () => db.exec(`delete from public.email_outbox`);
    const count = async () => (await db.query(`select count(*)::int n from public.email_outbox`)).rows[0].n;
    const eq = (got, want, what) => {
        const g = JSON.stringify(got), w = JSON.stringify(want);
        if (g !== w) throw new Error(`${what}: got ${g}, expected ${w}`);
    };
    // Exactly one row per expected recipient, of this kind, with this link.
    const expectSent = async (source, kind, mails, link) => {
        const rows = (await outbox(source)).filter((r) => r.kind === kind);
        eq(rows.map((r) => r.to_email).sort(), [...mails].sort(), `${kind} recipients`);
        for (const r of rows) {
            eq(r.link_path, link, `${kind} link`);
            if (!r.body_html.includes(`https://dtghr-fe.vercel.app${link.replace(/&/g, "&amp;")}`))
                throw new Error(`${kind}: html lacks the link`);
            if (!r.body_text.includes(`https://dtghr-fe.vercel.app${link}`)) throw new Error(`${kind}: text lacks the link`);
            if (r.sent_at !== null || r.attempts !== 0) throw new Error("not fresh");
        }
        return rows;
    };
    const never = (rows, ...mails) => {
        for (const m of mails) if (rows.some((r) => r.to_email === m)) throw new Error(`${m} was emailed`);
    };

    // =======================================================================

    await step("notifications: the migration re-runs cleanly and keeps the site URL", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        await db.query(`update public.app_settings set value = 'https://hr.example.test/' where key = 'public_site_url'`);
        await db.exec(readFileSync(join(import.meta.dirname, "..", "..", "migrations",
            "20260926001300_notifications.sql"), "utf8"));
        const r = await db.query(`select public.notifications_site_url() u`);
        await db.query(`update public.app_settings set value = 'https://dtghr-fe.vercel.app' where key = 'public_site_url'`);
        eq(r.rows[0].u, "https://hr.example.test", "site url");
    });

    await step("notifications: the site URL comes from app_settings", async () => {
        await clear();
        await db.query(`update public.app_settings set value = 'https://hr.dtgeotech.com' where key = 'public_site_url'`);
        try {
            const t = await call(U.REPORTER, "tickets_raise", ["Monitor flickers", "It flickers", "hardware"]);
            const [row] = await outbox(t.id);
            if (!row.body_text.includes("https://hr.dtgeotech.com/support")) throw new Error(row.body_text);
            if (row.body_html.includes("vercel.app")) throw new Error("old domain in the html");
        } finally {
            await db.query(`update public.app_settings set value = 'https://dtghr-fe.vercel.app' where key = 'public_site_url'`);
        }
    });

    await step("notifications: the outbox is closed to the browser", async () => {
        for (const sql of [`select * from public.email_outbox`, `select public.notifications_claim(1)`,
                           `select public.notifications_mark('${U.MARK}'::uuid, null)`]) {
            try {
                await tx(PETER, sql);
            } catch (e) {
                if (!/permission denied/.test(e.message)) throw new Error(`${sql}: ${e.message}`);
                continue;
            }
            throw new Error(`${sql} was allowed`);
        }
    });

    await step("notifications: recipient filter drops opted-out, inactive and excluded people", async () => {
        const r = await db.query(`select email from public.notifications_recipients($1::uuid[], $2::uuid[])`,
            [[PETER, U.MARK, U.OLDEXEC, U.ITGONE, U.STAFF, U.LONER], [U.LONER]]);
        eq(r.rows.map((x) => x.email).sort(), [PETER_MAIL, MAIL.STAFF].sort(), "recipients");
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
        if (!mine.body_html.includes("VPN &lt;down&gt; &amp; out") || mine.body_html.includes("<down>"))
            throw new Error("subject not escaped in html");
        if (!mine.body_text.includes("VPN <down> & out")) throw new Error("text should carry it raw");
        if (!mine.body_text.startsWith(`Dear ${NAME.ITGUY},`)) throw new Error(mine.body_text);
    });

    await step("notifications: IT support raising their own ticket is not emailed about it", async () => {
        await clear();
        const t = await call(U.ITGUY, "tickets_raise", ["My own laptop", "Broken", "hardware"]);
        never(await outbox(t.id), MAIL.ITGUY);
    });

    await step("notifications: working a ticket enqueues nothing", async () => {
        const t = await call(U.REPORTER, "tickets_raise", ["Printer", "Jammed", "hardware"]);
        await clear();
        await call(U.ITGUY, "tickets_set_status", [t.id, "in_progress", null], ["uuid", "text", "text"]);
        await call(U.ITGUY, "tickets_comment", [t.id, "On it", false], ["uuid", "text", "boolean"]);
        eq(await count(), 0, "outbox rows");
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
        await clear();
        await call(DIRECTOR, "payroll_endorse_month", [monthId], ["uuid"]);
        const execs = await roleMails("executive");
        if (!execs.includes(PETER_MAIL) || execs.includes(MAIL.MARK)) throw new Error(JSON.stringify(execs));
        const rows = await expectSent(monthId, "payroll_endorsed", execs, "/payroll");
        never(rows, MAIL.MARK, MAIL.OLDEXEC, DIRECTOR_MAIL);
        eq(rows[0].subject, "Payroll for September 2041 is waiting for your approval", "subject");
    });

    await step("notifications: payroll sent back to the director reaches the director, with the reason", async () => {
        await clear();
        await call(PETER, "payroll_request_changes", [monthId, "Check <Nessa's> shifts", "director"], ["uuid", "text", "text"]);
        const rows = await expectSent(monthId, "payroll_returned", await roleMails("director"), "/payroll");
        never(rows, PETER_MAIL, HIMAWAN_MAIL);
        const r = rows[0];
        if (!r.body_text.includes("The reason given: Check <Nessa's> shifts")) throw new Error(r.body_text);
        if (!r.body_html.includes("Check &lt;Nessa&#39;s&gt; shifts")) throw new Error("reason not escaped");
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
        const rows = await expectSent(r.id, "finance_submitted", await roleMails("executive"), "/finance-requests");
        never(rows, MAIL.MARK, MAIL.OLDEXEC, HIMAWAN_MAIL, DIRECTOR_MAIL);
        eq(rows[0].subject, `Finance request ${r.reference} has been submitted for approval`, "subject");
        if (!rows[0].body_text.includes("Total: IDR 2,500,000")) throw new Error(rows[0].body_text);
    });

    await step("notifications: the director's review enqueues nothing; a send-back reaches finance", async () => {
        await clear();
        await call(DIRECTOR, "finance_review", [requestId]);
        eq(await count(), 0, "review");
        await call(PETER, "finance_send_back", [requestId, "Attach the receipt", "finance"]);
        const rows = await expectSent(requestId, "finance_sent_back", await roleMails("finance"), "/finance-requests");
        never(rows, PETER_MAIL);
    });

    await step("notifications: the executive sending a request back to the director reaches the director", async () => {
        await call(HIMAWAN, "finance_submit", [requestId]);
        await call(DIRECTOR, "finance_review", [requestId]);
        await clear();
        await call(PETER, "finance_send_back", [requestId, "Check the vendor", "director"]);
        const rows = await expectSent(requestId, "finance_sent_back_director", await roleMails("director"), "/finance-requests");
        never(rows, PETER_MAIL, HIMAWAN_MAIL);
        if (!rows[0].body_text.includes("Check the vendor")) throw new Error(rows[0].body_text);
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
        if (!rows[0].body_text.includes("Dates: 2 November 2026 to 3 November 2026")) throw new Error(rows[0].body_text);
        if (!rows[0].body_html.includes("Wedding &lt;3")) throw new Error("reason not escaped");
        await clear();
        await call(U.MANAGER, "approve_leave_request", [r.id, "Enjoy"], ["uuid", "text"]);
        const done = await expectSent(r.id, "leave_approved", [MAIL.STAFF], "/leaves");
        eq(done[0].subject, "Your leave request has been approved", "subject");
        if (!done[0].body_text.includes("Note from the approver: Enjoy")) throw new Error(done[0].body_text);
        eq(await count(), 1, "only the requester");
        await clear();
        await call(U.STAFF, "cancel_leave_request", [r.id], ["uuid"]);
        eq(await count(), 0, "cancelling enqueues nothing");
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
        const rows = await expectSent(r.id, "leave_submitted", await roleMails("executive"), "/leaves");
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
        const rows = await expectSent(id, "kpi_submitted", await roleMails("executive"), `/kpi?employee=${E.LONER}`);
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
        const rows = await expectSent(draft.id, "salary_submitted", await roleMails("executive"), "/salary");
        never(rows, MAIL.MARK, MAIL.OLDEXEC, DIRECTOR_MAIL, MAIL.STAFF);
        eq(rows[0].subject, "Salary review for Staff Notify is waiting for your approval", "subject");
        await clear();
        await call(PETER, "salary_decline_review", [draft.id, "Not this year"], ["uuid", "text"]);
        eq(await count(), 0, "a decline enqueues nothing");
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
