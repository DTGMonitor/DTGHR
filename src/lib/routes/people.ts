// Routes for the people area. See supabase/PORTING.md.
//
// /employees (the directory, the record, role history, photos) and
// /profile-requests, answered by the people_* functions in
// supabase/migrations/20260926000200_people.sql. /auth/me and
// /auth/change-password are not routes any more: AuthContext calls
// bootstrap_session() and complete_password_change() directly.
import { route } from "@/lib/api";
import { ApiError, rpc, supabase } from "@/lib/supabase";

const PHOTO_BUCKET = "employee-photos";

function asInt(value: string | undefined, fallback: number): number {
    if (value === undefined || value === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asBool(value: string | undefined): boolean {
    return value === "true" || value === "1";
}

function storageError(error: { message?: string } | null, fallback: string): ApiError {
    return new ApiError(error?.message || fallback, 400);
}

// --- the directory and the record ------------------------------------------

route("GET", "/employees", ({ query }) =>
    rpc("people_list_employees", {
        p_page: asInt(query.page, 1),
        p_page_size: asInt(query.page_size, 20),
        p_search: query.search ?? null,
        p_department: query.department ?? null,
        p_include_inactive: asBool(query.include_inactive),
    }),
);

route("POST", "/employees", ({ body }) => rpc("people_create_employee", { p_payload: body ?? {} }));

route("GET", "/employees/:id", ({ path }) => rpc("people_get_employee", { p_employee_id: path.id }));

route("PUT", "/employees/:id", ({ path, body }) =>
    rpc("people_update_employee", { p_employee_id: path.id, p_payload: body ?? {} }),
);

route("DELETE", "/employees/:id", async ({ path }) => {
    await rpc("people_deactivate_employee", { p_employee_id: path.id });
    return null;
});

route("POST", "/employees/:id/create-account", ({ path }) =>
    rpc("create_employee_account", { p_employee_id: path.id }),
);

// --- role history -----------------------------------------------------------

route("GET", "/employees/:id/history", ({ path }) =>
    rpc("people_role_history", { p_employee_id: path.id }),
);

route("PATCH", "/employees/:id/history/:changeId", ({ path, body }) =>
    rpc("people_amend_role_change", {
        p_employee_id: path.id,
        p_change_id: path.changeId,
        p_payload: body ?? {},
    }),
);

// --- photos, in the private employee-photos bucket --------------------------

route("GET", "/employees/:id/photo", async ({ path }) => {
    const key = await rpc<string>("people_photo_path", { p_employee_id: path.id });
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).download(key);
    if (error || !data) throw new ApiError("No photo", 404);
    return data; // a Blob, whatever responseType asked for
});

route("PUT", "/employees/:id/photo", async ({ path, body }) => {
    const file = body instanceof FormData ? body.get("file") : null;
    if (!(file instanceof Blob)) throw new ApiError("Empty file", 400);

    // Who may, what type, what size -- checked before anything is uploaded.
    const key = await rpc<string>("people_prepare_photo", {
        p_employee_id: path.id,
        p_content_type: file.type || null,
        p_byte_size: file.size,
    });
    const { error } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(key, file, { upsert: true, contentType: file.type, cacheControl: "300" });
    if (error) throw storageError(error, "Could not store the photo.");

    await rpc("people_record_photo", { p_employee_id: path.id, p_path: key });
    return null;
});

route("DELETE", "/employees/:id/photo", async ({ path }) => {
    const key = await rpc<string | null>("people_delete_photo", { p_employee_id: path.id });
    if (key) {
        const { error } = await supabase.storage.from(PHOTO_BUCKET).remove([key]);
        if (error) throw storageError(error, "Could not remove the photo.");
    }
    return null;
});

// --- profile change requests -----------------------------------------------

route("GET", "/profile-requests", () => rpc("people_list_profile_requests"));

route("GET", "/profile-requests/fields", () => rpc("people_profile_request_fields"));

route("POST", "/profile-requests", ({ body }) => {
    const b = (body ?? {}) as { field?: string; requested_value?: string | null; reason?: string | null };
    return rpc("people_raise_profile_request", {
        p_field: b.field ?? "",
        p_requested_value: b.requested_value ?? null,
        p_reason: b.reason ?? null,
    });
});

route("POST", "/profile-requests/:id/approve", ({ path, body }) =>
    rpc("people_approve_profile_request", {
        p_request_id: path.id,
        p_note: (body as { note?: string | null } | undefined)?.note ?? null,
    }),
);

route("POST", "/profile-requests/:id/decline", ({ path, body }) =>
    rpc("people_decline_profile_request", {
        p_request_id: path.id,
        p_note: (body as { note?: string | null } | undefined)?.note ?? null,
    }),
);

route("POST", "/profile-requests/:id/cancel", ({ path }) =>
    rpc("people_cancel_profile_request", { p_request_id: path.id }),
);
