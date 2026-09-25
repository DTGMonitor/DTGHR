// Staff articles: the bulletin. Port of backend/app/api/routes/articles.py.
export default async ({ db, step, tx, people }) => {
    const { DIRECTOR, RINA, PETER } = people;

    const one = async (uid, sql, params) => (await tx(uid, sql, params)).rows[0].j;
    const refused = async (fn, code, message) => {
        try {
            await fn();
        } catch (e) {
            if (code && e.code && e.code !== code) throw new Error(`code ${e.code}: ${e.message}`);
            if (message && e.message !== message) throw new Error(`message: ${e.message}`);
            return;
        }
        throw new Error("was allowed");
    };
    const create = (uid, title, extra = {}) =>
        one(uid, `select public.articles_create($1, $2, $3, $4, $5) j`,
            [title, extra.summary ?? null, extra.body ?? "", extra.category ?? null, extra.slug ?? null]);
    const patch = (uid, id, p) =>
        one(uid, `select public.articles_update($1::uuid, $2::jsonb) j`, [id, JSON.stringify(p)]);
    const get = (uid, slug) => one(uid, `select public.articles_get($1) j`, [slug]);
    const list = (uid, drafts = false, category = null) =>
        one(uid, `select public.articles_list($1, $2) j`, [drafts, category]);
    const NOT_AUTHOR = "Only the bulletin's authors can add or change articles.";

    // Rina is an employee with no flag; make sure of it.
    await db.exec(`update public.employees set can_write_articles = false
                    where user_id = '${RINA}'`);

    let draft;
    await step("the director writes without the flag; an employee without it may not", async () => {
        const flag = await tx(DIRECTOR, `select public.can_write_articles() v`);
        if (flag.rows[0].v !== false) throw new Error("director holds the flag; test proves nothing");
        draft = await create(DIRECTOR, "Untitled article");
        if (draft.status !== "draft") throw new Error(`status ${draft.status}`);
        if (draft.can_edit !== true || draft.can_publish !== true) throw new Error("director cannot edit");
        if (draft.author_name !== "HR Admin") throw new Error(`author ${draft.author_name}`);
        await refused(() => create(RINA, "Rina's piece"), "PT403", NOT_AUTHOR);
        await refused(() => create(PETER, "Peter's piece"), "PT403", NOT_AUTHOR);
    });

    await step("the list says who may write", async () => {
        if ((await list(DIRECTOR)).can_write !== true) throw new Error("director");
        if ((await list(RINA)).can_write !== false) throw new Error("rina");
    });

    await step("the can_write_articles flag makes an author", async () => {
        await db.exec(`update public.employees set can_write_articles = true where user_id = '${RINA}'`);
        try {
            const a = await create(RINA, "Flag holder's note");
            if ((await list(RINA)).can_write !== true) throw new Error("list can_write");
            await one(RINA, `select public.articles_delete($1::uuid) j`, [a.id]);
        } finally {
            await db.exec(`update public.employees set can_write_articles = false where user_id = '${RINA}'`);
        }
        await refused(() => create(RINA, "Again"), "PT403", NOT_AUTHOR);
    });

    let second, third;
    await step("slugs count up instead of colliding", async () => {
        second = await create(DIRECTOR, "Untitled article");
        third = await create(DIRECTOR, "Untitled article");
        const slugs = [draft.slug, second.slug, third.slug].join(",");
        if (slugs !== "untitled-article,untitled-article-2,untitled-article-3") throw new Error(slugs);
    });

    await step("a draft's slug follows its title", async () => {
        const r = await patch(DIRECTOR, second.id, { title: "Heat Stress & You!" });
        if (r.slug !== "heat-stress-you") throw new Error(r.slug);
        // Re-saving the same title keeps it (the article itself is excluded).
        const again = await patch(DIRECTOR, second.id, { title: "Heat Stress & You!" });
        if (again.slug !== "heat-stress-you") throw new Error(again.slug);
        const clash = await patch(DIRECTOR, third.id, { title: "Heat stress you" });
        if (clash.slug !== "heat-stress-you-2") throw new Error(clash.slug);
        third = clash;
        const body = await patch(DIRECTOR, third.id, { body: "no title here" });
        if (body.slug !== "heat-stress-you-2") throw new Error("slug moved without a title");
    });

    await step("drafts are the authors' alone", async () => {
        await refused(() => get(RINA, "heat-stress-you"), "PT404", "Article not found.");
        const r = await list(RINA, true);
        if (r.items.some((a) => a.id === second.id)) throw new Error("draft listed for Rina");
        const d = await list(DIRECTOR, true);
        if (!d.items.some((a) => a.id === second.id)) throw new Error("draft missing for author");
        const dl = await list(DIRECTOR, false);
        if (dl.items.some((a) => a.id === second.id)) throw new Error("draft listed without include_drafts");
        await refused(() => get(RINA, "no-such-article"), "PT404", "Article not found.");
    });

    let firstPublishedAt;
    await step("publishing releases it to everyone and freezes the slug", async () => {
        const p = await one(DIRECTOR, `select public.articles_publish($1::uuid) j`, [second.id]);
        if (p.status !== "published" || !p.published_at || p.is_live !== true) throw new Error(JSON.stringify(p));
        firstPublishedAt = p.published_at;
        const seen = await get(RINA, "heat-stress-you");
        if (seen.can_edit !== false || seen.can_publish !== false) throw new Error("rina may edit");
        const r = await list(RINA);
        if (!r.items.some((a) => a.id === second.id)) throw new Error("not listed for Rina");
        const renamed = await patch(DIRECTOR, second.id, { title: "Heat stress, revised" });
        if (renamed.slug !== "heat-stress-you") throw new Error(`slug moved: ${renamed.slug}`);
        await refused(() => one(RINA, `select public.articles_publish($1::uuid) j`, [third.id]), "PT403", NOT_AUTHOR);
    });

    await step("withdrawing keeps the original date; republishing does not move it", async () => {
        const u = await one(DIRECTOR, `select public.articles_unpublish($1::uuid) j`, [second.id]);
        if (u.status !== "draft" || u.publish_at !== null) throw new Error(JSON.stringify(u));
        if (u.published_at !== firstPublishedAt) throw new Error("published_at lost");
        await refused(() => get(RINA, "heat-stress-you"), "PT404", "Article not found.");
        const p = await one(DIRECTOR, `select public.articles_publish($1::uuid) j`, [second.id]);
        if (p.published_at !== firstPublishedAt) throw new Error("published_at moved");
    });

    await step("scheduling: future hidden, past live, cleared back to draft", async () => {
        const f = await one(DIRECTOR, `select public.articles_schedule($1::uuid, $2::timestamptz) j`,
            [third.id, "2099-01-06T01:00:00Z"]);
        if (f.status !== "scheduled" || f.is_live !== false) throw new Error(JSON.stringify(f));
        if (!String(f.publish_at).startsWith("2099-01-06T01:00:00")) throw new Error(`publish_at ${f.publish_at}`);
        await refused(() => get(RINA, third.slug), "PT404", "Article not found.");
        const log = await db.query(`select description from public.activity_logs
            where target_id = $1 and action = 'ARTICLE_SCHEDULED' order by created_at desc limit 1`, [third.id]);
        if (log.rows[0]?.description !== "Scheduled 'Heat stress you' for 06 Jan 2099")
            throw new Error(`log ${log.rows[0]?.description}`);

        const past = await one(DIRECTOR, `select public.articles_schedule($1::uuid, $2::timestamptz) j`,
            [third.id, "2020-01-01T00:00:00Z"]);
        if (past.status !== "scheduled" || past.is_live !== true) throw new Error(JSON.stringify(past));
        const seen = await get(RINA, third.slug);
        if (seen.id !== third.id) throw new Error("not visible");

        const cleared = await one(DIRECTOR, `select public.articles_schedule($1::uuid, null) j`, [third.id]);
        if (cleared.status !== "draft" || cleared.publish_at !== null) throw new Error(JSON.stringify(cleared));
    });

    await step("pinned lead the list; category is free text and filters", async () => {
        const safety = await create(DIRECTOR, "Ladder safety", { category: "Ladders & Heights" });
        await one(DIRECTOR, `select public.articles_publish($1::uuid) j`, [safety.id]);
        await patch(DIRECTOR, second.id, { is_pinned: true });
        const r = await list(RINA);
        if (r.items[0].id !== second.id) throw new Error("pinned not first");
        if (r.total !== r.items.length) throw new Error("total");
        const f = await list(RINA, false, "Ladders & Heights");
        if (f.total !== 1 || f.items[0].id !== safety.id) throw new Error(JSON.stringify(f));
        const s = await patch(DIRECTOR, safety.id, { category: null, summary: null });
        if (s.category !== null) throw new Error("category not cleared");
    });

    await step("read minutes: words / 200, rounded half to even, at least 1", async () => {
        const w = (n) => Array(n).fill("word").join(" ");
        const r = await db.query(`select public.articles_read_minutes('') a,
            public.articles_read_minutes($1) b, public.articles_read_minutes($2) c,
            public.articles_read_minutes($3) d`, [w(500), w(700), w(1000)]);
        const { a, b, c, d } = r.rows[0];
        if (a !== 1 || b !== 2 || c !== 4 || d !== 5) throw new Error(`${a} ${b} ${c} ${d}`);
    });

    let img1, img2, img3;
    const addImage = (uid, id, name, type = "image/png", size = 1000) =>
        one(uid, `select public.articles_add_image($1::uuid, $2, $3, $4) j`, [id, name, type, size]);
    await step("figures: the first becomes the cover; type and size are checked", async () => {
        img1 = await addImage(DIRECTOR, third.id, "fig1.png");
        if (img1.storage_path !== `${third.id}/${img1.id}`) throw new Error(img1.storage_path);
        img2 = await addImage(DIRECTOR, third.id, "fig2.jpg", "image/jpeg");
        img3 = await addImage(DIRECTOR, third.id, "fig3.webp", "image/webp");
        const d = await get(DIRECTOR, third.slug);
        if (d.cover_image_id !== img1.id) throw new Error("first is not the cover");
        if (d.images.map((i) => i.filename).join(",") !== "fig1.png,fig2.jpg,fig3.webp") throw new Error("images");
        if (Object.keys(d.images[0]).sort().join(",") !== "caption,content_type,filename,id") throw new Error("image shape");
        await refused(() => addImage(DIRECTOR, third.id, "x.pdf", "application/pdf"), "PT400",
            "Figures must be PNG, JPEG, WebP, SVG or GIF.");
        await refused(() => addImage(DIRECTOR, third.id, "big.png", "image/png", 6 * 1024 * 1024), "PT413",
            "Figure is 6144 KB; the limit is 5120 KB.");
        await refused(() => addImage(RINA, third.id, "r.png"), "PT403", NOT_AUTHOR);
        await refused(() => addImage(DIRECTOR, "00000000-0000-0000-0000-00000000dead", "r.png"), "PT404",
            "Article not found.");
    });

    await step("any signed-in user may fetch a figure's location", async () => {
        const i = await one(RINA, `select public.articles_get_image($1::uuid) j`, [img2.id]);
        if (i.storage_path !== img2.storage_path || i.content_type !== "image/jpeg") throw new Error(JSON.stringify(i));
        await refused(() => one(RINA, `select public.articles_get_image($1::uuid) j`,
            ["00000000-0000-0000-0000-00000000dead"]), "PT404", "Image not found.");
    });

    await step("figures: set as cover, remove, and the cover moves on", async () => {
        let d = await patch(DIRECTOR, third.id, { cover_image_id: img2.id });
        if (d.cover_image_id !== img2.id) throw new Error("cover not set");
        // Removing a non-cover leaves the cover alone.
        const gone = await one(DIRECTOR, `select public.articles_delete_image($1::uuid, $2::uuid) j`, [third.id, img1.id]);
        if (gone.storage_path !== img1.storage_path) throw new Error("path");
        d = await get(DIRECTOR, third.slug);
        if (d.cover_image_id !== img2.id || d.images.length !== 2) throw new Error(JSON.stringify(d));
        // Removing the cover hands it to the next remaining figure.
        await one(DIRECTOR, `select public.articles_delete_image($1::uuid, $2::uuid) j`, [third.id, img2.id]);
        d = await get(DIRECTOR, third.slug);
        if (d.cover_image_id !== img3.id) throw new Error(`cover ${d.cover_image_id}`);
        // The last one: the cover clears.
        await one(DIRECTOR, `select public.articles_delete_image($1::uuid, $2::uuid) j`, [third.id, img3.id]);
        d = await get(DIRECTOR, third.slug);
        if (d.cover_image_id !== null || d.images.length !== 0) throw new Error("cover not cleared");
        await refused(() => one(DIRECTOR, `select public.articles_delete_image($1::uuid, $2::uuid) j`,
            [third.id, img3.id]), "PT404", "Figure not found.");
        await refused(() => one(RINA, `select public.articles_delete_image($1::uuid, $2::uuid) j`,
            [third.id, img3.id]), "PT403", NOT_AUTHOR);
    });

    await step("an explicit null clears the cover", async () => {
        const i = await addImage(DIRECTOR, third.id, "again.png");
        let d = await get(DIRECTOR, third.slug);
        if (d.cover_image_id !== i.id) throw new Error("cover");
        d = await patch(DIRECTOR, third.id, { cover_image_id: null });
        if (d.cover_image_id !== null) throw new Error("not cleared");
    });

    await step("deleting an article takes its figures and reports their paths", async () => {
        await refused(() => one(RINA, `select public.articles_delete($1::uuid) j`, [third.id]), "PT403", NOT_AUTHOR);
        const r = await one(DIRECTOR, `select public.articles_delete($1::uuid) j`, [third.id]);
        if (r.storage_paths.length !== 1) throw new Error(JSON.stringify(r));
        const left = await db.query(`select count(*)::int n from public.article_images where article_id = $1`, [third.id]);
        if (left.rows[0].n !== 0) throw new Error("figures left behind");
        await refused(() => one(DIRECTOR, `select public.articles_delete($1::uuid) j`, [third.id]),
            "PT404", "Article not found.");
    });

    await step("what the backend logged is logged", async () => {
        const r = await db.query(`select action, count(*)::int n from public.activity_logs
            where action like 'ARTICLE_%' group by action`);
        const got = Object.fromEntries(r.rows.map((x) => [x.action, x.n]));
        for (const a of ["ARTICLE_CREATED", "ARTICLE_PUBLISHED", "ARTICLE_UNPUBLISHED",
                         "ARTICLE_SCHEDULED", "ARTICLE_DELETED"]) {
            if (!got[a]) throw new Error(`no ${a}`);
        }
    });

    await step("tables have row level security and no open reads", async () => {
        const r = await db.query(`select relname, relrowsecurity from pg_class
            where relname in ('articles', 'article_images') and relnamespace = 'public'::regnamespace`);
        if (r.rows.length !== 2 || r.rows.some((x) => !x.relrowsecurity)) throw new Error(JSON.stringify(r.rows));
        const rows = await tx(RINA, `select count(*)::int n from public.articles`).catch(() => ({ rows: [{ n: 0 }] }));
        if (rows.rows[0].n !== 0) throw new Error("rows readable directly");
    });

    await step("signed out is refused", async () => {
        await db.exec("begin");
        try {
            await db.exec("set local role authenticated");
            await refused(() => db.query(`select public.articles_list(false, null)`), "PT401", "Not authenticated");
        } finally {
            await db.exec("rollback");
        }
    });
};
