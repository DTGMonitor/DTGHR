import { rpc, supabase, toApiError } from "@/lib/supabase";
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
    async list(params?: {
        page?: number;
        page_size?: number;
    }): Promise<{ data: WorkScheduleListResponse }> {
        const page = params?.page ?? 1;
        const pageSize = params?.page_size ?? 20;
        const from = (page - 1) * pageSize;

        // RLS hides draft periods from anyone who is not a superuser, so this
        // needs no role branch of its own.
        const { data, error, count } = await supabase
            .from("work_schedules")
            .select("*", { count: "exact" })
            .order("start_date", { ascending: false })
            .range(from, from + pageSize - 1);

        if (error) throw toApiError(error);

        return {
            data: {
                items: (data ?? []) as WorkSchedule[],
                total: count ?? 0,
                page,
                page_size: pageSize,
            },
        };
    },

    /**
     * The whole roster period in one call: cells, approved-leave overlays,
     * open proposals, the public holidays it spans and the right-hand totals.
     * The old endpoint assembled this from six queries behind a lambda.
     */
    async get(id: string): Promise<{ data: WorkScheduleDetail }> {
        return {
            data: await rpc<WorkScheduleDetail>("get_schedule_detail", { p_schedule_id: id }),
        };
    },

    async create(data: ScheduleCreateData): Promise<{ data: WorkSchedule }> {
        return {
            data: await rpc<WorkSchedule>("create_schedule", {
                p_name: data.name,
                p_start_date: data.start_date,
                p_end_date: data.end_date,
            }),
        };
    },

    async saveAssignments(
        id: string,
        assignments: ShiftAssignmentInput[],
    ): Promise<{ data: WorkScheduleDetail }> {
        return {
            data: await rpc<WorkScheduleDetail>("save_schedule_assignments", {
                p_schedule_id: id,
                p_assignments: assignments,
            }),
        };
    },

    /** Superuser: set or clear one cell straight away. */
    async setCell(
        id: string,
        data: ShiftCellUpdate,
    ): Promise<{ data: ShiftAssignment | null }> {
        return {
            data: await rpc<ShiftAssignment | null>("set_schedule_cell", {
                p_schedule_id: id,
                p_employee_id: data.employee_id,
                p_date: data.date,
                p_shift_code: data.shift_code,
            }),
        };
    },

    /** Anyone: propose a change; it only lands once a superuser approves. */
    async proposeChange(
        id: string,
        data: ShiftChangeCreate,
    ): Promise<{ data: ShiftChangeRequest }> {
        return {
            data: await rpc<ShiftChangeRequest>("propose_shift_changes", {
                p_schedule_id: id,
                p_items: data.items,
                p_reason: data.reason ?? null,
            }),
        };
    },

    async listChangeRequests(params?: {
        status?: ShiftChangeStatus;
        schedule_id?: string;
    }): Promise<{ data: ShiftChangeRequest[] }> {
        return {
            data: await rpc<ShiftChangeRequest[]>("list_change_requests", {
                p_status: params?.status ?? null,
                p_schedule_id: params?.schedule_id ?? null,
            }),
        };
    },

    /** Superuser: accept or turn down a proposal, whole or in part. */
    async reviewChange(
        requestId: string,
        review: ShiftChangeReview = {},
    ): Promise<{ data: ShiftChangeRequest }> {
        return {
            data: await rpc<ShiftChangeRequest>("review_shift_change", {
                p_request_id: requestId,
                p_approved_item_ids: review.approved_item_ids ?? null,
                p_rejected_item_ids: review.rejected_item_ids ?? null,
                p_review_note: review.review_note ?? null,
            }),
        };
    },

    /** Withdraw one's own still-pending proposal. */
    async cancelChange(requestId: string): Promise<void> {
        await rpc<null>("cancel_shift_change", { p_request_id: requestId });
    },

    /** Superuser: repeat a rotation across a date range, creating months as needed. */
    async applyPattern(data: RosterPatternData): Promise<{ data: RosterPatternResult }> {
        return {
            data: await rpc<RosterPatternResult>("apply_roster_pattern", {
                p_employee_ids: data.employee_ids,
                p_pattern: data.pattern,
                p_start_date: data.start_date,
                p_end_date: data.end_date,
                p_offset_days: data.offset_days ?? 0,
                p_overwrite: data.overwrite ?? true,
                p_apply_public_holidays: data.apply_public_holidays ?? true,
            }),
        };
    },

    async publicHolidays(year?: number): Promise<{ data: PublicHoliday[] }> {
        let query = supabase.from("public_holidays").select("*");
        if (year) {
            query = query.gte("date", `${year}-01-01`).lte("date", `${year}-12-31`);
        }
        const { data, error } = await query.order("date", { ascending: true });
        if (error) throw toApiError(error);
        return { data: (data ?? []) as PublicHoliday[] };
    },

    async publish(id: string): Promise<{ data: WorkSchedule }> {
        return { data: await rpc<WorkSchedule>("publish_schedule", { p_schedule_id: id }) };
    },

    async unpublish(id: string): Promise<{ data: WorkSchedule }> {
        return { data: await rpc<WorkSchedule>("unpublish_schedule", { p_schedule_id: id }) };
    },

    async delete(id: string): Promise<void> {
        await rpc<null>("delete_schedule", { p_schedule_id: id });
    },
};
