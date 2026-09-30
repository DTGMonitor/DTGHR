// Career history: employee_career, its backfill from employee_role_changes,
// the automatic entry on a profile change, and the people_career_* functions.
// See supabase/migrations/20260930000100_career_history.sql.
export default async ({ db, step, tx }) => {
    const HERA = "ca000000-0000-0000-0000-000000000001"; // holds the people-admin flag
    const MAX = "ca000000-0000-0000-0000-000000000002";  // management, no flag
    const PAT = "ca000000-0000-0000-0000-000000000003";  // an engineer
    const NESS = "ca000000-0000-0000-0000-000000000004"; // another engineer

    const E_HERA = "ce000000-0000-0000-0000-000000000001";
    const E_MAX = "ce000000-0000-0000-0000-000000000002";
    const E_PAT = "ce000000-0000-0000-0000-000000000003";
    const E_NESS = "ce000000-0000-0000-0000-000000000004";
    const E_OTTO = "ce000000-0000-0000-0000-000000000005"; // no account
    const E_SOLO = "ce000000-0000-0000-0000-000000000006"; // no account

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
          ${authRow(HERA, "hera.career@dtgeotech.com", "Hera People")},
          ${authRow(MAX, "max.career@dtgeotech.com", "Max Manager")},
          ${authRow(PAT, "pat.career@dtgeotech.com", "Pat Engineer")},
          ${authRow(NESS, "ness.career@dtgeotech.com", "Ness Support")};

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      job_level, date_of_joining, user_id, can_manage_people, is_management_role, is_active)
        values
          ('${E_HERA}','CAR-01','Hera','People','hera.career@dtgeotech.com','HR','HR Officer', null,'2021-01-01','${HERA}', true, false, true),
          ('${E_MAX}', 'CAR-02','Max','Manager','max.career@dtgeotech.com','Ops','Ops Manager', null,'2021-02-01','${MAX}', false, true, true),
          ('${E_PAT}', 'CAR-03','Pat','Engineer','pat.career@dtgeotech.com','Ops','Engineer','L1','2023-01-01','${PAT}', false, false, true),
          ('${E_NESS}','CAR-04','Ness','Support','ness.career@dtgeotech.com','Business Support','Business & Technical Support','Engineer','2024-01-15','${NESS}', false, false, true),
          ('${E_OTTO}','CAR-05','Otto','Owner','otto.career@dtgeotech.com','Management','Director', null,'2020-01-01', null, false, true, true),
          ('${E_SOLO}','CAR-06','Solo','Single','solo.career@dtgeotech.com','Ops','Technician', null,'2025-05-05', null, false, false, true);
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
    const list = (uid, id) =>
        tx(uid, `select public.people_career_list($1::uuid) j`, [id]).then((r) => r.rows[0].j);
    const add = (uid, id, p) =>
        tx(uid, `select public.people_career_add($1::uuid, $2::jsonb) j`, [id, JSON.stringify(p)]).then((r) => r.rows[0].j);
    const edit = (uid, entry, p) =>
        tx(uid, `select public.people_career_update($1::uuid, $2::jsonb) j`, [entry, JSON.stringify(p)]).then((r) => r.rows[0].j);
    const del = (uid, entry) => tx(uid, `select public.people_career_delete($1::uuid)`, [entry]);
    const update = (uid, id, patch) =>
        tx(uid, `select public.people_update_employee($1::uuid, $2::jsonb) j`, [id, JSON.stringify(patch)]);
    const profile = (id) =>
        db.query(`select position, job_level, department from public.employees where id=$1`, [id]).then((r) => r.rows[0]);
    const entries = (id) =>
        db.query(`select to_char(effective_date,'YYYY-MM-DD') d, position, job_level, department, note
                    from public.employee_career where employee_id=$1 order by effective_date`, [id]).then((r) => r.rows);
    const today = (await db.query(`select to_char(public.local_today(),'YYYY-MM-DD') d`)).rows[0].d;
    const inDays = async (n) =>
        (await db.query(`select to_char(public.local_today() + $1::int,'YYYY-MM-DD') d`, [n])).rows[0].d;

    // --- backfill ----------------------------------------------------------

    await step("career: every employee has an entry at joining, from the profile", async () => {
        const r = await db.query(`select count(*)::int n from public.employees e
                                   where not exists (select 1 from public.employee_career c where c.employee_id = e.id)`);
        if (r.rows[0].n !== 0) throw new Error(`${r.rows[0].n} employees without history`);
        const rina = await entries("aaaaaaaa-0000-0000-0000-000000000001");
        if (rina.length !== 1 || rina[0].d !== "2024-03-02" || rina[0].position !== "Geologist" || rina[0].department !== "Ops")
            throw new Error(JSON.stringify(rina));
    });

    const rebuild = async (id) => {
        await db.query(`delete from public.employee_career where employee_id=$1`, [id]);
        await db.query(`select public.people_career_backfill($1::uuid)`, [id]);
        return entries(id);
    };

    await step("career: backfill folds 'not set' fill-ins and collapses a day's changes into its final state", async () => {
        // Ness: level filled in (not set -> Engineer), then on one day moved to
        // Business Support, back, and to Business Support again.
        await db.exec(`
            insert into public.employee_role_changes (employee_id, effective_date, created_at,
                previous_position, new_position, previous_job_level, new_job_level,
                previous_department, new_department, note) values
              ('${E_NESS}','2025-04-02','2025-04-02 01:00', null, null, null, 'Engineer', null, null, null),
              ('${E_NESS}','2026-08-01','2026-08-01 01:00', 'Geotechnical Monitoring Engineer','Business & Technical Support', null, null, 'Monitoring','Business Support', null),
              ('${E_NESS}','2026-08-01','2026-08-01 02:00', 'Business & Technical Support','Geotechnical Monitoring Engineer', null, null, 'Business Support','Monitoring', null),
              ('${E_NESS}','2026-08-01','2026-08-01 03:00', 'Geotechnical Monitoring Engineer','Business & Technical Support', null, null, 'Monitoring','Business Support', 'Moved to Business Support');
        `);
        const e = await rebuild(E_NESS);
        if (e.length !== 2) throw new Error(JSON.stringify(e));
        const [a, b] = e;
        if (a.d !== "2024-01-15" || a.position !== "Geotechnical Monitoring Engineer" || a.job_level !== "Engineer"
            || a.department !== "Monitoring") throw new Error(JSON.stringify(a));
        if (b.d !== "2026-08-01" || b.position !== "Business & Technical Support" || b.job_level !== "Engineer"
            || b.department !== "Business Support" || b.note !== "Moved to Business Support") throw new Error(JSON.stringify(b));
    });

    await step("career: backfill walks a promotion ladder and drops a day that ends where it began", async () => {
        await db.exec(`
            insert into public.employee_role_changes (employee_id, effective_date, created_at,
                previous_position, new_position) values
              ('${E_OTTO}','2022-01-01','2022-01-01 01:00','Engineer','Senior Engineer'),
              ('${E_OTTO}','2024-06-01','2024-06-01 01:00','Senior Engineer','Director'),
              ('${E_OTTO}','2025-05-01','2025-05-01 01:00','Director','Typo'),
              ('${E_OTTO}','2025-05-01','2025-05-01 02:00','Typo','Director');
        `);
        const e = await rebuild(E_OTTO);
        const got = e.map((x) => `${x.d} ${x.position}`).join(" | ");
        if (got !== "2020-01-01 Engineer | 2022-01-01 Senior Engineer | 2024-06-01 Director") throw new Error(got);
    });

    // --- automatic entries -------------------------------------------------

    await step("career: a profile change of position adds an entry dated today; a second one updates it", async () => {
        await update(HERA, E_PAT, { position: "Senior Engineer", phone: "0811" });
        let e = await entries(E_PAT);
        if (e.length !== 2 || e[1].d !== today || e[1].position !== "Senior Engineer" || e[1].job_level !== "L1")
            throw new Error(JSON.stringify(e));
        await update(HERA, E_PAT, { job_level: "L2" });
        e = await entries(E_PAT);
        if (e.length !== 2 || e[1].position !== "Senior Engineer" || e[1].job_level !== "L2")
            throw new Error(JSON.stringify(e));
        // Not a change of job.
        await update(HERA, E_PAT, { phone: "0812" });
        if ((await entries(E_PAT)).length !== 2) throw new Error("phone change wrote an entry");
    });

    // --- reading -----------------------------------------------------------

    await step("career: the employee reads their own; management reads; other staff are refused", async () => {
        const own = await list(PAT, E_PAT);
        if (own.length !== 2 || own[0].effective_date !== today || !own[0].is_current || own[0].end_date !== null)
            throw new Error(JSON.stringify(own));
        if (own[1].end_date === null || own[1].is_current) throw new Error(JSON.stringify(own[1]));
        for (const k of ["id", "employee_id", "effective_date", "end_date", "position", "job_level", "department", "note"])
            if (!(k in own[0])) throw new Error(`missing ${k}`);
        if ((await list(MAX, E_PAT)).length !== 2) throw new Error("management cannot read");
        await raises(() => list(NESS, E_PAT), "PT403");
        await raises(() => list(HERA, "ce000000-0000-0000-0000-0000000000ff"), "PT404");
    });

    // --- editing -----------------------------------------------------------

    await step("career: only the people admin edits", async () => {
        const [cur] = await list(PAT, E_PAT);
        for (const uid of [PAT, MAX]) {
            await raises(() => add(uid, E_PAT, { effective_date: "2024-01-01", position: "X" }), "PT403", /not set up/);
            await raises(() => edit(uid, cur.id, { note: "x" }), "PT403", /not set up/);
            await raises(() => del(uid, cur.id), "PT403", /not set up/);
        }
    });

    await step("career: validation -- date, position, not in the future, one entry per date", async () => {
        await raises(() => add(HERA, E_PAT, { position: "X" }), "PT422", /Start date is required/);
        await raises(() => add(HERA, E_PAT, { effective_date: "2024-01-01", position: " " }), "PT422", /Position is required/);
        const tomorrow = await inDays(1);
        await raises(() => add(HERA, E_PAT, { effective_date: tomorrow, position: "X" }), "PT422",
            /^The start date can't be in the future\.$/);
        const [latest] = await list(HERA, E_PAT);
        await raises(() => edit(HERA, latest.id, { effective_date: tomorrow }), "PT422", /in the future/);
        await raises(() => add(HERA, E_PAT, { effective_date: "2023-01-01", position: "X" }), "PT409",
            /^There is already an entry on that date\.$/);
        const [cur] = await list(HERA, E_PAT);
        await raises(() => edit(HERA, cur.id, { effective_date: "2023-01-01" }), "PT409", /already an entry/);
    });

    await step("career: the only entry cannot be deleted", async () => {
        const [only] = await list(HERA, E_SOLO);
        await raises(() => del(HERA, only.id), "PT409", /only entry/);
        await raises(() => del(HERA, "ce000000-0000-0000-0000-0000000000ff"), "PT404");
    });

    await step("career: adding an older entry leaves the profile; a newer one sets it", async () => {
        const older = await add(HERA, E_PAT, { effective_date: "2024-06-01", position: "Engineer II",
            job_level: "L1", department: "Ops", note: "Promoted" });
        const yesterday = await inDays(-1);
        if (older.note !== "Promoted" || older.end_date !== yesterday) throw new Error(JSON.stringify(older));
        let p = await profile(E_PAT);
        if (p.position !== "Senior Engineer" || p.job_level !== "L2") throw new Error(JSON.stringify(p));

        // Solo has only the joining entry (2025-05-05): a later one becomes current.
        const newer = await add(HERA, E_SOLO, { effective_date: "2026-01-05", position: "Senior Technician",
            job_level: "T2", department: "Monitoring", note: "Promoted" });
        if (!newer.is_current) throw new Error(JSON.stringify(newer));
        p = await profile(E_SOLO);
        if (p.position !== "Senior Technician" || p.job_level !== "T2" || p.department !== "Monitoring")
            throw new Error(JSON.stringify(p));
        // The sync is not itself a profile change: no entry for today.
        let e = await entries(E_SOLO);
        if (e.length !== 2 || e.some((x) => x.d === today)) throw new Error(JSON.stringify(e));

        const edited = await edit(HERA, newer.id, { position: "Lead Technician" });
        if (edited.position !== "Lead Technician" || edited.job_level !== "T2") throw new Error(JSON.stringify(edited));
        p = await profile(E_SOLO);
        if (p.position !== "Lead Technician") throw new Error(JSON.stringify(p));

        // Moving it before the joining entry makes the joining entry current again.
        await edit(HERA, newer.id, { effective_date: "2025-01-01" });
        p = await profile(E_SOLO);
        if (p.position !== "Technician" || p.job_level !== null || p.department !== "Ops") throw new Error(JSON.stringify(p));
        await edit(HERA, newer.id, { effective_date: "2026-01-05" });

        await del(HERA, newer.id);
        p = await profile(E_SOLO);
        if (p.position !== "Technician" || p.department !== "Ops") throw new Error(JSON.stringify(p));
        e = await entries(E_SOLO);
        if (e.length !== 1) throw new Error("entry not deleted");

        // Editing today's entry on Pat changes Pat's profile.
        const [cur] = await list(HERA, E_PAT);
        await edit(HERA, cur.id, { position: "Principal Engineer" });
        p = await profile(E_PAT);
        if (p.position !== "Principal Engineer") throw new Error(JSON.stringify(p));
        await del(HERA, older.id);
    });

    await step("career: changes are logged", async () => {
        const r = await db.query(`select action from public.activity_logs where target_id = any($1::uuid[]) and action like 'CAREER_%'`, [[E_PAT, E_SOLO]]);
        const actions = new Set(r.rows.map((x) => x.action));
        for (const a of ["CAREER_ENTRY_ADDED", "CAREER_ENTRY_UPDATED", "CAREER_ENTRY_DELETED"])
            if (!actions.has(a)) throw new Error(`no ${a}`);
    });
};
