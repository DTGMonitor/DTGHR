// What each code means, held in shift_codes (20261012000100_shift_code_rules.sql):
// working, leave, away, field day, in rotation, off; the leave type mapping in
// leave_type_codes; labels from the table.
import { readFileSync } from "node:fs";

export default async ({ db, step, tx, people }) => {
    const { DIRECTOR } = people;

    const U = { KAI: "2c000000-0000-0000-0000-000000000001" };
    const E = { KAI: "2ce00000-0000-0000-0000-000000000001" };
    const MAR = "2cb00000-0000-0000-0000-000000000001"; // March 2032, published

    await db.exec(`
        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) values
        ('00000000-0000-0000-0000-000000000000','${U.KAI}','authenticated','authenticated',
         'kai.scr@dtgeotech.com','x', now(), '{"provider":"email","providers":["email"]}'::jsonb,
         '{"full_name":"Kai Rules"}'::jsonb, now(), now(), '', '', '', '');

        insert into public.employees (id, employee_id, first_name, last_name, email, department,
                                      position, date_of_joining, annual_leave_opening_balance,
                                      user_id, work_pattern, is_active, gender) values
          ('${E.KAI}','SCR-01','Kai','Rules','kai.scr@dtgeotech.com','Ops','Engineer','2025-01-01',10,
           '${U.KAI}','roster',true,'female');

        insert into public.work_schedules (id, name, start_date, end_date, status) values
          ('${MAR}','March 2032','2032-03-01','2032-03-31','published');

        -- 1-10 DS, 11-12 TW, 15 T on a national holiday, 16 ST.
        insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
        select gen_random_uuid(), '${MAR}', '${E.KAI}', d::date,
               case when d::date <= '2032-03-10' then 'DS' else 'TW' end
          from generate_series('2032-03-01'::date, '2032-03-12'::date, interval '1 day') d;
        insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code) values
          (gen_random_uuid(), '${MAR}', '${E.KAI}', '2032-03-15', 'T'),
          (gen_random_uuid(), '${MAR}', '${E.KAI}', '2032-03-16', 'ST');
        insert into public.public_holidays (id, date, name, is_national)
        values (gen_random_uuid(), '2032-03-15', 'Rules Holiday', true);
    `);

    const overview = async (day) => {
        // Run as the owner with the director's identity: only management sees
        // who is on duty, and overview_at() is not granted to clients.
        await db.exec("begin");
        try {
            await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [DIRECTOR]);
            const r = await db.query(`select public.overview_at($1::date) j`, [day]);
            await db.exec("commit");
            return r.rows[0].j;
        } catch (e) {
            await db.exec("rollback");
            throw e;
        }
    };

    await step("shift code rules: the fourteen codes' meanings", async () => {
        const r = await db.query(`
            select string_agg(code, ',' order by sort_order) filter (where is_working) w,
                   string_agg(code, ',' order by sort_order) filter (where is_leave) l,
                   string_agg(code, ',' order by sort_order) filter (where is_away) a,
                   string_agg(code, ',' order by sort_order) filter (where is_field_day) f,
                   string_agg(code, ',' order by sort_order) filter (where in_rotation) r,
                   string_agg(code, ',' order by sort_order) filter (where is_off) o
              from public.shift_codes`);
        const got = r.rows[0];
        const want = { w: "DS,NS,C,D,TW,T", l: "AL,SL,DL,SP", a: "AL,SL,DL,SP,ST",
                       f: "DS,NS", r: "DS,NS,C,D,B", o: "B,O" };
        for (const k of Object.keys(want)) {
            if (got[k] !== want[k]) throw new Error(`${k}: ${got[k]}, expected ${want[k]}`);
        }
    });

    await step("shift code rules: worked days include travel work and training", async () => {
        const d = (await tx(DIRECTOR, `select public.get_schedule_detail($1::uuid) j`, [MAR])).rows[0].j;
        const w = d.working_days.find((x) => x.employee_id === E.KAI);
        // DS x10 + TW x2 + T x1; ST is not worked.
        if (w.working_days !== 13) throw new Error(`total days ${w.working_days}`);
        // Training on the national holiday earns the loading.
        if (w.public_holiday_loading !== 1) throw new Error(`PH loading ${w.public_holiday_loading}`);
    });

    await step("shift code rules: field days are DS and NS only", async () => {
        const r = await db.query(`select public.payroll_roster_shift_days($1, 2032, 3) n`, [E.KAI]);
        if (r.rows[0].n !== 10) throw new Error(`shift days ${r.rows[0].n}`);
    });

    await step("shift code rules: study leave is away but not charged", async () => {
        const o = await overview("2032-03-16");
        if (!o.on_duty.on_leave.includes("Kai")) throw new Error(`away ${JSON.stringify(o.on_duty.on_leave)}`);
        // 15 T is a working day and charged; 16 ST is a permitted absence.
        const r = await db.query(`select public.leaves_count_days($1, '2032-03-15', '2032-03-16') n`, [E.KAI]);
        if (r.rows[0].n !== 1) throw new Error(`charged ${r.rows[0].n}`);
    });

    await step("shift code rules: the week strip labels from the table; NS is Night shift", async () => {
        const r = await db.query(`select public.overview_shift_label('SP') sp, public.overview_shift_label('NS') ns`);
        if (r.rows[0].sp !== "Special leave") throw new Error(`SP ${r.rows[0].sp}`);
        if (r.rows[0].ns !== "Night shift") throw new Error(`NS ${r.rows[0].ns}`);
    });

    await step("shift code rules: a new code means nothing until marked", async () => {
        await db.exec(`insert into public.shift_codes (code, label, bg, fg, sort_order)
                       values ('ZZ', 'Test', '#000000', '#FFFFFF', 99)`);
        await db.query(`insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
                        values (gen_random_uuid(), $1, $2, '2032-03-22', 'ZZ')`, [MAR, E.KAI]);
        try {
            const r = await db.query(`
                select public.leaves_count_days($1, '2032-03-22', '2032-03-22') charged,
                       public.payroll_roster_shift_days($1, 2032, 3) field`, [E.KAI]);
            if (r.rows[0].charged !== 0) throw new Error(`charged ${r.rows[0].charged}`);
            if (r.rows[0].field !== 10) throw new Error(`field ${r.rows[0].field}`);
            const d = (await tx(DIRECTOR, `select public.get_schedule_detail($1::uuid) j`, [MAR])).rows[0].j;
            const w = d.working_days.find((x) => x.employee_id === E.KAI);
            if (w.working_days !== 13) throw new Error(`total days ${w.working_days}`);
            const o = await overview("2032-03-22");
            if (o.on_duty.on_leave.includes("Kai")) throw new Error("shown as away");
        } finally {
            await db.query(`delete from public.shift_assignments where shift_code = 'ZZ'`);
            await db.exec(`delete from public.shift_codes where code = 'ZZ'`);
        }
    });

    await step("shift code rules: a leave type mapped to a new away code writes that code", async () => {
        await db.exec(`insert into public.shift_codes (code, label, bg, fg, sort_order, is_leave, is_away)
                       values ('MT', 'Maternity', '#C2185B', '#FFFFFF', 98, true, true);
                       update public.leave_type_codes set shift_code = 'MT' where leave_type = 'maternity';`);
        try {
            const id = (await db.query(`insert into public.leave_requests
                    (id, employee_id, leave_type, start_date, end_date, days_requested, status)
                  values (gen_random_uuid(), $1, 'maternity', '2032-03-02', '2032-03-03', 2, 'pending')
                  returning id`, [E.KAI])).rows[0].id;
            await tx(DIRECTOR, `select public.approve_leave_request($1::uuid, null)`, [id]);
            const c = await db.query(`select string_agg(shift_code, ',' order by date) s
                                        from public.shift_assignments
                                       where employee_id = $1 and date between '2032-03-02' and '2032-03-03'`, [E.KAI]);
            if (c.rows[0].s !== "MT,MT") throw new Error(c.rows[0].s);
            await tx(U.KAI, `select public.cancel_leave_request($1::uuid)`, [id]);
        } finally {
            await db.exec(`update public.leave_type_codes set shift_code = 'SP' where leave_type = 'maternity';
                           delete from public.shift_codes where code = 'MT';`);
        }
    });

    await step("shift code rules: the migration refuses a leave mapped to a working code", async () => {
        const sql = readFileSync(new URL("../../migrations/20261012000100_shift_code_rules.sql", import.meta.url), "utf8");
        await db.exec(`update public.leave_type_codes set shift_code = 'DS' where leave_type = 'marriage'`);
        try {
            let refused = false;
            try {
                await db.exec(sql);
            } catch (e) {
                if (!/not away codes: marriage -> DS/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
                refused = true;
                await db.exec("rollback");
            }
            if (!refused) throw new Error("expected the migration to refuse");
        } finally {
            await db.exec(`update public.leave_type_codes set shift_code = 'SP' where leave_type = 'marriage'`);
        }
    });
};
