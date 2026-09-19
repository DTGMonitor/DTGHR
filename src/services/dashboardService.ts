import { rpc, supabase, toApiError } from "@/lib/supabase";

export interface ActivityItem {
    id: string;
    action: string;
    description: string;
    actor_name: string;
    created_at: string;
}

export interface ActivityPage {
    items: ActivityItem[];
    total: number;
    page: number;
    page_size: number;
}

export const dashboardService = {
    /**
     * Admin and employee branches, as the old /dashboard/stats returned them.
     * The shape is a discriminated union on `role`; the caller names it, since
     * that is where the two variants are actually pulled apart.
     */
    async stats<T = unknown>(): Promise<{ data: T }> {
        return { data: await rpc<T>("dashboard_stats") };
    },

    /**
     * The audit trail. activity_logs_view already narrows this to what the
     * viewer is entitled to -- everything for HR, and for everyone else what
     * they did plus what was done to them.
     */
    async recentActivity(params: {
        page?: number;
        page_size?: number;
    }): Promise<{ data: ActivityPage }> {
        const page = params.page ?? 1;
        const pageSize = params.page_size ?? 10;
        const from = (page - 1) * pageSize;

        const { data, error, count } = await supabase
            .from("activity_logs_view")
            .select("*", { count: "exact" })
            .order("created_at", { ascending: false })
            .range(from, from + pageSize - 1);

        if (error) throw toApiError(error);

        return {
            data: {
                items: (data ?? []) as ActivityItem[],
                total: count ?? 0,
                page,
                page_size: pageSize,
            },
        };
    },
};
