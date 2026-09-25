// The port core: capability columns, helpers, and the session shape.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, RINA } = people;

    await step("the session carries the capability flags the screens read", async () => {
        const r = await tx(DIRECTOR, `select public.bootstrap_session() j`);
        const j = r.rows[0].j;
        for (const k of ["is_management", "can_write_articles", "can_manage_people",
                         "can_manage_contracts", "is_it_support", "is_founder", "is_platform_admin"]) {
            if (!(k in j)) throw new Error(`missing ${k}`);
        }
        if (j.role !== "director") throw new Error(`role ${j.role}`);
        if (j.is_platform_admin !== true) throw new Error("director is the platform admin");
    });

    await step("managing people is the flag alone, not being an administrator", async () => {
        const before = await tx(DIRECTOR, `select public.can_manage_people() v`);
        if (before.rows[0].v !== false) throw new Error("granted without the flag");
        await db.exec(`update public.employees set can_manage_people = true
                        where user_id = '${RINA}'`);
        const rina = await tx(RINA, `select public.can_manage_people() v, public.is_platform_admin() a`);
        if (rina.rows[0].v !== true) throw new Error("flag not read");
        if (rina.rows[0].a !== false) throw new Error("the flag is not platform admin");
        await db.exec(`update public.employees set can_manage_people = false
                        where user_id = '${RINA}'`);
    });
};
