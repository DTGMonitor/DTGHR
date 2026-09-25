import { useState, useEffect, useCallback } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";

import api from "@/lib/api";
import Icon, { type IconName } from "@/components/ui/icons";

/*
 * The audit trail, on its own page.
 *
 * It used to sit on the dashboard, where it was the first thing everybody saw
 * every morning -- a list of who edited what. Useful when you need it, but it
 * is a record rather than news, and it was occupying the place the staff
 * bulletin belongs. Management only, below the roster.
 */

interface ActivityItem {
    id: string;
    action: string;
    description: string;
    actor_name: string;
    created_at: string;
}

/** Icon and accent per audit action. Colour never carries the meaning alone. */
const ACTION_STYLE: Record<string, { icon: IconName; tone: string }> = {
    EMPLOYEE_CREATED: { icon: "userPlus", tone: "text-signal" },
    EMPLOYEE_UPDATED: { icon: "pencil", tone: "text-teal-300" },
    EMPLOYEE_DEACTIVATED: { icon: "userMinus", tone: "text-danger" },
    ACCOUNT_CREATED: { icon: "key", tone: "text-teal-300" },
    LEAVE_REQUESTED: { icon: "clipboard", tone: "text-gold" },
    LEAVE_APPROVED: { icon: "check", tone: "text-signal" },
    LEAVE_REJECTED: { icon: "x", tone: "text-danger" },
    LEAVE_CANCELLED: { icon: "refresh", tone: "text-muted" },
    KPI_REVIEW_PUBLISHED: { icon: "check", tone: "text-signal" },
    KPI_REVIEW_UNPUBLISHED: { icon: "refresh", tone: "text-gold" },
    KPI_REVIEW_RESET: { icon: "refresh", tone: "text-danger" },
};

function timeAgo(dateStr: string): string {
    const now = new Date();
    const date = new Date(dateStr);
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const ACTIVITY_PAGE_SIZE = 25;

export default function ActivityLogPage() {
    const { user } = useAuth();
    const isManagement =
        Boolean(user?.is_management) ||
        user?.role === "director" ||
        user?.role === "executive";

    const [activity, setActivity] = useState<ActivityItem[]>([]);
    const [activityPage, setActivityPage] = useState(1);
    const [activityTotal, setActivityTotal] = useState(0);
    const [activityLoading, setActivityLoading] = useState(false);
    const [loading, setLoading] = useState(true);

    const loadActivity = useCallback(async (page: number) => {
        setActivityLoading(true);
        try {
            const res = await api.get("/activity/recent", {
                params: { page, page_size: ACTIVITY_PAGE_SIZE },
            });
            setActivity(res.data.items);
            setActivityTotal(res.data.total);
            setActivityPage(page);
        } catch {
            // silently ignore
        } finally {
            setActivityLoading(false);
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadActivity(1);
    }, [loadActivity]);

    const totalPages = Math.max(1, Math.ceil(activityTotal / ACTIVITY_PAGE_SIZE));

    /*
     * The endpoint already scopes its rows -- an employee only ever sees their
     * own entries -- so this is not what keeps the data safe. It keeps the
     * page from existing for people it was not built for, which is a
     * different and lesser job, and is why it lives here rather than pretending
     * to be a security boundary.
     */
    if (user && !isManagement) return <Navigate to="/" replace />;

    return (
        <div className="dtg-fade-in space-y-6">
            <header>
                <p className="dtg-eyebrow">Governance</p>
                <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                    Activity log
                </h1>
                <p className="mt-1.5 text-sm text-paper-soft">
                    Every change to people, leave, rosters and KPI achievements, and who made it.
                </p>
            </header>

    {/* ── Recent activity ───────────────────────────────────────── */}
    <section className="dtg-panel overflow-hidden">
        <header className="flex items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-4">
            <div>
                <p className="dtg-eyebrow">Audit trail</p>
                <h2 className="mt-1 text-base font-semibold text-paper">Recent activity</h2>
            </div>
            {activityTotal > 0 && (
                <span className="flex-shrink-0 font-mono text-micro text-muted">
                    {activityTotal} entr{activityTotal === 1 ? "y" : "ies"}
                </span>
            )}
        </header>

        {loading ? (
            <div className="space-y-2 p-5">
                {[...Array(4)].map((_, i) => (
                    <div key={i} className="h-14 animate-pulse rounded-lg bg-white/[0.04]" />
                ))}
            </div>
        ) : activity.length === 0 && activityPage === 1 ? (
            <div className="px-5 py-14 text-center">
                <Icon name="clipboard" className="mx-auto h-8 w-8 text-teal-700" />
                <p className="mt-3 text-sm text-paper-soft">No activity recorded yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
                    Leave requests, approvals and employee changes will be logged here.
                </p>
            </div>
        ) : (
            <>
                <ul
                    className={`divide-y divide-white/[0.06] transition-opacity ${
                        activityLoading ? "opacity-50" : ""
                    }`}
                >
                    {activity.map((item) => {
                        const style = ACTION_STYLE[item.action] ?? {
                            icon: "pin" as IconName,
                            tone: "text-muted",
                        };
                        return (
                            <li
                                key={item.id}
                                className="flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-white/[0.03]"
                            >
                                <span
                                    className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border border-white/[0.08] bg-deep/50 ${style.tone}`}
                                >
                                    <Icon name={style.icon} className="h-4 w-4" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm text-paper">{item.description}</p>
                                    <p className="truncate text-xs text-muted">by {item.actor_name}</p>
                                </div>
                                <time
                                    dateTime={item.created_at}
                                    title={new Date(item.created_at).toLocaleString("en-GB")}
                                    className="flex-shrink-0 font-mono text-micro text-muted"
                                >
                                    {timeAgo(item.created_at)}
                                </time>
                            </li>
                        );
                    })}
                </ul>

                {totalPages > 1 && (
                    <div className="flex items-center justify-between gap-3 border-t border-white/[0.08] px-5 py-3.5">
                        <button
                            onClick={() => loadActivity(activityPage - 1)}
                            disabled={activityPage <= 1 || activityLoading}
                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                        >
                            <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                            Previous
                        </button>
                        <span className="font-mono text-micro text-muted">
                            {activityPage} / {totalPages}
                        </span>
                        <button
                            onClick={() => loadActivity(activityPage + 1)}
                            disabled={activityPage >= totalPages || activityLoading}
                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                        >
                            Next
                            <Icon name="arrowRight" className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}
            </>
        )}
    </section>
        </div>
    );
}
