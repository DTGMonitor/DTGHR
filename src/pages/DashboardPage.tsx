import { useState, useEffect } from "react";
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

export default function DashboardPage() {
    const { user } = useAuth();
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const res = await api.get("/dashboard/stats");
                setStats(res.data);
            } catch {
                // silently ignore
            } finally {
                setLoading(false);
            }
        })();
    }, []);

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

            {/* Recent Activity placeholder */}
            <div className="rounded-2xl border border-white/10 bg-gray-900/30 p-6">
                <h2 className="text-lg font-semibold text-white">Recent Activity</h2>
                <p className="mt-2 text-sm text-gray-500">
                    No recent activity to display. This section will show leave requests,
                    approvals, and other updates.
                </p>
            </div>
        </div>
    );
}
