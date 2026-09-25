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
    leave: {
        total: number;
        used: number;
        remaining: number;
        /** The next approved leave, if any is booked ahead. */
        next_from?: string;
        next_to?: string;
    } | null;
    /** Open tickets in the queue — IT support only, else null. */
    tickets_open: number | null;
    /** Open tickets this person raised themselves. */
    my_tickets_open: number;
    pending_mine: number;
    /** Management only; null otherwise. */
    pending_approvals: number | null;
    on_leave_today: number | null;
    /** Active employees. Management only; null otherwise. */
    headcount: number | null;
    /**
     * Salary reviews sitting on this person's signature.
     *
     * Nurhuda: the approvals worth putting on a dashboard are leave and
     * salary. The scorecard queue lives on the KPI page, which is where you go
     * to work through it.
     */
    salary_awaiting: number | null;
    /** The payroll run sitting on this person's signature, if any. */
    payroll_awaiting: { count: number; label: string | null } | null;
    /** Finance requests sent back to finance, with the reason. Finance only. */
    finance_sent_back: { reference: string; title: string; note: string | null }[] | null;
    /** Finance only: what is on their desk right now. */
    payroll_desk: {
        sent_back: { label: string; note: string | null }[];
        this_month: string;
        this_month_status: string | null;
        days_left: number;
        due_soon: boolean;
        not_started: boolean;
    } | null;
    /** Scorecards waiting on this person's signature. Management only. */
    kpi_awaiting: number | null;
    /**
     * The same queues by name, for the sentence at the top: whose leave,
     * which month's payroll from whom. Management only.
     */
    approvals: {
        leave: { name: string; leave_type: string; start: string; end: string; days: number }[];
        payroll: {
            label: string;
            submitted_by: string | null;
            /** Set when the executive sent it back to the director's review. */
            sent_back_note: string | null;
            sent_back_by: string | null;
        }[];
        salary: { name: string }[];
        kpi: { name: string; period: string }[];
        /** Finance requests on this person's review (director) or approval (executive). */
        finance: {
            reference: string;
            title: string;
            total: number;
            requested_by: string | null;
            /** Set when the executive sent it back to the director's review. */
            sent_back_note: string | null;
            sent_back_by: string | null;
        }[];
    } | null;
    /**
     * Who is covering the site today, by first name. Management only.
     *
     * Names, and nothing else -- this is a roster fact, not a personnel one.
     */
    on_duty: { dayshift: string[]; nightshift: string[]; on_leave: string[] } | null;
    /** The next public holiday of any month, so the band always has one. */
    next_holiday: { date: string; name: string } | null;
}

export const overviewService = {
    get(): Promise<{ data: Overview }> {
        return api.get("/overview");
    },
};
