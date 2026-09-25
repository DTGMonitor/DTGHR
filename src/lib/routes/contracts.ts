// Routes for the contracts area. See supabase/PORTING.md.
//
// Ported from app/api/routes/contracts.py. Every rule lives in the
// contracts_* Postgres functions (20260926001000_contracts.sql); the signed
// documents live in the private `contract-documents` Storage bucket under
// `<contract_id>/<document_id>`.
import { route } from "@/lib/api";
import { ApiError, rpc, supabase } from "@/lib/supabase";

const BUCKET = "contract-documents";

interface StoredDocument {
    id: string;
    filename: string;
    content_type: string;
    byte_size: number;
    storage_path: string;
}

function newId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    // Fallback for older runtimes: RFC 4122 v4 from Math.random.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
        const r = (Math.random() * 16) | 0;
        return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

async function removeObjects(paths: string[]): Promise<void> {
    if (!paths.length) return;
    // Best effort: the row is already gone, and an orphaned object is only
    // reachable by somebody who could read the contract anyway.
    await supabase.storage.from(BUCKET).remove(paths);
}

route("GET", "/contracts", ({ query }) =>
    rpc("contracts_list", { p_kind: query.kind ?? null }),
);

route("POST", "/contracts", ({ body }) => rpc("contracts_create", { p_body: body ?? {} }));

route("PATCH", "/contracts/:id", ({ path, body }) =>
    rpc("contracts_update", { p_id: path.id, p_body: body ?? {} }),
);

route("POST", "/contracts/:id/reminders/:reminderId/acknowledge", ({ path, body }) =>
    rpc("contracts_acknowledge", {
        p_id: path.id,
        p_reminder_id: path.reminderId,
        p_note: (body as { note?: string | null } | undefined)?.note ?? null,
    }),
);

route("DELETE", "/contracts/:id", async ({ path }) => {
    const res = await rpc<{ storage_paths: string[] }>("contracts_delete", { p_id: path.id });
    await removeObjects(res?.storage_paths ?? []);
    return undefined; // 204 No Content
});

route("POST", "/contracts/:id/documents", async ({ path, body }) => {
    const file = body instanceof FormData ? body.get("file") : null;
    if (!(file instanceof Blob)) {
        throw new ApiError("Field required", 422);
    }
    const filename = file instanceof File ? file.name : "";
    const contentType = file.type;

    // Every rule first, so a refusal carries the backend's message (403, 404,
    // 409, 415, 413, 400 in its order) rather than whatever Storage would say.
    await rpc("contracts_check_document", {
        p_id: path.id,
        p_content_type: contentType,
        p_byte_size: file.size,
    });

    const documentId = newId();
    const storagePath = `${path.id}/${documentId}`;
    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, { contentType, upsert: false });
    if (error) throw new ApiError(error.message, 400);

    try {
        return await rpc("contracts_add_document", {
            p_id: path.id,
            p_document_id: documentId,
            p_filename: filename,
            p_content_type: contentType,
            p_byte_size: file.size,
            p_storage_path: storagePath,
        });
    } catch (err) {
        await removeObjects([storagePath]);
        throw err;
    }
});

// The viewer asks with responseType "blob"; the bytes are the only answer
// this path ever had, so a Blob is returned either way.
route("GET", "/contracts/:id/documents/:documentId", async ({ path }) => {
    const doc = await rpc<StoredDocument>("contracts_get_document", {
        p_id: path.id,
        p_document_id: path.documentId,
    });
    const { data, error } = await supabase.storage.from(BUCKET).download(doc.storage_path);
    if (error || !data) throw new ApiError("Not found", 404);
    // Typed as stored, so a PDF opens in the viewer rather than downloading.
    return new Blob([data], { type: doc.content_type });
});

route("DELETE", "/contracts/:id/documents/:documentId", async ({ path }) => {
    const res = await rpc<{ contract: unknown; storage_path: string }>(
        "contracts_delete_document",
        { p_id: path.id, p_document_id: path.documentId },
    );
    await removeObjects([res.storage_path]);
    return res.contract;
});
