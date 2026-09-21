import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import StatTile from "@/components/ui/StatTile";
import { Wordmark } from "@/components/brand/Logo";
import BulletinSection from "@/components/articles/BulletinSection";
import WeekStrip from "@/components/dashboard/WeekStrip";
import { overviewService, type Overview } from "@/services/dashboardService";

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────


// ─── Component ────────────────────────────────────────────────────────────────


export default function DashboardPage() {
    const { user } = useAuth();

    /*
     * Reading or writing an article takes over the page.
     *
     * The bulletin lives on the dashboard, so without this the welcome band
     * and the four stat tiles sat above whatever you had opened -- you scrolled
     * past your own headcount to reach the article, and the editor had the
     * dashboard's furniture stacked on top of it. The same URL keys the
     * bulletin's own mode, so the two cannot disagree.
     */
    const [params] = useSearchParams();
    const focused = params.has("read") || params.has("edit");
    const [overview, setOverview] = useState<Overview | null>(null);
    // Kept so the effect can say when it has finished; the panels below
    // simply do not render until `overview` arrives.
    const [, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const res = await overviewService.get();
                setOverview(res.data);
            } catch {
                // A dashboard that cannot load its summary should still show
                // the bulletin rather than an error page.
            } finally {
                setLoading(false);
            }
        })();
    }, []);


    const today = new Date();
    const firstName = user?.full_name?.split(" ")[0];

    return (
        <div className="dtg-fade-in space-y-6">
            {!focused && (
                <>
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
                                {overview?.is_management
                                    ? "Your week, what is waiting on you, and the bulletin."
                                    : "Your week, your leave, and what the team should know."}
                            </p>
                        </div>

                        {/* The wordmark was set at 32px and 40% opacity, which read as a
                            watermark somebody had forgotten to remove. The asset is
                            552x198, so it carries far more size than it was being given:
                            56px is still a downscale, and therefore still crisp. */}
                        <Wordmark className="hidden h-11 opacity-70 lg:block xl:h-14" />
                    </div>
                </section>

                {/*
                    Your week, then what is waiting.

                    This replaced four counters -- headcount, approvals, on
                    leave today, new this month -- which for a team of ten read
                    "10, 0, 0, 0" most mornings. True, and no use to anybody.
                    These are the questions people actually arrive with.
                */}
                {overview && (
                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                        <section className="dtg-panel overflow-hidden">
                            <header className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-3">
                                <div>
                                    <p className="dtg-eyebrow">Your week</p>
                                    <h2 className="mt-0.5 text-sm font-semibold text-paper">
                                        Next seven days
                                    </h2>
                                </div>
                                <Link
                                    to="/schedules"
                                    className="text-label font-semibold uppercase tracking-label text-teal-300 transition-colors hover:text-signal"
                                >
                                    Full roster
                                </Link>
                            </header>
                            <WeekStrip days={overview.week} />
                        </section>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
                            {/* Founders carry no annual balance, so they are
                                shown none rather than a nought. */}
                            {overview.leave && (
                                <Link to="/leaves" className="block">
                                    <StatTile
                                        label="Annual leave left"
                                        value={overview.leave.remaining}
                                        sub={`of ${overview.leave.total} days · ${overview.leave.used} used`}
                                        icon="sun"
                                        accent="action"
                                        footer={
                                            overview.pending_mine > 0 ? (
                                                <span className="text-gold">
                                                    {overview.pending_mine} awaiting a decision
                                                </span>
                                            ) : undefined
                                        }
                                    />
                                </Link>
                            )}

                            {overview.is_management && overview.pending_approvals !== null && (
                                <Link to="/leaves" className="block">
                                    <StatTile
                                        label="Waiting on you"
                                        value={overview.pending_approvals}
                                        sub={
                                            overview.pending_approvals > 0
                                                ? "leave requests to review"
                                                : "nothing to review"
                                        }
                                        icon="clipboard"
                                        accent={overview.pending_approvals > 0 ? "attention" : "neutral"}
                                        footer={
                                            overview.on_leave_today ? (
                                                <span>{overview.on_leave_today} on leave today</span>
                                            ) : undefined
                                        }
                                    />
                                </Link>
                            )}
                        </div>
                    </div>
                )}

                {/* Public holidays still to come this month. Hidden entirely
                    when there are none -- an empty panel saying "none" is the
                    kind of thing that made the old dashboard feel dead. */}
                {overview && overview.holidays.length > 0 && (
                    <section className="dtg-panel overflow-hidden">
                        <header className="border-b border-white/[0.08] px-4 py-3">
                            <p className="dtg-eyebrow">Public holidays</p>
                            <h2 className="mt-0.5 text-sm font-semibold text-paper">
                                Still to come this month
                            </h2>
                        </header>
                        <ul className="flex flex-wrap gap-3 p-4">
                            {overview.holidays.map((h) => {
                                const d = new Date(`${h.date}T00:00:00`);
                                return (
                                    <li
                                        key={h.date + h.name}
                                        className="flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2"
                                    >
                                        <div
                                            className={`flex h-9 w-9 flex-col items-center justify-center rounded border ${
                                                h.is_national
                                                    ? "border-signal/30 bg-signal/10 text-signal"
                                                    : "border-gold/30 bg-gold/10 text-gold"
                                            }`}
                                        >
                                            <span className="font-mono text-xs font-bold leading-none">
                                                {d.getDate()}
                                            </span>
                                            <span className="text-[0.5rem] uppercase tracking-wider">
                                                {d.toLocaleDateString("en-GB", { month: "short" })}
                                            </span>
                                        </div>
                                        <div>
                                            <p className="text-sm text-paper">{h.name}</p>
                                            <p className="text-micro text-muted">
                                                {h.is_national ? "National holiday" : "Cuti bersama"}
                                            </p>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                )}
                </>
            )}

            {/* ── Staff bulletin ─────────────────────────────────────────
                Where the audit trail used to sit. This is the thing people
                should read on the way past; the audit trail is a record you
                go looking for, and it has its own page now. */}
            <BulletinSection />

        </div>
    );
}
