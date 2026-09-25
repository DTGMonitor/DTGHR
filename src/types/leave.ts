export enum LeaveType {
    ANNUAL = "annual",
    SICK = "sick",
    STUDY = "study",

    // The handbook's Family & Wellbeing Leave.
    MATERNITY = "maternity",
    PATERNITY = "paternity",
    MISCARRIAGE = "miscarriage",
    MENSTRUAL = "menstrual",

    // The handbook's Special Leave — fully paid, fixed allowances.
    MARRIAGE = "marriage",
    CHILD_MARRIAGE = "child_marriage",
    CHILD_CEREMONY = "child_ceremony",
    BEREAVEMENT = "bereavement",
    BEREAVEMENT_HOUSEHOLD = "bereavement_household",
}

/**
 * One kind of leave, as the API offers it to this person.
 *
 * Served rather than listed here, because who may ask for study leave is a
 * setting an administrator changes — a list baked into the front end would go
 * stale the moment somebody is granted it.
 */
export interface LeaveTypeOption {
    value: LeaveType;
    label: string;
    group: "core" | "family" | "special";
    allowance_days: number | null;
    note: string;
    needs_document: boolean;
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
    /**
     * The same entitlement as at today rather than at the year end.
     *
     * Annual leave accrues monthly, so in September the figure December will
     * close on is several days lower than the one you can book against now.
     * Both are true; a single number with no date on it is what confused the
     * card before.
     */
    as_at?: string | null;
    accrued_now?: number | null;
    used_now?: number | null;
    remaining_now?: number | null;
    year_end?: string | null;
}
