import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { employeeService } from "@/services/employeeService";
import { kpiService } from "@/services/kpiService";
import { useAuth } from "@/contexts/AuthContext";
import type { EmployeeDetail } from "@/types/employee";
import {
    BAND_TONES,
    KPI_MAX_SCORE,
    KPI_STATUS_LABELS,
    type KpiReviewSummary,
    type KpiTemplateSummary,
} from "@/types/kpi";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";
import Alert from "@/components/ui/Alert";
import KpiReviewPanel from "@/components/kpi/KpiReviewPanel";

/** The current review year. Reviews are annual — the reward model works on a
 *  full year, so a quarterly card could never produce a bonus figure. */
function currentPeriod(): { label: string; start: string; end: string } {
    const year = new Date().getFullYear();
    return { label: String(year), start: `${year}-01-01`, end: `${year}-12-31` };
}

function StatusChip({ review }: { review: KpiReviewSummary | undefined }) {
    if (!review) {
        return (
            <span className="dtg-chip border-white/12 bg-white/[0.04] text-muted">
                Not started
            </span>
        );
    }
    const tone =
        review.status === "approved"
            ? "border-signal/35 bg-signal/10 text-signal"
            : review.status === "submitted"
              ? "border-gold/35 bg-gold/10 text-gold"
              : review.status === "returned"
                ? "border-danger/35 bg-danger/10 text-danger"
                : "border-teal-300/35 bg-teal-300/10 text-teal-300";
    return <span className={`dtg-chip ${tone}`}>{KPI_STATUS_LABELS[review.status]}</span>;
}

function ScoreCell({ review }: { review: KpiReviewSummary | undefined }) {
    if (!review || !review.is_complete) {
        return <span className="font-mono text-xs text-muted">—</span>;
    }
    return (
        <div className="flex items-center justify-end gap-2.5">
            <span className="font-mono text-sm font-semibold text-paper">
                {(review.total_score ?? 0).toFixed(1)}
            </span>
            <span className="font-mono text-micro text-muted">/ {KPI_MAX_SCORE}</span>
            {review.band_code && (
                <span
                    className={`dtg-chip ${
                        BAND_TONES[review.band_code] ?? "border-white/12 text-paper-soft"
                    }`}
                >
                    {review.band_code}
                </span>
            )}
        </div>
    );
}

/**
 * Performance, as its own section.
 *
 * Scorecards used to live only inside an employee's profile, which meant
 * finding one took three clicks and answering "where is everybody up to?"
 * meant opening eight profiles in turn. This is the per-person index: one row
 * each, showing the period's status and band, with the scorecard itself still
 * on the profile where the rest of the person's record is.
 */
export default function KpiPage() {
    const { user } = useAuth();
    const canReview = user?.role === "director" || user?.role === "executive";

    const [employees, setEmployees] = useState<EmployeeDetail[]>([]);
    const [reviews, setReviews] = useState<KpiReviewSummary[]>([]);
    const [templates, setTemplates] = useState<KpiTemplateSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [period, setPeriod] = useState<string>(() => currentPeriod().label);

    // The open scorecard is a URL parameter rather than local state, so
    // "have a look at Lintang's Q3" is one link, and the browser back button
    // returns to the list instead of leaving the section.
    const [searchParams, setSearchParams] = useSearchParams();
    const openId = searchParams.get("employee");
    const [openEmployee, setOpenEmployee] = useState<EmployeeDetail | null>(null);
    const [openLoading, setOpenLoading] = useState(false);

    useEffect(() => {
        if (!openId) {
            setOpenEmployee(null);
            return;
        }
        setOpenLoading(true);
        employeeService
            .get(openId)
            .then((res) => setOpenEmployee(res.data))
            .catch(() => setOpenEmployee(null))
            .finally(() => setOpenLoading(false));
    }, [openId]);

    const openScorecard = (id: string) => setSearchParams({ employee: id });
    const closeScorecard = () => {
        setSearchParams({});
        // The list's status chips are stale the moment a rating changes.
        load();
    };

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [emps, revs, tpls] = await Promise.all([
                employeeService.list({ page_size: 100 }),
                kpiService.listReviews(),
                kpiService.listTemplates(),
            ]);
            // Founders and anyone exempt are not assessed, so they do not
            // belong on a list whose whole purpose is tracking who has been.
            // The list endpoint returns the lean shape, so fetch the detail
            // for the flag rather than guessing from the template being unset.
            const details = await Promise.all(
                emps.data.items.map((e) => employeeService.get(e.id).then((r) => r.data))
            );
            setEmployees(details.filter((e) => e.kpi_review_required));
            setReviews(revs.data.items);
            setTemplates(tpls.data);
        } catch {
            setError("Could not load performance data.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (canReview) load();
        else setLoading(false);
    }, [canReview, load]);

    /** Every period that has a scorecard, newest first, plus the current one. */
    const periods = useMemo(() => {
        const set = new Set(reviews.map((r) => r.period_label));
        set.add(currentPeriod().label);
        return [...set].sort().reverse();
    }, [reviews]);

    const byEmployee = useMemo(() => {
        const map = new Map<string, KpiReviewSummary>();
        for (const r of reviews) {
            if (r.period_label === period) map.set(r.employee_id, r);
        }
        return map;
    }, [reviews, period]);

    const stats = useMemo(() => {
        const rows = employees.map((e) => byEmployee.get(e.id));
        return {
            approved: rows.filter((r) => r?.status === "approved").length,
            awaiting: rows.filter((r) => r?.status === "submitted").length,
            drafting: rows.filter((r) => r?.status === "draft" || r?.status === "returned").length,
            notStarted: rows.filter((r) => !r).length,
        };
    }, [employees, byEmployee]);

    if (!canReview) {
        return (
            <div className="dtg-panel px-5 py-20 text-center">
                <Icon name="chart" className="mx-auto h-8 w-8 text-teal-700" />
                <p className="mt-3 text-sm text-paper-soft">Performance is not available</p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">
                    Scorecards are limited to the review chain in this release.
                </p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading performance…
            </div>
        );
    }

    if (openId) {
        return (
            <div className="dtg-fade-in space-y-5">
                <button
                    type="button"
                    onClick={closeScorecard}
                    className="inline-flex items-center gap-1.5 text-micro font-semibold uppercase tracking-label text-teal-300 transition-colors hover:text-teal-100"
                >
                    <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                    All scorecards
                </button>

                {openLoading || !openEmployee ? (
                    <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-paper-soft">
                        <Spinner className="h-4 w-4 text-signal" />
                        Loading scorecard…
                    </div>
                ) : (
                    <>
                        <header className="dtg-panel flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                            <div className="flex items-center gap-3.5">
                                <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded border border-teal-300/20 bg-teal-900 font-mono text-xs font-semibold tracking-wider text-teal-100">
                                    {(openEmployee.first_name[0] ?? "").toUpperCase()}
                                    {(openEmployee.last_name[0] ?? "").toUpperCase()}
                                </span>
                                <div className="min-w-0">
                                    <p className="dtg-eyebrow">{openEmployee.position}</p>
                                    <h1 className="mt-1 text-xl font-bold tracking-tight text-paper">
                                        {openEmployee.first_name} {openEmployee.last_name}
                                    </h1>
                                </div>
                            </div>
                            <p className="font-mono text-micro text-muted">
                                {openEmployee.employee_id}
                            </p>
                        </header>

                        <KpiReviewPanel employee={openEmployee} />
                    </>
                )}
            </div>
        );
    }

    return (
        <div className="dtg-fade-in space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Performance</p>
                    <h1 className="mt-2 text-2xl font-bold tracking-tight text-paper">
                        KPI scorecards
                    </h1>
                    <p className="mt-1.5 text-sm text-paper-soft">
                        One scorecard per person per period, scored out of{" "}
                        <span className="font-mono text-paper">{KPI_MAX_SCORE}</span>.
                    </p>
                </div>

                <label className="flex items-center gap-2.5">
                    <span className="dtg-eyebrow">Period</span>
                    <select
                        value={period}
                        onChange={(e) => setPeriod(e.target.value)}
                        className="dtg-input w-auto py-2"
                    >
                        {periods.map((p) => (
                            <option key={p} value={p}>
                                {p}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {error && <Alert tone="danger">{error}</Alert>}

            {/* Where the period stands overall. */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                    { label: "Approved", value: stats.approved, tone: "border-l-signal" },
                    { label: "Awaiting approval", value: stats.awaiting, tone: "border-l-gold" },
                    { label: "In progress", value: stats.drafting, tone: "border-l-teal-300" },
                    { label: "Not started", value: stats.notStarted, tone: "border-l-teal-700" },
                ].map((s) => (
                    <div
                        key={s.label}
                        className={`rounded-2xl border border-white/10 border-l-2 bg-surface px-4 py-3 ${s.tone}`}
                    >
                        <p className="dtg-eyebrow text-paper-soft">{s.label}</p>
                        <p className="mt-2 font-mono text-2xl font-semibold leading-none text-paper">
                            {s.value}
                        </p>
                    </div>
                ))}
            </div>

            {/* One row per person. */}
            <div className="dtg-panel overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-white/10 bg-deep/40">
                            <th className="dtg-th">Employee</th>
                            <th className="dtg-th">Scorecard</th>
                            <th className="dtg-th">{period}</th>
                            <th className="dtg-th text-right">Score</th>
                            <th className="dtg-th text-right">Open</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                        {employees.map((emp) => {
                            const review = byEmployee.get(emp.id);
                            return (
                                <tr key={emp.id} className="transition-colors hover:bg-white/[0.03]">
                                    <td className="dtg-td">
                                        <button
                                            type="button"
                                            onClick={() => openScorecard(emp.id)}
                                            className="group flex items-center gap-3 text-left"
                                        >
                                            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-teal-300/20 bg-teal-900 font-mono text-[0.6875rem] font-semibold tracking-wider text-teal-100">
                                                {(emp.first_name[0] ?? "").toUpperCase()}
                                                {(emp.last_name[0] ?? "").toUpperCase()}
                                            </span>
                                            <span className="min-w-0">
                                                <span className="block truncate font-medium text-paper group-hover:text-signal">
                                                    {emp.first_name} {emp.last_name}
                                                </span>
                                                <span className="block truncate font-mono text-micro text-muted">
                                                    {emp.employee_id}
                                                </span>
                                            </span>
                                        </button>
                                    </td>
                                    <td className="dtg-td">
                                        <span className="text-xs text-paper-soft">
                                            {emp.position}
                                        </span>
                                    </td>
                                    <td className="dtg-td">
                                        <StatusChip review={review} />
                                    </td>
                                    <td className="dtg-td text-right">
                                        <ScoreCell review={review} />
                                    </td>
                                    <td className="dtg-td text-right">
                                        <button
                                            type="button"
                                            onClick={() => openScorecard(emp.id)}
                                            className="dtg-btn-secondary px-2.5 py-1.5 text-micro"
                                        >
                                            {review ? "Review" : "Start"}
                                            <Icon name="arrowRight" className="h-3.5 w-3.5" />
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>

                {employees.length === 0 && (
                    <div className="px-5 py-16 text-center">
                        <Icon name="users" className="mx-auto h-8 w-8 text-teal-700" />
                        <p className="mt-3 text-sm text-paper-soft">No employees to score</p>
                    </div>
                )}
            </div>

            {/* The frameworks themselves, for reference. */}
            <section className="dtg-panel overflow-hidden">
                <header className="border-b border-white/[0.08] px-5 py-3.5">
                    <p className="dtg-eyebrow">Reference</p>
                    <h2 className="mt-0.5 text-sm font-semibold text-paper">
                        Role frameworks ({templates.length})
                    </h2>
                </header>
                <ul className="divide-y divide-white/[0.06]">
                    {templates.map((t) => (
                        <li key={t.id} className="px-5 py-3">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <p className="text-sm font-medium text-paper">{t.title}</p>
                                <p className="font-mono text-micro text-muted">
                                    {t.item_count} KPIs · v{t.version}
                                </p>
                            </div>
                            {t.bands && (
                                <p className="mt-1 text-micro leading-relaxed text-muted">
                                    {t.bands}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}
