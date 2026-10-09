// Approved leave on the roster (20261011000100_leave_writes_roster.sql):
// approval writes the leave's code over working cells, cancelling gives them
// back, the generator gives way to it, only leave approved from now on is
// written, and the annual balance counts leave days, not calendar days.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR } = people;

    const U = {
        CREW: "1a000000-0000-0000-0000-000000000001",   // Lara, rotating crew
        OFFICE: "1a000000-0000-0000-0000-000000000002", // Ofa, office days
    };
    const E = {
        CREW: "1ae00000-0000-0000-0000-000000000001",
        OFFICE: "1ae00000-0000-0000-0000-000000000002",
    };
    const MAR = "1ab00000-0000-0000-0000-000000000001"; // March 2031, published

    const authUser = (id, email, name) => `
        ('00000000-0000-0000-0000-000000000000','${id}','authenticated','authenticated',
         '${email}','x', now(), '{"provider":"email","providers":["email"]}'::jsonb,
         '{"full_name":"${name}"}'::jsonb, now(), now(), '', '', '', '')`;

    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
        ${authUser(U.CREW, "lara.lr@dtgeotech.com", "Lara Crew")},
        ${authUser(U.OFFICE, "ofa.lr@dtgeotech.com", "Ofa Office")};

        insert into public.employees (id, employee_id, first_name, last_name, email, department,
                                      position, date_of_joining, annual_leave_opening_balance,
                                      user_id, work_pattern, is_active, gender) values
          ('${E.CREW}','LR-01','Lara','Crew','lara.lr@dtgeotech.com','Ops','Engineer','2025-01-01',10,'${U.CREW}','roster',true,'male'),
          ('${E.OFFICE}','LR-02','Ofa','Office','ofa.lr@dtgeotech.com','Ops','Engineer','2025-01-01',10,'${U.OFFICE}','office_day',true,'female');

        insert into public.work_schedules (id, name, start_date, end_date, status) values
          ('${MAR}','March 2031','2031-03-01','2031-03-31','published');

        -- Lara: 3-7 March DS, 8-9 B, 10 O. Ofa: Monday-Friday D, weekend B.
        insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
        select gen_random_uuid(), '${MAR}', '${E.CREW}', d::date,
               case when d::date <= '2031-03-07' then 'DS'
                    when d::date <= '2031-03-09' then 'B'
                    else 'O' end
          from generate_series('2031-03-03'::date, '2031-03-10'::date, interval '1 day') d;
        insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
        select gen_random_uuid(), '${MAR}', '${E.OFFICE}', d::date,
               case when extract(isodow from d) >= 6 then 'B' else 'D' end
          from generate_series('2031-03-03'::date, '2031-03-16'::date, interval '1 day') d;
    `);

    const cells = async (emp, from, to) =>
        (await db.query(`select shift_code from public.shift_assignments
                          where employee_id = $1 and date between $2 and $3 order by date`,
            [emp, from, to])).rows.map((r) => r.shift_code).join(",");
    // A pending request, straight in: the form's rules are not under test here.
    const request = async (emp, type, start, end) =>
        (await db.query(`insert into public.leave_requests
                            (id, employee_id, leave_type, start_date, end_date, days_requested, status)
                          values (gen_random_uuid(), $1, $2, $3, $4,
                                  public.leaves_count_days($1, $3::date, $4::date), 'pending')
                          returning id`, [emp, type, start, end])).rows[0].id;
    const approve = (id) => tx(DIRECTOR, `select public.approve_leave_request($1::uuid, null)`, [id]);
    const cancel = (uid, id) => tx(uid, `select public.cancel_leave_request($1::uuid)`, [id]);
    const records = async (id) =>
        (await db.query(`select count(*)::int n from public.leave_roster_cells where leave_request_id = $1`,
            [id])).rows[0].n;
    const annualTaken = async (emp, through) =>
        (await db.query(`select taken from public.leaves_annual_position($1, $2::date)`,
            [emp, through])).rows[0].taken;

    await step("leave on roster: the count of days is unchanged by the shared rule", async () => {
        // Lara 3-10 March: five DS count; B, B and O do not. Ofa: weekdays only.
        const r = await db.query(`select public.leaves_count_days($1, '2031-03-03', '2031-03-10') crew,
                                         public.leaves_count_days($2, '2031-03-06', '2031-03-11') office`,
            [E.CREW, E.OFFICE]);
        if (r.rows[0].crew !== 5 || r.rows[0].office !== 4) throw new Error(JSON.stringify(r.rows[0]));
    });

    await step("leave on roster: each type has its code", async () => {
        const r = await db.query(`select string_agg(public.leaves_roster_code(t), ',' order by o) c
                                    from unnest(array['annual','sick','study','paternity','marriage','maternity',
                                                      'menstrual','bereavement_household']) with ordinality x(t, o)`);
        if (r.rows[0].c !== "AL,SL,ST,SP,SP,SP,SP,SP") throw new Error(r.rows[0].c);
    });

    let sick;
    await step("leave on roster: approving sick leave turns DS into SL and leaves B and O alone", async () => {
        const before = (await db.query(`select public.payroll_roster_shift_days($1, 2031, 3) n`, [E.CREW])).rows[0].n;
        if (before !== 5) throw new Error(`shift days before ${before}`);

        sick = await request(E.CREW, "sick", "2031-03-05", "2031-03-12");
        await approve(sick);
        // 5-7 DS -> SL; 8-9 B and 10 O stay; 11-12 have no cell and get none.
        const got = await cells(E.CREW, "2031-03-03", "2031-03-12");
        if (got !== "DS,DS,SL,SL,SL,B,B,O") throw new Error(got);
        const on = (await db.query(`select on_roster from public.leave_requests where id = $1`, [sick])).rows[0];
        if (!on.on_roster) throw new Error("not marked on_roster");
        if (await records(sick) !== 3) throw new Error(`records ${await records(sick)}`);

        const after = (await db.query(`select public.payroll_roster_shift_days($1, 2031, 3) n`, [E.CREW])).rows[0].n;
        if (after !== 2) throw new Error(`shift days after ${after}`);
    });

    await step("leave on roster: the dashboard has her away, not on day shift", async () => {
        // overview_at() is not granted to clients, and only management sees
        // who is on duty: run it as the owner with the director's identity.
        await db.exec("begin");
        let o;
        try {
            await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [DIRECTOR]);
            o = (await db.query(`select public.overview_at('2031-03-05'::date) j`)).rows[0].j;
            await db.exec("commit");
        } catch (e) {
            await db.exec("rollback");
            throw e;
        }
        if (o.on_duty.dayshift.includes("Lara")) throw new Error(`dayshift ${JSON.stringify(o.on_duty.dayshift)}`);
        if (!o.on_duty.on_leave.includes("Lara")) throw new Error(`on_leave ${JSON.stringify(o.on_duty.on_leave)}`);
    });

    await step("leave on roster: cancelling gives the shifts back, but not over an edit", async () => {
        // The director moves 6 March to NS after approval; it must stay NS.
        await db.query(`update public.shift_assignments set shift_code = 'NS'
                         where employee_id = $1 and date = '2031-03-06'`, [E.CREW]);
        await cancel(U.CREW, sick);
        const got = await cells(E.CREW, "2031-03-03", "2031-03-10");
        if (got !== "DS,DS,DS,NS,DS,B,B,O") throw new Error(got);
        if (await records(sick) !== 0) throw new Error("records left behind");
    });

    await step("leave on roster: a family type is SP; an office worker's weekend stays B", async () => {
        const id = await request(E.OFFICE, "maternity", "2031-03-07", "2031-03-10");
        await approve(id);
        // Friday 7 and Monday 10 become SP; Saturday and Sunday stay B.
        const got = await cells(E.OFFICE, "2031-03-07", "2031-03-10");
        if (got !== "SP,B,B,SP") throw new Error(got);
        await cancel(U.OFFICE, id);
        if (await cells(E.OFFICE, "2031-03-07", "2031-03-10") !== "D,B,B,D") throw new Error("not restored");
    });

    await step("leave on roster: a month generated later picks the leave up, and keeps it when regenerated", async () => {
        const id = await request(E.CREW, "annual", "2031-04-02", "2031-04-03");
        await approve(id);
        if (await records(id) !== 0) throw new Error("April has no roster yet; nothing to write");

        const gen = () => tx(DIRECTOR, `select public.schedules_apply_roster_pattern(
            array[$1::uuid], '[{"shift_code":"DS","days":4},{"shift_code":"B","days":4}]'::jsonb,
            '2031-04-01', '2031-04-08', 0, true, false, false, false)`, [E.CREW]);
        await gen();
        let got = await cells(E.CREW, "2031-04-01", "2031-04-08");
        if (got !== "DS,AL,AL,DS,B,B,B,B") throw new Error(`generated ${got}`);
        await gen();
        got = await cells(E.CREW, "2031-04-01", "2031-04-08");
        if (got !== "DS,AL,AL,DS,B,B,B,B") throw new Error(`regenerated ${got}`);

        await cancel(U.CREW, id);
        got = await cells(E.CREW, "2031-04-01", "2031-04-08");
        if (got !== "DS,DS,DS,DS,B,B,B,B") throw new Error(`after cancel ${got}`);
    });

    await step("leave on roster: leave approved before go-live is never written", async () => {
        // As the migration left every older request: approved, on_roster false.
        const id = (await db.query(`insert into public.leave_requests
                (id, employee_id, leave_type, start_date, end_date, days_requested, status, on_roster)
              values (gen_random_uuid(), $1, 'sick', '2031-05-06', '2031-05-07', 2, 'approved', false)
              returning id`, [E.CREW])).rows[0].id;
        await tx(DIRECTOR, `select public.schedules_apply_roster_pattern(
            array[$1::uuid], '[{"shift_code":"DS","days":4},{"shift_code":"B","days":4}]'::jsonb,
            '2031-05-05', '2031-05-08', 0, true, false, false, false)`, [E.CREW]);
        const got = await cells(E.CREW, "2031-05-05", "2031-05-08");
        if (got !== "DS,DS,DS,DS") throw new Error(got);
        if (await records(id) !== 0) throw new Error("records written");
    });

    await step("annual balance: a Friday-to-Monday request takes two days, not four", async () => {
        // Ofa, no roster in June 2031: Friday 6 to Monday 9.
        const before = await annualTaken(E.OFFICE, "2031-12-31");
        const id = await request(E.OFFICE, "annual", "2031-06-06", "2031-06-09");
        await approve(id);
        const after = await annualTaken(E.OFFICE, "2031-12-31");
        if (after - before !== 2) throw new Error(`took ${after - before}`);
        await cancel(U.OFFICE, id);
    });

    await step("annual balance: a crew request over DS and B days takes the DS days, once", async () => {
        // Lara 3-10 March: DS x5, B x2, O. An older request (on_roster false)
        // so the cells stay DS -- the balance counts the leave days alone.
        const before = await annualTaken(E.CREW, "2031-12-31");
        const id = (await db.query(`insert into public.leave_requests
                (id, employee_id, leave_type, start_date, end_date, days_requested, status, on_roster)
              values (gen_random_uuid(), $1, 'annual', '2031-03-03', '2031-03-10', 5, 'approved', false)
              returning id`, [E.CREW])).rows[0].id;
        let after = await annualTaken(E.CREW, "2031-12-31");
        if (after - before !== 5) throw new Error(`took ${after - before}`);

        // An AL cell on a day inside the request is still one day.
        await db.query(`update public.shift_assignments set shift_code = 'AL'
                         where employee_id = $1 and date = '2031-03-04'`, [E.CREW]);
        after = await annualTaken(E.CREW, "2031-12-31");
        if (after - before !== 5) throw new Error(`with an AL cell, took ${after - before}`);
        await db.query(`delete from public.leave_requests where id = $1`, [id]);
    });
};
