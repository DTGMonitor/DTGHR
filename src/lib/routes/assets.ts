// Routes for the office asset register. See supabase/PORTING.md.
//
// Every rule -- who registers and moves items, who reads values, whose
// handover it is, who answers a check-in item -- is enforced in the assets_*
// Postgres functions (supabase/migrations/20261016000100_office_asset_register.sql).
import { route } from "@/lib/api";
import { rpc } from "@/lib/supabase";

type Body = Record<string, unknown>;

const asBody = (body: unknown): Body => (body && typeof body === "object" ? (body as Body) : {});
const flag = (v: string | undefined): boolean => v === "true" || v === "1";
const text = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

route("GET", "/assets", ({ query }) =>
    rpc("assets_list", { p_include_retired: flag(query.include_retired) }),
);

// The fixed paths are registered before "/assets/:id" so they are not taken
// for an id.
route("GET", "/assets/mine", () => rpc("assets_mine"));
route("GET", "/assets/categories", () => rpc("assets_categories"));
route("POST", "/assets/categories", ({ body }) => rpc("assets_category_save", { p: asBody(body) }));
route("GET", "/assets/leavers", () => rpc("assets_leavers"));

route("GET", "/assets/rounds", () => rpc("assets_rounds"));
route("POST", "/assets/rounds", ({ body }) => {
    const b = asBody(body);
    return rpc("assets_round_start", { p_name: text(b.name), p_due_date: text(b.due_date) });
});
route("GET", "/assets/rounds/:id", ({ path }) => rpc("assets_round_get", { p_id: path.id }));
route("POST", "/assets/rounds/:id/close", ({ path }) => rpc("assets_round_close", { p_id: path.id }));
route("POST", "/assets/round-items/:id/answer", ({ path, body }) => {
    const b = asBody(body);
    return rpc("assets_round_answer", { p_item_id: path.id, p_have_it: b.have_it === true, p_note: text(b.note) });
});
route("POST", "/assets/round-items/:id/seen", ({ path, body }) =>
    rpc("assets_round_mark_seen", { p_item_id: path.id, p_note: text(asBody(body).note) }),
);

route("POST", "/assets", ({ body }) => rpc("assets_register", { p: asBody(body) }));
route("GET", "/assets/:id", ({ path }) => rpc("assets_get", { p_id: path.id }));
route("PATCH", "/assets/:id", ({ path, body }) => rpc("assets_update", { p_id: path.id, p: asBody(body) }));

route("POST", "/assets/:id/assign", ({ path, body }) => {
    const b = asBody(body);
    return rpc("assets_assign", { p_id: path.id, p_employee_id: text(b.employee_id), p_note: text(b.note) });
});
route("POST", "/assets/:id/return", ({ path, body }) => {
    const b = asBody(body);
    return rpc("assets_return", { p_id: path.id, p_location: text(b.location), p_note: text(b.note) });
});
route("POST", "/assets/:id/repair_out", ({ path, body }) =>
    rpc("assets_send_to_repair", { p_id: path.id, p_note: text(asBody(body).note) }),
);
route("POST", "/assets/:id/repair_back", ({ path, body }) =>
    rpc("assets_back_from_repair", { p_id: path.id, p_note: text(asBody(body).note) }),
);
route("POST", "/assets/:id/lost", ({ path, body }) =>
    rpc("assets_mark_lost", { p_id: path.id, p_note: text(asBody(body).note) }),
);
route("POST", "/assets/:id/found", ({ path, body }) => {
    const b = asBody(body);
    return rpc("assets_mark_found", { p_id: path.id, p_location: text(b.location), p_note: text(b.note) });
});
route("POST", "/assets/:id/retire", ({ path, body }) =>
    rpc("assets_retire", { p_id: path.id, p_reason: text(asBody(body).note) }),
);
route("POST", "/assets/:id/respond", ({ path, body }) => {
    const b = asBody(body);
    return rpc("assets_respond_handover", { p_id: path.id, p_accept: b.accept === true, p_note: text(b.note) });
});
route("POST", "/assets/:id/clear-flag", ({ path, body }) =>
    rpc("assets_clear_flag", { p_id: path.id, p_note: text(asBody(body).note) }),
);

// Which asset a ticket concerns. IT only; null unlinks.
route("POST", "/tickets/:id/asset", ({ path, body }) =>
    rpc("tickets_link_asset", { p_ticket_id: path.id, p_asset_id: text(asBody(body).asset_id) }),
);
