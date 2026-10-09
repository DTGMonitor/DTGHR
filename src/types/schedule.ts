import type { WorkPattern } from "@/types/employee";

export enum ScheduleStatus {
    DRAFT = "draft",
    PUBLISHED = "published",
}

/**
 * A code from the absence-type key of the STAFF ROSTER workbook. The codes,
 * their labels and colours live in the database (public.shift_codes) and
 * reach the screens through useShiftCodes(); a code is just its letters here.
 */
export type ShiftCode = string;

/**
 * The codes the screens name: the roster presets use DS, NS, D and B, and the
 * annual-leave count AL. The database marks these is_system and never lets
 * them go inactive.
 */
export const SystemShiftCode = {
    DS: "DS",
    NS: "NS",
    D: "D",
    B: "B",
    AL: "AL",
    PH: "PH",
} as const;

/** One row of public.shift_codes. */
export interface ShiftCodeRow {
    code: ShiftCode;
    label: string;
    /** Exact fill from the spreadsheet. */
    bg: string;
    /** Legible text colour on that fill. */
    fg: string;
    sort_order: number;
    /** A break day is drawn as a plain block with no letter in it. */
    blank_in_grid: boolean;
    /** Inactive codes still show on old cells but cannot be chosen. */
    active: boolean;
    is_system: boolean;
}

export enum ShiftChangeStatus {
    PENDING = "pending",
    APPROVED = "approved",
    REJECTED = "rejected",
    /** Some days in the proposal were accepted, others turned down. */
    PARTIALLY_APPROVED = "partially_approved",
    CANCELLED = "cancelled",
}

/**
 * Codes that count towards the "Total days" column — matches the backend.
 * A rule rather than a display detail; it moves to the table with the other
 * code rules.
 */
export const WORKING_DAY_CODES: ShiftCode[] = ["DS", "NS", "C", "D"];

export interface ShiftAssignment {
    id: string;
    schedule_id: string;
    employee_id: string;
    employee_name: string | null;
    date: string;
    shift_code: ShiftCode;
    start_time: string | null;
    end_time: string | null;
}

/** One cell inside a proposal -- the unit a reviewer accepts or turns down. */
export interface ShiftChangeItem {
    id: string;
    employee_id: string;
    employee_name: string | null;
    date: string;
    current_code: ShiftCode | null;
    requested_code: ShiftCode | null;
    status: ShiftChangeStatus;
}

/**
 * A proposal: one submission covering however many cells the requester edited
 * in a sitting. Reviewed as a unit, but individual days can be turned down.
 */
export interface ShiftChangeRequest {
    id: string;
    schedule_id: string;
    status: ShiftChangeStatus;
    reason: string | null;
    review_note: string | null;
    requested_by_id: string;
    requested_by_name: string | null;
    reviewed_by_id: string | null;
    reviewed_by_name: string | null;
    reviewed_at: string | null;
    created_at: string;
    items: ShiftChangeItem[];
}

export interface PublicHoliday {
    id: string;
    date: string;
    name: string;
    /** False for *cuti bersama* — a government day off, not a holiday proper. */
    is_national: boolean;
}

/** The right-hand totals for one employee, mirroring the workbook. */
export interface WorkingDaysSummary {
    employee_id: string;
    employee_name: string | null;
    /** Days worked: DS, NS, C and D only. */
    working_days: number;
    by_code: Record<string, number>;
    /** Running annual-leave balance at the end of this period. */
    annual_leave_days: number;
    /** AL days falling inside this period alone. */
    annual_leave_taken: number;
    /** National public holidays this employee was rostered to work. */
    public_holiday_loading: number;
    /**
     * "office_day" or "roster".
     *
     * The workbook keeps both crews on one sheet; this is what lets the grid
     * group them, and what tells the page which rows the viewer is entitled to
     * see at all.
     */
    work_pattern: WorkPattern | null;
}

export interface WorkSchedule {
    id: string;
    name: string;
    start_date: string;
    end_date: string;
    status: ScheduleStatus;
    created_at: string;
    updated_at: string;
}

export interface WorkScheduleDetail extends WorkSchedule {
    assignments: ShiftAssignment[];
    leaves: LeaveOverlay[];
    pending_changes: ShiftChangeRequest[];
    holidays: PublicHoliday[];
    working_days: WorkingDaysSummary[];
}

export interface LeaveOverlay {
    employee_id: string;
    leave_type: string;
    start_date: string;
    end_date: string;
}

export interface WorkScheduleListResponse {
    items: WorkSchedule[];
    total: number;
    page: number;
    page_size: number;
}

/**
 * How a cell is drawn, from its shift_codes row (styleOf in useShiftCodes).
 *
 * `blankInGrid` reproduces the one quirk of the spreadsheet: a break day is
 * drawn as a plain cyan block with no letter in it.
 */
export interface ShiftStyle {
    /** Exact fill from the spreadsheet. */
    bg: string;
    /** Legible text colour on that fill. */
    fg: string;
    label: string;
    blankInGrid?: boolean;
}


/** A name for a roster row. Deliberately not the full employee record. */
export interface ScheduleEmployee {
    id: string;
    employee_id: string;
    first_name: string;
    last_name: string;
    position: string;
    work_pattern: string;
    is_backup_engineer: boolean;
}
