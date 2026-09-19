import { ApiError, getSessionFacts, rpc, supabase, toApiError } from "@/lib/supabase";
import {
    LeaveType,
    type LeaveActivity,
    type LeaveBalance,
    type LeaveOverview,
    type LeaveRequest,
    type LeaveStatus,
} from "@/types/leave";
import { isoDate } from "@/lib/dates";

export interface LeaveRequestCreateData {
    leave_type: LeaveType;
    start_date: string;
    end_date: string;
    days_requested: number;
    reason?: string;
}

export interface LeaveActionData {
    note?: string;
}

interface ActivityList {
    items: LeaveActivity[];
    total: number;
    page: number;
    page_size: number;
}

interface LeaveList {
    items: LeaveRequest[];
    total: number;
    page: number;
    page_size: number;
}

export const leaveService = {
    async getMyBalances(year?: number): Promise<{ data: LeaveBalance[] }> {
        return {
            data: await rpc<LeaveBalance[]>("get_leave_balances", {
                p_employee_id: null,
                p_year: year ?? null,
            }),
        };
    },

    async listMyRequests(params: {
        page?: number;
        page_size?: number;
        status?: LeaveStatus;
        leave_type?: LeaveType;
    }): Promise<{ data: LeaveList }> {
        const page = params.page ?? 1;
        const pageSize = params.page_size ?? 20;
        const from = (page - 1) * pageSize;
        const { employeeId } = getSessionFacts();

        if (!employeeId) {
            return { data: { items: [], total: 0, page, page_size: pageSize } };
        }

        let query = supabase
            .from("leave_requests_view")
            .select("*", { count: "exact" })
            .eq("employee_id", employeeId);

        if (params.status) query = query.eq("status", params.status);
        if (params.leave_type) query = query.eq("leave_type", params.leave_type);

        const { data, error, count } = await query
            .order("created_at", { ascending: false })
            .range(from, from + pageSize - 1);

        if (error) throw toApiError(error);

        return {
            data: {
                items: (data ?? []) as LeaveRequest[],
                total: count ?? 0,
                page,
                page_size: pageSize,
            },
        };
    },

    async submitRequest(data: LeaveRequestCreateData): Promise<{ data: LeaveRequest }> {
        return { data: await rpc<LeaveRequest>("submit_leave_request", { p_payload: data }) };
    },

    async cancelRequest(id: string): Promise<{ data: LeaveRequest }> {
        return { data: await rpc<LeaveRequest>("cancel_leave_request", { p_id: id }) };
    },

    /**
     * The approval queue.
     *
     * RLS already narrows leave_requests_view to what the viewer may see --
     * their own, their direct reports', or everything for HR. A manager's own
     * requests are not theirs to approve, though, so those are filtered back
     * out here, matching what the old /pending-approvals endpoint returned.
     */
    async listPendingApprovals(params?: {
        page?: number;
        page_size?: number;
    }): Promise<{ data: LeaveList }> {
        const page = params?.page ?? 1;
        const pageSize = params?.page_size ?? 20;
        const from = (page - 1) * pageSize;
        const { employeeId, isSuperuser } = getSessionFacts();

        let query = supabase
            .from("leave_requests_view")
            .select("*", { count: "exact" })
            .eq("status", "pending");

        if (!isSuperuser) {
            if (!employeeId) {
                return { data: { items: [], total: 0, page, page_size: pageSize } };
            }
            query = query.neq("employee_id", employeeId);
        }

        const { data, error, count } = await query
            .order("created_at", { ascending: true })
            .range(from, from + pageSize - 1);

        if (error) throw toApiError(error);

        return {
            data: {
                items: (data ?? []) as LeaveRequest[],
                total: count ?? 0,
                page,
                page_size: pageSize,
            },
        };
    },

    async approveRequest(id: string, data?: LeaveActionData): Promise<{ data: LeaveRequest }> {
        return {
            data: await rpc<LeaveRequest>("approve_leave_request", {
                p_id: id,
                p_note: data?.note ?? null,
            }),
        };
    },

    async rejectRequest(id: string, data?: LeaveActionData): Promise<{ data: LeaveRequest }> {
        return {
            data: await rpc<LeaveRequest>("reject_leave_request", {
                p_id: id,
                p_note: data?.note ?? null,
            }),
        };
    },

    /**
     * Balances plus every one of the caller's requests, folded into the
     * figures the summary cards show. Requests are fetched unfiltered and
     * unpaginated -- a person has a handful a year -- so the cards do not move
     * when the table below them is filtered.
     */
    async getMyOverview(): Promise<{ data: LeaveOverview }> {
        const year = new Date().getFullYear();
        const { employeeId } = getSessionFacts();
        if (!employeeId) {
            throw new ApiError("No employee profile linked to this user account", 403);
        }

        const [balancesRes, requestsRes] = await Promise.all([
            this.getMyBalances(year),
            supabase
                .from("leave_requests_view")
                .select("*")
                .eq("employee_id", employeeId)
                .order("start_date", { ascending: true }),
        ]);
        if (requestsRes.error) throw toApiError(requestsRes.error);

        const balances = balancesRes.data;
        const requests = (requestsRes.data ?? []) as LeaveRequest[];
        const today = isoDate(new Date());
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;

        const pick = (type: LeaveType) => {
            const b = balances.find((x) => x.leave_type === type);
            return {
                total: b?.total_days ?? 0,
                used: b?.used_days ?? 0,
                remaining: b?.remaining_days ?? 0,
            };
        };

        const pending = requests.filter((r) => r.status === "pending");
        const approvedThisYear = requests.filter(
            (r) => r.status === "approved" && r.start_date >= yearStart && r.start_date <= yearEnd
        );
        const usedByType = Object.fromEntries(
            Object.values(LeaveType).map((t) => [t, 0])
        ) as Record<LeaveType, number>;
        for (const r of approvedThisYear) usedByType[r.leave_type] += r.days_requested;

        return {
            data: {
                year,
                annual: pick(LeaveType.ANNUAL),
                sick: pick(LeaveType.SICK),
                pending_count: pending.length,
                pending_days: pending.reduce((n, r) => n + r.days_requested, 0),
                used_days: approvedThisYear.reduce((n, r) => n + r.days_requested, 0),
                used_by_type: usedByType,
                next_leave:
                    requests.find((r) => r.status === "approved" && r.end_date >= today) ?? null,
                balances,
            },
        };
    },

    /**
     * Leave activity. "mine" is what happened to the caller's own requests --
     * submitted, approved, rejected, cancelled. "all" is everything the view
     * lets the caller see, which for HR is the whole organisation.
     */
    async listActivity(params: {
        scope: "mine" | "all";
        page?: number;
        page_size?: number;
    }): Promise<{ data: ActivityList }> {
        const page = params.page ?? 1;
        const pageSize = params.page_size ?? 10;
        const from = (page - 1) * pageSize;
        const { employeeId } = getSessionFacts();

        let query = supabase.from("leave_activity_view").select("*", { count: "exact" });
        if (params.scope === "mine") {
            if (!employeeId) return { data: { items: [], total: 0, page, page_size: pageSize } };
            query = query.eq("employee_id", employeeId);
        }

        const { data, error, count } = await query
            .order("created_at", { ascending: false })
            .range(from, from + pageSize - 1);
        if (error) throw toApiError(error);

        return {
            data: {
                items: (data ?? []) as LeaveActivity[],
                total: count ?? 0,
                page,
                page_size: pageSize,
            },
        };
    },

    async getSummary(): Promise<{ data: Record<string, Record<string, number>> }> {
        return { data: await rpc<Record<string, Record<string, number>>>("leave_summary") };
    },
};
