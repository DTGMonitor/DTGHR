import { useEffect, useState } from "react";

import api from "@/lib/api";
import Spinner from "@/components/ui/Spinner";
import type { KpiReviewDetail, KpiReviewSummary } from "@/types/kpi";

/*
 * Your own scorecard, once it has been published to you.
 *
 * Everybody who is assessed gets one, Nurhuda included — she is assessed by
 * Peter like anybody else and had no way to read her own result. The KPI page
 * is the reviewer's workbench; this is the finished card, read-only.
 *
 * Written as its own view rather than reusing KpiReviewPanel: that panel is
 * built around the reviewer's endpoints and its rating buttons, and lending it
 * to an employee would mean disabling half of it and hoping.
 *
 * Reward figures never appear here. The server withholds bonus, multiplier and
 * salary from the person a scorecard concerns, so there is nothing to hide in
 * the markup — it simply is not in the response.
 */

const RATING_WORD: Record<number, string> = {
    0: "Unacceptable",
    1: "Needs improvement",
    2: "Approaching",
    3: "Meets",
    4: "Exceeds",
    5: "Outstanding",
};

export default function MyScorecardPage() {
    const [rows, setRows] = useState<KpiReviewSummary[]>([]);
    const [detail, setDetail] = useState<KpiReviewDetail | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        api.get<{ items: KpiReviewSummary[] }>("/kpi/reviews/mine")
            .then((r) => {
                setRows(r.data.items);
                if (r.data.items.length) setOpenId(r.data.items[0]!.id);
            })
            .catch(() => setRows([]))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        if (!openId) return;
        api.get<KpiReviewDetail>(`/kpi/reviews/${openId}`)
            .then((r) => setDetail(r.data))
            .catch(() => setDetail(null));
    }, [openId]);

    if (loading) {
        return (
            <div className="dtg-panel flex items-center gap-2.5 px-5 py-16 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading your KPI achievement…
            </div>
        );
    }

    return (
        <div className="dtg-fade-in space-y-5">
            <header>
                <p className="dtg-eyebrow">Performance</p>
                <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                    My KPI Achievement
                </h1>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                    Your assessment for each period, once it has been signed off and released.
                </p>
            </header>

            {rows.length === 0 ? (
                <div className="dtg-panel px-5 py-16 text-center">
                    <p className="text-sm text-paper-soft">Nothing published yet.</p>
                    <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-muted">
                        A KPI achievement appears here once it has been assessed, approved and released
                        to you. Until then it is still being worked on, and an unfinished card is
                        more misleading than none at all.
                    </p>
                </div>
            ) : (
                <>
                    {rows.length > 1 && (
                        <div className="flex flex-wrap gap-2">
                            {rows.map((r) => (
                                <button
                                    key={r.id}
                                    onClick={() => setOpenId(r.id)}
                                    className={`rounded-lg border px-3.5 py-2 text-sm transition-colors ${
                                        openId === r.id
                                            ? "border-signal/50 bg-signal/10 font-semibold text-paper"
                                            : "border-white/10 bg-white/[0.02] text-paper-soft hover:bg-white/[0.05]"
                                    }`}
                                >
                                    {r.period_label}
                                </button>
                            ))}
                        </div>
                    )}

                    {detail && (
                        <>
                            {/* The headline: the score and what it means. */}
                            <section className="dtg-panel flex flex-wrap items-end justify-between gap-6 p-6">
                                <div>
                                    <p className="dtg-eyebrow">{detail.period_label}</p>
                                    <h2 className="mt-1 text-sm font-semibold text-paper">
                                        {detail.template_title ?? "KPI achievement"}
                                    </h2>
                                    {detail.template_bands && (
                                        <p className="mt-2 max-w-xl text-micro leading-relaxed text-muted">
                                            {detail.template_bands}
                                        </p>
                                    )}
                                </div>
                                <div className="text-right">
                                    <p className="font-mono text-4xl font-bold leading-none text-paper">
                                        {detail.total_score?.toFixed(1) ?? "—"}
                                        <span className="ml-1 text-base font-normal text-muted">
                                            / {detail.max_score}
                                        </span>
                                    </p>
                                    {detail.band_label && (
                                        <p className="mt-2 text-sm font-semibold text-signal">
                                            {detail.band_code} · {detail.band_label}
                                        </p>
                                    )}
                                </div>
                            </section>

                            {detail.approver_comment && (
                                <section className="dtg-panel p-5">
                                    <p className="dtg-eyebrow">Comment</p>
                                    <p className="mt-2 text-sm leading-relaxed text-paper-soft">
                                        {detail.approver_comment}
                                    </p>
                                </section>
                            )}

                            {/* Line by line, so a score is never just a number. */}
                            <section className="dtg-panel overflow-hidden">
                                <header className="border-b border-white/[0.08] px-5 py-3.5">
                                    <p className="dtg-eyebrow">Detail</p>
                                    <h2 className="mt-0.5 text-sm font-semibold text-paper">
                                        How the score was reached
                                    </h2>
                                </header>
                                <ul className="divide-y divide-white/[0.06]">
                                    {detail.items.map((item) => (
                                        <li key={item.id} className="px-5 py-3.5">
                                            <div className="flex flex-wrap items-start justify-between gap-4">
                                                <div className="min-w-0">
                                                    <p className="text-sm text-paper">
                                                        <span className="mr-2 font-mono text-micro text-muted">
                                                            {item.number}
                                                        </span>
                                                        {item.name}
                                                    </p>
                                                    {item.target && (
                                                        <p className="mt-1 text-xs leading-relaxed text-muted">
                                                            Target: {item.target}
                                                        </p>
                                                    )}
                                                    {item.actual_result && (
                                                        <p className="mt-1 text-xs italic leading-relaxed text-paper-soft">
                                                            {item.actual_result}
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="flex-shrink-0 text-right">
                                                    {item.is_not_applicable ? (
                                                        <span className="text-micro uppercase tracking-label text-muted">
                                                            Not applicable
                                                        </span>
                                                    ) : (
                                                        <>
                                                            <p className="text-sm font-semibold text-paper">
                                                                {item.rating === null
                                                                    ? "—"
                                                                    : RATING_WORD[item.rating]}
                                                            </p>
                                                            <p className="font-mono text-micro text-muted">
                                                                weight {item.effective_weight ?? item.weight}
                                                                {" · "}
                                                                {item.points?.toFixed(1) ?? "0.0"} pts
                                                            </p>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        </>
                    )}
                </>
            )}
        </div>
    );
}
