import { getSessionFacts, rpc, supabase, toApiError } from "@/lib/supabase";
import type { LeaveRequest, LeaveBalance, LeaveType, LeaveStatus } from "@/types/leave";

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

    async getSummary(): Promise<{ data: Record<string, Record<string, number>> }> {
        return { data: await rpc<Record<string, Record<string, number>>>("leave_summary") };
    },
};
