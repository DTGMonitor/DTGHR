import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import StatTile, { StatTileSkeleton, type StatTileProps } from "@/components/ui/StatTile";
import Icon, { type IconName } from "@/components/ui/icons";
import { Wordmark } from "@/components/brand/Logo";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminStats {
    role: "admin";
    total_employees: number;
    pending_approvals: number;
    on_leave_today: number;
    new_this_month: number;
}

interface EmployeeStats {
    role: "employee";
    annual_remaining: number;
    annual_total: number;
    sick_remaining: number;
    sick_total: number;
    pending_requests: number;
    total_used: number;
}

type DashboardStats = AdminStats | EmployeeStats;

interface ActivityItem {
    id: string;
    action: string;
    description: string;
    actor_name: string;
    created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function buildAdminTiles(s: AdminStats): StatTileProps[] {
    return [
        { label: "Total Employees", value: s.total_employees, icon: "users", accent: "data" },
        {
            label: "Pending Approvals",
            value: s.pending_approvals,
            icon: "clipboard",
            // Zero pending is a good state, so it should not sit there in gold.
            accent: s.pending_approvals > 0 ? "attention" : "neutral",
            sub: s.pending_approvals > 0 ? "awaiting your review" : "nothing waiting",
        },
        { label: "On Leave Today", value: s.on_leave_today, icon: "sun", accent: "neutral" },
        { label: "New This Month", value: s.new_this_month, icon: "userPlus", accent: "action" },
    ];
}

function buildEmployeeTiles(s: EmployeeStats): StatTileProps[] {
    return [
        {
            label: "Annual Leave",
            value: s.annual_remaining,
            sub: `of ${s.annual_total} days remaining`,
            icon: "sun",
            accent: "action",
        },
        {
            label: "Sick Leave",
            value: s.sick_remaining,
            sub: `of ${s.sick_total} days remaining`,
            icon: "heart",
            accent: "data",
        },
        {
            label: "Pending Requests",
            value: s.pending_requests,
            icon: "clock",
            accent: s.pending_requests > 0 ? "attention" : "neutral",
        },
        {
            label: "Total Used",
            value: s.total_used,
            sub: "days this year",
            icon: "chart",
            accent: "neutral",
        },
    ];
}

// ─── Component ────────────────────────────────────────────────────────────────

const ACTIVITY_PAGE_SIZE = 10;

export default function DashboardPage() {
    const { user } = useAuth();
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [activity, setActivity] = useState<ActivityItem[]>([]);
    const [activityPage, setActivityPage] = useState(1);
    const [activityTotal, setActivityTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [activityLoading, setActivityLoading] = useState(false);

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
        }
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const [statsRes] = await Promise.all([
                    api.get("/dashboard/stats"),
                    loadActivity(1),
                ]);
                setStats(statsRes.data);
            } catch {
                // silently ignore
            } finally {
                setLoading(false);
            }
        })();
    }, [loadActivity]);

    const totalPages = Math.max(1, Math.ceil(activityTotal / ACTIVITY_PAGE_SIZE));

    const tiles: StatTileProps[] = loading
        ? []
        : stats?.role === "admin"
          ? buildAdminTiles(stats)
          : stats?.role === "employee"
            ? buildEmployeeTiles(stats)
            : [];

    const today = new Date();
    const firstName = user?.full_name?.split(" ")[0];

    return (
        <div className="dtg-fade-in space-y-6">
            {/* ── Welcome band ───────────────────────────────────────────── */}
            <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-band px-6 py-7 sm:px-8">
                {/* Pixel wash, echoing the wordmark's dissolving edge. */}
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 opacity-[0.08]"
                    style={{
                        backgroundImage:
                            "radial-gradient(circle at 1px 1px, #F4F0E7 1px, transparent 0)",
                        backgroundSize: "14px 14px",
                        maskImage: "linear-gradient(105deg, transparent 45%, #000 100%)",
                        WebkitMaskImage: "linear-gradient(105deg, transparent 45%, #000 100%)",
                    }}
                />

                <div className="relative flex flex-wrap items-center justify-between gap-6">
                    <div className="min-w-0">
                        {/* The date earns its place: the first thing you check on a
                            roster-driven morning is what day it actually is. */}
                        <p className="dtg-eyebrow">
                            {today.toLocaleDateString("en-GB", {
                                weekday: "long",
                                day: "numeric",
                                month: "long",
                                year: "numeric",
                            })}
                        </p>
                        <h1 className="mt-2.5 text-2xl font-bold tracking-tight text-paper sm:text-3xl">
                            {firstName ? `Welcome back, ${firstName}.` : "Welcome back."}
                        </h1>
                        {/* A 2px signal rule under the greeting, the same device the
                            marketing site uses to mark a live section. */}
                        <div className="mt-3 h-0.5 w-12 rounded-full bg-signal" />
                        <p className="mt-3 max-w-xl text-sm leading-relaxed text-teal-100/75">
                            {stats?.role === "admin"
                                ? "Headcount, approvals and cover for today, at a glance."
                                : "Your leave balances, requests and recent activity."}
                        </p>
                    </div>

                    {/* The wordmark was set at 32px and 40% opacity, which read as a
                        watermark somebody had forgotten to remove. The asset is
                        552x198, so it carries far more size than it was being given:
                        56px is still a downscale, and therefore still crisp. */}
                    <Wordmark className="hidden h-11 opacity-70 lg:block xl:h-14" />
                </div>
            </section>

            {/* ── Stat tiles ─────────────────────────────────────────────── */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {loading
                    ? [...Array(4)].map((_, i) => <StatTileSkeleton key={i} />)
                    : tiles.map((tile) => <StatTile key={tile.label} {...tile} />)}
            </div>

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
