// Contracts that renew themselves (20260930000200): billing cycle as a
// choice, next renewal worked out from the start date, the daily roll, the
// legacy backfill and the default warnings per cycle.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR } = people;

    const today = (await db.query(`select public.local_today()::text d`)).rows[0].d;
    const plus = async (n) =>
        (await db.query(`select (public.local_today() + $1::int)::text d`, [n])).rows[0].d;
    const next = async (start, cycle, on = today) =>
        (await db.query(`select public._contracts_next_renewal($1::date, $2, $3::date)::text d`,
            [start, cycle, on])).rows[0].d;
    const addMonths = async (d, n) =>
        (await db.query(`select ($1::date + make_interval(months => $2::int))::date::text d`, [d, n])).rows[0].d;

    const expectRaise = async (fn, code, pattern) => {
        try {
            await fn();
        } catch (e) {
            if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
            if (pattern && !pattern.test(e.message)) throw new Error(`wrong message: ${e.message}`);
            return;
        }
        throw new Error("expected a raise");
    };

    const create = (body) =>
        tx(DIRECTOR, `select public.contracts_create($1::jsonb) j`, [JSON.stringify(body)]).then((r) => r.rows[0].j);
    const update = (id, body) =>
        tx(DIRECTOR, `select public.contracts_update($1::uuid, $2::jsonb) j`, [id, JSON.stringify(body)]).then((r) => r.rows[0].j);
    const days = (c) => c.reminders.map((r) => r.days_before).join(",");
    const made = [];

    await step("renew: legacy billing text is classified; subscriptions renew automatically", async () => {
        const rows = [
            ["subscription", "Monthly", "monthly", true],
            ["subscription", "per QUARTER", "quarterly", true],
            ["subscription", "Yearly", "annual", true],
            ["subscription", "annual in advance", "annual", true],
            ["subscription", "one-off", "one_off", false],
            ["subscription", "paid once", "one_off", false],
            ["client", "monthly", "monthly", false],
            ["subscription", "whenever", null, false],
        ];
        const ids = [];
        for (const [kind, text] of rows) {
            const r = await db.query(
                `insert into public.contracts (kind, title, start_date, end_date, billing_period)
                 values ($1, 'Legacy ' || $2, '2026-01-15', '2099-01-01', $2) returning id`, [kind, text]);
            ids.push(r.rows[0].id);
        }
        await db.query(`select public._contracts_backfill_billing_cycles()`);
        for (let i = 0; i < rows.length; i++) {
            const got = (await db.query(`select billing_cycle, auto_renew, billing_period from public.contracts where id = $1`, [ids[i]])).rows[0];
            if (got.billing_cycle !== rows[i][2] || got.auto_renew !== rows[i][3])
                throw new Error(`${rows[i][1]}: ${got.billing_cycle}/${got.auto_renew}`);
            if (got.billing_period !== rows[i][1]) throw new Error(`billing_period rewritten: ${got.billing_period}`);
        }
        // Once only: a subscription someone turned off stays off.
        await db.query(`update public.contracts set auto_renew = false where id = $1`, [ids[0]]);
        await db.query(`select public._contracts_backfill_billing_cycles()`);
        const again = (await db.query(`select auto_renew from public.contracts where id = $1`, [ids[0]])).rows[0];
        if (again.auto_renew !== false) throw new Error("backfill re-enabled auto_renew");
        await db.query(`delete from public.contracts where id = any($1::uuid[])`, [ids]);
    });

    await step("renew: a monthly subscription needs only a start date", async () => {
        const c = await create({
            kind: "subscription", title: "Claude", start_date: "2026-01-29",
            billing_cycle: "monthly", auto_renew: true, amount: 100, currency: "USD",
            end_date: "2020-01-01", // ignored
        });
        made.push(c.id);
        if (c.billing_cycle !== "monthly" || c.auto_renew !== true) throw new Error(`${c.billing_cycle}/${c.auto_renew}`);
        if (c.billing_period !== "Monthly") throw new Error(`billing_period ${c.billing_period}`);
        if (!(c.next_renewal > today)) throw new Error(`next_renewal ${c.next_renewal} not after ${today}`);
        if (c.end_date !== c.next_renewal) throw new Error("end_date is not the next renewal");
        if (c.next_renewal !== (await next("2026-01-29", "monthly"))) throw new Error(`next_renewal ${c.next_renewal}`);
        // The first start + k months after today: one month earlier is not after today.
        const [y, m] = c.next_renewal.split("-").map(Number);
        const k = (y - 2026) * 12 + (m - 1);
        if ((await addMonths("2026-01-29", k)) !== c.next_renewal) throw new Error("not start + k months");
        if (!((await addMonths("2026-01-29", k - 1)) <= today)) throw new Error("an earlier renewal is still ahead");
        const dr = (await db.query(`select ($1::date - public.local_today()) n`, [c.next_renewal])).rows[0].n;
        if (c.days_remaining !== dr) throw new Error(`days_remaining ${c.days_remaining}`);
        if (days(c) !== "7") throw new Error(`reminders ${days(c)}`);
    });

    await step("renew: auto-renew needs a start date and a recurring cycle", async () => {
        await expectRaise(() => create({ kind: "subscription", title: "Dropbox", billing_cycle: "monthly", auto_renew: true }),
            "PT422", /^Auto-renewing contracts need a start date\.$/);
        await expectRaise(() => create({ kind: "subscription", title: "Dropbox", start_date: "2026-01-01", billing_cycle: "one_off", auto_renew: true }),
            "PT422", /monthly, quarterly or annual/);
        await expectRaise(() => create({ kind: "subscription", title: "Dropbox", start_date: "2026-01-01", billing_cycle: "weekly" }),
            "PT422", /billing_cycle/);
    });

    await step("renew: month ends clamp the way Postgres adds months", async () => {
        if ((await next("2027-01-31", "monthly", "2027-02-01")) !== "2027-02-28") throw new Error("2027 Feb");
        if ((await next("2028-01-31", "monthly", "2028-02-01")) !== "2028-02-29") throw new Error("2028 Feb");
        // Always from the start, so March is the 31st again, not the 28th.
        if ((await next("2027-01-31", "monthly", "2027-02-28")) !== "2027-03-31") throw new Error("2027 Mar");
        if ((await next("2027-01-31", "monthly", "2027-01-31")) !== "2027-02-28") throw new Error("on the start day");
        if ((await next("2027-01-31", "quarterly", "2027-02-01")) !== "2027-04-30") throw new Error("quarterly");
        if ((await next("2024-02-29", "annual", "2024-03-01")) !== "2025-02-28") throw new Error("leap annual");
        if ((await next("2020-05-10", "annual", "2027-05-10")) !== "2028-05-10") throw new Error("annual on the day");
    });

    await step("renew: annual, and a start in the future renews one cycle after it", async () => {
        const tv = await create({ kind: "subscription", title: "TeamViewer", start_date: "2025-03-10", billing_cycle: "annual", auto_renew: true });
        made.push(tv.id);
        if (tv.next_renewal !== (await next("2025-03-10", "annual"))) throw new Error(`annual ${tv.next_renewal}`);
        if (!tv.next_renewal.endsWith("-03-10") || !(tv.next_renewal > today)) throw new Error(`annual ${tv.next_renewal}`);
        if (days(tv) !== "30") throw new Error(`reminders ${days(tv)}`);

        const start = await plus(20);
        const fut = await create({ kind: "subscription", title: "Future", start_date: start, billing_cycle: "monthly", auto_renew: true });
        made.push(fut.id);
        if (fut.next_renewal !== (await addMonths(start, 1))) throw new Error(`future ${fut.next_renewal}`);
    });

    await step("renew: default warnings per cycle; clients keep 60/42/30", async () => {
        const q = await create({ kind: "subscription", title: "Quarterly", start_date: "2026-01-01", billing_cycle: "quarterly", auto_renew: true });
        made.push(q.id);
        if (days(q) !== "14") throw new Error(`quarterly ${days(q)}`);
        const cl = await create({ kind: "client", title: "Client monthly", end_date: await plus(90), billing_cycle: "monthly" });
        made.push(cl.id);
        if (days(cl) !== "60,42,30") throw new Error(`client ${days(cl)}`);
        if (cl.auto_renew !== false || cl.next_renewal !== null) throw new Error("client auto");
        const own = await create({ kind: "subscription", title: "Own", start_date: "2026-01-01", billing_cycle: "monthly", auto_renew: true, reminder_days: [3] });
        made.push(own.id);
        if (days(own) !== "3") throw new Error(`explicit ${days(own)}`);
        const legacy = await create({ kind: "subscription", title: "Legacy text", end_date: await plus(10), billing_period: "annual" });
        made.push(legacy.id);
        if (legacy.billing_cycle !== "annual" || legacy.auto_renew !== false || days(legacy) !== "30")
            throw new Error(`legacy ${legacy.billing_cycle}/${legacy.auto_renew}/${days(legacy)}`);
    });

    await step("renew: one-off and non-renewing contracts still need an end date", async () => {
        await expectRaise(() => create({ kind: "subscription", title: "Once", start_date: "2026-01-01", billing_cycle: "one_off" }),
            "PT422", /^end_date: Field required$/);
        await expectRaise(() => create({ kind: "subscription", title: "Manual", start_date: "2026-01-01", billing_cycle: "monthly", auto_renew: false }),
            "PT422", /^end_date: Field required$/);
        const o = await create({ kind: "subscription", title: "Once", end_date: await plus(5), billing_cycle: "one_off" });
        made.push(o.id);
        if (o.billing_period !== "One-off" || o.auto_renew !== false || o.next_renewal !== null) throw new Error(JSON.stringify(o));
        if (o.days_remaining !== 5) throw new Error(`days_remaining ${o.days_remaining}`);
    });

    await step("renew: the roll advances overdue auto-renewals, clears acknowledgements, leaves one-offs", async () => {
        const auto = await create({ kind: "subscription", title: "Dropbox", start_date: "2026-01-15", billing_cycle: "monthly", auto_renew: true });
        const once = await create({ kind: "subscription", title: "One-off", end_date: await plus(1), billing_cycle: "one_off" });
        made.push(auto.id, once.id);
        // Pretend the job has not run: both dates in the past, warnings acknowledged.
        await db.query(`update public.contracts set end_date = public.local_today() - 3 where id = any($1::uuid[])`, [[auto.id, once.id]]);
        await db.query(`update public.contract_reminders set acknowledged_at = now(), acknowledgement_note = 'paid'
                         where contract_id = any($1::uuid[])`, [[auto.id, once.id]]);

        // Even before the roll, the auto-renewing one shows the next date.
        const pre = (await tx(DIRECTOR, `select public.contracts_list('subscription') j`)).rows[0].j.items.find((i) => i.id === auto.id);
        if (pre.next_renewal !== (await next("2026-01-15", "monthly"))) throw new Error(`pre-roll ${pre.next_renewal}`);

        const n = (await db.query(`select public.contracts_roll_renewals() n`)).rows[0].n;
        if (n < 1) throw new Error(`rolled ${n}`);
        const a = (await db.query(`select end_date::text d from public.contracts where id = $1`, [auto.id])).rows[0].d;
        if (a !== (await next("2026-01-15", "monthly"))) throw new Error(`auto end_date ${a}`);
        const ack = (await db.query(`select count(*)::int n from public.contract_reminders
                                      where contract_id = $1 and acknowledged_at is not null`, [auto.id])).rows[0].n;
        if (ack !== 0) throw new Error("acknowledgements survived the roll");
        const o = (await db.query(`select end_date::text d from public.contracts where id = $1`, [once.id])).rows[0].d;
        if (o !== (await plus(-3))) throw new Error(`one-off moved to ${o}`);
        const oack = (await db.query(`select count(*)::int n from public.contract_reminders
                                       where contract_id = $1 and acknowledged_at is not null`, [once.id])).rows[0].n;
        if (oack !== 1) throw new Error("one-off acknowledgement cleared");

        // Nothing due again: a second run changes nothing.
        const again = (await db.query(`select public.contracts_roll_renewals() n`)).rows[0].n;
        if (again !== 0) throw new Error(`second roll moved ${again}`);
    });

    await step("renew: an inactive auto-renewing contract is not rolled", async () => {
        const c = await create({ kind: "subscription", title: "Cancelled", start_date: "2026-01-15", billing_cycle: "monthly", auto_renew: true });
        made.push(c.id);
        await db.query(`update public.contracts set end_date = public.local_today() - 3, status = 'cancelled' where id = $1`, [c.id]);
        await db.query(`select public.contracts_roll_renewals()`);
        const d = (await db.query(`select end_date::text d from public.contracts where id = $1`, [c.id])).rows[0].d;
        if (d !== (await plus(-3))) throw new Error(`moved to ${d}`);
    });

    await step("renew: editing switches renewal on and off", async () => {
        const c = await create({ kind: "subscription", title: "Switch", end_date: await plus(12), billing_cycle: "monthly" });
        made.push(c.id);
        if (c.auto_renew) throw new Error("auto by default");
        await expectRaise(() => update(c.id, { auto_renew: true }), "PT422", /^Auto-renewing contracts need a start date\.$/);
        const on = await update(c.id, { auto_renew: true, start_date: "2026-02-03" });
        if (on.next_renewal !== (await next("2026-02-03", "monthly"))) throw new Error(`on ${on.next_renewal}`);
        const yearly = await update(c.id, { billing_cycle: "annual" });
        if (yearly.billing_period !== "Annual" || yearly.next_renewal !== (await next("2026-02-03", "annual")))
            throw new Error(`annual ${yearly.billing_period} ${yearly.next_renewal}`);
        // A warning-schedule edit leaves the date alone.
        const sched = await update(c.id, { reminder_days: [10], end_date: "2020-01-01" });
        if (sched.end_date !== yearly.end_date) throw new Error("end_date changed on a schedule edit");
        const off = await update(c.id, { billing_cycle: "one_off" });
        if (off.auto_renew !== false || off.next_renewal !== null) throw new Error("one-off still renews");
    });

    await step("renew: the renewal email job rolls first", async () => {
        const c = await create({ kind: "subscription", title: "Notify", start_date: "2026-01-15", billing_cycle: "monthly", auto_renew: true });
        made.push(c.id);
        await db.query(`update public.contracts set end_date = public.local_today() - 1 where id = $1`, [c.id]);
        await db.query(`select public.contracts_send_renewal_notices()`);
        const d = (await db.query(`select end_date::text d from public.contracts where id = $1`, [c.id])).rows[0].d;
        if (!(d > today)) throw new Error(`not rolled: ${d}`);
        await db.exec(`delete from public.renewal_notices`);
    });

    await db.query(`delete from public.contracts where id = any($1::uuid[])`, [made]);
};
