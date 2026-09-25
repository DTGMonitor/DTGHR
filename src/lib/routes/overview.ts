// Routes for the overview area: the dashboard and the activity log.
// See supabase/PORTING.md; the rules live in
// supabase/migrations/20260926001200_overview.sql.
import { route } from "@/lib/api";
import { rpc } from "@/lib/supabase";

const int = (v: string | undefined, fallback: number): number => {
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

route("GET", "/overview", () => rpc("overview_get"));

route("GET", "/dashboard/stats", () => rpc("dashboard_stats"));

route("GET", "/activity/recent", ({ query }) =>
    rpc("activity_recent", {
        p_page: int(query.page, 1),
        p_page_size: int(query.page_size, 10),
    }),
);
