import api from "@/lib/api";
import type {
    PublicHoliday,
    ShiftChangeRequest,
    ShiftChangeStatus,
    ShiftAssignment,
    ShiftCode,
    WorkSchedule,
    WorkScheduleDetail,
    WorkScheduleListResponse,
} from "@/types/schedule";

export interface ScheduleCreateData {
    name: string;
    start_date: string;
    end_date: string;
}

export interface ShiftAssignmentInput {
    employee_id: string;
    date: string;
    shift_code: ShiftCode;
    start_time?: string | null;
    end_time?: string | null;
}

export interface ShiftCellUpdate {
    employee_id: string;
    date: string;
    /** null clears the cell. */
    shift_code: ShiftCode | null;
}

export interface ShiftChangeItemInput {
    employee_id: string;
    date: string;
    requested_code: ShiftCode | null;
}

export interface ShiftChangeCreate {
    /** Every cell the user edited in this sitting, submitted together. */
    items: ShiftChangeItemInput[];
    reason?: string | null;
}

export interface ShiftChangeReview {
    /**
     * Leave both lists undefined to accept the proposal wholesale. Naming ids
     * reviews only those days; the rest stay pending.
     */
    approved_item_ids?: string[];
    rejected_item_ids?: string[];
    review_note?: string | null;
}

export interface RosterPatternBlock {
    shift_code: ShiftCode;
    days: number;
}

export interface RosterPatternData {
    employee_ids: string[];
    pattern: RosterPatternBlock[];
    start_date: string;
    end_date: string;
    /** Rotation offset applied per employee, so crews land on different legs. */
    offset_days?: number;
    overwrite?: boolean;
    apply_public_holidays?: boolean;
}

export interface RosterPatternResult {
    schedules_touched: number;
    cells_written: number;
    cells_skipped: number;
}

export const scheduleService = {
    list(params?: {
        page?: number;
        page_size?: number;
    }): Promise<{ data: WorkScheduleListResponse }> {
        return api.get("/schedules", { params });
    },

    get(id: string): Promise<{ data: WorkScheduleDetail }> {
        return api.get(`/schedules/${id}`);
    },

    create(data: ScheduleCreateData): Promise<{ data: WorkSchedule }> {
        return api.post("/schedules", data);
    },

    saveAssignments(
        id: string,
        assignments: ShiftAssignmentInput[],
    ): Promise<{ data: WorkScheduleDetail }> {
        return api.put(`/schedules/${id}/assignments`, { assignments });
    },

    /** Superuser: set or clear one cell straight away. */
    setCell(
        id: string,
        data: ShiftCellUpdate,
    ): Promise<{ data: ShiftAssignment | null }> {
        return api.put(`/schedules/${id}/cell`, data);
    },

    /** Anyone: propose a change; it only lands once a superuser approves. */
    proposeChange(
        id: string,
        data: ShiftChangeCreate,
    ): Promise<{ data: ShiftChangeRequest }> {
        return api.post(`/schedules/${id}/change-requests`, data);
    },

    listChangeRequests(params?: {
        status?: ShiftChangeStatus;
        schedule_id?: string;
    }): Promise<{ data: ShiftChangeRequest[] }> {
        return api.get("/schedules/change-requests", { params });
    },

    /** Superuser: accept or turn down a proposal, whole or in part. */
    reviewChange(
        requestId: string,
        review: ShiftChangeReview = {},
    ): Promise<{ data: ShiftChangeRequest }> {
        return api.put(`/schedules/change-requests/${requestId}/review`, review);
    },

    /** Withdraw one's own still-pending proposal. */
    cancelChange(requestId: string): Promise<void> {
        return api.delete(`/schedules/change-requests/${requestId}`);
    },

    /** Superuser: repeat a rotation across a date range, creating months as needed. */
    applyPattern(data: RosterPatternData): Promise<{ data: RosterPatternResult }> {
        return api.post("/schedules/roster-pattern", data);
    },

    publicHolidays(year?: number): Promise<{ data: PublicHoliday[] }> {
        return api.get("/schedules/public-holidays", { params: { year } });
    },

    publish(id: string): Promise<{ data: WorkSchedule }> {
        return api.put(`/schedules/${id}/publish`);
    },

    unpublish(id: string): Promise<{ data: WorkSchedule }> {
        return api.put(`/schedules/${id}/unpublish`);
    },

    delete(id: string): Promise<void> {
        return api.delete(`/schedules/${id}`);
    },
};
