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

// The dashboard, plus what investigations have waiting on this person
// (supabase/migrations/20260928001400_investigations.sql). The second call
// never breaks the dashboard: if it fails, the band simply leaves it out.
route("GET", "/overview", async () => {
    const [overview, investigations] = await Promise.all([
        rpc<Record<string, unknown>>("overview_get"),
        rpc<unknown>("investigations_waiting").catch(() => null),
    ]);
    return { ...overview, investigations };
});

route("GET", "/dashboard/stats", () => rpc("dashboard_stats"));

route("GET", "/activity/recent", ({ query }) =>
    rpc("activity_recent", {
        p_page: int(query.page, 1),
        p_page_size: int(query.page_size, 10),
    }),
);
