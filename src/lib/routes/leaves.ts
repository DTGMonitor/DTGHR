// Routes for the leaves area. See supabase/PORTING.md.
//
// Answers the /leaves paths from app/api/routes/leaves.py with the functions
// in supabase/migrations/20260926000300_leaves.sql. The fixed paths are
// registered before `/leaves/:id` so "types", "balances" and the rest are
// never read as an id.
import { route } from "@/lib/api";
import { rpc } from "@/lib/supabase";

const int = (v: string | undefined, fallback: number): number => {
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

const opt = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v);

const note = (body: unknown): string | null => {
    const n = (body as { note?: unknown } | null | undefined)?.note;
    return typeof n === "string" && n !== "" ? n : null;
};

const year = (v: string | undefined): number | null =>
    v === undefined || v === "" ? null : int(v, new Date().getFullYear());

route("GET", "/leaves/types", () => rpc("leaves_types"));

route("GET", "/leaves/balances", ({ query }) =>
    rpc("get_leave_balances", { p_employee_id: null, p_year: year(query.year) }),
);

route("GET", "/leaves/balances/:employeeId", ({ path, query }) =>
    rpc("get_leave_balances", { p_employee_id: path.employeeId, p_year: year(query.year) }),
);

route("GET", "/leaves/summary", () => rpc("leave_summary"));

route("GET", "/leaves/pending-approvals", ({ query }) =>
    rpc("leaves_pending_approvals", {
        p_page: int(query.page, 1),
        p_page_size: int(query.page_size, 20),
    }),
);

route("GET", "/leaves", ({ query }) =>
    rpc("leaves_list_mine", {
        p_page: int(query.page, 1),
        p_page_size: int(query.page_size, 20),
        p_status: opt(query.status),
        p_leave_type: opt(query.leave_type),
    }),
);

route("POST", "/leaves", ({ body }) => rpc("submit_leave_request", { p_payload: body ?? {} }));

route("GET", "/leaves/:id", ({ path }) => rpc("leaves_get", { p_id: path.id }));

route("POST", "/leaves/:id/cancel", ({ path }) => rpc("cancel_leave_request", { p_id: path.id }));

route("POST", "/leaves/:id/approve", ({ path, body }) =>
    rpc("approve_leave_request", { p_id: path.id, p_note: note(body) }),
);

route("POST", "/leaves/:id/reject", ({ path, body }) =>
    rpc("reject_leave_request", { p_id: path.id, p_note: note(body) }),
);
