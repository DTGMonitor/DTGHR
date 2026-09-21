/**
 * Performance scorecards.
 *
 * Mirrors the DTG role KPI documents (v1.1): ten weighted KPIs per role, rated
 * 0-5, where each rating maps to an achievement factor. A card where every line
 * is rated 5 totals 130, which is why scores are out of 130 and not 100.
 */

export type KpiPeriodType = "quarterly" | "half_year" | "annual";

export type KpiReviewStatus =
    | "draft"
    | "submitted"
    | "approved"
    | "returned"
    /** Released to the person it is about. Read-only for everyone. */
    | "published";

export const KPI_PERIOD_LABELS: Record<KpiPeriodType, string> = {
    quarterly: "Quarterly check-in",
    half_year: "Half-year calibration",
    annual: "Annual outcome",
};

export const KPI_STATUS_LABELS: Record<KpiReviewStatus, string> = {
    draft: "Draft",
    submitted: "Awaiting approval",
    approved: "Approved",
    returned: "Returned for revision",
    published: "Published to employee",
};

/** Rating -> factor, from section 5 of the role documents. */
export const KPI_RATINGS: { rating: number; label: string; factor: number }[] = [
    { rating: 5, label: "Exceptional", factor: 1.3 },
    { rating: 4, label: "Above target", factor: 1.15 },
    { rating: 3, label: "Meets target", factor: 1.0 },
    { rating: 2, label: "Partly meets", factor: 0.75 },
    { rating: 1, label: "Below target", factor: 0.5 },
    { rating: 0, label: "Not achieved", factor: 0 },
];

/** A scorecard where every line is rated 5. */
export const KPI_MAX_SCORE = 130;

/**
 * The multiplier by weighted score, from DTG_KPI_Bonus_Scorecards_2026.
 *
 * Note these are NOT the performance-band cut-points. A score of 90 is
 * "Meets Expectations" as a band but earns only half the multiplier — the
 * workbook intends both statements to be true at once.
 *
 * Two labels per tier, and the distinction matters. Bonuses are offered to
 * management roles only, so outside those the scale must be described without
 * the word: the multiplier still applies, to salary reviews, but a table that
 * says "target bonus" to an engineer describes something they are not offered.
 */
export const MULTIPLIER_TIERS: {
    min: number;
    multiplier: number;
    /** Neutral wording. Used for every role. */
    label: string;
    /** Bonus wording. Management roles only. */
    bonusLabel: string;
}[] = [
    { min: 115, multiplier: 1.5, label: "Well above target", bonusLabel: "150% of target bonus" },
    { min: 105, multiplier: 1.25, label: "Above target", bonusLabel: "125% of target bonus" },
    { min: 95, multiplier: 1.0, label: "At target", bonusLabel: "Target bonus" },
    { min: 85, multiplier: 0.5, label: "Below target", bonusLabel: "Half of target bonus" },
    { min: 0, multiplier: 0, label: "No adjustment", bonusLabel: "No KPI bonus" },
];

/** Rupiah, no decimals — amounts here are always whole rupiah. */
export function formatRupiah(value: number | null | undefined): string {
    if (value === null || value === undefined) return "—";
    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
    }).format(value);
}

export interface KpiTemplateSummary {
    id: string;
    code: string;
    title: string;
    version: string;
    bands: string | null;
    item_count: number;
}

export interface KpiReviewItem {
    id: string;
    number: string;
    category: string | null;
    name: string;
    weight: number;
    target: string | null;
    how_measured: string | null;
    evidence: string | null;
    sort_order: number;

    rating: number | null;
    is_not_applicable: boolean;
    actual_result: string | null;
    evidence_note: string | null;

    /** Weight after not-applicable lines were removed and the rest renormalised. */
    effective_weight: number;
    factor: number | null;
    points: number;
}

export interface KpiReviewSummary {
    id: string;
    employee_id: string;
    employee_name: string | null;
    period_type: KpiPeriodType;
    period_label: string;
    period_start: string;
    period_end: string;
    status: KpiReviewStatus;
    total_score: number | null;
    band: string | null;
    band_code: string | null;
    band_label: string | null;
    is_complete: boolean;
    hard_gate_triggered: boolean;
    updated_at: string;
}

export interface KpiReviewDetail extends KpiReviewSummary {
    template_id: string | null;
    template_title: string | null;
    template_bands: string | null;

    assessor_id: string | null;
    assessor_name: string | null;
    approver_id: string | null;
    approver_name: string | null;

    submitted_at: string | null;
    approved_at: string | null;

    assessor_comment: string | null;
    approver_comment: string | null;
    hard_gate_note: string | null;

    max_score: number;
    rated_count: number;
    applicable_count: number;
    not_applicable_count: number;

    /** Resolved server-side, so the client never re-derives the review rules. */
    can_edit: boolean;
    can_submit: boolean;
    can_approve: boolean;
    /** Looser than can_edit: the reward is decided after the ratings lock. */
    can_edit_reward: boolean;
    /** Release an approved scorecard to its subject. The approver's. */
    can_publish: boolean;
    /** Withdraw a published one for correction. The administrator's. */
    can_unpublish: boolean;
    /** Discard every rating and start again. The administrator's. */
    can_reset: boolean;
    /**
     * Whether the reward block is shown at all. False for the subject of the
     * review: salary and bonus are discretionary and are not shared with staff.
     */
    can_see_reward: boolean;
    /**
     * Whether an annual bonus exists for this role. False outside management
     * roles, and then no bonus is shown at all rather than a bonus of zero.
     */
    bonus_applies: boolean;
    published_at: string | null;

    // ── Reward ──────────────────────────────────────────────────────────
    critical_gate_cleared: boolean;
    target_bonus_amount: number | null;
    bonus_available: boolean;
    current_basic_salary: number | null;
    approved_increase_pct: number | null;

    /** Derived from the score, server-side. */
    bonus_multiplier: number;
    bonus_multiplier_label: string;
    recommended_bonus: number | null;
    proposed_basic_salary: number | null;
    salary_review_status: string;
    reward_blocked_reason: string | null;

    items: KpiReviewItem[];
}

/** Band colour by code, shared by the chip and the score bar. */
export const BAND_TONES: Record<string, string> = {
    "1": "border-danger/35 bg-danger/10 text-danger",
    "2L": "border-gold/35 bg-gold/10 text-gold",
    "2M": "border-teal-300/35 bg-teal-300/10 text-teal-300",
    "2H": "border-signal/35 bg-signal/10 text-signal",
    "3": "border-signal/50 bg-signal/20 text-signal",
};
