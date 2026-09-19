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

/**
 * The headline figures for one employee, derived from their balances and
 * requests. The dashboard and the Leaves page both read this, so the two can
 * never disagree.
 */
export interface LeaveOverview {
    year: number;
    annual: { total: number; used: number; remaining: number };
    sick: { total: number; used: number; remaining: number };
    /** Requests still awaiting a decision, whatever their dates. */
    pending_count: number;
    pending_days: number;
    /** Approved days starting this year, every leave type including unpaid. */
    used_days: number;
    used_by_type: Record<LeaveType, number>;
    /** The next approved leave that has not ended yet. */
    next_leave: LeaveRequest | null;
    balances: LeaveBalance[];
}

export type LeaveActivityAction =
    | "LEAVE_REQUESTED"
    | "LEAVE_APPROVED"
    | "LEAVE_REJECTED"
    | "LEAVE_CANCELLED";

/** One row of leave_activity_view: an audit entry joined to its request. */
export interface LeaveActivity {
    id: string;
    action: LeaveActivityAction;
    description: string;
    actor_id: string | null;
    actor_name: string;
    created_at: string;
    leave_request_id: string;
    employee_id: string;
    employee_name: string;
    leave_type: LeaveType;
    start_date: string;
    end_date: string;
    days_requested: number;
    status: LeaveStatus;
    reviewer_note: string | null;
}
