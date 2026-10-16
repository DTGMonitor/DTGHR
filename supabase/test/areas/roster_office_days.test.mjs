// The roster: an administrator hides a row; office days fill an empty row.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, RINA } = people;
    const E = {
        NEW: "8f000000-0000-0000-0000-000000000001",     // office day, joins mid-month
        BACKUP: "8f000000-0000-0000-0000-000000000002",  // office day, back-up engineer
        CREW: "8f000000-0000-0000-0000-000000000003",    // rotating crew
        DRAWN: "8f000000-0000-0000-0000-000000000004",   // office day, row already drawn
        HIDDEN: "8f000000-0000-0000-0000-000000000005",  // office day, off the roster
    };
    const SCHED = "8fb00000-0000-0000-0000-000000000001"; // March 2087

    await db.exec(`
        insert into public.employees (id, employee_id, first_name, last_name, email, department, position,
                                      date_of_joining, annual_leave_opening_balance, work_pattern, is_backup_engineer, on_roster) values
          ('${E.NEW}','OD-001','New','Starter','od-new@dtgeotech.com','Ops','Staff','2087-03-08',0,'office_day',false,true),
          ('${E.BACKUP}','OD-002','Back','Up','od-backup@dtgeotech.com','Ops','Staff','2080-01-01',0,'office_day',true,true),
          ('${E.CREW}','OD-003','Crew','Member','od-crew@dtgeotech.com','Ops','Engineer','2080-01-01',0,'roster',false,true),
          ('${E.DRAWN}','OD-004','Already','Drawn','od-drawn@dtgeotech.com','Ops','Staff','2080-01-01',0,'office_day',false,true),
          ('${E.HIDDEN}','OD-005','Hidden','Person','od-hidden@dtgeotech.com','Ops','Cleaner','2080-01-01',0,'office_day',false,false);
        insert into public.work_schedules (id, name, start_date, end_date, status)
        values ('${SCHED}','March 2087','2087-03-01','2087-03-31','draft');
        insert into public.public_holidays (id, date, name, is_national)
        values (gen_random_uuid(), '2087-03-12', 'Test Holiday', true)
        on conflict do nothing;
        insert into public.shift_assignments (id, schedule_id, employee_id, date, shift_code)
        values (gen_random_uuid(), '${SCHED}', '${E.DRAWN}', '2087-03-02', 'AL');
    `);

    const call = async (uid, fn, args = [], casts = []) => {
        const ph = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ""}`).join(", ");
        return (await tx(uid, `select public.${fn}(${ph}) j`, args)).rows[0].j;
    };
    const refused = async (p, code) => {
        try {
            await p;
        } catch (e) {
            if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
            return;
        }
        throw new Error("expected a refusal");
    };
    const cells = async (emp) =>
        Object.fromEntries((await db.query(
            `select to_char(date, 'DD') d, shift_code from public.shift_assignments
              where employee_id = $1 and schedule_id = $2`, [emp, SCHED])).rows.map((r) => [r.d, r.shift_code]));

    await step("office days: an empty office-day row fills from the joining date", async () => {
        await refused(call(RINA, "schedules_fill_office_days_now", [null, SCHED], ["uuid", "uuid"]), "PT403");
        const r = await call(DIRECTOR, "schedules_fill_office_days_now", [null, SCHED], ["uuid", "uuid"]);
        if (!(r.filled > 0)) throw new Error(JSON.stringify(r));
        const c = await cells(E.NEW);
        // Joins Sat 8 March: nothing before; the weekend B; Wed 12 a national
        // holiday; the other weekdays D, to Mon 31.
        if (c["07"] !== undefined) throw new Error("filled before joining");
        if (c["08"] !== "B" || c["09"] !== "B") throw new Error(`weekend ${c["08"]} ${c["09"]}`);
        if (c["12"] !== "PH") throw new Error(`holiday ${c["12"]}`);
        if (c["10"] !== "D" || c["13"] !== "D" || c["31"] !== "D") throw new Error(`weekday ${c["10"]} ${c["13"]} ${c["31"]}`);
        if (Object.keys(c).length !== 24) throw new Error(`days ${Object.keys(c).length}`);
    });

    await step("office days: the back-up engineer, the crew, a drawn row and a hidden row are left alone", async () => {
        if (Object.keys(await cells(E.BACKUP)).length !== 0) throw new Error("back-up engineer filled");
        if (Object.keys(await cells(E.CREW)).length !== 0) throw new Error("crew filled");
        const d = await cells(E.DRAWN);
        if (Object.keys(d).length !== 1 || d["02"] !== "AL") throw new Error("drawn row changed");
        if (Object.keys(await cells(E.HIDDEN)).length !== 0) throw new Error("hidden row filled");
        // Running it again writes nothing.
        const again = await call(DIRECTOR, "schedules_fill_office_days_now", [null, SCHED], ["uuid", "uuid"]);
        if (again.filled !== 0) throw new Error(`refilled ${again.filled}`);
    });

    await step("roster: an administrator hides and shows a row", async () => {
        const names = async () => (await call(DIRECTOR, "schedules_list_employees")).map((e) => e.id);
        if ((await names()).includes(E.HIDDEN)) throw new Error("hidden row listed");
        const hidden = (await call(DIRECTOR, "schedules_list_hidden")).map((e) => e.id);
        if (!hidden.includes(E.HIDDEN)) throw new Error("not in the hidden list");
        await refused(call(RINA, "schedules_set_on_roster", [E.HIDDEN, true], ["uuid", "boolean"]), "PT403");
        await call(DIRECTOR, "schedules_set_on_roster", [E.HIDDEN, true], ["uuid", "boolean"]);
        if (!(await names()).includes(E.HIDDEN)) throw new Error("shown row missing");
        const filled = await call(DIRECTOR, "schedules_fill_office_days_now", [E.HIDDEN, null], ["uuid", "uuid"]);
        if (!(filled.filled > 0)) throw new Error("shown row not filled");
        await call(DIRECTOR, "schedules_set_on_roster", [E.HIDDEN, false], ["uuid", "boolean"]);
        if ((await names()).includes(E.HIDDEN)) throw new Error("re-hidden row listed");
        if ((await call(RINA, "schedules_list_hidden")).length !== 0) throw new Error("staff see the hidden list");
    });

    await db.exec(`delete from public.shift_assignments where schedule_id = '${SCHED}';
                   delete from public.work_schedules where id = '${SCHED}';
                   delete from public.employees where id in ('${Object.values(E).join("','")}');`);
};
