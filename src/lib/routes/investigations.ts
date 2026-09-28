// Routes for monitoring investigations and their disciplinary outcomes.
// Every rule -- who investigates, who may be named, who sees which outcome --
// is enforced in the investigations_* Postgres functions
// (supabase/migrations/20260928001400_investigations.sql).
import { route } from "@/lib/api";
import { rpc } from "@/lib/supabase";

type Body = Record<string, unknown>;

const asBody = (body: unknown): Body => (body && typeof body === "object" ? (body as Body) : {});
const text = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
const int = (v: unknown): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};

// Fixed paths first, so none of them is taken for an id.
route("GET", "/investigations", () => rpc("investigations_list"));
route("GET", "/investigations/people", () => rpc("investigations_people"));
route("GET", "/investigations/mine", () => rpc("investigations_my_outcomes"));
route("GET", "/investigations/waiting", () => rpc("investigations_waiting"));

route("GET", "/investigations/sites", () => rpc("investigations_sites"));
const saveSite = (id: string | null, body: unknown) => {
    const b = asBody(body);
    return rpc("investigations_save_site", {
        p_id: id,
        p_name: text(b.name),
        p_client: text(b.client),
        p_is_active: typeof b.is_active === "boolean" ? b.is_active : null,
        p_sort_order: int(b.sort_order),
    });
};
route("POST", "/investigations/sites", ({ body }) => saveSite(null, body));
route("PUT", "/investigations/sites/:id", ({ path, body }) => saveSite(path.id!, body));

route("GET", "/investigations/settings", () => rpc("investigations_team_settings"));
route("PUT", "/investigations/settings/:employeeId", ({ path, body }) => {
    const b = asBody(body);
    return rpc("investigations_set_flag", {
        p_employee_id: path.employeeId,
        p_flag: text(b.flag),
        p_value: b.value === true,
    });
});

route("POST", "/investigations/outcomes/:id/respond", ({ path, body }) => {
    const b = asBody(body);
    return rpc("investigations_respond", {
        p_outcome_id: path.id,
        p_response: text(b.response),
        p_text: text(b.text),
    });
});
route("POST", "/investigations/outcomes/:id/resolve", ({ path, body }) =>
    rpc("investigations_resolve", { p_outcome_id: path.id, p_note: text(asBody(body).note) }),
);
route("DELETE", "/investigations/outcomes/:id", ({ path }) =>
    rpc("investigations_remove_outcome", { p_outcome_id: path.id }),
);

route("GET", "/investigations/:id", ({ path }) => rpc("investigations_get", { p_id: path.id }));
route("POST", "/investigations", ({ body }) =>
    rpc("investigations_save", { p_id: null, p_payload: asBody(body) }),
);
route("PUT", "/investigations/:id", ({ path, body }) =>
    rpc("investigations_save", { p_id: path.id, p_payload: asBody(body) }),
);
route("DELETE", "/investigations/:id", async ({ path }) => {
    await rpc("investigations_delete", { p_id: path.id });
    return null;
});

route("POST", "/investigations/:id/outcomes", ({ path, body }) =>
    rpc("investigations_save_outcome", {
        p_investigation_id: path.id,
        p_outcome_id: null,
        p_payload: asBody(body),
    }),
);
route("PUT", "/investigations/:id/outcomes/:outcomeId", ({ path, body }) =>
    rpc("investigations_save_outcome", {
        p_investigation_id: path.id,
        p_outcome_id: path.outcomeId,
        p_payload: asBody(body),
    }),
);

route("POST", "/investigations/:id/issue", ({ path }) => rpc("investigations_issue", { p_id: path.id }));
route("POST", "/investigations/:id/close", ({ path }) => rpc("investigations_close", { p_id: path.id }));
route("POST", "/investigations/:id/reopen", ({ path }) => rpc("investigations_reopen", { p_id: path.id }));
