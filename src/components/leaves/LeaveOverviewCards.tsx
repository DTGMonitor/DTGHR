import { LeaveType, type LeaveOverview } from "@/types/leave";
import { LEAVE_TYPE_LABELS, formatDays } from "./leaveLabels";

/**
 * The four headline figures. Annual and sick come from the balance rows the
 * approval RPC deducts from; pending and used are counted from the requests
 * themselves -- the same numbers the table underneath lists.
 */
export default function LeaveOverviewCards({
    overview,
    loading,
}: {
    overview: LeaveOverview | null;
    loading: boolean;
}) {
    if (loading || !overview) {
        return (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {[...Array(4)].map((_, i) => (
                    <div key={i} className="h-36 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
                ))}
            </div>
        );
    }

    const { annual, sick } = overview;
    const usedBreakdown = Object.values(LeaveType)
        .filter((t) => overview.used_by_type[t] > 0)
        .map((t) => `${LEAVE_TYPE_LABELS[t]} ${overview.used_by_type[t]}`)
        .join(" · ");

    return (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MeterCard
                label="Annual leave"
                value={annual.remaining}
                unit="days remaining"
                used={annual.used}
                total={annual.total}
                tone="from-blue-500/20 to-cyan-500/20 border-blue-500/20"
            />
            <div className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/20 to-orange-500/20 p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Pending requests</p>
                <p className="mt-1 text-3xl font-bold text-white">{overview.pending_count}</p>
                <p className="text-xs text-gray-500">awaiting approval</p>
                <p className="mt-4 text-xs text-gray-400">
                    {overview.pending_count ? `${formatDays(overview.pending_days)} requested` : "Nothing waiting"}
                </p>
            </div>
            <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/20 to-green-500/20 p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Total used</p>
                <p className="mt-1 text-3xl font-bold text-white">{overview.used_days}</p>
                <p className="text-xs text-gray-500">days approved in {overview.year}</p>
                <p className="mt-4 truncate text-xs text-gray-400" title={usedBreakdown}>
                    {usedBreakdown || "No leave taken yet"}
                </p>
            </div>
            <MeterCard
                label="Sick leave"
                value={sick.remaining}
                unit="days remaining"
                used={sick.used}
                total={sick.total}
                tone="from-red-500/20 to-rose-500/20 border-red-500/20"
            />
        </div>
    );
}

function MeterCard({
    label,
    value,
    unit,
    used,
    total,
    tone,
}: {
    label: string;
    value: number;
    unit: string;
    used: number;
    total: number;
    tone: string;
}) {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    return (
        <div className={`rounded-2xl border bg-gradient-to-br p-5 ${tone}`}>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">{label}</p>
            <p className="mt-1 text-3xl font-bold text-white">{value}</p>
            <p className="text-xs text-gray-500">{unit}</p>
            <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={used}
                aria-label={`${label}: ${used} of ${total} days used`}
            >
                <div className="h-full rounded-full bg-white/50 transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-gray-400">
                {used} of {total} used
            </p>
        </div>
    );
}
