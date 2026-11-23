// Routes for purchasing and vendors. See supabase/PORTING.md.
//
// Every rule -- who raises, registers, approves, orders and checks in, what
// evidence each tier needs, the per-vendor-per-month count, and who sees
// prices -- lives in the purchases_* and vendors_* Postgres functions
// (supabase/migrations/20261017000100_purchasing_flow.sql). Attachments live
// in the private Storage bucket `purchase-documents`, at
// <purchase_id>/<uuid>/<filename>, recorded through purchases_document_add.
import { route } from "@/lib/api";
import { ApiError, rpc, supabase } from "@/lib/supabase";

const BASE = "/purchases";
const BUCKET = "purchase-documents";

const ALLOWED_TYPES: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};
const MAX_BYTES = 10 * 1024 * 1024;

type Body = Record<string, unknown>;

const asBody = (body: unknown): Body =>
    body && typeof body === "object" && !(body instanceof FormData) ? (body as Body) : {};
const text = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));

async function removeObjects(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    // Best effort: the record is already gone, and an orphan is unreachable.
    await supabase.storage.from(BUCKET).remove(paths);
}

// ── Reading ─────────────────────────────────────────────────────────────

route("GET", BASE, ({ query }) => {
    const filters: Body = {};
    for (const k of ["status", "tier", "vendor_id", "requester_id", "urgent", "late_entry", "self_approved", "related_party", "q"]) {
        if (query[k]) filters[k] = query[k];
    }
    return rpc("purchases_list", { p_filters: filters });
});

// The fixed paths come before "/purchases/:id".
route("GET", `${BASE}/mine`, () => rpc("purchases_mine"));
route("GET", `${BASE}/to-check`, () => rpc("purchases_to_check"));
route("GET", `${BASE}/settings`, () => rpc("purchases_settings"));
route("PUT", `${BASE}/settings`, ({ body }) => rpc("purchases_settings_update", { p: asBody(body) }));

route("GET", `${BASE}/:id`, ({ path }) => rpc("purchases_get", { p_id: path.id }));
route("GET", `${BASE}/:id/checkers`, ({ path }) => rpc("purchases_checker_candidates", { p_id: path.id }));

// ── The requester ───────────────────────────────────────────────────────

route("POST", BASE, ({ body }) => rpc("purchases_create", { p: asBody(body) }));
route("PUT", `${BASE}/:id`, ({ path, body }) => rpc("purchases_update", { p_id: path.id, p: asBody(body) }));
route("DELETE", `${BASE}/:id`, async ({ path }) => {
    const paths = await rpc<string[]>("purchases_delete", { p_id: path.id });
    await removeObjects(paths ?? []);
    return null;
});
route("POST", `${BASE}/:id/submit`, ({ path }) => rpc("purchases_submit", { p_id: path.id }));
route("POST", `${BASE}/:id/cancel`, ({ path, body }) =>
    rpc("purchases_cancel", { p_id: path.id, p_reason: text(asBody(body).reason) }),
);

// ── Finance ─────────────────────────────────────────────────────────────

route("POST", `${BASE}/:id/register`, ({ path, body }) =>
    rpc("purchases_register", { p_id: path.id, p: asBody(body) }),
);
route("POST", `${BASE}/:id/return`, ({ path, body }) =>
    rpc("purchases_return", { p_id: path.id, p_note: text(asBody(body).note) }),
);
route("POST", `${BASE}/:id/petty-cash`, ({ path, body }) => {
    const estimate = Number(asBody(body).estimate);
    return rpc("purchases_close_petty_cash", { p_id: path.id, p_estimate: Number.isFinite(estimate) ? estimate : null });
});
route("POST", `${BASE}/:id/source`, ({ path, body }) =>
    rpc("purchases_source", { p_id: path.id, p: asBody(body) }),
);
route("POST", `${BASE}/:id/send`, ({ path }) => rpc("purchases_send_for_approval", { p_id: path.id }));
route("POST", `${BASE}/:id/order`, ({ path, body }) =>
    rpc("purchases_issue_order", { p_id: path.id, p_checker_id: text(asBody(body).checker_id) }),
);
route("POST", `${BASE}/:id/checker`, ({ path, body }) =>
    rpc("purchases_change_checker", { p_id: path.id, p_checker_id: text(asBody(body).checker_id) }),
);
route("POST", `${BASE}/:id/ask-amount`, ({ path, body }) => {
    const b = asBody(body);
    const amount = Number(b.amount);
    return rpc("purchases_ask_amount", {
        p_id: path.id,
        p_amount: Number.isFinite(amount) ? amount : null,
        p_note: text(b.note),
    });
});
route("POST", `${BASE}/:id/match`, ({ path, body }) => rpc("purchases_match", { p_id: path.id, p: asBody(body) }));

// ── The approver ────────────────────────────────────────────────────────

route("POST", `${BASE}/:id/approve`, ({ path, body }) =>
    rpc("purchases_approve", { p_id: path.id, p_note: text(asBody(body).note) }),
);
route("POST", `${BASE}/:id/send-back`, ({ path, body }) =>
    rpc("purchases_send_back", { p_id: path.id, p_note: text(asBody(body).note) }),
);
route("POST", `${BASE}/:id/reject`, ({ path, body }) =>
    rpc("purchases_reject", { p_id: path.id, p_reason: text(asBody(body).reason) }),
);
route("POST", `${BASE}/:id/confirm-urgent`, ({ path, body }) =>
    rpc("purchases_confirm_urgent", { p_id: path.id, p_note: text(asBody(body).note) }),
);
route("POST", `${BASE}/:id/decide-amount`, ({ path, body }) => {
    const b = asBody(body);
    return rpc("purchases_decide_amount", { p_id: path.id, p_approve: b.approve === true, p_note: text(b.note) });
});

// ── The checker ─────────────────────────────────────────────────────────

route("POST", `${BASE}/:id/receive`, ({ path, body }) => {
    const b = asBody(body);
    return rpc("purchases_receive", {
        p_id: path.id,
        p_lines: Array.isArray(b.lines) ? b.lines : [],
        p_matches: typeof b.matches === "boolean" ? b.matches : null,
        p_note: text(b.note),
    });
});

// ── Documents ───────────────────────────────────────────────────────────

route("POST", `${BASE}/:id/documents`, async ({ path, body }) => {
    const file = body instanceof FormData ? body.get("file") : null;
    const kind = body instanceof FormData ? String(body.get("kind") ?? "") : "";
    if (!(file instanceof File)) throw new ApiError("Choose a file to upload.", 422);
    const ext = ALLOWED_TYPES[file.type];
    if (!ext) throw new ApiError("Upload a PDF, an image, or a Word or Excel document.", 415);
    if (file.size === 0) throw new ApiError("That file is empty.", 400);
    if (file.size > MAX_BYTES) {
        throw new ApiError(`That file is ${Math.floor(file.size / 1024 / 1024)} MB. The limit is 10 MB.`, 413);
    }

    const filename = file.name || `document${ext}`;
    const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, "_") || `document${ext}`;
    const storagePath = `${path.id}/${crypto.randomUUID()}/${safeName}`;

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, { contentType: file.type, upsert: false });
    if (error) {
        const status = Number((error as { statusCode?: string | number }).statusCode) || 400;
        if (status === 403 || /row-level security|unauthori[sz]ed/i.test(error.message)) {
            throw new ApiError("You can't attach documents to this purchase now.", 403);
        }
        throw new ApiError(error.message || "The file could not be stored.", status);
    }

    try {
        return await rpc("purchases_document_add", {
            p_purchase_id: path.id,
            p_kind: kind,
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
        "purchases_document_get",
        { p_purchase_id: path.id, p_document_id: path.docId },
    );
    const { data, error } = await supabase.storage.from(BUCKET).download(doc.storage_path);
    if (error || !data) throw new ApiError("Not found", 404);
    return data.type === doc.content_type ? data : new Blob([data], { type: doc.content_type });
});

route("DELETE", `${BASE}/:id/documents/:docId`, async ({ path }) => {
    const out = await rpc<{ purchase: unknown; storage_path: string }>("purchases_document_delete", {
        p_purchase_id: path.id,
        p_document_id: path.docId,
    });
    await removeObjects([out.storage_path]);
    return out.purchase;
});

// ── Vendors ─────────────────────────────────────────────────────────────

route("GET", "/vendors", ({ query }) =>
    rpc("vendors_list", { p_include_inactive: query.include_inactive === "true" }),
);
route("POST", "/vendors", ({ body }) => rpc("vendors_create", { p: asBody(body) }));
route("GET", "/vendors/:id", ({ path }) => rpc("vendors_get", { p_id: path.id }));
route("PATCH", "/vendors/:id", ({ path, body }) => rpc("vendors_update", { p_id: path.id, p: asBody(body) }));
route("POST", "/vendors/:id/active", ({ path, body }) => {
    const b = asBody(body);
    return rpc("vendors_set_active", { p_id: path.id, p_active: b.active === true, p_note: text(b.note) });
});
route("POST", "/vendors/:id/bank", ({ path, body }) => {
    const b = asBody(body);
    return rpc("vendors_change_bank", {
        p_id: path.id,
        p: {
            bank_name: text(b.bank_name),
            bank_account_number: text(b.bank_account_number),
            bank_account_holder: text(b.bank_account_holder),
        },
        p_callback_note: text(b.callback_note),
    });
});
