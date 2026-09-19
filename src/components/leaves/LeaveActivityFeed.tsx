import { useCallback, useEffect, useState } from "react";
import { leaveService } from "@/services/leaveService";
import type { LeaveActivity, LeaveActivityAction } from "@/types/leave";
import { LEAVE_TYPE_LABELS, formatDays, formatRange, timeAgo } from "./leaveLabels";

const PAGE_SIZE = 8;

const ACTION_META: Record<LeaveActivityAction, { icon: string; label: string; tone: string }> = {
    LEAVE_REQUESTED: { icon: "📝", label: "Submitted", tone: "bg-indigo-500/15 text-indigo-300" },
    LEAVE_APPROVED: { icon: "✅", label: "Approved", tone: "bg-emerald-500/15 text-emerald-400" },
    LEAVE_REJECTED: { icon: "❌", label: "Rejected", tone: "bg-red-500/15 text-red-400" },
    LEAVE_CANCELLED: { icon: "↩️", label: "Cancelled", tone: "bg-gray-500/15 text-gray-400" },
};

/** One sentence per event, phrased for whoever is reading it. */
function headline(item: LeaveActivity, scope: "mine" | "all"): string {
    const what = `${LEAVE_TYPE_LABELS[item.leave_type].toLowerCase()} leave`;
    const whose = scope === "mine" ? "Your" : `${item.employee_name}'s`;
    switch (item.action) {
        case "LEAVE_REQUESTED":
            return scope === "mine"
                ? `You requested ${formatDays(item.days_requested)} of ${what}`
                : `${item.employee_name} requested ${formatDays(item.days_requested)} of ${what}`;
        case "LEAVE_APPROVED":
            return `${whose} ${what} was approved by ${item.actor_name}`;
        case "LEAVE_REJECTED":
            return `${whose} ${what} was rejected by ${item.actor_name}`;
        case "LEAVE_CANCELLED":
            return scope === "mine"
                ? `You cancelled your ${what}`
                : `${item.employee_name} cancelled their ${what}`;
        default:
            return item.description;
    }
}

/**
 * Leave activity. "mine" is the updates on the reader's own requests;
 * "all" is every request the reader can see -- the whole company for HR.
 * Bump `refreshKey` after an approve/reject/submit to pull the new entry in.
 */
export default function LeaveActivityFeed({
    scope,
    title,
    refreshKey = 0,
}: {
    scope: "mine" | "all";
    title: string;
    refreshKey?: number;
}) {
    const [items, setItems] = useState<LeaveActivity[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const load = useCallback(
        async (p: number) => {
            setLoading(true);
            setError(false);
            try {
                const res = await leaveService.listActivity({ scope, page: p, page_size: PAGE_SIZE });
                setItems(res.data.items);
                setTotal(res.data.total);
                setPage(p);
            } catch {
                setError(true);
            } finally {
                setLoading(false);
            }
        },
        [scope]
    );

    useEffect(() => {
        load(1);
    }, [load, refreshKey]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <section className="rounded-2xl border border-white/10 bg-gray-900/30 p-5">
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-white">{title}</h2>
                {total > 0 && <span className="text-xs text-gray-500">{total} total</span>}
            </div>

            {loading && items.length === 0 ? (
                <div className="mt-4 space-y-2">
                    {[...Array(3)].map((_, i) => (
                        <div key={i} className="h-14 animate-pulse rounded-xl bg-white/5" />
                    ))}
                </div>
            ) : error ? (
                <p className="mt-3 text-sm text-red-400">Could not load activity.</p>
            ) : items.length === 0 ? (
                <p className="mt-3 text-sm text-gray-500">
                    {scope === "mine"
                        ? "Nothing yet. Submissions, approvals and rejections of your requests will show up here."
                        : "No leave activity yet."}
                </p>
            ) : (
                <>
                    <ol className={`mt-4 space-y-2 transition-opacity ${loading ? "opacity-50" : ""}`}>
                        {items.map((item) => {
                            const meta = ACTION_META[item.action] ?? ACTION_META.LEAVE_REQUESTED;
                            return (
                                <li
                                    key={item.id}
                                    className="flex gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5"
                                >
                                    <span className="mt-0.5 text-lg leading-none" aria-hidden>
                                        {meta.icon}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm text-gray-200">{headline(item, scope)}</p>
                                        <p className="mt-0.5 text-xs text-gray-500">
                                            {formatRange(item.start_date, item.end_date)} · {formatDays(item.days_requested)}
                                        </p>
                                        {item.reviewer_note &&
                                            (item.action === "LEAVE_APPROVED" || item.action === "LEAVE_REJECTED") && (
                                                <p className="mt-1 rounded-lg bg-white/5 px-2 py-1 text-xs italic text-gray-400">
                                                    “{item.reviewer_note}”
                                                </p>
                                            )}
                                    </div>
                                    <div className="flex flex-shrink-0 flex-col items-end gap-1">
                                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.tone}`}>
                                            {meta.label}
                                        </span>
                                        <span className="text-[11px] text-gray-500">{timeAgo(item.created_at)}</span>
                                    </div>
                                </li>
                            );
                        })}
                    </ol>

                    {totalPages > 1 && (
                        <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-3">
                            <button
                                onClick={() => load(page - 1)}
                                disabled={page <= 1 || loading}
                                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-30"
                            >
                                ← Newer
                            </button>
                            <span className="text-xs text-gray-500">
                                Page {page} of {totalPages}
                            </span>
                            <button
                                onClick={() => load(page + 1)}
                                disabled={page >= totalPages || loading}
                                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-30"
                            >
                                Older →
                            </button>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
