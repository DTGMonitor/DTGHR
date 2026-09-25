import api from "@/lib/api";
import type {
    LeaveRequest,
    LeaveBalance,
    LeaveType,
    LeaveTypeOption,
    LeaveStatus,
} from "@/types/leave";

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

export const leaveService = {
    getMyBalances(year?: number): Promise<{ data: LeaveBalance[] }> {
        return api.get("/leaves/balances", { params: year ? { year } : {} });
    },

    listMyRequests(params: {
        page?: number;
        page_size?: number;
        status?: LeaveStatus;
        leave_type?: LeaveType;
    }): Promise<{ data: { items: LeaveRequest[]; total: number; page: number; page_size: number } }> {
        return api.get("/leaves", { params });
    },

    /** The kinds of leave this person may actually ask for. */
    myTypes(): Promise<{ data: LeaveTypeOption[] }> {
        return api.get("/leaves/types");
    },

    submitRequest(data: LeaveRequestCreateData): Promise<{ data: LeaveRequest }> {
        return api.post("/leaves", data);
    },

    cancelRequest(id: string): Promise<{ data: LeaveRequest }> {
        return api.post(`/leaves/${id}/cancel`);
    },

    listPendingApprovals(params?: { page?: number; page_size?: number }): Promise<{
        data: { items: LeaveRequest[]; total: number; page: number; page_size: number };
    }> {
        return api.get("/leaves/pending-approvals", { params });
    },

    approveRequest(id: string, data?: LeaveActionData): Promise<{ data: LeaveRequest }> {
        return api.post(`/leaves/${id}/approve`, data ?? {});
    },

    rejectRequest(id: string, data?: LeaveActionData): Promise<{ data: LeaveRequest }> {
        return api.post(`/leaves/${id}/reject`, data ?? {});
    },

    getSummary(): Promise<{ data: Record<string, Record<string, number>> }> {
        return api.get("/leaves/summary");
    },
};
