/*
 * Routes for the payroll area: the monthly run (/payroll) and the pay
 * forecast (/compensation). Each answers what the FastAPI route of the same
 * path answered, through the Postgres function named beside it. See
 * supabase/PORTING.md and supabase/migrations/20260926000600_payroll.sql.
 */
import { route } from "@/lib/api";
import { ApiError, rpc } from "@/lib/supabase";

/** A query-string integer, or null when absent. */
function int(value: string | undefined, name: string): number | null {
    if (value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isInteger(n)) throw new ApiError(`${name} must be a whole number`, 422);
    return n;
}

function object(body: unknown): Record<string, unknown> {
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

// ── Months ───────────────────────────────────────────────────────────────

route("GET", "/payroll/months", ({ query }) =>
    rpc("payroll_list_months", { p_year: int(query.year, "year") }),
);

route("POST", "/payroll/months", ({ body }) => {
    const b = object(body);
    return rpc("payroll_create_month", {
        p_year: b.year,
        p_month: b.month,
        p_copy_previous: b.copy_previous ?? true,
    });
});

route("GET", "/payroll/months/:id", ({ path }) =>
    rpc("payroll_get_month", { p_month_id: path.id }),
);

route("PATCH", "/payroll/months/:id", ({ path, body }) =>
    rpc("payroll_update_month", { p_month_id: path.id, p_changes: object(body) }),
);

route("DELETE", "/payroll/months/:id", async ({ path }) => {
    await rpc("payroll_delete_month", { p_month_id: path.id });
    return null;
});

// ── The chain ────────────────────────────────────────────────────────────

route("POST", "/payroll/months/:id/submit", ({ path }) =>
    rpc("payroll_submit_month", { p_month_id: path.id }),
);

route("POST", "/payroll/months/:id/endorse", ({ path }) =>
    rpc("payroll_endorse_month", { p_month_id: path.id }),
);

route("POST", "/payroll/months/:id/approve", ({ path }) =>
    rpc("payroll_approve_month", { p_month_id: path.id }),
);

route("POST", "/payroll/months/:id/request-changes", ({ path, body }) => {
    const b = object(body);
    return rpc("payroll_request_changes", {
        p_month_id: path.id,
        p_note: typeof b.note === "string" ? b.note : null,
        p_send_to: b.send_to ?? "finance",
    });
});

// ── Lines ────────────────────────────────────────────────────────────────

route("POST", "/payroll/months/:id/lines", ({ path, body }) =>
    rpc("payroll_add_line", { p_month_id: path.id, p_line: object(body) }),
);

route("PUT", "/payroll/lines/:id", ({ path, body }) =>
    rpc("payroll_update_line", { p_line_id: path.id, p_changes: object(body) }),
);

route("DELETE", "/payroll/lines/:id", async ({ path }) => {
    await rpc("payroll_delete_line", { p_line_id: path.id });
    return null;
});

// ── One person across the year ───────────────────────────────────────────

route("GET", "/payroll/staff/:employeeId", ({ path, query }) =>
    rpc("payroll_person_by_month", {
        p_employee_id: path.employeeId,
        p_year: int(query.year, "year"),
    }),
);

// ── The pay forecast ─────────────────────────────────────────────────────

route("GET", "/compensation", ({ query }) =>
    rpc("compensation_list", { p_year: int(query.year, "year") }),
);

route("PUT", "/compensation/:employeeId", ({ path, query, body }) =>
    rpc("compensation_upsert", {
        p_employee_id: path.employeeId,
        p_changes: object(body),
        p_year: int(query.year, "year"),
    }),
);
