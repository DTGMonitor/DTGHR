export enum ScheduleStatus {
    DRAFT = "draft",
    PUBLISHED = "published",
}

/**
 * The absence-type key from the STAFF ROSTER workbook. Codes and colours are
 * kept identical to the spreadsheet so the grid reads the same to anyone who
 * has been living in that file.
 */
export enum ShiftCode {
    DS = "DS",   // Dayshift
    NS = "NS",   // Night shift
    C = "C",     // Cross (overnight)
    B = "B",     // Break
    D = "D",     // Day only
    O = "O",     // Swap off
    AL = "AL",   // Annual leave
    SL = "SL",   // Sick leave
    DL = "DL",   // Discretionary leave day
    PH = "PH",   // Public holiday
    TW = "TW",   // Travel work
    ST = "ST",   // Study leave
    T = "T",     // Training
}

export enum ShiftChangeStatus {
    PENDING = "pending",
    APPROVED = "approved",
    REJECTED = "rejected",
    /** Some days in the proposal were accepted, others turned down. */
    PARTIALLY_APPROVED = "partially_approved",
    CANCELLED = "cancelled",
}

/** Codes that count towards the "Total days" column — matches the backend. */
export const WORKING_DAY_CODES: ShiftCode[] = [
    ShiftCode.DS,
    ShiftCode.NS,
    ShiftCode.C,
    ShiftCode.D,
];

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
 * Cell styling, lifted straight out of the workbook's fills.
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

export const SHIFT_STYLES: Record<ShiftCode, ShiftStyle> = {
    [ShiftCode.DS]: { bg: "#FFFF00", fg: "#000000", label: "Dayshift" },
    [ShiftCode.NS]: { bg: "#002060", fg: "#FFFFFF", label: "Night" },
    [ShiftCode.C]: { bg: "#F59D87", fg: "#000000", label: "Cross" },
    [ShiftCode.B]: { bg: "#00B0F0", fg: "#FFFFFF", label: "Break", blankInGrid: true },
    [ShiftCode.D]: { bg: "#B8DFC9", fg: "#000000", label: "Day only" },
    [ShiftCode.O]: { bg: "#591BB6", fg: "#FFFFFF", label: "Swap off" },
    [ShiftCode.AL]: { bg: "#AFABAB", fg: "#FFFFFF", label: "Annual leave" },
    [ShiftCode.SL]: { bg: "#D8A141", fg: "#000000", label: "Sick leave" },
    [ShiftCode.DL]: { bg: "#0070C0", fg: "#FFFFFF", label: "Discretionary leave" },
    [ShiftCode.PH]: { bg: "#00B050", fg: "#000000", label: "Public holiday" },
    [ShiftCode.TW]: { bg: "#CC3610", fg: "#FFFFFF", label: "Travel work" },
    [ShiftCode.ST]: { bg: "#CC3610", fg: "#FFFFFF", label: "Study leave" },
    [ShiftCode.T]: { bg: "#7030A0", fg: "#FFFFFF", label: "Training" },
};

/** Legend order, matching the "Absence type key" row of the workbook. */
export const SHIFT_CODE_ORDER: ShiftCode[] = [
    ShiftCode.DS,
    ShiftCode.NS,
    ShiftCode.C,
    ShiftCode.D,
    ShiftCode.B,
    ShiftCode.AL,
    ShiftCode.SL,
    ShiftCode.DL,
    ShiftCode.PH,
    ShiftCode.O,
    ShiftCode.TW,
    ShiftCode.ST,
    ShiftCode.T,
];
