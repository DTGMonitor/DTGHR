// Role assignment: the director sets employee, finance or director on an
// active, linked account; executive stays outside the app; every change to a
// role or a sign-in switch is logged, however it was made.
// openspec/changes/role-assignment.
export default async ({ db, step, tx, people }) => {
    const { PETER } = people;

    // Our own cast, under our own ids.
    const RAY = "b0000300-0000-0000-0000-000000000001";  // the director
    const FIA = "b0000300-0000-0000-0000-000000000002";  // finance
    const FEN = "b0000300-0000-0000-0000-000000000003";  // finance, the second
    const EMMA = "b0000300-0000-0000-0000-000000000004"; // an employee
    const PAD = "b0000300-0000-0000-0000-000000000005";  // employee with the people-admin flag
    const OLD = "b0000300-0000-0000-0000-000000000006";  // login on, staff record deactivated
    const LONE = "b0000300-0000-0000-0000-000000000007"; // a login with no staff record
    const OFF = "b0000300-0000-0000-0000-000000000008";  // login switched off, staff record active
    const CAST = [RAY, FIA, FEN, EMMA, PAD, OLD, LONE, OFF];

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
          ${authRow(RAY, "ray.roles@dtgeotech.com", "Ray Director")},
          ${authRow(FIA, "fia.roles@dtgeotech.com", "Fia Finance")},
          ${authRow(FEN, "fen.roles@dtgeotech.com", "Fen Finance")},
          ${authRow(EMMA, "emma.roles@dtgeotech.com", "Emma Staff")},
          ${authRow(PAD, "pad.roles@dtgeotech.com", "Pad People")},
          ${authRow(OLD, "old.roles@dtgeotech.com", "Olga Old")},
          ${authRow(LONE, "lone.roles@dtgeotech.com", "Lone Login")},
          ${authRow(OFF, "off.roles@dtgeotech.com", "Otto Off")};

        update public.users set role = 'director' where id = '${RAY}';
        update public.users set role = 'finance'  where id in ('${FIA}', '${FEN}');

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, user_id, can_manage_people, is_active)
        values
          ('e0000300-0000-0000-0000-000000000001','ROL-01','Ray','Director','ray.roles@dtgeotech.com','Management','Director','2020-01-01','${RAY}', false, true),
          ('e0000300-0000-0000-0000-000000000002','ROL-02','Fia','Finance','fia.roles@dtgeotech.com','Finance','Accountant','2021-01-01','${FIA}', false, true),
          ('e0000300-0000-0000-0000-000000000003','ROL-03','Fen','Finance','fen.roles@dtgeotech.com','Finance','Accountant','2021-01-01','${FEN}', false, true),
          ('e0000300-0000-0000-0000-000000000004','ROL-04','Emma','Staff','emma.roles@dtgeotech.com','Ops','Engineer','2022-01-01','${EMMA}', false, true),
          ('e0000300-0000-0000-0000-000000000005','ROL-05','Pad','People','pad.roles@dtgeotech.com','HR','HR Officer','2022-01-01','${PAD}', true, true),
          ('e0000300-0000-0000-0000-000000000006','ROL-06','Olga','Old','old.roles@dtgeotech.com','Ops','Engineer','2019-01-01','${OLD}', false, false),
          ('e0000300-0000-0000-0000-000000000008','ROL-08','Otto','Off','off.roles@dtgeotech.com','Ops','Engineer','2022-01-01','${OFF}', false, true);

        -- An older row: the record is inactive but the login was never switched
        -- off. And a login switched off on its own.
        update public.users set is_active = true  where id = '${OLD}';
        update public.users set is_active = false where id = '${OFF}';
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
    const setRole = (uid, target, role) =>
        tx(uid, `select public.roles_set_user_role($1::uuid, $2::public.user_role) j`, [target, role])
            .then((r) => r.rows[0].j);
    const roleOf = (id) =>
        db.query(`select role::text, is_superuser from public.users where id = $1`, [id]).then((r) => r.rows[0]);
    const logs = (target, action = "ROLE_CHANGED") =>
        db.query(`select actor_id, description from public.activity_logs
                   where target_user_id = $1 and action = $2 order by description`, [target, action])
            .then((r) => r.rows);
    const notes = (target) =>
        db.query(`select user_id, payload, needs_action from public.notifications
                   where kind = 'role_changed' and source_id = $1`, [target]).then((r) => r.rows);
    const list = (uid) => tx(uid, `select public.roles_list() j`).then((r) => r.rows[0].j);

    // --- the director assigns ----------------------------------------------

    await step("roles: the director makes an employee finance", async () => {
        const j = await setRole(RAY, EMMA, "finance");
        if (j.role !== "finance" || j.is_superuser !== false || j.user_id !== EMMA) throw new Error(JSON.stringify(j));
        const r = await roleOf(EMMA);
        if (r.role !== "finance" || r.is_superuser) throw new Error(JSON.stringify(r));
    });

    await step("roles: the change is logged with the director as actor", async () => {
        const l = await logs(EMMA);
        if (l.length !== 1) throw new Error(`${l.length} entries`);
        if (l[0].actor_id !== RAY) throw new Error(`actor ${l[0].actor_id}`);
        if (l[0].description !== "Emma Staff: Employee → Finance") throw new Error(l[0].description);
    });

    await step("roles: the executive and the person are notified, the director is not", async () => {
        const n = await notes(EMMA);
        const peter = n.filter((x) => x.user_id === PETER);
        const emma = n.filter((x) => x.user_id === EMMA);
        if (peter.length !== 1) throw new Error(`Peter got ${peter.length}`);
        if (emma.length !== 1) throw new Error(`Emma got ${emma.length}`);
        if (n.some((x) => x.user_id === RAY)) throw new Error("the director was notified");
        if (n.some((x) => x.needs_action)) throw new Error("needs action");

        const execs = (await db.query(`select public.notifications_role_users('executive') a`)).rows[0].a;
        for (const x of n) if (x.user_id !== EMMA && !execs.includes(x.user_id))
            throw new Error(`${x.user_id} is not an executive`);

        const p = peter[0].payload;
        if (p.tone !== "reminder" || p.headline !== "Emma Staff is now Finance" || p.link.path !== "/activity")
            throw new Error(JSON.stringify(p));
        const d = Object.fromEntries(p.details);
        if (d.Person !== "Emma Staff" || d.From !== "Employee" || d.To !== "Finance" || d["Changed by"] !== "Ray Director")
            throw new Error(JSON.stringify(p.details));

        const e = emma[0].payload;
        if (e.tone !== "success" || e.headline !== "You now have the Finance role" || e.link.path !== "/")
            throw new Error(JSON.stringify(e));
        if (!/refresh the page or sign in/.test(e.intro ?? "")) throw new Error(`intro ${e.intro}`);
    });

    await step("roles: losing finance is a reminder, not a success", async () => {
        await setRole(RAY, EMMA, "employee");
        const e = (await notes(EMMA)).filter((x) => x.user_id === EMMA && x.payload.headline === "You now have the Employee role");
        if (e.length !== 1 || e[0].payload.tone !== "reminder") throw new Error(JSON.stringify(e));
    });

    await step("roles: the director makes someone director, and is_superuser follows", async () => {
        await setRole(RAY, EMMA, "director");
        const r = await roleOf(EMMA);
        if (r.role !== "director" || !r.is_superuser) throw new Error(JSON.stringify(r));
        await setRole(RAY, EMMA, "employee");
        const back = await roleOf(EMMA);
        if (back.role !== "employee" || back.is_superuser) throw new Error(JSON.stringify(back));
    });

    await step("roles: setting the role it already has writes nothing", async () => {
        const before = [(await logs(FIA)).length, (await notes(FIA)).length];
        const j = await setRole(RAY, FIA, "finance");
        if (j.role !== "finance") throw new Error(JSON.stringify(j));
        const after = [(await logs(FIA)).length, (await notes(FIA)).length];
        if (before.join() !== after.join()) throw new Error(`${before} → ${after}`);
    });

    // --- refusals -----------------------------------------------------------

    await step("roles: nobody but the director may assign", async () => {
        for (const uid of [PETER, FIA, EMMA, PAD]) {
            await raises(() => setRole(uid, FEN, "employee"), "PT403", /Only the director/);
        }
        if ((await roleOf(FEN)).role !== "finance") throw new Error("role changed");
    });

    await step("roles: nobody changes their own role", async () => {
        await raises(() => setRole(RAY, RAY, "employee"), "PT403", /^You cannot change your own role\.$/);
        if ((await roleOf(RAY)).role !== "director") throw new Error("role changed");
    });

    await step("roles: executive is neither granted nor removed", async () => {
        await raises(() => setRole(RAY, EMMA, "executive"), "PT403", /outside the app/);
        await raises(() => setRole(RAY, PETER, "director"), "PT403", /outside the app/);
        if ((await roleOf(EMMA)).role !== "employee") throw new Error("Emma changed");
        if ((await roleOf(PETER)).role !== "executive") throw new Error("Peter changed");
    });

    await step("roles: the target must be an active login with an active staff record", async () => {
        await raises(() => setRole(RAY, OFF, "finance"), "PT422", /deactivated/);
        await raises(() => setRole(RAY, LONE, "finance"), "PT422", /not linked to a staff record/);
        await raises(() => setRole(RAY, OLD, "finance"), "PT422", /staff record is deactivated/);
        await raises(() => setRole(RAY, "b0000300-0000-0000-0000-0000000000ff", "finance"), "PT404");
        for (const id of [OFF, LONE, OLD]) if ((await roleOf(id)).role !== "employee") throw new Error(`${id} changed`);
    });

    // --- the audit trigger ----------------------------------------------------

    await step("roles: a change outside the app is logged with no actor, and notifies nobody", async () => {
        await db.exec(`update public.users set role = 'executive' where id = '${LONE}'`);
        await db.exec(`update public.users set role = 'employee'  where id = '${LONE}'`);
        const l = await logs(LONE);
        const ds = l.map((x) => x.description);
        if (l.length !== 2 || l.some((x) => x.actor_id !== null)) throw new Error(JSON.stringify(l));
        if (!ds.includes("Lone Login: Employee → Executive (outside the app)")) throw new Error(ds.join(" | "));
        if (!ds.includes("Lone Login: Executive → Employee (outside the app)")) throw new Error(ds.join(" | "));
        if ((await notes(LONE)).length !== 0) throw new Error("notified");
    });

    await step("roles: switching a login off and on is logged", async () => {
        await db.exec(`update public.users set is_active = false where id = '${LONE}'`);
        await db.exec(`update public.users set is_active = true  where id = '${LONE}'`);
        const off = await logs(LONE, "ACCOUNT_DEACTIVATED");
        const on = await logs(LONE, "ACCOUNT_REACTIVATED");
        if (off.length !== 1 || off[0].description !== "Lone Login: sign-in switched off (outside the app)")
            throw new Error(JSON.stringify(off));
        if (on.length !== 1) throw new Error(JSON.stringify(on));
    });

    await step("roles: deactivating a staff record logs the login being switched off", async () => {
        await tx(RAY, `select public.people_deactivate_employee('e0000300-0000-0000-0000-000000000005'::uuid)`);
        const off = await logs(PAD, "ACCOUNT_DEACTIVATED");
        if (off.length !== 1 || off[0].actor_id !== RAY) throw new Error(JSON.stringify(off));
        if (off[0].description !== "Pad People: sign-in switched off") throw new Error(off[0].description);
    });

    await step("roles: an unrelated update to users logs nothing", async () => {
        const before = (await db.query(`select count(*)::int n from public.activity_logs where target_user_id = $1`, [FEN])).rows[0].n;
        await db.exec(`update public.users set full_name = 'Fen F.' where id = '${FEN}'`);
        await db.exec(`update public.users set full_name = 'Fen Finance' where id = '${FEN}'`);
        const after = (await db.query(`select count(*)::int n from public.activity_logs where target_user_id = $1`, [FEN])).rows[0].n;
        if (before !== after) throw new Error(`${before} → ${after}`);
    });

    // --- the matrix's read --------------------------------------------------

    await step("roles: the director reads every active, linked role and the finance count", async () => {
        const j = await list(RAY);
        const byUser = Object.fromEntries(j.items.map((i) => [i.user_id, i]));
        if (byUser[FIA]?.role !== "finance" || byUser[FIA]?.employee_id !== "e0000300-0000-0000-0000-000000000002")
            throw new Error(JSON.stringify(byUser[FIA]));
        if (byUser[PETER]?.role !== "executive") throw new Error("Peter missing");
        for (const id of [LONE, OFF, OLD, PAD]) if (byUser[id]) throw new Error(`${id} listed`);
        const n = (await db.query(`select count(*)::int n from public.users u
                                    where u.role = 'finance' and u.is_active
                                      and not public.employee_deactivated(u.id)`)).rows[0].n;
        if (j.finance_count !== n || n < 2) throw new Error(`finance_count ${j.finance_count}, expected ${n}`);
    });

    await step("roles: nobody else reads the role list", async () => {
        for (const uid of [PETER, FIA, EMMA]) await raises(() => list(uid), "PT403");
    });

    await step("roles: clients cannot reach the internal helpers", async () => {
        await raises(() => tx(EMMA, `select public.roles_label('finance'::public.user_role)`), "42501");
        await raises(() => tx(EMMA, `select public.roles_person_name('${EMMA}'::uuid)`), "42501");
    });

    // --- leave nothing behind -----------------------------------------------
    // Later suites count finance holders, directors and their notifications.
    const ids = CAST.map((id) => `'${id}'`).join(",");
    await db.exec(`
        update public.employees set is_active = false where user_id in (${ids});
        update public.users set role = 'employee', is_active = false where id in (${ids});
    `);
};
