import { useEffect, useState } from "react";
import { kpiService } from "@/services/kpiService";
import { BONUS_TIERS, formatRupiah, type KpiReviewDetail } from "@/types/kpi";
import Icon from "@/components/ui/icons";
import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";

/**
 * Bonus and salary outcome, from DTG_KPI_Bonus_Scorecards_2026.
 *
 * The score is the input; everything here follows from it plus three decisions
 * only a person can make — whether the integrity gate cleared, what the target
 * bonus was agreed at, and whether the company can fund one this year.
 *
 * The multiplier tiers are not the performance bands. A scorecard can read
 * "Meets Expectations" and still earn only half a target bonus, because the
 * band starts at 85 and a full bonus starts at 95. Both are shown so the gap
 * is visible rather than surprising.
 */
export default function RewardPanel({
    review,
    onChange,
}: {
    review: KpiReviewDetail;
    onChange: (updated: KpiReviewDetail) => void;
}) {
    // Not `can_edit`: the ratings lock on submission, the reward does not.
    const editable = review.can_edit_reward;

    const [target, setTarget] = useState(review.target_bonus_amount ?? "");
    const [salary, setSalary] = useState(review.current_basic_salary ?? "");
    const [increase, setIncrease] = useState(review.approved_increase_pct ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setTarget(review.target_bonus_amount ?? "");
        setSalary(review.current_basic_salary ?? "");
        setIncrease(review.approved_increase_pct ?? "");
    }, [review.id, review.target_bonus_amount, review.current_basic_salary, review.approved_increase_pct]);

    const save = async (patch: Parameters<typeof kpiService.updateReview>[1]) => {
        setSaving(true);
        setError(null);
        try {
            const res = await kpiService.updateReview(review.id, patch);
            onChange(res.data);
        } catch (err) {
            const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
            setError(detail ?? "Could not save.");
        } finally {
            setSaving(false);
        }
    };

    const numberOrNull = (v: string | number) =>
        v === "" || v === null ? null : Number(v);

    const blocked = review.reward_blocked_reason;

    /*
     * Peter, September 2026: salary reviews, increases and bonuses are
     * discretionary -- they turn on company performance as well as individual
     * performance -- so none of this calculation is shared with staff.
     *
     * The server already withholds the figures from anyone outside the review
     * chain; this is the matching decision not to draw an empty panel where
     * they would have been. An interface that shows a greyed-out bonus box
     * still tells the reader a bonus exists.
     */
    if (!review.can_see_reward) return null;

    /*
     * And annual bonuses are not offered outside management roles at this
     * stage, so for everyone else the bonus is absent rather than zero. The
     * multiplier stays: Peter kept it for salary reviews.
     */
    const showBonus = review.bonus_applies;

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="flex items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
                <div>
                    <p className="dtg-eyebrow">Reward</p>
                    <h3 className="mt-0.5 text-sm font-semibold text-paper">
                        {showBonus ? "Bonus & salary outcome" : "Salary review"}
                    </h3>
                </div>
                {saving && <Spinner className="h-4 w-4 text-signal" />}
            </header>

            <div className="space-y-5 p-5">
                {error && <Alert tone="danger">{error}</Alert>}

                {blocked ? (
                    <Alert tone={review.is_complete ? "danger" : "info"}>{blocked}</Alert>
                ) : (
                    /* ── The outcome ────────────────────────────────────── */
                    <div className={`grid grid-cols-1 gap-3 ${showBonus ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
                        <div className="dtg-panel-inset p-4">
                            <p className="dtg-eyebrow">Multiplier</p>
                            <p className="mt-2 font-mono text-2xl font-semibold leading-none text-paper">
                                ×{review.bonus_multiplier}
                            </p>
                            <p className="mt-1.5 text-micro text-muted">
                                {review.bonus_multiplier_label}
                            </p>
                        </div>
                        {showBonus && (
                            <div className="dtg-panel-inset border-l-2 border-l-signal p-4">
                                <p className="dtg-eyebrow">Recommended bonus</p>
                                <p className="mt-2 font-mono text-xl font-semibold leading-none text-paper">
                                    {formatRupiah(review.recommended_bonus)}
                                </p>
                                <p className="mt-1.5 text-micro text-muted">
                                    target × multiplier
                                </p>
                            </div>
                        )}
                        <div className="dtg-panel-inset p-4">
                            <p className="dtg-eyebrow">Proposed basic salary</p>
                            <p className="mt-2 font-mono text-xl font-semibold leading-none text-paper">
                                {formatRupiah(review.proposed_basic_salary)}
                            </p>
                            <p className="mt-1.5 text-micro text-muted">
                                {review.approved_increase_pct
                                    ? `+${review.approved_increase_pct}% approved`
                                    : "no increase entered"}
                            </p>
                        </div>
                    </div>
                )}

                {review.salary_review_status && !blocked && (
                    <p className="text-xs leading-relaxed text-paper-soft">
                        <span className="dtg-eyebrow">Salary review</span>{" "}
                        {review.salary_review_status}
                    </p>
                )}

                {!showBonus && (
                    <p className="text-xs leading-relaxed text-muted">
                        No annual bonus applies to this role. The multiplier informs the
                        salary review only, and is not shared with the employee.
                    </p>
                )}

                {/* ── The decisions ──────────────────────────────────────── */}
                <div className="grid grid-cols-1 gap-4 border-t border-white/[0.08] pt-5 sm:grid-cols-2">
                    <Toggle
                        label="Critical / integrity gate cleared"
                        help="No means no KPI-linked reward, whatever the score."
                        checked={review.critical_gate_cleared}
                        disabled={!editable}
                        onChange={(v) => save({ critical_gate_cleared: v })}
                    />
                    {showBonus && (
                        <Toggle
                            label="Bonus available from company"
                            help="When it is not, the outcome routes to a salary review instead."
                            checked={review.bonus_available}
                            disabled={!editable}
                            onChange={(v) => save({ bonus_available: v })}
                        />
                    )}

                    {showBonus && (
                        <Money
                            label="Target bonus amount"
                            value={target}
                            disabled={!editable}
                            onChange={setTarget}
                            onCommit={() => save({ target_bonus_amount: numberOrNull(target) })}
                            help="Agreed before the period. The bonus at target performance."
                        />
                    )}
                    <Money
                        label="Current monthly basic salary"
                        value={salary}
                        disabled={!editable}
                        onChange={setSalary}
                        onCommit={() => save({ current_basic_salary: numberOrNull(salary) })}
                    />

                    <div>
                        <label className="dtg-label">Approved salary increase %</label>
                        <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.5}
                            value={increase}
                            disabled={!editable}
                            onChange={(e) => setIncrease(e.target.value)}
                            onBlur={() => save({ approved_increase_pct: numberOrNull(increase) })}
                            className="dtg-input"
                            placeholder="0"
                        />
                        <p className="mt-1.5 text-micro leading-relaxed text-muted">
                            Not automatic. Enter only what has actually been approved.
                        </p>
                    </div>
                </div>

                {/* ── The scale, for reference ───────────────────────────── */}
                <details className="border-t border-white/[0.08] pt-4">
                    <summary className="cursor-pointer text-micro font-semibold uppercase tracking-label text-teal-300 hover:text-teal-100">
                        Bonus tiers
                    </summary>
                    <ul className="mt-3 space-y-1.5">
                        {BONUS_TIERS.map((tier) => {
                            const active =
                                review.is_complete &&
                                (review.total_score ?? 0) >= tier.min &&
                                review.bonus_multiplier === tier.multiplier;
                            return (
                                <li
                                    key={tier.min}
                                    className={`flex items-center justify-between rounded px-2.5 py-1.5 font-mono text-micro ${
                                        active
                                            ? "bg-signal/10 text-signal"
                                            : "text-muted"
                                    }`}
                                >
                                    <span>
                                        {tier.min === 0 ? "below 85" : `${tier.min} and above`}
                                    </span>
                                    <span>×{tier.multiplier}</span>
                                    <span className="hidden sm:inline">{tier.label}</span>
                                    {active && <Icon name="check" className="h-3.5 w-3.5" />}
                                </li>
                            );
                        })}
                    </ul>
                </details>
            </div>
        </section>
    );
}

function Toggle({
    label,
    help,
    checked,
    disabled,
    onChange,
}: {
    label: string;
    help?: string;
    checked: boolean;
    disabled: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <div className="dtg-panel-inset flex items-start justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
                <p className="text-sm font-medium text-paper">{label}</p>
                {help && <p className="mt-0.5 text-micro leading-relaxed text-muted">{help}</p>}
            </div>
            <label className="relative inline-flex flex-shrink-0 cursor-pointer items-center">
                <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.checked)}
                />
                <span className="sr-only">{label}</span>
                <div className="peer h-6 w-11 rounded-full border border-white/15 bg-deep transition-colors after:absolute after:left-[3px] after:top-[3px] after:h-4 after:w-4 after:rounded-full after:bg-paper-soft after:transition-all after:content-[''] peer-checked:border-signal/50 peer-checked:bg-signal/25 peer-checked:after:translate-x-full peer-checked:after:bg-signal peer-disabled:opacity-50" />
            </label>
        </div>
    );
}

function Money({
    label,
    value,
    disabled,
    onChange,
    onCommit,
    help,
}: {
    label: string;
    value: string | number;
    disabled: boolean;
    onChange: (v: string) => void;
    onCommit: () => void;
    help?: string;
}) {
    return (
        <div>
            <label className="dtg-label">{label}</label>
            <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted">
                    Rp
                </span>
                <input
                    type="number"
                    min={0}
                    step={100000}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value)}
                    onBlur={onCommit}
                    className="dtg-input pl-9 font-mono"
                    placeholder="0"
                />
            </div>
            {help && <p className="mt-1.5 text-micro leading-relaxed text-muted">{help}</p>}
        </div>
    );
}
