import api from "@/lib/api";

// No "endorsed": the director writes the proposal, so there is nobody left
// to endorse it before the CEO sees it.
export type SalaryStatus = "draft" | "submitted" | "approved" | "declined";

export interface SalaryReview {
    id: string;
    employee_id: string;
    employee_name: string;
    employee_position: string | null;
    effective_date: string;
    current_amount: number;
    proposed_amount: number;
    currency: string;
    rationale: string | null;
    status: SalaryStatus;
    /** The role it is sitting on, or null when it is finished. */
    awaiting_role: string | null;
    endorsement_note: string | null;
    decline_reason: string | null;
    submitted_at: string | null;
    endorsed_at: string | null;
    approved_at: string | null;
}

export interface SalaryReviewList {
    items: SalaryReview[];
    /** What this caller may do. The server decides; the page only obeys. */
    can_prepare: boolean;
    can_endorse: boolean;
    can_approve: boolean;
    awaiting_me: number;
}

export interface SalaryDraft {
    employee_id: string;
    effective_date: string;
    current_amount: number;
    proposed_amount: number;
    currency?: string;
    rationale?: string | null;
}

/**
 * One person's KPI result, next to where their salary review stands. The
 * scorecard no longer shows any of the reward; this is where it lives.
 */
export interface KpiSummaryRow {
    employee_id: string;
    employee_name: string;
    employee_position: string | null;
    /** Set when the person is not assessed this year, and why. */
    kpi_exemption_reason: string | null;

    kpi_review_id: string | null;
    period_label: string | null;
    kpi_status: "draft" | "submitted" | "approved" | "returned" | "published" | null;
    total_score: number | null;
    max_score: number;
    is_complete: boolean;
    band_code: string | null;
    band_label: string | null;
    critical_gate_cleared: boolean;
    hard_gate_triggered: boolean;
    /** From management's band table, once the scorecard is approved. */
    recommended_increase_pct: number | null;
    /** Where the figure came from, or why there is none yet. Null when there is no scorecard. */
    recommendation_note: string | null;
    can_edit_gate: boolean;

    /** Where a new review starts from: the last approved figure, else the old scorecard's. */
    current_salary: number | null;

    salary_review_id: string | null;
    salary_review_status: SalaryStatus | null;
    salary_review_effective_date: string | null;
    salary_review_proposed_amount: number | null;
}

export const salaryService = {
    list: () => api.get<SalaryReviewList>("/salary-reviews"),
    kpiSummary: () => api.get<{ items: KpiSummaryRow[] }>("/salary-reviews/kpi-summary"),
    create: (body: SalaryDraft) => api.post<SalaryReview>("/salary-reviews", body),
    update: (id: string, body: Partial<SalaryDraft>) =>
        api.patch<SalaryReview>(`/salary-reviews/${id}`, body),
    submit: (id: string) => api.post<SalaryReview>(`/salary-reviews/${id}/submit`),
    endorse: (id: string, note?: string) =>
        api.post<SalaryReview>(`/salary-reviews/${id}/endorse`, { note: note ?? null }),
    approve: (id: string, note?: string) =>
        api.post<SalaryReview>(`/salary-reviews/${id}/approve`, { note: note ?? null }),
    decline: (id: string, note: string) =>
        api.post<SalaryReview>(`/salary-reviews/${id}/decline`, { note }),
    remove: (id: string) => api.delete(`/salary-reviews/${id}`),
};

/** Whole rupiah, grouped. Salary figures are never shown with decimals. */
export function money(amount: number, currency = "IDR"): string {
    return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
    }).format(amount);
}
