// Routes for the tickets area (IT support). See supabase/PORTING.md.
//
// Every rule -- who works the queue, who reads the history, who sees internal
// notes -- is enforced in the tickets_* Postgres functions
// (supabase/migrations/20260926000900_tickets.sql).
import { route } from "@/lib/api";
import { rpc } from "@/lib/supabase";

type Body = Record<string, unknown>;

const asBody = (body: unknown): Body => (body && typeof body === "object" ? (body as Body) : {});
const flag = (v: string | undefined): boolean => v === "true" || v === "1";
const text = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

route("GET", "/tickets", ({ query }) =>
    rpc("tickets_list", {
        p_mine_only: flag(query.mine_only),
        p_include_closed: flag(query.include_closed),
    }),
);

// Registered before "/tickets/:id" so "history" is not taken for an id.
route("GET", "/tickets/history", () => rpc("tickets_history"));

route("GET", "/tickets/:id", ({ path }) => rpc("tickets_get", { p_ticket_id: path.id }));

route("POST", "/tickets", ({ body }) => {
    const b = asBody(body);
    return rpc("tickets_raise", {
        p_subject: text(b.subject),
        p_description: text(b.description),
        p_category: text(b.category),
        p_priority: text(b.priority) ?? "normal",
        p_location: text(b.location),
    });
});

route("POST", "/tickets/:id/comments", ({ path, body }) => {
    const b = asBody(body);
    return rpc("tickets_comment", {
        p_ticket_id: path.id,
        p_body: text(b.body),
        p_is_internal: b.is_internal === true,
    });
});

route("POST", "/tickets/:id/status", ({ path, body }) => {
    const b = asBody(body);
    return rpc("tickets_set_status", {
        p_ticket_id: path.id,
        p_status: text(b.status),
        p_note: text(b.note),
    });
});

route("POST", "/tickets/:id/assign", ({ path, body }) => {
    const b = asBody(body);
    return rpc("tickets_assign", {
        p_ticket_id: path.id,
        p_assignee_id: text(b.assignee_id),
    });
});
