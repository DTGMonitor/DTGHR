export enum ScheduleStatus {
    DRAFT = "draft",
    PUBLISHED = "published",
}

export enum ShiftCode {
    DS = "DS",   // Dayshift
    NS = "NS",   // Night Shift
    C = "C",     // Cross (overnight)
    B = "B",     // Break
    D = "D",     // Day only
    O = "O",     // Swap Off
}

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
}

export interface WorkScheduleListResponse {
    items: WorkSchedule[];
    total: number;
    page: number;
    page_size: number;
}

/** Colors for each shift code badge in the grid */
export const SHIFT_COLORS: Record<ShiftCode, { bg: string; text: string; label: string }> = {
    [ShiftCode.DS]: { bg: "bg-blue-500/80", text: "text-white", label: "Dayshift" },
    [ShiftCode.NS]: { bg: "bg-indigo-600/80", text: "text-white", label: "Night" },
    [ShiftCode.C]: { bg: "bg-amber-500/80", text: "text-white", label: "Cross" },
    [ShiftCode.B]: { bg: "bg-emerald-500/80", text: "text-white", label: "Break" },
    [ShiftCode.D]: { bg: "bg-gray-400/60", text: "text-white", label: "Day only" },
    [ShiftCode.O]: { bg: "bg-purple-500/70", text: "text-white", label: "Swap Off" },
};
