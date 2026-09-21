import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import StatTile, { StatTileSkeleton, type StatTileProps } from "@/components/ui/StatTile";
import { Wordmark } from "@/components/brand/Logo";
import BulletinSection from "@/components/articles/BulletinSection";

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

// ─── Helpers ──────────────────────────────────────────────────────────────────


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


export default function DashboardPage() {
    const { user } = useAuth();
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const statsRes = await api.get("/dashboard/stats");
                setStats(statsRes.data);
            } catch {
                // silently ignore
            } finally {
                setLoading(false);
            }
        })();
    }, []);


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

            {/* ── Staff bulletin ─────────────────────────────────────────
                Where the audit trail used to sit. This is the thing people
                should read on the way past; the audit trail is a record you
                go looking for, and it has its own page now. */}
            <BulletinSection />

        </div>
    );
}
