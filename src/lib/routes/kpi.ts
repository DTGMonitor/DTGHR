// Routes for the kpi area. See supabase/PORTING.md.
//
// Performance scorecards: the reference data, the review chain (open, rate,
// submit, approve / return, publish / unpublish, reset, discard) and the
// subject's own published results. Each path calls one `kpi_*` function in
// 20260926000500_kpi.sql, which re-checks permission and returns the FastAPI
// response shape.
import { route } from "@/lib/api";
import { rpc } from "@/lib/supabase";

type Body = Record<string, unknown> | undefined;

const comment = (body: unknown): string | null => {
    const c = (body as Body)?.comment;
    return typeof c === "string" ? c : null;
};

route("GET", "/kpi/meta", () => rpc("kpi_meta"));

route("GET", "/kpi/templates", () => rpc("kpi_list_templates"));

route("GET", "/kpi/templates/:id", ({ path }) =>
    rpc("kpi_get_template", { p_template_id: path.id }));

// Registered before "/kpi/reviews/:id" so "mine" is not read as an id.
route("GET", "/kpi/reviews/mine", () => rpc("kpi_list_my_reviews"));

route("GET", "/kpi/reviews", ({ query }) =>
    rpc("kpi_list_reviews", { p_employee_id: query.employee_id || null }));

route("POST", "/kpi/reviews", ({ body }) =>
    rpc("kpi_create_review", { p_body: body ?? {} }));

route("GET", "/kpi/reviews/:id", ({ path }) =>
    rpc("kpi_get_review", { p_review_id: path.id }));

route("PATCH", "/kpi/reviews/:id", ({ path, body }) =>
    rpc("kpi_update_review", { p_review_id: path.id, p_body: body ?? {} }));

route("PATCH", "/kpi/reviews/:id/items/:itemId", ({ path, body }) =>
    rpc("kpi_update_item", {
        p_review_id: path.id,
        p_item_id: path.itemId,
        p_body: body ?? {},
    }));

route("POST", "/kpi/reviews/:id/submit", ({ path }) =>
    rpc("kpi_submit_review", { p_review_id: path.id }));

route("POST", "/kpi/reviews/:id/approve", ({ path, body }) =>
    rpc("kpi_approve_review", { p_review_id: path.id, p_comment: comment(body) }));

route("POST", "/kpi/reviews/:id/return", ({ path, body }) =>
    rpc("kpi_return_review", { p_review_id: path.id, p_comment: comment(body) }));

route("POST", "/kpi/reviews/:id/publish", ({ path }) =>
    rpc("kpi_publish_review", { p_review_id: path.id }));

route("POST", "/kpi/reviews/:id/unpublish", ({ path }) =>
    rpc("kpi_unpublish_review", { p_review_id: path.id }));

route("POST", "/kpi/reviews/:id/reset", ({ path }) =>
    rpc("kpi_reset_review", { p_review_id: path.id }));

route("DELETE", "/kpi/reviews/:id", async ({ path }) => {
    await rpc("kpi_delete_review", { p_review_id: path.id });
    return null;
});
