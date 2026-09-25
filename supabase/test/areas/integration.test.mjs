// Integration: rules that span areas once they are merged.
export default async ({ db, step, tx }) => {
    const U = {
        LEAD: "71000000-0000-0000-0000-000000000001",
        STAFF: "71000000-0000-0000-0000-000000000002",
        OTHER: "71000000-0000-0000-0000-000000000003",
    };
    const E = {
        LEAD: "72000000-0000-0000-0000-000000000001",
        STAFF: "72000000-0000-0000-0000-000000000002",
        OTHER: "72000000-0000-0000-0000-000000000003",
    };
    const authRow = (id, email, name) => `('00000000-0000-0000-0000-000000000000','${id}',
        'authenticated','authenticated','${email}','x', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"full_name":"${name}"}'::jsonb, now(), now(), '', '', '', '')`;

    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
          ${authRow(U.LEAD, "in-lead@dtgeotech.com", "In Lead")},
          ${authRow(U.STAFF, "in-staff@dtgeotech.com", "In Staff")},
          ${authRow(U.OTHER, "in-other@dtgeotech.com", "In Other")};

        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, user_id, manager_id,
                                      is_management_role, kpi_review_required) values
          ('${E.LEAD}','IN-001','In','Lead','in-lead@dtgeotech.com','Ops','Lead','2024-01-01',0,'${U.LEAD}',null,false,true),
          ('${E.STAFF}','IN-002','In','Staff','in-staff@dtgeotech.com','Ops','Technician','2024-01-01',0,'${U.STAFF}','${E.LEAD}',false,true),
          ('${E.OTHER}','IN-003','In','Other','in-other@dtgeotech.com','Ops','Technician','2024-01-01',0,'${U.OTHER}',null,false,true);

        insert into public.leave_requests
            (id, employee_id, leave_type, start_date, end_date, days_requested, status)
        values ('73000000-0000-0000-0000-000000000001','${E.STAFF}','annual',
                '2031-03-10','2031-03-11', 2, 'pending');
    `);

    const visible = async (uid) =>
        Number((await tx(uid,
            `select count(*)::int n from public.leave_requests where id = '73000000-0000-0000-0000-000000000001'`,
        )).rows[0].n);

    await step("integration: a manager outside management still sees their team's leave", async () => {
        if ((await visible(U.LEAD)) !== 1) throw new Error("manager cannot see the report's request");
    });

    await step("integration: a colleague who is not the manager does not", async () => {
        if ((await visible(U.OTHER)) !== 0) throw new Error("unrelated colleague sees the request");
    });

    await step("integration: payroll_r2 rounds exactly as Python's round(x, 2)", async () => {
        // Expected values printed by Python 3 for the same floats.
        const cases = [[2.675, 2.67], [0.125, 0.12], [0.375, 0.38], [1.005, 1.0],
                       [-2.675, -2.67], [12345678.905, 12345678.9], [3.14159, 3.14], [0, 0]];
        for (const [x, want] of cases) {
            const got = (await db.query(`select public.payroll_r2($1::float8) v`, [x])).rows[0].v;
            if (got !== want) throw new Error(`payroll_r2(${x}) = ${got}, expected ${want}`);
        }
    });

    await step("integration: local_today() is the Jakarta date", async () => {
        const r = (await db.query(
            `select public.local_today() = (now() at time zone 'Asia/Jakarta')::date ok`)).rows[0];
        if (!r.ok) throw new Error("local_today is not the Jakarta date");
    });
};
