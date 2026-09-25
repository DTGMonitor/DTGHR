import { useCallback, useEffect, useMemo, useState } from "react";
import { useDialog } from "@/components/ui/Dialog";
import { kpiService } from "@/services/kpiService";
import type { EmployeeDetail } from "@/types/employee";
import {
    BAND_TONES,
    KPI_RATINGS,
    KPI_STATUS_LABELS,
    type KpiReviewDetail,
    type KpiReviewItem,
    type KpiReviewSummary,
} from "@/types/kpi";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";
import Alert from "@/components/ui/Alert";

/** The current review year. Reviews are annual — the reward model works on a
 *  full year, so a quarterly card could never produce a bonus figure. */
function currentPeriod(): { label: string; start: string; end: string } {
    const year = new Date().getFullYear();
    return { label: String(year), start: `${year}-01-01`, end: `${year}-12-31` };
}

function BandChip({ code, label }: { code: string | null; label: string | null }) {
    if (!code) {
        return (
            <span className="dtg-chip border-white/12 bg-white/[0.04] text-muted">
                Not yet banded
            </span>
        );
    }
    return (
        <span className={`dtg-chip ${BAND_TONES[code] ?? "border-white/12 text-paper-soft"}`}>
            Band {code} · {label}
        </span>
    );
}

/** The out-of-130 total, with the band thresholds marked along the track. */
function ScoreBar({ review }: { review: KpiReviewDetail }) {
    const pct = Math.min(100, ((review.total_score ?? 0) / review.max_score) * 100);
    const marks = [70, 85, 105, 115];

    return (
        <div>
            <div className="flex items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-2">
                    <span className="font-mono text-3xl font-semibold leading-none tracking-tight text-paper">
                        {review.is_complete ? (review.total_score ?? 0).toFixed(1) : "—"}
                    </span>
                    <span className="font-mono text-xs text-muted">/ {review.max_score}</span>
                </div>
                <BandChip code={review.band_code} label={review.band_label} />
            </div>

            <div className="relative mt-3 h-1.5 overflow-hidden rounded-sm bg-white/10">
                <div
                    className={`h-full rounded-sm transition-all duration-500 ${
                        review.is_complete ? "bg-signal" : "bg-teal-500"
                    }`}
                    style={{ width: `${pct}%` }}
                />
                {marks.map((m) => (
                    <span
                        key={m}
                        className="absolute top-0 h-full w-px bg-deep/70"
                        style={{ left: `${(m / review.max_score) * 100}%` }}
                        aria-hidden="true"
                    />
                ))}
            </div>

            <p className="mt-2 font-mono text-micro text-muted">
                {review.rated_count}/{review.applicable_count} rated
                {review.not_applicable_count > 0 && ` · ${review.not_applicable_count} N/A`}
            </p>
        </div>
    );
}

function RatingPicker({
    item,
    disabled,
    onPick,
}: {
    item: KpiReviewItem;
    disabled: boolean;
    onPick: (rating: number | null, notApplicable: boolean) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-1">
            {KPI_RATINGS.map((r) => {
                const active = !item.is_not_applicable && item.rating === r.rating;
                return (
                    <button
                        key={r.rating}
                        type="button"
                        disabled={disabled}
                        onClick={() => onPick(r.rating, false)}
                        title={`${r.label} — factor ${Math.round(r.factor * 100)}%`}
                        aria-pressed={active}
                        className={`h-7 w-7 rounded border font-mono text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            active
                                ? "border-signal bg-signal text-signal-on"
                                : "border-white/12 bg-white/[0.03] text-paper-soft hover:border-white/25 hover:text-paper"
                        }`}
                    >
                        {r.rating}
                    </button>
                );
            })}
            <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(null, !item.is_not_applicable)}
                title="Not applicable this period — the weight is shared across the other KPIs"
                aria-pressed={item.is_not_applicable}
                className={`ml-1 h-7 rounded border px-2 font-mono text-micro font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    item.is_not_applicable
                        ? "border-gold bg-gold/20 text-gold"
                        : "border-white/12 bg-white/[0.03] text-muted hover:border-white/25 hover:text-paper-soft"
                }`}
            >
                N/A
            </button>
        </div>
    );
}

function ScorecardLine({
    item,
    editable,
    onChange,
}: {
    item: KpiReviewItem;
    editable: boolean;
    onChange: (patch: { rating?: number | null; is_not_applicable?: boolean; actual_result?: string }) => void;
}) {
    const [open, setOpen] = useState(false);
    const [actual, setActual] = useState(item.actual_result ?? "");
    const hasNote = Boolean(item.actual_result?.trim());

    useEffect(() => setActual(item.actual_result ?? ""), [item.actual_result]);

    return (
        <li className="border-b border-white/[0.06] last:border-b-0">
            <div className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-start lg:gap-5">
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                        <span className="font-mono text-micro text-teal-300">{item.number}</span>
                        {item.category && (
                            <span className="text-micro font-semibold uppercase tracking-label text-muted">
                                {item.category}
                            </span>
                        )}
                    </div>
                    <p className="mt-1 text-sm font-medium text-paper">{item.name}</p>

                    {/* One disclosure for the whole line. Ten permanently open
                        note boxes made the scorecard several screens long and
                        buried the ratings, which are what the reviewer is
                        actually here to set. */}
                    <button
                        type="button"
                        onClick={() => setOpen((o) => !o)}
                        aria-expanded={open}
                        className="mt-1.5 inline-flex items-center gap-1.5 text-micro font-semibold uppercase tracking-label text-teal-300 transition-colors hover:text-teal-100"
                    >
                        <svg
                            className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
                            viewBox="0 0 24 24" fill="none" strokeWidth={2.5}
                            stroke="currentColor" aria-hidden="true"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
                        </svg>
                        Target, evidence &amp; notes
                        {hasNote && !open && (
                            <span
                                className="h-1.5 w-1.5 rounded-full bg-signal"
                                title="A note has been recorded"
                            />
                        )}
                    </button>

                    {open && (
                        <div className="mt-2.5 space-y-3">
                            <dl className="dtg-panel-inset space-y-2.5 p-3 text-xs">
                                {[
                                    ["Target", item.target],
                                    ["How it is measured", item.how_measured],
                                    ["Evidence", item.evidence],
                                ].map(([label, value]) =>
                                    value ? (
                                        <div key={label as string}>
                                            <dt className="dtg-eyebrow">{label}</dt>
                                            <dd className="mt-1 leading-relaxed text-paper-soft">
                                                {value}
                                            </dd>
                                        </div>
                                    ) : null
                                )}
                            </dl>

                            <div>
                                <label className="dtg-label mb-1">
                                    Actual result / evidence note
                                </label>
                                {editable ? (
                                    <textarea
                                        value={actual}
                                        onChange={(e) => setActual(e.target.value)}
                                        onBlur={() => {
                                            if (actual !== (item.actual_result ?? "")) {
                                                onChange({ actual_result: actual });
                                            }
                                        }}
                                        placeholder="What was achieved, and where the evidence sits"
                                        className="dtg-input min-h-[3.5rem] resize-y text-xs"
                                    />
                                ) : (
                                    <p className="text-xs leading-relaxed text-paper-soft">
                                        {item.actual_result || (
                                            <span className="text-muted">No note recorded</span>
                                        )}
                                    </p>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex flex-shrink-0 flex-col gap-2 lg:w-64 lg:items-end">
                    <RatingPicker
                        item={item}
                        disabled={!editable}
                        onPick={(rating, na) =>
                            onChange(na ? { is_not_applicable: true } : { rating, is_not_applicable: false })
                        }
                    />
                    <p className="font-mono text-micro text-muted">
                        {item.is_not_applicable ? (
                            <>weight {item.weight}% reallocated</>
                        ) : (
                            <>
                                {item.effective_weight.toFixed(1)}%
                                {item.factor !== null && ` × ${Math.round(item.factor * 100)}%`}
                                {item.rating !== null && ` = ${item.points.toFixed(1)} pts`}
                            </>
                        )}
                    </p>
                </div>
            </div>
        </li>
    );
}

export default function KpiReviewPanel({ employee }: { employee: EmployeeDetail }) {
    const [reviews, setReviews] = useState<KpiReviewSummary[]>([]);
    const [active, setActive] = useState<KpiReviewDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const { confirm, prompt } = useDialog();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const period = useMemo(currentPeriod, []);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await kpiService.listReviews(employee.id);
            setReviews(res.data.items);
            // Newest period first, so this opens the one being worked on.
            const latest = res.data.items[0];
            if (latest) {
                const detail = await kpiService.getReview(latest.id);
                setActive(detail.data);
            } else {
                setActive(null);
            }
        } catch {
            setError("Could not load scorecards.");
        } finally {
            setLoading(false);
        }
    }, [employee.id]);

    useEffect(() => {
        load();
    }, [load]);

    const open = async (id: string) => {
        setBusy(true);
        try {
            const res = await kpiService.getReview(id);
            setActive(res.data);
        } finally {
            setBusy(false);
        }
    };

    const act = async (fn: () => Promise<{ data: KpiReviewDetail }>) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fn();
            setActive(res.data);
            const list = await kpiService.listReviews(employee.id);
            setReviews(list.data.items);
        } catch (err) {
            const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
            setError(detail ?? "That did not work. Please try again.");
        } finally {
            setBusy(false);
        }
    };

    // ── No scorecard assigned ────────────────────────────────────────────
    if (!employee.kpi_template_id) {
        return (
            <section className="dtg-panel px-5 py-14 text-center">
                <Icon name="chart" className="mx-auto h-8 w-8 text-teal-700" />
                <p className="mt-3 text-sm text-paper-soft">No KPI framework assigned</p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">
                    {employee.first_name} has no KPI framework yet. Assign one in
                    Settings, under Role scorecards, before opening a review.
                </p>
            </section>
        );
    }

    if (loading) {
        return (
            <div className="dtg-panel flex items-center justify-center gap-2.5 py-16 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading scorecards…
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}

            {/* ── Period picker ─────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                    {reviews.map((r) => (
                        <button
                            key={r.id}
                            onClick={() => open(r.id)}
                            className={`dtg-chip ${
                                active?.id === r.id
                                    ? "border-signal/50 bg-signal/10 text-signal"
                                    : "border-white/12 bg-white/[0.03] text-paper-soft hover:text-paper"
                            }`}
                        >
                            {r.period_label}
                            <span className="text-muted">· {KPI_STATUS_LABELS[r.status]}</span>
                        </button>
                    ))}
                </div>

                <button
                    onClick={() =>
                        act(() =>
                            kpiService.createReview({
                                employee_id: employee.id,
                                period_type: "annual",
                                period_label: period.label,
                                period_start: period.start,
                                period_end: period.end,
                            })
                        )
                    }
                    disabled={busy}
                    className="dtg-btn-secondary px-3 py-1.5 text-micro"
                >
                    <Icon name="plus" className="h-3.5 w-3.5" />
                    Open {period.label}
                </button>
            </div>

            {!active ? (
                <section className="dtg-panel px-5 py-14 text-center">
                    <Icon name="clipboard" className="mx-auto h-8 w-8 text-teal-700" />
                    <p className="mt-3 text-sm text-paper-soft">No scorecard for this employee yet</p>
                    <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">
                        Open {period.label} to start one against the{" "}
                        {employee.kpi_template_title ?? "assigned"} framework.
                    </p>
                </section>
            ) : (
                <>
                    {/* ── Summary ───────────────────────────────────────── */}
                    <section className="dtg-panel p-5">
                        <div className="flex flex-wrap items-start justify-between gap-5">
                            <div className="min-w-0">
                                <p className="dtg-eyebrow">{active.template_title}</p>
                                <h3 className="mt-1 text-base font-semibold text-paper">
                                    {active.period_label} · {KPI_STATUS_LABELS[active.status]}
                                </h3>
                                {active.template_bands && (
                                    <p className="mt-1.5 max-w-xl text-micro leading-relaxed text-muted">
                                        {active.template_bands}
                                    </p>
                                )}
                                {/* "Assessed by … · approved by …" used to sit
                                    here. Nurhuda asked for it gone: either
                                    reviewer may fill a card in now, so naming
                                    one of them as *the* assessor was both
                                    noise and, increasingly, wrong. Who
                                    actually signed is still recorded on the
                                    review and shows in the activity log. */}
                            </div>
                            <div className="w-full max-w-xs">
                                <ScoreBar review={active} />
                            </div>
                        </div>

                        {active.hard_gate_triggered && (
                            <Alert tone="danger" className="mt-4">
                                <strong className="font-semibold">Hard gate raised.</strong>{" "}
                                {active.hard_gate_note ||
                                    "A confirmed critical breach requires documented technical and HR review before this score is treated as satisfactory."}
                            </Alert>
                        )}

                        {active.status === "returned" && active.approver_comment && (
                            <Alert tone="warning" className="mt-4">
                                <strong className="font-semibold">Returned:</strong>{" "}
                                {active.approver_comment}
                            </Alert>
                        )}
                        {active.status === "approved" && active.approver_comment && (
                            <Alert tone="success" className="mt-4">
                                {active.approver_comment}
                            </Alert>
                        )}

                        {(active.can_submit ||
                            active.can_approve ||
                            active.can_publish ||
                            active.can_unpublish ||
                            active.can_reset) && (
                            <div className="mt-4 flex flex-wrap gap-2 border-t border-white/[0.08] pt-4">
                                {active.can_submit && (
                                    <button
                                        onClick={() => act(() => kpiService.submit(active.id))}
                                        disabled={busy}
                                        className="dtg-btn-primary px-3 py-1.5 text-xs"
                                    >
                                        Submit for approval
                                    </button>
                                )}
                                {active.can_approve && (
                                    <>
                                        <button
                                            onClick={() => act(() => kpiService.approve(active.id))}
                                            disabled={busy}
                                            className="dtg-btn-primary px-3 py-1.5 text-xs"
                                        >
                                            <Icon name="check" className="h-3.5 w-3.5" />
                                            Approve
                                        </button>
                                        <button
                                            onClick={async () => {
                                                const note = await prompt({
                                                    title: "Return for revision",
                                                    body: `${active.employee_name ?? "The reviewer"} gets the scorecard back to change, with your note on it.`,
                                                    label: "What needs changing",
                                                    multiline: true,
                                                    required: true,
                                                    confirmLabel: "Return it",
                                                });
                                                if (note) {
                                                    act(() => kpiService.return(active.id, note));
                                                }
                                            }}
                                            disabled={busy}
                                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                        >
                                            Return for revision
                                        </button>
                                    </>
                                )}

                                {/* Approval settles the assessment between the two
                                    reviewers. Publishing is the separate decision to
                                    show it to the person it is about, so nothing
                                    reaches an employee by accident. */}
                                {active.can_publish && (
                                    <button
                                        onClick={async () => {
                                            if (
                                                await confirm({
                                                    title: `Publish this KPI achievement to ${active.employee_name ?? "the employee"}?`,
                                                    body: "They will be able to read their ratings, score and band. Salary and bonus are never shown.",
                                                    confirmLabel: "Publish",
                                                })
                                            ) {
                                                act(() => kpiService.publish(active.id));
                                            }
                                        }}
                                        disabled={busy}
                                        className="dtg-btn-primary px-3 py-1.5 text-xs"
                                    >
                                        <Icon name="check" className="h-3.5 w-3.5" />
                                        Publish to employee
                                    </button>
                                )}

                                {active.can_unpublish && (
                                    <button
                                        onClick={async () => {
                                            if (
                                                await confirm({
                                                    title: "Withdraw this published KPI achievement?",
                                                    body: "It becomes invisible to the employee again and editable. The approval is kept.",
                                                    confirmLabel: "Withdraw",
                                                })
                                            ) {
                                                act(() => kpiService.unpublish(active.id));
                                            }
                                        }}
                                        disabled={busy}
                                        className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                    >
                                        Withdraw from employee
                                    </button>
                                )}

                                {/* Destructive, so it asks -- and it asks with the
                                    consequence spelled out rather than "are you sure". */}
                                {active.can_reset && (
                                    <button
                                        onClick={async () => {
                                            if (
                                                await confirm({
                                                    title: "Reset this KPI achievement?",
                                                    body: "Every rating, note and sign-off is cleared and it goes back to an empty draft. This cannot be undone.",
                                                    confirmLabel: "Reset scorecard",
                                                    tone: "danger",
                                                })
                                            ) {
                                                act(() => kpiService.reset(active.id));
                                            }
                                        }}
                                        disabled={busy}
                                        className="dtg-btn-danger ml-auto px-3 py-1.5 text-xs"
                                    >
                                        <Icon name="refresh" className="h-3.5 w-3.5" />
                                        Reset
                                    </button>
                                )}
                            </div>
                        )}
                    </section>

                    {/* ── The ten lines ─────────────────────────────────── */}
                    <section className="dtg-panel overflow-hidden">
                        <header className="flex items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
                            <div>
                                <p className="dtg-eyebrow">Scorecard</p>
                                <h3 className="mt-0.5 text-sm font-semibold text-paper">
                                    {active.items.length} weighted KPIs
                                </h3>
                            </div>
                            <p className="hidden font-mono text-micro text-muted sm:block">
                                5 = 130% · 4 = 115% · 3 = 100% · 2 = 75% · 1 = 50% · 0 = 0%
                            </p>
                        </header>

                        <ul className={busy ? "opacity-60 transition-opacity" : "transition-opacity"}>
                            {active.items.map((item) => (
                                <ScorecardLine
                                    key={item.id}
                                    item={item}
                                    editable={active.can_edit && !busy}
                                    onChange={(patch) =>
                                        act(() => kpiService.updateItem(active.id, item.id, patch))
                                    }
                                />
                            ))}
                        </ul>
                    </section>

                    {/* No reward block. Nurhuda, September 2026: the scorecard
                        scores performance; the multiplier, the integrity gate
                        and salary sit together on the Salary page. */}
                </>
            )}
        </div>
    );
}
