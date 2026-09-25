// Routes for the articles area (the staff bulletin). See supabase/PORTING.md.
//
// Port of backend/app/api/routes/articles.py. Rules live in the
// `articles_*` functions (migration 20260926001100_articles.sql); figures'
// bytes live in the private Storage bucket `article-images`.
import { route } from "@/lib/api";
import { ApiError, rpc, supabase } from "@/lib/supabase";

const BUCKET = "article-images";

interface StoredImage {
    id: string;
    filename: string;
    content_type: string;
    caption: string | null;
    storage_path: string;
}

// Registered before "/articles/:slug", which would otherwise swallow it.
route("GET", "/articles/images/:imageId", async ({ path }) => {
    const image = await rpc<{ content_type: string; storage_path: string }>("articles_get_image", {
        p_image_id: path.imageId,
    });
    const { data, error } = await supabase.storage.from(BUCKET).download(image.storage_path);
    if (error || !data) throw new ApiError("Image not found.", 404);
    // AuthImage asks for a blob; it is the only caller.
    return data.type === image.content_type ? data : new Blob([data], { type: image.content_type });
});

route("GET", "/articles", ({ query }) =>
    rpc("articles_list", {
        p_include_drafts: query.include_drafts === "true",
        p_category: query.category || null,
    }),
);

route("GET", "/articles/:slug", ({ path }) => rpc("articles_get", { p_slug: path.slug }));

route("POST", "/articles", ({ body }) => {
    const b = (body ?? {}) as {
        title?: string;
        summary?: string | null;
        body?: string;
        category?: string | null;
        slug?: string | null;
    };
    return rpc("articles_create", {
        p_title: b.title ?? null,
        p_summary: b.summary ?? null,
        p_body: b.body ?? "",
        p_category: b.category ?? null,
        p_slug: b.slug ?? null,
    });
});

// Only the keys sent change: an explicit null clears summary, category or cover.
route("PATCH", "/articles/:id", ({ path, body }) =>
    rpc("articles_update", { p_article_id: path.id, p_patch: body ?? {} }),
);

route("POST", "/articles/:id/publish", ({ path }) =>
    rpc("articles_publish", { p_article_id: path.id }),
);

route("POST", "/articles/:id/unpublish", ({ path }) =>
    rpc("articles_unpublish", { p_article_id: path.id }),
);

route("POST", "/articles/:id/schedule", ({ path, body }) =>
    rpc("articles_schedule", {
        p_article_id: path.id,
        p_publish_at: (body as { publish_at?: string | null } | undefined)?.publish_at ?? null,
    }),
);

// Record the figure first -- that is where who-may and what-type are decided,
// with the backend's messages -- then put the bytes where it says. If the
// upload fails the record is taken back out.
route("POST", "/articles/:id/images", async ({ path, body }) => {
    const file = body instanceof FormData ? body.get("file") : null;
    if (!(file instanceof File)) throw new ApiError("Field required: file", 422);

    const image = await rpc<StoredImage>("articles_add_image", {
        p_article_id: path.id,
        p_filename: file.name,
        p_content_type: file.type,
        p_byte_size: file.size,
    });

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(image.storage_path, file, { contentType: file.type, upsert: false });
    if (error) {
        await rpc("articles_delete_image", { p_article_id: path.id, p_image_id: image.id }).catch(
            () => undefined,
        );
        throw new ApiError(`Could not store the figure: ${error.message}`, 500);
    }

    // ArticleImageResponse: the storage path stays on the server side.
    return {
        id: image.id,
        filename: image.filename,
        content_type: image.content_type,
        caption: image.caption,
    };
});

route("DELETE", "/articles/:id/images/:imageId", async ({ path }) => {
    const { storage_path } = await rpc<{ storage_path: string }>("articles_delete_image", {
        p_article_id: path.id,
        p_image_id: path.imageId,
    });
    // The row is gone either way; a stray object is harmless.
    await supabase.storage.from(BUCKET).remove([storage_path]);
    return undefined;
});

route("DELETE", "/articles/:id", async ({ path }) => {
    const { storage_paths } = await rpc<{ storage_paths: string[] }>("articles_delete", {
        p_article_id: path.id,
    });
    if (storage_paths.length) await supabase.storage.from(BUCKET).remove(storage_paths);
    return undefined;
});
