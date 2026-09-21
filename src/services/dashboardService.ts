import api from "@/lib/api";

export interface OverviewDay {
    date: string;
    code: string | null;
    label: string | null;
    holiday: string | null;
    is_today: boolean;
}

export interface Overview {
    is_management: boolean;
    has_employee_record: boolean;
    week: OverviewDay[];
    holidays: { date: string; name: string; is_national: boolean }[];
    /** Null for anyone who carries no annual balance -- the founders. */
    leave: { total: number; used: number; remaining: number } | null;
    pending_mine: number;
    /** Management only; null otherwise. */
    pending_approvals: number | null;
    on_leave_today: number | null;
}

export const overviewService = {
    get(): Promise<{ data: Overview }> {
        return api.get("/overview");
    },
};
