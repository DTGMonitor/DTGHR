export enum LeaveType {
    ANNUAL = "annual",
    SICK = "sick",
    PERSONAL = "personal",
    UNPAID = "unpaid",
}

export enum LeaveStatus {
    PENDING = "pending",
    APPROVED = "approved",
    REJECTED = "rejected",
    CANCELLED = "cancelled",
}

export interface LeaveRequest {
    id: string;
    employee_id: string;
    employee_name: string | null;
    leave_type: LeaveType;
    start_date: string;
    end_date: string;
    days_requested: number;
    reason: string | null;
    status: LeaveStatus;
    reviewed_by: string | null;
    reviewed_at: string | null;
    reviewer_note: string | null;
    created_at: string;
    updated_at: string;
}

export interface LeaveRequestListResponse {
    items: LeaveRequest[];
    total: number;
    page: number;
    page_size: number;
}

export interface LeaveBalance {
    id: string;
    employee_id: string;
    leave_type: LeaveType;
    year: number;
    total_days: number;
    used_days: number;
    remaining_days: number;
}
