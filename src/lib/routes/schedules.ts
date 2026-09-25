// Routes for the schedules area (the roster). See supabase/PORTING.md.
//
// Answers the /schedules paths from app/api/routes/schedules.py with the
// functions in supabase/migrations/20260916000600_rpc_schedules.sql, as
// replaced or extended by 20260926000400_schedules.sql. The fixed paths --
// "employees", "change-requests", "roster-pattern", "public-holidays" -- are
// registered before `/schedules/:id` so none of them is read as an id.
import { route } from "@/lib/api";
import { ApiError, rpc } from "@/lib/supabase";

type Body = Record<string, unknown>;

const body = (b: unknown): Body => (b && typeof b === "object" ? (b as Body) : {});

const int = (v: string | undefined, fallback: number): number => {
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ApiError(`Input should be a valid integer, got '${v}'`, 422);
    return Math.trunc(n);
};

const opt = (v: unknown): string | null =>
    v === undefined || v === null || v === "" ? null : String(v);

const bool = (v: unknown, fallback: boolean): boolean =>
    v === undefined || v === null ? fallback : Boolean(v);

const ids = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null);

// --- fixed paths ------------------------------------------------------------

route("GET", "/schedules/employees", () => rpc("schedules_list_employees"));

route("GET", "/schedules/change-requests", ({ query }) =>
    rpc("list_change_requests", {
        p_status: opt(query.status),
        p_schedule_id: opt(query.schedule_id),
    }),
);

route("PUT", "/schedules/change-requests/:id/review", ({ path, body: b }) => {
    const r = body(b);
    return rpc("review_shift_change", {
        p_request_id: path.id,
        p_approved_item_ids: ids(r.approved_item_ids),
        p_rejected_item_ids: ids(r.rejected_item_ids),
        p_review_note: opt(r.review_note),
    });
});

route("DELETE", "/schedules/change-requests/:id", async ({ path }) => {
    await rpc("cancel_shift_change", { p_request_id: path.id });
    return null;
});

route("POST", "/schedules/roster-pattern", ({ body: b }) => {
    const r = body(b);
    return rpc("schedules_apply_roster_pattern", {
        p_employee_ids: ids(r.employee_ids) ?? [],
        p_pattern: Array.isArray(r.pattern) ? r.pattern : [],
        p_start_date: opt(r.start_date),
        p_end_date: opt(r.end_date),
        p_offset_days: typeof r.offset_days === "number" ? Math.trunc(r.offset_days) : 0,
        p_overwrite: bool(r.overwrite, true),
        p_apply_public_holidays: bool(r.apply_public_holidays, true),
        p_continue_rotation: bool(r.continue_rotation, true),
        p_weekdays_only: bool(r.weekdays_only, false),
    });
});

route("GET", "/schedules/public-holidays", ({ query }) =>
    rpc("schedules_list_public_holidays", {
        p_year: query.year === undefined || query.year === "" ? null : int(query.year, 0),
    }),
);

route("POST", "/schedules/public-holidays", ({ body: b }) => {
    const r = body(b);
    return rpc("schedules_create_public_holiday", {
        p_date: opt(r.date),
        p_name: opt(r.name),
        p_is_national: bool(r.is_national, true),
    });
});

route("PATCH", "/schedules/public-holidays/:id", ({ path, body: b }) => {
    // Only the fields sent are changed, as with exclude_unset on the backend.
    const r = body(b);
    const patch: Body = {};
    for (const k of ["date", "name", "is_national"]) {
        if (r[k] !== undefined && r[k] !== null) patch[k] = r[k];
    }
    return rpc("schedules_update_public_holiday", { p_id: path.id, p_patch: patch });
});

route("DELETE", "/schedules/public-holidays/:id", async ({ path }) => {
    await rpc("schedules_delete_public_holiday", { p_id: path.id });
    return null;
});

// --- periods ----------------------------------------------------------------

route("GET", "/schedules", ({ query }) =>
    rpc("schedules_list", {
        p_page: int(query.page, 1),
        p_page_size: int(query.page_size, 20),
    }),
);

route("POST", "/schedules", ({ body: b }) => {
    const r = body(b);
    return rpc("create_schedule", {
        p_name: opt(r.name),
        p_start_date: opt(r.start_date),
        p_end_date: opt(r.end_date),
    });
});

route("GET", "/schedules/:id", ({ path }) =>
    rpc("get_schedule_detail", { p_schedule_id: path.id }),
);

route("POST", "/schedules/:id/change-requests", ({ path, body: b }) => {
    const r = body(b);
    return rpc("propose_shift_changes", {
        p_schedule_id: path.id,
        p_items: Array.isArray(r.items) ? r.items : [],
        p_reason: opt(r.reason),
    });
});

route("PUT", "/schedules/:id/cell", ({ path, body: b }) => {
    const r = body(b);
    return rpc("set_schedule_cell", {
        p_schedule_id: path.id,
        p_employee_id: opt(r.employee_id),
        p_date: opt(r.date),
        p_shift_code: opt(r.shift_code),
    });
});

route("PUT", "/schedules/:id/assignments", ({ path, body: b }) => {
    const r = body(b);
    return rpc("save_schedule_assignments", {
        p_schedule_id: path.id,
        p_assignments: Array.isArray(r.assignments) ? r.assignments : [],
    });
});

route("PUT", "/schedules/:id/publish", ({ path }) =>
    rpc("publish_schedule", { p_schedule_id: path.id }),
);

route("PUT", "/schedules/:id/unpublish", ({ path }) =>
    rpc("unpublish_schedule", { p_schedule_id: path.id }),
);

route("DELETE", "/schedules/:id", async ({ path }) => {
    await rpc("delete_schedule", { p_schedule_id: path.id });
    return null;
});
