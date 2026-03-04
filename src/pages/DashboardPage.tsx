import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";

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

interface StatCard {
    label: string;
    value: string;
    sub?: string;
    icon: string;
    color: string;
    border: string;
}

interface ActivityItem {
    id: string;
    action: string;
    description: string;
    actor_name: string;
    created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, string> = {
    EMPLOYEE_CREATED: "👤",
    EMPLOYEE_UPDATED: "✏️",
    EMPLOYEE_DEACTIVATED: "🚫",
    ACCOUNT_CREATED: "🔑",
    LEAVE_REQUESTED: "📝",
    LEAVE_APPROVED: "✅",
    LEAVE_REJECTED: "❌",
    LEAVE_CANCELLED: "🔄",
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
    return date.toLocaleDateString();
}

function buildAdminCards(s: AdminStats): StatCard[] {
    return [
        {
            label: "Total Employees",
            value: String(s.total_employees),
            icon: "👥",
            color: "from-blue-500/20 to-cyan-500/20",
            border: "border-blue-500/20",
        },
        {
            label: "Pending Approvals",
            value: String(s.pending_approvals),
            icon: "📋",
            color: "from-amber-500/20 to-orange-500/20",
            border: "border-amber-500/20",
        },
        {
            label: "On Leave Today",
            value: String(s.on_leave_today),
            icon: "🏖️",
            color: "from-emerald-500/20 to-green-500/20",
            border: "border-emerald-500/20",
        },
        {
            label: "New This Month",
            value: String(s.new_this_month),
            icon: "🆕",
            color: "from-purple-500/20 to-violet-500/20",
            border: "border-purple-500/20",
        },
    ];
}

function buildEmployeeCards(s: EmployeeStats): StatCard[] {
    return [
        {
            label: "Annual Leave",
            value: String(s.annual_remaining),
            sub: `of ${s.annual_total} days`,
            icon: "🏖️",
            color: "from-blue-500/20 to-cyan-500/20",
            border: "border-blue-500/20",
        },
        {
            label: "Sick Leave",
            value: String(s.sick_remaining),
            sub: `of ${s.sick_total} days`,
            icon: "🏥",
            color: "from-red-500/20 to-rose-500/20",
            border: "border-red-500/20",
        },
        {
            label: "Pending Requests",
            value: String(s.pending_requests),
            icon: "⏳",
            color: "from-amber-500/20 to-orange-500/20",
            border: "border-amber-500/20",
        },
        {
            label: "Total Used",
            value: String(s.total_used),
            sub: "days this year",
            icon: "📊",
            color: "from-emerald-500/20 to-green-500/20",
            border: "border-emerald-500/20",
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

    const cards: StatCard[] = loading
        ? []
        : stats?.role === "admin"
            ? buildAdminCards(stats)
            : stats?.role === "employee"
                ? buildEmployeeCards(stats)
                : [];

    return (
        <div className="space-y-6">
            {/* Welcome Banner */}
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-pink-500/10 p-8">
                <div className="pointer-events-none absolute -right-20 -top-20 h-60 w-60 rounded-full bg-indigo-500/10 blur-3xl" />
                <h1 className="text-2xl font-bold text-white">
                    Welcome back, {user?.full_name?.split(" ")[0]} 👋
                </h1>
                <p className="mt-2 text-gray-400">
                    {stats?.role === "admin"
                        ? "Here's your organisation overview."
                        : "Here's your HR Hub dashboard overview."}
                </p>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {loading
                    ? [...Array(4)].map((_, i) => (
                        <div
                            key={i}
                            className="animate-pulse rounded-2xl border border-white/10 bg-white/5 p-6 h-28"
                        />
                    ))
                    : cards.map((stat) => (
                        <div
                            key={stat.label}
                            className={`rounded-2xl border ${stat.border} bg-gradient-to-br ${stat.color} p-6 transition-transform hover:scale-[1.02]`}
                        >
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm text-gray-400">{stat.label}</p>
                                    <p className="mt-1 text-3xl font-bold text-white">
                                        {stat.value}
                                    </p>
                                    {stat.sub && (
                                        <p className="mt-0.5 text-xs text-gray-500">{stat.sub}</p>
                                    )}
                                </div>
                                <span className="text-3xl">{stat.icon}</span>
                            </div>
                        </div>
                    ))}
            </div>

            {/* Recent Activity */}
            <div className="rounded-2xl border border-white/10 bg-gray-900/30 p-6">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-white">Recent Activity</h2>
                    {activityTotal > 0 && (
                        <span className="text-xs text-gray-500">
                            {activityTotal} total
                        </span>
                    )}
                </div>
                {loading ? (
                    <div className="mt-4 space-y-3">
                        {[...Array(3)].map((_, i) => (
                            <div
                                key={i}
                                className="animate-pulse h-12 rounded-xl bg-white/5"
                            />
                        ))}
                    </div>
                ) : activity.length === 0 && activityPage === 1 ? (
                    <p className="mt-3 text-sm text-gray-500">
                        No recent activity yet. Actions like leave requests and approvals will
                        appear here.
                    </p>
                ) : (
                    <>
                        <div className={`mt-4 space-y-2 transition-opacity ${activityLoading ? "opacity-50" : ""}`}>
                            {activity.map((item) => (
                                <div
                                    key={item.id}
                                    className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 transition-colors hover:bg-white/[0.04]"
                                >
                                    <span className="flex-shrink-0 text-xl">
                                        {ACTION_ICONS[item.action] || "📌"}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm text-gray-200">
                                            {item.description}
                                        </p>
                                        <p className="text-xs text-gray-500">
                                            by {item.actor_name}
                                        </p>
                                    </div>
                                    <span className="flex-shrink-0 text-xs text-gray-500">
                                        {timeAgo(item.created_at)}
                                    </span>
                                </div>
                            ))}
                        </div>

                        {/* Pagination */}
                        {totalPages > 1 && (
                            <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-4">
                                <button
                                    onClick={() => loadActivity(activityPage - 1)}
                                    disabled={activityPage <= 1 || activityLoading}
                                    className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                    ← Previous
                                </button>
                                <span className="text-xs text-gray-500">
                                    Page {activityPage} of {totalPages}
                                </span>
                                <button
                                    onClick={() => loadActivity(activityPage + 1)}
                                    disabled={activityPage >= totalPages || activityLoading}
                                    className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                    Next →
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
