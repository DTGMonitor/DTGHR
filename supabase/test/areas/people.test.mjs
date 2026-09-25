// People: the directory, the employee record, role history, profile change
// requests and photos. Ported from employees.py / profile_requests.py and
// tests/test_platform_admin.py, tests/test_employee_id.py,
// tests/test_auth_routes.py on the FastAPI line.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER } = people;

    // Our own cast, under our own ids.
    const DORA = "b0000200-0000-0000-0000-000000000001"; // a second director: the platform admin as an employee
    const PIA = "b0000200-0000-0000-0000-000000000002";  // holds the people-admin flag, role employee
    const MONA = "b0000200-0000-0000-0000-000000000003"; // management, no flag
    const EKO = "b0000200-0000-0000-0000-000000000004";  // an engineer

    const E_DORA = "e0000200-0000-0000-0000-000000000001";
    const E_PIA = "e0000200-0000-0000-0000-000000000002";
    const E_MONA = "e0000200-0000-0000-0000-000000000003";
    const E_EKO = "e0000200-0000-0000-0000-000000000004";
    const E_GONE = "e0000200-0000-0000-0000-000000000005"; // a leaver, no account

    const authRow = (id, email, name) => `
        ('00000000-0000-0000-0000-000000000000','${id}','authenticated','authenticated',
         '${email}','x', now(), '{"provider":"email","providers":["email"]}'::jsonb,
         '{"full_name":"${name}"}'::jsonb, now(), now(), '', '', '', '')`;

    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
          ${authRow(DORA, "dora.people@dtgeotech.com", "Dora Director")},
          ${authRow(PIA, "pia.people@dtgeotech.com", "Pia People")},
          ${authRow(MONA, "mona.people@dtgeotech.com", "Mona Manager")},
          ${authRow(EKO, "eko.people@dtgeotech.com", "Eko Engineer")};

        update public.users set role = 'director' where id = '${DORA}';

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, user_id, can_manage_people, is_management_role, is_active,
                                      phone, bank_name)
        values
          ('${E_DORA}','PPL-01','Dora','Director','dora.people@dtgeotech.com','Management','Director','2020-01-01','${DORA}', false, true, true, null, null),
          ('${E_PIA}', 'PPL-02','Pia','People','pia.people@dtgeotech.com','HR','HR Officer','2021-01-01','${PIA}', true, false, true, null, null),
          ('${E_MONA}','PPL-03','Mona','Manager','mona.people@dtgeotech.com','Ops','Ops Manager','2021-02-01','${MONA}', false, true, true, null, null),
          ('${E_EKO}', 'PPL-04','Eko','Engineer','eko.people@dtgeotech.com','Ops','Engineer','2022-03-01','${EKO}', false, false, true, '0811', 'BCA'),
          ('${E_GONE}','PPL-05','Gina','Gone','gina.people@dtgeotech.com','Ops','Engineer','2022-03-01', null, false, false, false, null, null);
    `);

    const raises = async (fn, code, re) => {
        try {
            await fn();
        } catch (e) {
            if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
            if (re && !re.test(e.message)) throw new Error(`wrong error: ${e.message}`);
            return;
        }
        throw new Error("expected a raise");
    };
    const list = (uid, args = "1, 100, null, null, false") =>
        tx(uid, `select public.people_list_employees(${args}) j`).then((r) => r.rows[0].j);
    const get = (uid, id) => tx(uid, `select public.people_get_employee($1::uuid) j`, [id]).then((r) => r.rows[0].j);
    const update = (uid, id, patch) =>
        tx(uid, `select public.people_update_employee($1::uuid, $2::jsonb) j`, [id, JSON.stringify(patch)])
            .then((r) => r.rows[0].j);

    // --- directory -------------------------------------------------------

    await step("people: the directory is refused to staff outside management", async () => {
        await raises(() => list(EKO), "PT403", /available to management\. Your own record is on your profile\./);
    });

    await step("people: management, the people admin and the executive read the directory", async () => {
        for (const uid of [MONA, PIA, PETER, DIRECTOR]) {
            const j = await list(uid);
            if (!j.items.some((e) => e.id === E_EKO)) throw new Error(`${uid} cannot see Eko`);
            for (const k of ["total", "page", "page_size"]) if (typeof j[k] !== "number") throw new Error(`${k} missing`);
        }
    });

    await step("people: leavers are hidden unless an administrator asks for them", async () => {
        const plain = await list(DIRECTOR);
        if (plain.items.some((e) => e.id === E_GONE)) throw new Error("leaver listed");
        const all = await list(DIRECTOR, "1, 100, null, null, true");
        if (!all.items.some((e) => e.id === E_GONE)) throw new Error("admin cannot reach the leaver");
        const mona = await list(MONA, "1, 100, null, null, true");
        if (mona.items.some((e) => e.id === E_GONE)) throw new Error("include_inactive honoured for a non-admin");
    });

    await step("people: search, department filter and paging", async () => {
        const s = await list(MONA, "1, 20, 'ppl-0', 'ops', false");
        if (s.total !== 2) throw new Error(`total ${s.total}`); // Mona and Eko; Gina is inactive
        if (s.items[0].employee_id !== "PPL-03") throw new Error(`order ${s.items.map((e) => e.employee_id)}`);
        const p2 = await list(MONA, "2, 1, 'ppl-0', 'ops', false");
        if (p2.items.length !== 1 || p2.items[0].employee_id !== "PPL-04") throw new Error("page 2 wrong");
        await raises(() => list(MONA, "1, 101, null, null, false"), "PT422");
    });

    await step("people: staff read their own record and nobody else's", async () => {
        const me = await get(EKO, E_EKO);
        if (me.id !== E_EKO || me.has_photo !== false || me.work_pattern !== "office_day")
            throw new Error(JSON.stringify(me));
        for (const k of ["bank_name", "national_id", "kpi_template_title", "is_it_support", "on_leave_today"])
            if (!(k in me)) throw new Error(`detail missing ${k}`);
        await raises(() => get(EKO, E_MONA), "PT403", /available to management/);
        await raises(() => get(MONA, "e0000200-0000-0000-0000-0000000000ff"), "PT404", /Employee not found/);
    });

    await step("people: RLS keeps the table itself to your own row outside the directory", async () => {
        const eko = await tx(EKO, `select count(*)::int n from public.employees`);
        if (eko.rows[0].n !== 1) throw new Error(`Eko reads ${eko.rows[0].n} rows`);
        const view = await tx(EKO, `select count(*)::int n from public.employees_view`);
        if (view.rows[0].n !== 1) throw new Error(`Eko reads ${view.rows[0].n} view rows`);
        const mona = await tx(MONA, `select count(*)::int n from public.employees`);
        if (mona.rows[0].n < 5) throw new Error(`Mona reads ${mona.rows[0].n} rows`);
    });

    // --- creating --------------------------------------------------------

    await step("people: numbers run DTG-YY-NNN, skip gaps and hand-edited ids", async () => {
        await db.exec(`
            insert into public.employees (id, employee_id, first_name, last_name, email, department, position, date_of_joining)
            values ('e0000200-0000-0000-0000-000000000031','DTG-31-001','A','A','a31.people@dtgeotech.com','Ops','X','2031-01-05'),
                   ('e0000200-0000-0000-0000-000000000033','DTG-31-003','B','B','b31.people@dtgeotech.com','Ops','X','2031-05-05'),
                   ('e0000200-0000-0000-0000-000000000034','DTG-31-INTERN','C','C','c31.people@dtgeotech.com','Ops','X','2031-02-05');`);
        const r = await tx(PIA, `select public.people_create_employee(
            '{"first_name":"Nina","last_name":"New","email":"nina.people@dtgeotech.com","department":"Ops",
              "position":"Engineer","date_of_joining":"2031-09-01","annual_leave_opening_balance":1.5}'::jsonb) j`);
        const j = r.rows[0].j;
        if (j.employee_id !== "DTG-31-004") throw new Error(`got ${j.employee_id}`);
        if (j.annual_leave_opening_balance !== 1.5 || j.is_active !== true || j.has_account !== false)
            throw new Error(JSON.stringify(j));
        const first = await db.query(`select public.people_next_employee_id('2032-02-01') n`);
        if (first.rows[0].n !== "DTG-32-001") throw new Error(`first of a year ${first.rows[0].n}`);
        const log = await db.query(`select 1 from public.activity_logs where action='EMPLOYEE_CREATED'
                                     and description like 'Added new employee Nina New (DTG-31-004)'`);
        if (!log.rows.length) throw new Error("not logged");
    });

    await step("people: a duplicate email is a conflict", async () => {
        await raises(() => tx(PIA, `select public.people_create_employee(
            '{"first_name":"N","last_name":"N","email":"nina.people@dtgeotech.com","department":"Ops",
              "position":"E","date_of_joining":"2031-09-01"}'::jsonb)`),
            "PT409", /An employee with this email already exists/);
    });

    await step("people: being an administrator does not let you add employees", async () => {
        await raises(() => tx(PETER, `select public.people_create_employee(
            '{"first_name":"N","last_name":"N","email":"n2.people@dtgeotech.com","department":"Ops",
              "position":"E","date_of_joining":"2031-09-01"}'::jsonb)`),
            "PT403", /You are not set up to add or edit employee records\./);
    });

    // --- editing and capabilities -----------------------------------------

    await step("people: the director changes permissions", async () => {
        const j = await update(DIRECTOR, E_EKO, { is_it_support: true });
        if (j.id !== E_EKO) throw new Error("no response");
        const r = await db.query(`select is_it_support from public.employees where id=$1`, [E_EKO]);
        if (r.rows[0].is_it_support !== true) throw new Error("not changed");
    });

    await step("people: an executive does not", async () => {
        await raises(() => update(PETER, E_EKO, { is_it_support: false }), "PT403",
            /Only the platform administrator can change what somebody is allowed to do\./);
    });

    await step("people: unchanged permissions do not block an edit; a changed one does", async () => {
        await update(PIA, E_EKO, { position: "Senior Engineer", is_it_support: true });
        await raises(() => update(PIA, E_EKO, { is_it_support: false }), "PT403", /Only the platform administrator/);
        await raises(() => update(PIA, E_PIA, { is_management_role: true }), "PT403", /Only the platform administrator/);
    });

    await step("people: editing data needs the people-admin flag, through either name", async () => {
        await raises(() => update(MONA, E_EKO, { phone: "1" }), "PT403", /not set up to add or edit/);
        await raises(() => tx(PETER, `select public.update_employee($1::uuid, '{"phone":"1"}'::jsonb)`, [E_EKO]),
            "PT403", /not set up to add or edit/);
    });

    await step("people: a change of position or department is written to the role history", async () => {
        await update(PIA, E_EKO, { department: "Monitoring", phone: "0812" });
        const r = await db.query(`select * from public.employee_role_changes where employee_id=$1
                                   order by created_at`, [E_EKO]);
        if (r.rows.length !== 2) throw new Error(`rows ${r.rows.length}`);
        const [a, b] = r.rows;
        if (a.previous_position !== "Engineer" || a.new_position !== "Senior Engineer" || a.new_department !== null)
            throw new Error(JSON.stringify(a));
        if (b.previous_department !== "Ops" || b.new_department !== "Monitoring" || b.new_position !== null)
            throw new Error(JSON.stringify(b));
        if (a.recorded_by !== PIA) throw new Error("recorded_by");
        // Contact details alone are not a change of job.
        await update(PIA, E_EKO, { phone: "0813" });
        const n = await db.query(`select count(*)::int n from public.employee_role_changes where employee_id=$1`, [E_EKO]);
        if (n.rows[0].n !== 2) throw new Error("phone change recorded as a role change");
    });

    await step("people: management reads the history, staff do not, the people admin corrects it", async () => {
        const h = (await tx(MONA, `select public.people_role_history($1::uuid) j`, [E_EKO])).rows[0].j;
        if (h.length !== 2) throw new Error(`history ${h.length}`);
        for (const k of ["id", "employee_id", "effective_date", "previous_position", "new_position", "note", "created_at"])
            if (!(k in h[0])) throw new Error(`missing ${k}`);
        await raises(() => tx(EKO, `select public.people_role_history($1::uuid)`, [E_EKO]), "PT403");
        const id = h[0].id;
        const j = (await tx(PIA, `select public.people_amend_role_change($1::uuid, $2::uuid, $3::jsonb) j`,
            [E_EKO, id, JSON.stringify({ effective_date: "2026-10-01", note: "Promotion" })])).rows[0].j;
        if (j.effective_date !== "2026-10-01" || j.note !== "Promotion") throw new Error(JSON.stringify(j));
        await raises(() => tx(MONA, `select public.people_amend_role_change($1::uuid, $2::uuid, '{"note":"x"}'::jsonb)`,
            [E_EKO, id]), "PT403", /not set up/);
        await raises(() => tx(PIA, `select public.people_amend_role_change($1::uuid, $2::uuid, '{"note":"x"}'::jsonb)`,
            [E_MONA, id]), "PT404", /Not found/);
    });

    // --- nobody locks out the platform admin, or themselves ---------------

    await step("people: nobody locks out the platform admin", async () => {
        await raises(() => update(PIA, E_DORA, { is_active: false }), "PT403",
            /The platform administrator cannot be deactivated here\./);
        await raises(() => tx(PETER, `select public.people_deactivate_employee($1::uuid)`, [E_DORA]), "PT403",
            /platform administrator cannot be deactivated/);
    });

    await step("people: nobody deactivates themselves", async () => {
        await raises(() => tx(DORA, `select public.people_deactivate_employee($1::uuid)`, [E_DORA]), "PT403",
            /You cannot deactivate your own account\./);
        await raises(() => update(PIA, E_PIA, { is_active: false }), "PT403", /your own account/);
    });

    await step("people: only an administrator uses DELETE", async () => {
        await raises(() => tx(PIA, `select public.people_deactivate_employee($1::uuid)`, [E_EKO]), "PT403",
            /Only an administrator can deactivate an employee\./);
    });

    // --- profile change requests -----------------------------------------

    const raise = (uid, field, value, reason = null) =>
        tx(uid, `select public.people_raise_profile_request($1, $2, $3) j`, [field, value, reason])
            .then((r) => r.rows[0].j);

    await step("people: the requestable fields are served in order", async () => {
        const f = (await tx(EKO, `select public.people_profile_request_fields() j`)).rows[0].j;
        if (f.length !== 16 || f[0].key !== "phone" || f[9].label !== "NIK (KTP)") throw new Error(JSON.stringify(f));
    });

    let phoneReq;
    await step("people: staff raise a request against their own record", async () => {
        phoneReq = await raise(EKO, "phone", "0899", "New number");
        if (phoneReq.status !== "pending" || phoneReq.current_value !== "0813" || phoneReq.field_label !== "Phone")
            throw new Error(JSON.stringify(phoneReq));
        if (phoneReq.employee_name !== "Eko Engineer") throw new Error(phoneReq.employee_name);
        await raises(() => raise(EKO, "phone", "0898"), "PT409", /A request to change Phone is already waiting\./);
        await raises(() => raise(EKO, "bank_name", "BCA"), "PT409", /That is already what the record says\./);
        await raises(() => raise(EKO, "position", "CEO"), "PT422", /That detail cannot be changed by request\./);
        await raises(() => raise(DIRECTOR, "phone", "1"), "PT404", /No employee record is linked/);
    });

    await step("people: staff see their own requests; the people admin sees all and reviews", async () => {
        const eko = (await tx(EKO, `select public.people_list_profile_requests() j`)).rows[0].j;
        if (eko.can_review !== false || eko.items.length !== 1 || eko.pending !== 1) throw new Error(JSON.stringify(eko));
        const mona = (await tx(MONA, `select public.people_list_profile_requests() j`)).rows[0].j;
        if (mona.can_review !== false || mona.items.length !== 0) throw new Error("Mona sees Eko's request");
        const pia = (await tx(PIA, `select public.people_list_profile_requests() j`)).rows[0].j;
        if (pia.can_review !== true || !pia.items.some((i) => i.id === phoneReq.id)) throw new Error(JSON.stringify(pia));
        const peter = (await tx(PETER, `select public.people_list_profile_requests() j`)).rows[0].j;
        if (peter.can_review !== true) throw new Error("an administrator reviews too");
    });

    await step("people: approving writes the value; only once", async () => {
        await raises(() => tx(EKO, `select public.people_approve_profile_request($1::uuid, null)`, [phoneReq.id]),
            "PT403", /You are not set up to review profile requests\./);
        const j = (await tx(PIA, `select public.people_approve_profile_request($1::uuid, 'ok') j`, [phoneReq.id])).rows[0].j;
        if (j.status !== "approved" || j.review_note !== "ok" || !j.reviewed_at) throw new Error(JSON.stringify(j));
        const r = await db.query(`select phone from public.employees where id=$1`, [E_EKO]);
        if (r.rows[0].phone !== "0899") throw new Error(`phone ${r.rows[0].phone}`);
        await raises(() => tx(PIA, `select public.people_approve_profile_request($1::uuid, null)`, [phoneReq.id]),
            "PT409", /That request is already decided\./);
        const log = await db.query(`select description from public.activity_logs
                                     where action='PROFILE_CHANGE_APPROVED' and target_id=$1`, [E_EKO]);
        if (log.rows[0]?.description !== "Phone for Eko Engineer: 0813 → 0899") throw new Error(log.rows[0]?.description);
    });

    await step("people: a record that moved since the request is not overwritten", async () => {
        const req = await raise(EKO, "bank_name", "Mandiri");
        await db.query(`update public.employees set bank_name='BNI' where id=$1`, [E_EKO]);
        await raises(() => tx(PIA, `select public.people_approve_profile_request($1::uuid, null)`, [req.id]),
            "PT409", /Bank has changed since this was raised — it now reads BNI\. Ask for a fresh request\./);
    });

    await step("people: declining needs a reason; cancelling is the requester's alone", async () => {
        const req = await raise(EKO, "religion", "Islam");
        await raises(() => tx(PIA, `select public.people_decline_profile_request($1::uuid, '  ')`, [req.id]),
            "PT422", /Say why, so they know what to do next\./);
        const d = (await tx(PIA, `select public.people_decline_profile_request($1::uuid, 'Need KTP') j`, [req.id])).rows[0].j;
        if (d.status !== "declined") throw new Error(d.status);
        const again = await raise(EKO, "religion", "Islam");
        await raises(() => tx(MONA, `select public.people_cancel_profile_request($1::uuid)`, [again.id]), "PT404", /Not found/);
        const c = (await tx(EKO, `select public.people_cancel_profile_request($1::uuid) j`, [again.id])).rows[0].j;
        if (c.status !== "cancelled") throw new Error(c.status);
        await raises(() => tx(EKO, `select public.people_cancel_profile_request($1::uuid)`, [again.id]), "PT409", /already decided/);
    });

    // --- photos ----------------------------------------------------------

    await step("people: photo uploads are checked for who, type and size", async () => {
        const prep = (uid, type, size) =>
            tx(uid, `select public.people_prepare_photo($1::uuid, $2, $3) p`, [E_EKO, type, size]);
        await raises(() => prep(EKO, "image/jpeg", 100), "PT403", /not set up/);
        await raises(() => prep(PIA, "image/gif", 100), "PT415",
            /Unsupported image type 'image\/gif'\. Use a JPEG, PNG or WebP\./);
        await raises(() => prep(PIA, "image/png", 0), "PT400", /Empty file/);
        await raises(() => prep(PIA, "image/png", 2 * 1024 * 1024 + 1), "PT413", /Photo is larger than 2 MB\./);
        const p = (await prep(PIA, "image/webp", 5000)).rows[0].p;
        if (p !== `${E_EKO}/photo`) throw new Error(p);
    });

    await step("people: a recorded photo shows on the record, and deletes", async () => {
        await raises(() => tx(EKO, `select public.people_photo_path($1::uuid)`, [E_EKO]), "PT404", /No photo/);
        await tx(PIA, `select public.people_record_photo($1::uuid, $2)`, [E_EKO, `${E_EKO}/photo`]);
        const me = await get(EKO, E_EKO);
        if (me.has_photo !== true) throw new Error("has_photo false");
        const path = (await tx(MONA, `select public.people_photo_path($1::uuid) p`, [E_EKO])).rows[0].p;
        if (path !== `${E_EKO}/photo`) throw new Error(path);
        await raises(() => tx(EKO, `select public.people_delete_photo($1::uuid)`, [E_EKO]), "PT403");
        const gone = (await tx(PIA, `select public.people_delete_photo($1::uuid) p`, [E_EKO])).rows[0].p;
        if (gone !== `${E_EKO}/photo`) throw new Error(`delete returned ${gone}`);
        if ((await get(EKO, E_EKO)).has_photo !== false) throw new Error("still has a photo");
    });

    // --- deactivation locks out; reactivation lets back in ---------------

    await step("people: a deactivated employee is locked out, and let back in", async () => {
        await tx(DIRECTOR, `select public.people_deactivate_employee($1::uuid)`, [E_EKO]);
        let u = await db.query(`select p.is_active, a.banned_until from public.users p join auth.users a using (id)
                                 where id=$1`, [EKO]);
        if (u.rows[0].is_active !== false || u.rows[0].banned_until === null) throw new Error("login still open");
        await raises(() => get(EKO, E_EKO), "PT401", /User not found or inactive/);
        await update(PIA, E_EKO, { is_active: true });
        u = await db.query(`select p.is_active, a.banned_until from public.users p join auth.users a using (id)
                             where id=$1`, [EKO]);
        if (u.rows[0].is_active !== true || u.rows[0].banned_until !== null) throw new Error("login not restored");
        if ((await get(EKO, E_EKO)).is_active !== true) throw new Error("record not active");
    });

    await step("people: deactivating through the form locks out too", async () => {
        await update(PIA, E_EKO, { is_active: false });
        await raises(() => get(EKO, E_EKO), "PT401");
        await update(PIA, E_EKO, { is_active: true });
    });
};
