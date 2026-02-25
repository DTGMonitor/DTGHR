import { useAuth } from "@/contexts/AuthContext";

export default function DashboardPage() {
    const { user } = useAuth();

    return (
        <div className="space-y-6">
            {/* Welcome Banner */}
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-pink-500/10 p-8">
                <div className="pointer-events-none absolute -right-20 -top-20 h-60 w-60 rounded-full bg-indigo-500/10 blur-3xl" />
                <h1 className="text-2xl font-bold text-white">
                    Welcome back, {user?.full_name?.split(" ")[0]} 👋
                </h1>
                <p className="mt-2 text-gray-400">
                    Here's your HR Hub dashboard overview.
                </p>
            </div>

            {/* Quick Stats */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[
                    {
                        label: "Total Employees",
                        value: "—",
                        icon: "👥",
                        color: "from-blue-500/20 to-cyan-500/20",
                        border: "border-blue-500/20",
                    },
                    {
                        label: "Pending Leaves",
                        value: "—",
                        icon: "📋",
                        color: "from-amber-500/20 to-orange-500/20",
                        border: "border-amber-500/20",
                    },
                    {
                        label: "My Leave Balance",
                        value: "—",
                        icon: "🗓",
                        color: "from-emerald-500/20 to-green-500/20",
                        border: "border-emerald-500/20",
                    },
                ].map((stat) => (
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
                            </div>
                            <span className="text-3xl">{stat.icon}</span>
                        </div>
                    </div>
                ))}
            </div>

            {/* Placeholder (future: recent activity, upcoming leaves, etc.) */}
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
