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

function SampleTag() {
    return (
        <span
            className="rounded-full border border-dashed border-gray-600 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-500"
            title="Placeholder content until this module is connected"
        >
            Sample data
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
        <section className={`rounded-2xl border border-white/10 bg-gray-900/30 p-5 ${className}`}>
            <div className="mb-4 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold text-white">{title}</h2>
                    {sample && <SampleTag />}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

function StatTile({
    label,
    value,
    sub,
    icon,
    tone,
    to,
    sample,
}: {
    label: string;
    value: string;
    sub?: string;
    icon: string;
    tone: string;
    to?: string;
    sample?: boolean;
}) {
    const body = (
        <div className={`h-full rounded-2xl border bg-gradient-to-br p-5 transition-transform hover:scale-[1.02] ${tone}`}>
            <div className="flex items-start justify-between">
                <p className="text-sm text-gray-400">{label}</p>
                <span className="text-2xl" aria-hidden>{icon}</span>
            </div>
            <p className="mt-1 text-3xl font-bold text-white">{value}</p>
            <div className="mt-1 flex items-center justify-between gap-2">
                {sub && <p className="truncate text-xs text-gray-400">{sub}</p>}
                {sample && <SampleTag />}
            </div>
        </div>
    );
    return to ? <Link to={to} className="block">{body}</Link> : body;
}

const LinkAction = ({ to, children }: { to: string; children: ReactNode }) => (
    <Link to={to} className="text-xs font-medium text-indigo-400 hover:underline">
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
        <div className="space-y-6">
            {/* Welcome */}
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-pink-500/10 p-6 sm:p-8">
                <div className="pointer-events-none absolute -right-20 -top-20 h-60 w-60 rounded-full bg-indigo-500/10 blur-3xl" />
                <p className="text-sm text-gray-400">
                    {today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                </p>
                <h1 className="mt-1 text-2xl font-bold text-white">
                    Welcome back, {user?.full_name?.split(" ")[0]} 👋
                </h1>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    {todayShift?.code ? (
                        <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-gray-200">
                            <span
                                className="h-2.5 w-2.5 rounded-sm"
                                style={{ background: SHIFT_STYLES[todayShift.code].bg }}
                            />
                            Today: {SHIFT_STYLES[todayShift.code].label} ({todayShift.code})
                        </span>
                    ) : employeeId && !loading ? (
                        <span className="rounded-full bg-white/10 px-3 py-1 text-gray-400">No shift rostered today</span>
                    ) : null}
                    {todayShift?.holiday && (
                        <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-300">
                            🇮🇩 {todayShift.holiday.name}
                        </span>
                    )}
                    {overview?.next_leave && (
                        <span className="rounded-full bg-blue-500/15 px-3 py-1 text-blue-300">
                            Next leave: {formatRange(overview.next_leave.start_date, overview.next_leave.end_date)}
                        </span>
                    )}
                </div>
            </div>

            {/* Headline tiles */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {loading ? (
                    [...Array(4)].map((_, i) => (
                        <div key={i} className="h-32 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
                    ))
                ) : (
                    <>
                        {overview ? (
                            <>
                                <StatTile
                                    label="Annual leave"
                                    value={String(overview.annual.remaining)}
                                    sub={`of ${overview.annual.total} days · ${overview.annual.used} used`}
                                    icon="🏖️"
                                    tone="from-blue-500/20 to-cyan-500/20 border-blue-500/20"
                                    to="/leaves"
                                />
                                <StatTile
                                    label="Pending requests"
                                    value={String(overview.pending_count)}
                                    sub={overview.pending_count ? `${formatDays(overview.pending_days)} awaiting approval` : "Nothing waiting"}
                                    icon="⏳"
                                    tone="from-amber-500/20 to-orange-500/20 border-amber-500/20"
                                    to="/leaves"
                                />
                            </>
                        ) : admin ? (
                            <>
                                <StatTile
                                    label="Total employees"
                                    value={String(admin.total_employees)}
                                    sub={`${admin.new_this_month} joined this month`}
                                    icon="👥"
                                    tone="from-blue-500/20 to-cyan-500/20 border-blue-500/20"
                                    to="/employees"
                                />
                                <StatTile
                                    label="Pending approvals"
                                    value={String(admin.pending_approvals)}
                                    sub={`${admin.on_leave_today} on leave today`}
                                    icon="📋"
                                    tone="from-amber-500/20 to-orange-500/20 border-amber-500/20"
                                    to="/leaves"
                                />
                            </>
                        ) : null}
                        <StatTile
                            label="Next payday"
                            value={payIn === 0 ? "Today" : `${payIn} day${payIn === 1 ? "" : "s"}`}
                            sub={payday.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                            icon="💰"
                            tone="from-emerald-500/20 to-green-500/20 border-emerald-500/20"
                            sample
                        />
                        <StatTile
                            label="KPI score"
                            value={`${SAMPLE_KPI_SCORE}%`}
                            sub={`${SAMPLE_KPI_PERIOD} · on track`}
                            icon="🎯"
                            tone="from-purple-500/20 to-violet-500/20 border-purple-500/20"
                            sample
                        />
                    </>
                )}
            </div>

            {/* Organisation strip -- HR who also have their own leave see both. */}
            {admin && overview && (
                <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:grid-cols-4">
                    {[
                        ["Employees", admin.total_employees, "/employees"],
                        ["Pending approvals", admin.pending_approvals, "/leaves"],
                        ["On leave today", admin.on_leave_today, "/employees"],
                        ["Joined this month", admin.new_this_month, "/employees"],
                    ].map(([label, value, to]) => (
                        <Link key={label as string} to={to as string} className="rounded-xl px-3 py-2 transition hover:bg-white/5">
                            <p className="text-xs text-gray-500">{label}</p>
                            <p className="text-xl font-semibold text-white">{value}</p>
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
                            className="text-xs font-medium text-indigo-400 hover:underline"
                        >
                            {showPay ? "Hide amounts" : "Show amounts"}
                        </button>
                    }
                >
                    <p className="text-xs text-gray-500">Latest payslip · {SAMPLE_PAYSLIP.period}</p>
                    <p className="mt-1 text-2xl font-bold text-white">{money(net)}</p>
                    <p className="text-xs text-gray-500">take-home pay</p>
                    <dl className="mt-4 space-y-1.5 text-sm">
                        <div className="flex justify-between text-gray-300">
                            <dt>Basic salary</dt>
                            <dd>{money(SAMPLE_PAYSLIP.basic)}</dd>
                        </div>
                        {SAMPLE_PAYSLIP.allowances.map((a) => (
                            <div key={a.label} className="flex justify-between text-gray-400">
                                <dt>+ {a.label}</dt>
                                <dd>{money(a.amount)}</dd>
                            </div>
                        ))}
                        {SAMPLE_PAYSLIP.deductions.map((d) => (
                            <div key={d.label} className="flex justify-between text-gray-500">
                                <dt>− {d.label}</dt>
                                <dd>{money(d.amount)}</dd>
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
                                    <span className="text-gray-300">{k.label}</span>
                                    <span className="whitespace-nowrap text-xs text-gray-400">
                                        {k.actual} / {k.target}
                                    </span>
                                </div>
                                <div
                                    className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"
                                    role="meter"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={k.progress}
                                    aria-label={`${k.label}: ${k.progress}% of target`}
                                >
                                    <div className="h-full rounded-full bg-indigo-400" style={{ width: `${k.progress}%` }} />
                                </div>
                            </li>
                        ))}
                    </ul>
                </Panel>

                {/* This week's roster */}
                <Panel title="My next 7 days" action={<LinkAction to="/schedules">Roster →</LinkAction>}>
                    {!employeeId ? (
                        <p className="text-sm text-gray-500">No roster row is linked to your account.</p>
                    ) : (
                        <ol className="space-y-1.5">
                            {week.map((d) => {
                                const style = d.code ? SHIFT_STYLES[d.code] : null;
                                return (
                                    <li key={d.iso} className="flex items-center gap-3 text-sm">
                                        <span className={`w-20 flex-shrink-0 ${d.iso === todayIso ? "font-semibold text-white" : "text-gray-400"}`}>
                                            {d.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                                        </span>
                                        <span
                                            className="inline-flex h-6 w-9 flex-shrink-0 items-center justify-center rounded text-[10px] font-bold"
                                            style={style ? { background: style.bg, color: style.fg } : { background: "rgba(255,255,255,0.05)", color: "#6b7280" }}
                                        >
                                            {d.code && !style?.blankInGrid ? d.code : d.code ? "" : "–"}
                                        </span>
                                        <span className="truncate text-gray-400">
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
                    <ul className="divide-y divide-white/5">
                        {SAMPLE_ANNOUNCEMENTS.map((a) => (
                            <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                                <div className="flex items-center gap-2">
                                    {a.pinned && <span title="Pinned" aria-label="Pinned">📌</span>}
                                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">{a.tag}</span>
                                    <h3 className="truncate text-sm font-medium text-white">{a.title}</h3>
                                    <span className="ml-auto flex-shrink-0 text-xs text-gray-500">
                                        {new Date(a.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                                    </span>
                                </div>
                                <p className="mt-1 text-sm text-gray-400">{a.body}</p>
                            </li>
                        ))}
                    </ul>
                </Panel>

                <div className="space-y-6">
                    {/* Leave used this year */}
                    {overview && (
                        <Panel title={`Leave in ${overview.year}`} action={<LinkAction to="/leaves">Details →</LinkAction>}>
                            <p className="text-2xl font-bold text-white">{formatDays(overview.used_days)}</p>
                            <p className="text-xs text-gray-500">approved so far</p>
                            <ul className="mt-3 space-y-1 text-sm">
                                {(Object.keys(overview.used_by_type) as (keyof typeof overview.used_by_type)[]).map((t) => (
                                    <li key={t} className="flex justify-between text-gray-400">
                                        <span>{LEAVE_TYPE_LABELS[t]}</span>
                                        <span className="text-gray-300">{overview.used_by_type[t]}</span>
                                    </li>
                                ))}
                            </ul>
                        </Panel>
                    )}

                    {/* Upcoming holidays */}
                    <Panel title="Upcoming holidays" action={<LinkAction to="/schedules">Calendar →</LinkAction>}>
                        {holidays.length === 0 ? (
                            <p className="text-sm text-gray-500">{loading ? "Loading…" : "None on file."}</p>
                        ) : (
                            <ul className="space-y-2">
                                {holidays.map((h) => {
                                    const d = new Date(`${h.date}T00:00:00`);
                                    const inDays = daysUntil(d, today);
                                    return (
                                        <li key={h.id} className="flex items-center gap-3">
                                            <div className={`flex h-10 w-10 flex-shrink-0 flex-col items-center justify-center rounded-lg ${h.is_national ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/10 text-amber-300"}`}>
                                                <span className="text-sm font-bold leading-none">{d.getDate()}</span>
                                                <span className="text-[9px] uppercase">{d.toLocaleDateString("en-GB", { month: "short" })}</span>
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm text-gray-200">{h.name}</p>
                                                <p className="text-xs text-gray-500">
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
