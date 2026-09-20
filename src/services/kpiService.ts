import api from "@/lib/api";
import type {
    KpiPeriodType,
    KpiReviewDetail,
    KpiReviewSummary,
    KpiTemplateSummary,
} from "@/types/kpi";

export interface KpiReviewCreateData {
    employee_id: string;
    period_type: KpiPeriodType;
    period_label: string;
    period_start: string;
    period_end: string;
}

export interface KpiItemUpdateData {
    rating?: number | null;
    is_not_applicable?: boolean;
    actual_result?: string | null;
    evidence_note?: string | null;
}

export const kpiService = {
    listTemplates(): Promise<{ data: KpiTemplateSummary[] }> {
        return api.get("/kpi/templates");
    },

    listReviews(employeeId?: string): Promise<{
        data: { items: KpiReviewSummary[]; total: number };
    }> {
        return api.get("/kpi/reviews", {
            params: employeeId ? { employee_id: employeeId } : {},
        });
    },

    getReview(id: string): Promise<{ data: KpiReviewDetail }> {
        return api.get(`/kpi/reviews/${id}`);
    },

    createReview(data: KpiReviewCreateData): Promise<{ data: KpiReviewDetail }> {
        return api.post("/kpi/reviews", data);
    },

    /** Rating one line returns the whole review, so the total stays in step. */
    updateItem(
        reviewId: string,
        itemId: string,
        data: KpiItemUpdateData
    ): Promise<{ data: KpiReviewDetail }> {
        return api.patch(`/kpi/reviews/${reviewId}/items/${itemId}`, data);
    },

    updateReview(
        reviewId: string,
        data: {
            assessor_comment?: string;
            hard_gate_triggered?: boolean;
            hard_gate_note?: string;
            critical_gate_cleared?: boolean;
            target_bonus_amount?: number | null;
            bonus_available?: boolean;
            current_basic_salary?: number | null;
            approved_increase_pct?: number | null;
        }
    ): Promise<{ data: KpiReviewDetail }> {
        return api.patch(`/kpi/reviews/${reviewId}`, data);
    },

    submit(reviewId: string): Promise<{ data: KpiReviewDetail }> {
        return api.post(`/kpi/reviews/${reviewId}/submit`);
    },

    approve(reviewId: string, comment?: string): Promise<{ data: KpiReviewDetail }> {
        return api.post(`/kpi/reviews/${reviewId}/approve`, { comment });
    },

    return(reviewId: string, comment: string): Promise<{ data: KpiReviewDetail }> {
        return api.post(`/kpi/reviews/${reviewId}/return`, { comment });
    },

    deleteReview(reviewId: string): Promise<void> {
        return api.delete(`/kpi/reviews/${reviewId}`);
    },
};
