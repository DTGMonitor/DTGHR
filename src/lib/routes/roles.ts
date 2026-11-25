// Routes for account roles, answered by the roles_* functions in
// supabase/migrations/20261124000100_role_assignment.sql. The director's
// alone: the server refuses everyone else.
import { route } from "@/lib/api";
import { rpc } from "@/lib/supabase";

route("GET", "/roles", () => rpc("roles_list"));

route("PUT", "/roles/:userId", ({ path, body }) =>
    rpc("roles_set_user_role", {
        p_user_id: path.userId,
        p_role: (body as { role?: string } | undefined)?.role ?? null,
    }),
);
