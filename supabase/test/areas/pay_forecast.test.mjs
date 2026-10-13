// The pay forecast workbook: who may read and write it, what a save checks.
// The arithmetic is checked against the workbook itself by
// scripts/check-pay-forecast.mjs; here the document is a stand-in.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, PETER, HIMAWAN, RINA } = people;

    const call = async (uid, fn, args = [], casts = []) => {
        const ph = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ""}`).join(", ");
        return (await tx(uid, `select public.${fn}(${ph}) j`, args)).rows[0].j;
    };
    const refused = async (p, code, re) => {
        try {
            await p;
        } catch (e) {
            if (code && e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
            if (re && !re.test(e.message)) throw new Error(`wrong message: ${e.message}`);
            return;
        }
        throw new Error("expected a refusal");
    };
    const doc = (title = "Test forecast") => ({
        version: 1,
        title,
        months: Array.from({ length: 18 }, (_, i) => `M${i + 1}`),
        revenue: { pl: [], pt: [] },
        salary: { groups: [] },
        gm: { notes: [] },
        bva: { actuals: {} },
    });
    const save = (uid, d, seen = null) =>
        call(uid, "pay_forecast_save", [JSON.stringify(d), seen], ["jsonb", "timestamptz"]);

    await db.exec(`delete from public.pay_forecast`);

    await step("pay forecast: management, directors and the executive only", async () => {
        await refused(call(RINA, "pay_forecast_get"), "PT404", /^Not found$/);
        await refused(call(HIMAWAN, "pay_forecast_get"), "PT404");
        await refused(save(RINA, doc()), "PT404");
        const empty = await call(DIRECTOR, "pay_forecast_get");
        if (empty.inputs !== null) throw new Error("not empty before a save");
        await call(PETER, "pay_forecast_get");
    });

    await step("pay forecast: a save stores the document and logs it", async () => {
        const r = await save(DIRECTOR, doc("First"));
        if (r.inputs.title !== "First" || !r.updated_at) throw new Error(JSON.stringify(r));
        const back = await call(PETER, "pay_forecast_get");
        if (back.inputs.title !== "First") throw new Error("not read back");
        const log = await db.query(`select count(*)::int n from public.activity_logs where action = 'PAY_FORECAST_SAVED'`);
        if (log.rows[0].n < 1) throw new Error("not logged");
    });

    await step("pay forecast: a stale save is refused, a current one goes through", async () => {
        const now = await call(DIRECTOR, "pay_forecast_get");
        await save(PETER, doc("Peter's"), now.updated_at);
        await refused(save(DIRECTOR, doc("Mine"), now.updated_at), "PT409", /Somebody saved the forecast/);
        const latest = await call(DIRECTOR, "pay_forecast_get");
        const r = await save(DIRECTOR, doc("Mine"), latest.updated_at);
        if (r.inputs.title !== "Mine") throw new Error("current save refused");
    });

    await step("pay forecast: the shape is checked", async () => {
        await refused(save(DIRECTOR, { title: "x" }), "PT422", /not a forecast/);
        await refused(save(DIRECTOR, { ...doc(), months: ["only one"] }), "PT422");
    });

    await step("pay forecast: the table is closed to direct reads", async () => {
        const r = await tx(PETER, `select count(*)::int n from public.pay_forecast`).catch((e) => e);
        if (!(r instanceof Error) && r.rows[0].n !== 0) throw new Error("readable directly");
    });
};
