// Routes for the finance area. See supabase/PORTING.md.
//
// Finance requests: petty cash, tax, BPJS and the rest. Every rule lives in
// the finance_* Postgres functions (20260926000800_finance.sql); attachments
// live in the private Storage bucket `finance-documents`, with their metadata
// recorded through finance_document_add.
import { route } from "@/lib/api";
import { ApiError, rpc, supabase } from "@/lib/supabase";

const BASE = "/finance-requests";
const BUCKET = "finance-documents";

/** The same list the FastAPI line accepted (contracts.ALLOWED_TYPES). */
const ALLOWED_TYPES: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};
const MAX_BYTES = 10 * 1024 * 1024;

type Json = Record<string, unknown>;

const asObject = (body: unknown): Json =>
    body && typeof body === "object" && !(body instanceof FormData) ? (body as Json) : {};

async function removeObjects(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    // Best effort: the record is already gone, and an orphaned object is
    // unreachable without it.
    await supabase.storage.from(BUCKET).remove(paths);
}

// ── Reading ─────────────────────────────────────────────────────────────

route("GET", BASE, () => rpc("finance_list"));

// Registered before `/:id`, which would otherwise match it.
route("GET", `${BASE}/settings`, () => rpc("finance_settings_get"));

route("PUT", `${BASE}/settings`, ({ body }) => {
    const value = asObject(body).director_final_approval;
    if (typeof value !== "boolean") {
        throw new ApiError("director_final_approval must be true or false.", 422);
    }
    return rpc("finance_settings_update", { p_director_final_approval: value });
});

route("GET", `${BASE}/:id`, ({ path }) => rpc("finance_get", { p_id: path.id }));

// ── Preparing ───────────────────────────────────────────────────────────

route("POST", BASE, ({ body }) => rpc("finance_create", { p_body: asObject(body) }));

route("PUT", `${BASE}/:id`, ({ path, body }) =>
    rpc("finance_update", { p_id: path.id, p_body: asObject(body) }),
);

route("DELETE", `${BASE}/:id`, async ({ path }) => {
    const paths = await rpc<string[]>("finance_delete", { p_id: path.id });
    await removeObjects(paths ?? []);
    return null; // 204
});

// ── The chain ───────────────────────────────────────────────────────────

route("POST", `${BASE}/:id/submit`, ({ path }) => rpc("finance_submit", { p_id: path.id }));

route("POST", `${BASE}/:id/review`, ({ path }) => rpc("finance_review", { p_id: path.id }));

route("POST", `${BASE}/:id/approve`, ({ path }) => rpc("finance_approve", { p_id: path.id }));

route("POST", `${BASE}/:id/send-back`, ({ path, body }) => {
    const b = asObject(body);
    return rpc("finance_send_back", {
        p_id: path.id,
        p_note: typeof b.note === "string" ? b.note : null,
        p_send_to: typeof b.send_to === "string" ? b.send_to : "finance",
    });
});

route("POST", `${BASE}/:id/paid`, ({ path, body }) => {
    const b = asObject(body);
    return rpc("finance_mark_paid", {
        p_id: path.id,
        p_paid_on: typeof b.paid_on === "string" && b.paid_on ? b.paid_on : null,
        p_note: typeof b.note === "string" ? b.note : null,
    });
});

// ── Documents ───────────────────────────────────────────────────────────

route("POST", `${BASE}/:id/documents`, async ({ path, body }) => {
    const file = body instanceof FormData ? body.get("file") : null;
    if (!(file instanceof File)) {
        throw new ApiError("Choose a file to upload.", 422);
    }
    // Checked here as well as in finance_document_add, so a file that would be
    // refused is never uploaded.
    const ext = ALLOWED_TYPES[file.type];
    if (!ext) throw new ApiError("Upload a PDF, an image, or a Word document.", 415);
    if (file.size === 0) throw new ApiError("That file is empty.", 400);
    if (file.size > MAX_BYTES) {
        throw new ApiError(
            `That file is ${Math.floor(file.size / 1024 / 1024)} MB. The limit is 10 MB.`,
            413,
        );
    }

    const filename = file.name || `document${ext}`;
    const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, "_") || `document${ext}`;
    const storagePath = `${path.id}/${crypto.randomUUID()}/${safeName}`;

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, { contentType: file.type, upsert: false });
    if (error) {
        const status = Number((error as { statusCode?: string | number }).statusCode) || 400;
        // Storage policy refuses anyone but finance; say it as the backend did.
        if (status === 403 || /row-level security|unauthori[sz]ed/i.test(error.message)) {
            throw new ApiError("Only finance attaches documents.", 403);
        }
        throw new ApiError(error.message || "The file could not be stored.", status);
    }

    try {
        return await rpc("finance_document_add", {
            p_request_id: path.id,
            p_filename: filename,
            p_content_type: file.type,
            p_byte_size: file.size,
            p_storage_path: storagePath,
        });
    } catch (err) {
        await removeObjects([storagePath]);
        throw err;
    }
});

route("GET", `${BASE}/:id/documents/:docId`, async ({ path }) => {
    const doc = await rpc<{ filename: string; content_type: string; storage_path: string }>(
        "finance_document_get",
        { p_request_id: path.id, p_document_id: path.docId },
    );
    const { data, error } = await supabase.storage.from(BUCKET).download(doc.storage_path);
    if (error || !data) throw new ApiError("Not found", 404);
    // Keep the recorded type, so the viewer renders a PDF as a PDF.
    return data.type === doc.content_type ? data : new Blob([data], { type: doc.content_type });
});

route("DELETE", `${BASE}/:id/documents/:docId`, async ({ path }) => {
    const out = await rpc<{ request: unknown; storage_path: string }>("finance_document_delete", {
        p_request_id: path.id,
        p_document_id: path.docId,
    });
    await removeObjects([out.storage_path]);
    return out.request;
});
