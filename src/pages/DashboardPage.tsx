import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { dashboardService } from "@/services/dashboardService";
import { leaveService } from "@/services/leaveService";
import { scheduleService } from "@/services/scheduleService";
import type { LeaveOverview } from "@/types/leave";
import { SHIFT_STYLES, type PublicHoliday, type ShiftCode } from "@/types/schedule";
import { isoDate } from "@/lib/dates";
import { formatDays, formatRange, LEAVE_TYPE_LABELS } from "@/components/leaves/leaveLabels";
import StatTile from "@/components/ui/StatTile";
import Icon from "@/components/ui/icons";
import {
    SAMPLE_ANNOUNCEMENTS,
    SAMPLE_KPIS,
    SAMPLE_KPI_PERIOD,
    SAMPLE_KPI_SCORE,
    SAMPLE_PAYSLIP,
    nextPayday,
} from "@/data/dashboardSample";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminStats {
    role: "admin";
    total_employees: number;
    pending_approvals: number;
    on_leave_today: number;
    new_this_month: number;
}

type DashboardStats = AdminStats | { role: "employee" };

interface DayShift {
    iso: string;
    date: Date;
    code: ShiftCode | null;
    holiday: PublicHoliday | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const idr = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });

function addDays(d: Date, n: number): Date {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
}

function daysUntil(target: Date, from: Date): number {
    const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    const b = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
    return Math.round((b - a) / 86_400_000);
}

// ─── Building blocks ──────────────────────────────────────────────────────────

/**
 * Marks a block whose numbers are invented. Payroll, KPI and announcements are
 * not wired to anything yet, and an unlabelled placeholder on a dashboard gets
 * quoted in a meeting sooner or later.
 */
function SampleTag() {
    return (
        <span
            className="dtg-chip border-dashed border-white/20 text-muted"
            title="Placeholder content until this module is connected"
        >
            Sample
        </span>
    );
}

function Panel({
    title,
    action,
    sample,
    className = "",
    children,
}: {
    title: string;
    action?: ReactNode;
    sample?: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <section className={`dtg-panel p-5 ${className}`}>
            <div className="mb-4 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                    <h2 className="dtg-eyebrow">{title}</h2>
                    {sample && <SampleTag />}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

const LinkAction = ({ to, children }: { to: string; children: ReactNode }) => (
    <Link
        to={to}
        className="text-label font-semibold uppercase tracking-label text-teal-300 transition-colors hover:text-signal"
    >
        {children}
    </Link>
);

// ─── Component ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
    const { user } = useAuth();
    const isAdmin = !!user?.is_superuser;
    const employeeId = user?.employee_id ?? null;

    const today = useMemo(() => new Date(), []);
    const todayIso = isoDate(today);

    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [overview, setOverview] = useState<LeaveOverview | null>(null);
    const [week, setWeek] = useState<DayShift[]>([]);
    const [holidays, setHolidays] = useState<PublicHoliday[]>([]);
    const [loading, setLoading] = useState(true);
    const [showPay, setShowPay] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const end = addDays(today, 6);

        (async () => {
            const [statsRes, overviewRes, shiftsRes, holidaysRes] = await Promise.allSettled([
                isAdmin ? dashboardService.stats<DashboardStats>() : Promise.resolve(null),
                employeeId ? leaveService.getMyOverview() : Promise.resolve(null),
                employeeId
                    ? scheduleService.shiftsFor(employeeId, todayIso, isoDate(end))
                    : Promise.resolve(null),
                scheduleService.upcomingHolidays(todayIso, 6),
            ]);
            if (cancelled) return;

            if (statsRes.status === "fulfilled" && statsRes.value) setStats(statsRes.value.data);
            if (overviewRes.status === "fulfilled" && overviewRes.value) setOverview(overviewRes.value.data);

            const upcoming = holidaysRes.status === "fulfilled" ? holidaysRes.value.data : [];
            setHolidays(upcoming);

            const codes = new Map<string, ShiftCode>();
            if (shiftsRes.status === "fulfilled" && shiftsRes.value) {
                for (const s of shiftsRes.value.data) codes.set(s.date, s.shift_code);
            }
            const byDate = new Map(upcoming.map((h) => [h.date, h]));
            setWeek(
                Array.from({ length: 7 }, (_, i) => {
                    const date = addDays(today, i);
                    const iso = isoDate(date);
                    return { iso, date, code: codes.get(iso) ?? null, holiday: byDate.get(iso) ?? null };
                })
            );
            setLoading(false);
        })();

        return () => {
            cancelled = true;
        };
    }, [isAdmin, employeeId, today, todayIso]);

    const payday = nextPayday(today);
    const payIn = daysUntil(payday, today);
    const gross =
        SAMPLE_PAYSLIP.basic + SAMPLE_PAYSLIP.allowances.reduce((n, a) => n + a.amount, 0);
    const deductions = SAMPLE_PAYSLIP.deductions.reduce((n, d) => n + d.amount, 0);
    const net = gross - deductions;
    const money = (n: number) => (showPay ? idr.format(n) : "Rp •••••••");

    const todayShift = week[0];
    const admin = stats?.role === "admin" ? stats : null;

    return (
        <div className="dtg-fade-in space-y-6">
            {/* Welcome. A flat teal band in the site's idiom — the gradient blobs
                this replaced were the only soft-focus element in the product. */}
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-band p-6 sm:p-8">
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 opacity-[0.06]"
                    style={{
                        backgroundImage: "radial-gradient(circle at 1px 1px, #F4F0E7 1px, transparent 0)",
                        backgroundSize: "14px 14px",
                        maskImage: "linear-gradient(110deg, #000 0%, transparent 55%)",
                        WebkitMaskImage: "linear-gradient(110deg, #000 0%, transparent 55%)",
                    }}
                />
                <div className="relative">
                    <p className="dtg-eyebrow">
                        {today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                    </p>
                    <h1 className="mt-2 text-2xl font-bold tracking-tight text-paper">
                        Welcome back, {user?.full_name?.split(" ")[0]}
                    </h1>
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                        {todayShift?.code ? (
                            <span className="inline-flex items-center gap-2 rounded border border-white/12 bg-white/[0.06] px-2.5 py-1 text-paper-soft">
                                <span
                                    className="h-2.5 w-2.5 rounded-sm"
                                    style={{ background: SHIFT_STYLES[todayShift.code].bg }}
                                />
                                Today: {SHIFT_STYLES[todayShift.code].label} ({todayShift.code})
                            </span>
                        ) : employeeId && !loading ? (
                            <span className="rounded border border-white/12 px-2.5 py-1 text-muted">
                                No shift rostered today
                            </span>
                        ) : null}
                        {todayShift?.holiday && (
                            <span className="rounded border border-signal/30 bg-signal/10 px-2.5 py-1 text-signal">
                                {todayShift.holiday.name}
                            </span>
                        )}
                        {overview?.next_leave && (
                            <span className="rounded border border-teal-500/30 bg-teal-900/40 px-2.5 py-1 text-teal-100">
                                Next leave: {formatRange(overview.next_leave.start_date, overview.next_leave.end_date)}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Headline tiles */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {loading ? (
                    [...Array(4)].map((_, i) => (
                        <div key={i} className="h-32 animate-pulse rounded-2xl border border-white/10 bg-white/[0.04]" />
                    ))
                ) : (
                    <>
                        {overview ? (
                            <>
                                <Link to="/leaves" className="block">
                                    <StatTile
                                        label="Annual leave"
                                        value={overview.annual.remaining}
                                        sub={`of ${overview.annual.total} days · ${overview.annual.used} used`}
                                        icon="sun"
                                        accent="action"
                                    />
                                </Link>
                                <Link to="/leaves" className="block">
                                    <StatTile
                                        label="Pending requests"
                                        value={overview.pending_count}
                                        sub={overview.pending_count ? `${formatDays(overview.pending_days)} awaiting approval` : "Nothing waiting"}
                                        icon="clock"
                                        accent="attention"
                                    />
                                </Link>
                            </>
                        ) : admin ? (
                            <>
                                <Link to="/employees" className="block">
                                    <StatTile
                                        label="Total employees"
                                        value={admin.total_employees}
                                        sub={`${admin.new_this_month} joined this month`}
                                        icon="users"
                                        accent="data"
                                    />
                                </Link>
                                <Link to="/leaves" className="block">
                                    <StatTile
                                        label="Pending approvals"
                                        value={admin.pending_approvals}
                                        sub={`${admin.on_leave_today} on leave today`}
                                        icon="clipboard"
                                        accent="attention"
                                    />
                                </Link>
                            </>
                        ) : null}
                        <StatTile
                            label="Next payday"
                            value={payIn === 0 ? "Today" : `${payIn} day${payIn === 1 ? "" : "s"}`}
                            sub={payday.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                            icon="calendar"
                            accent="neutral"
                            footer={<SampleTag />}
                        />
                        <StatTile
                            label="KPI score"
                            value={`${SAMPLE_KPI_SCORE}%`}
                            sub={`${SAMPLE_KPI_PERIOD} · on track`}
                            icon="chart"
                            accent="data"
                            footer={<SampleTag />}
                        />
                    </>
                )}
            </div>

            {/* Organisation strip -- HR who also have their own leave see both. */}
            {admin && overview && (
                <div className="dtg-panel grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
                    {[
                        ["Employees", admin.total_employees, "/employees"],
                        ["Pending approvals", admin.pending_approvals, "/leaves"],
                        ["On leave today", admin.on_leave_today, "/employees"],
                        ["Joined this month", admin.new_this_month, "/employees"],
                    ].map(([label, value, to]) => (
                        <Link
                            key={label as string}
                            to={to as string}
                            className="rounded-lg px-3 py-2 transition-colors hover:bg-white/5"
                        >
                            <p className="dtg-eyebrow text-paper-soft">{label}</p>
                            <p className="mt-1.5 font-mono text-xl font-semibold text-paper">{value}</p>
                        </Link>
                    ))}
                </div>
            )}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                {/* Salary */}
                <Panel
                    title="Salary"
                    sample
                    action={
                        <button
                            onClick={() => setShowPay((s) => !s)}
                            className="text-label font-semibold uppercase tracking-label text-teal-300 transition-colors hover:text-signal"
                        >
                            {showPay ? "Hide" : "Show"}
                        </button>
                    }
                >
                    <p className="text-xs text-muted">Latest payslip · {SAMPLE_PAYSLIP.period}</p>
                    <p className="mt-1.5 font-mono text-2xl font-semibold text-paper">{money(net)}</p>
                    <p className="text-xs text-muted">take-home pay</p>
                    <dl className="mt-4 space-y-1.5 text-sm">
                        <div className="flex justify-between text-paper-soft">
                            <dt>Basic salary</dt>
                            <dd className="font-mono">{money(SAMPLE_PAYSLIP.basic)}</dd>
                        </div>
                        {SAMPLE_PAYSLIP.allowances.map((a) => (
                            <div key={a.label} className="flex justify-between text-muted">
                                <dt>+ {a.label}</dt>
                                <dd className="font-mono">{money(a.amount)}</dd>
                            </div>
                        ))}
                        {SAMPLE_PAYSLIP.deductions.map((d) => (
                            <div key={d.label} className="flex justify-between text-muted">
                                <dt>− {d.label}</dt>
                                <dd className="font-mono">{money(d.amount)}</dd>
                            </div>
                        ))}
                    </dl>
                </Panel>

                {/* KPI */}
                <Panel title={`KPI · ${SAMPLE_KPI_PERIOD}`} sample>
                    <ul className="space-y-4">
                        {SAMPLE_KPIS.map((k) => (
                            <li key={k.label}>
                                <div className="flex items-baseline justify-between gap-2 text-sm">
                                    <span className="text-paper-soft">{k.label}</span>
                                    <span className="whitespace-nowrap font-mono text-xs text-muted">
                                        {k.actual} / {k.target}
                                    </span>
                                </div>
                                <div
                                    className="mt-1.5 h-1.5 overflow-hidden rounded-sm bg-white/10"
                                    role="meter"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={k.progress}
                                    aria-label={`${k.label}: ${k.progress}% of target`}
                                >
                                    <div className="h-full rounded-sm bg-signal" style={{ width: `${k.progress}%` }} />
                                </div>
                            </li>
                        ))}
                    </ul>
                </Panel>

                {/* This week's roster */}
                <Panel title="My next 7 days" action={<LinkAction to="/schedules">Roster</LinkAction>}>
                    {!employeeId ? (
                        <p className="text-sm text-muted">No roster row is linked to your account.</p>
                    ) : (
                        <ol className="space-y-1.5">
                            {week.map((d) => {
                                const style = d.code ? SHIFT_STYLES[d.code] : null;
                                return (
                                    <li key={d.iso} className="flex items-center gap-3 text-sm">
                                        <span className={`w-20 flex-shrink-0 font-mono text-xs ${d.iso === todayIso ? "font-semibold text-paper" : "text-muted"}`}>
                                            {d.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                                        </span>
                                        <span
                                            className="inline-flex h-6 w-9 flex-shrink-0 items-center justify-center rounded text-[10px] font-bold"
                                            style={style ? { background: style.bg, color: style.fg } : { background: "rgba(255,255,255,0.05)", color: "#7C8B92" }}
                                        >
                                            {d.code && !style?.blankInGrid ? d.code : d.code ? "" : "–"}
                                        </span>
                                        <span className="truncate text-paper-soft">
                                            {d.holiday ? d.holiday.name : style ? style.label : "Not rostered"}
                                        </span>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </Panel>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                {/* Announcements */}
                <Panel title="Announcements" sample className="lg:col-span-2">
                    <ul className="divide-y divide-white/[0.06]">
                        {SAMPLE_ANNOUNCEMENTS.map((a) => (
                            <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                                <div className="flex items-center gap-2">
                                    {a.pinned && (
                                        <Icon name="pin" className="h-3.5 w-3.5 flex-shrink-0 text-gold" aria-label="Pinned" />
                                    )}
                                    <span className="dtg-chip border-white/12 text-paper-soft">{a.tag}</span>
                                    <h3 className="truncate text-sm font-medium text-paper">{a.title}</h3>
                                    <span className="ml-auto flex-shrink-0 font-mono text-micro text-muted">
                                        {new Date(a.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                                    </span>
                                </div>
                                <p className="mt-1 text-sm text-paper-soft">{a.body}</p>
                            </li>
                        ))}
                    </ul>
                </Panel>

                <div className="space-y-6">
                    {/* Leave used this year */}
                    {overview && (
                        <Panel title={`Leave in ${overview.year}`} action={<LinkAction to="/leaves">Details</LinkAction>}>
                            <p className="font-mono text-2xl font-semibold text-paper">{formatDays(overview.used_days)}</p>
                            <p className="text-xs text-muted">approved so far</p>
                            <ul className="mt-3 space-y-1 text-sm">
                                {(Object.keys(overview.used_by_type) as (keyof typeof overview.used_by_type)[]).map((t) => (
                                    <li key={t} className="flex justify-between text-paper-soft">
                                        <span>{LEAVE_TYPE_LABELS[t]}</span>
                                        <span className="font-mono text-paper">{overview.used_by_type[t]}</span>
                                    </li>
                                ))}
                            </ul>
                        </Panel>
                    )}

                    {/* Upcoming holidays */}
                    <Panel title="Upcoming holidays" action={<LinkAction to="/schedules">Calendar</LinkAction>}>
                        {holidays.length === 0 ? (
                            <p className="text-sm text-muted">{loading ? "Loading…" : "None on file."}</p>
                        ) : (
                            <ul className="space-y-2">
                                {holidays.map((h) => {
                                    const d = new Date(`${h.date}T00:00:00`);
                                    const inDays = daysUntil(d, today);
                                    return (
                                        <li key={h.id} className="flex items-center gap-3">
                                            {/* National days carry the signal colour; cuti bersama
                                                is gold, the same split the roster legend uses. */}
                                            <div
                                                className={`flex h-10 w-10 flex-shrink-0 flex-col items-center justify-center rounded border ${
                                                    h.is_national
                                                        ? "border-signal/30 bg-signal/10 text-signal"
                                                        : "border-gold/30 bg-gold/10 text-gold"
                                                }`}
                                            >
                                                <span className="font-mono text-sm font-bold leading-none">{d.getDate()}</span>
                                                <span className="text-[9px] uppercase tracking-wider">
                                                    {d.toLocaleDateString("en-GB", { month: "short" })}
                                                </span>
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm text-paper">{h.name}</p>
                                                <p className="text-xs text-muted">
                                                    {h.is_national ? "National holiday" : "Cuti bersama"} ·{" "}
                                                    {inDays === 0 ? "today" : inDays === 1 ? "tomorrow" : `in ${inDays} days`}
                                                </p>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </Panel>
                </div>
            </div>
        </div>
    );
}
