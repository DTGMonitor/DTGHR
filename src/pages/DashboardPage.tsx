import { useState, useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import StatTile from "@/components/ui/StatTile";
import { Wordmark } from "@/components/brand/Logo";
import BulletinSection from "@/components/articles/BulletinSection";
import WeekStrip from "@/components/dashboard/WeekStrip";
import { SHIFT_STYLES, type ShiftCode } from "@/types/schedule";
import { overviewService, type Overview } from "@/services/dashboardService";
import { money } from "@/services/salaryService";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "Aris", "Aris and Adib", "Aris, Adib and Nessy". */
function names(list: string[]): string {
    if (list.length <= 1) return list[0] ?? "";
    return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** "annual" -> "annual leave", "child_marriage" -> "child marriage leave". */
function leaveName(kind: string): string {
    return `${kind.replace(/_/g, " ")} leave`;
}

/** "5 Oct", or "5–7 Oct", or "30 Sep – 2 Oct". */
function dayRange(start: string, end: string): string {
    const day = (iso: string, withMonth: boolean) =>
        new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
            day: "numeric",
            ...(withMonth ? { month: "short" } : {}),
        });
    if (start === end) return day(start, true);
    if (start.slice(0, 7) === end.slice(0, 7)) return `${day(start, false)}–${day(end, true)}`;
    return `${day(start, true)} – ${day(end, true)}`;
}

/** "Himawan Praptomo" -> "Himawan". The sentence is between colleagues. */
function firstName(full: string): string {
    return full.trim().split(/\s+/)[0] ?? full;
}

/**
 * Names worn in the colour of the shift they are working.
 *
 * Not coloured text: DS is #FFFF00 and NS is #002060, and navy lettering on a
 * navy band is unreadable. As a pill both work, because each carries the
 * roster's own foreground with it -- black on yellow, white on navy -- and the
 * ring keeps the dark one off the background. The same palette as the roster
 * grid and the week strip, so a colour means one thing everywhere.
 */
function Crew({ list, code }: { list: string[]; code: "DS" | "NS" }) {
    const style = SHIFT_STYLES[code as ShiftCode];
    return (
        <span
            className="mx-0.5 inline-block rounded px-1.5 py-px text-xs font-semibold ring-1 ring-white/20"
            style={{ background: style.bg, color: style.fg }}
        >
            {names(list)}
        </span>
    );
}

/**
 * Two short lines under the greeting: what today is, and what wants you.
 *
 * It was one sentence, and once it carried the crew it ran past the end of
 * the band and broke "your / approval." across lines. Splitting it by kind
 * rather than by length means neither line grows unpredictably: the first is
 * the state of the day, the second is the queue with your name on it, and a
 * line with nothing to say is not printed at all.
 *
 * Nurhuda asked for the crew on her dashboard too. She has a roster of her
 * own, so she gets both -- her shift, then who is covering the site.
 */
function bandLines(o: Overview): { today: ReactNode[]; waiting: ReactNode[] } {
    const today: ReactNode[] = [];
    const waiting: ReactNode[] = [];
    const mine = o.week.find((d) => d.is_today);
    const rostered = o.week.some((d) => d.code);

    // Your own day first, in the roster's wording and capitalisation.
    if (mine?.code) {
        today.push(`You are on ${mine.label ?? mine.code} today.`);
    } else if (rostered) {
        today.push("You are not rostered today.");
    }

    /*
     * Then who is covering the site, for management.
     *
     * For Peter this is the whole of the first line -- he carries no roster,
     * and "All 10 staff are on duty today" was a headcount wearing a sentence.
     * For Nurhuda it follows her own shift as the addition she asked for.
     */
    if (o.is_management && o.on_duty) {
        const { dayshift: ds, nightshift: ns } = o.on_duty;
        if (ds.length && ns.length) {
            today.push(
                <span key="crew">
                    <Crew list={ds} code="DS" /> {ds.length === 1 ? "is" : "are"} on dayshift, and{" "}
                    <Crew list={ns} code="NS" /> on night shift.
                </span>,
            );
        } else if (ds.length) {
            today.push(
                <span key="crew">
                    <Crew list={ds} code="DS" /> {ds.length === 1 ? "is" : "are"} on dayshift.
                </span>,
            );
        } else if (ns.length) {
            today.push(
                <span key="crew">
                    <Crew list={ns} code="NS" /> {ns.length === 1 ? "is" : "are"} on night shift.
                </span>,
            );
        } else if (!today.length) {
            today.push("No shift is rostered today.");
        }

        // Said only when it is true of somebody; "and nobody is on leave" is
        // not news anybody needed.
        if (o.on_duty.on_leave.length) {
            const away = o.on_duty.on_leave;
            today.push(`${names(away)} ${away.length === 1 ? "is" : "are"} on leave.`);
        }
    }

    /*
     * IT's queue, for whoever holds the flag.
     *
     * Nurhuda asked for a ticket to "pop up notifikasi ke akun Bintang". This
     * is that notification: the first line he reads in the morning, rather
     * than something he has to go and look for.
     */
    if (o.tickets_open) {
        waiting.push(
            `${o.tickets_open} IT ticket${o.tickets_open === 1 ? "" : "s"} ${
                o.tickets_open === 1 ? "needs" : "need"
            } looking at.`,
        );
    }

    /*
     * Finance's two standing worries, said before anything else.
     *
     * A run somebody sent back is not waiting on Himawan's patience, it is
     * blocking everyone's wages; and payroll is not something to find out about
     * on the 31st. Nurhuda asked for both.
     */
    for (const back of o.finance_sent_back ?? []) {
        waiting.push(
            `${back.reference} (${back.title}) came back${back.note ? `: ${back.note}` : "."}`,
        );
    }

    if (o.payroll_desk) {
        for (const back of o.payroll_desk.sent_back) {
            waiting.push(
                `${back.label} payroll came back${back.note ? `: ${back.note}` : "."}`,
            );
        }
        if (o.payroll_desk.not_started) {
            waiting.push(
                `${o.payroll_desk.this_month} payroll has not been started, and there ${
                    o.payroll_desk.days_left === 1 ? "is 1 day" : `are ${o.payroll_desk.days_left} days`
                } left in the month.`,
            );
        } else if (o.payroll_desk.due_soon) {
            waiting.push(
                `${o.payroll_desk.this_month} payroll is still a draft, with ${
                    o.payroll_desk.days_left === 1 ? "1 day" : `${o.payroll_desk.days_left} days`
                } left in the month.`,
            );
        }
    }

    if (o.is_management && o.approvals) {
        /*
         * What is waiting, by name, not by count.
         *
         * Nurhuda: "Nothing is awaiting your approval" should say, for her,
         * Peter and Mark, *what* is waiting when something is -- whose leave,
         * which month's payroll from Mas Him. "2 leave requests await your
         * approval" sent you to go and look; "Lintang's annual leave (5–7 Oct)"
         * tells you whether it can wait. It also said only one queue at a
         * time, so leave and a scorecard together dropped the scorecard.
         */
        const a = o.approvals;
        const items: string[] = [
            ...a.leave.map((l) => `${l.name}'s ${leaveName(l.leave_type)} (${dayRange(l.start, l.end)})`),
            ...a.payroll
                .filter((p) => !p.sent_back_note)
                .map((p) => `the ${p.label} payroll${p.submitted_by ? ` from ${firstName(p.submitted_by)}` : ""}`),
            ...a.salary.map((s) => `${s.name}'s salary review`),
            ...a.kpi.map((k) => `${k.name}'s ${k.period} KPI scorecard`),
            ...a.finance
                .filter((f) => !f.sent_back_note)
                .map(
                    (f) =>
                        `${f.reference} ${f.title} (${money(f.total)})${f.requested_by ? ` from ${firstName(f.requested_by)}` : ""}`,
                ),
        ];

        for (const f of a.finance.filter((x) => x.sent_back_note)) {
            waiting.push(
                `${f.sent_back_by ? firstName(f.sent_back_by) : "The CEO"} sent ${f.reference} back to you: ${f.sent_back_note}`,
            );
        }

        // A run the executive returned to the director is its own sentence:
        // it carries a reason, and the reason is the point.
        for (const p of a.payroll.filter((x) => x.sent_back_note)) {
            waiting.push(
                `${p.sent_back_by ? firstName(p.sent_back_by) : "The executive"} sent the ${p.label} payroll back to you: ${p.sent_back_note}`,
            );
        }

        if (items.length > 0) {
            // Four names read as a sentence; eleven read as a list, so the
            // rest are counted rather than named.
            const shown = items.length > 4 ? [...items.slice(0, 3), `${items.length - 3} more`] : items;
            waiting.push(`Awaiting your approval: ${names(shown)}.`);
        } else if (
            !a.payroll.some((p) => p.sent_back_note) &&
            !a.finance.some((f) => f.sent_back_note)
        ) {
            // Only when every queue really is empty.
            waiting.push("Nothing is awaiting your approval.");
        }
    } else if (o.pending_mine) {
        waiting.push(
            `Your ${o.pending_mine} leave request${o.pending_mine === 1 ? " is" : "s are"} awaiting a decision.`,
        );
    }

    // Your own tickets, whoever you are. Said after the queue, so Bintang
    // reads what is waiting on him before what he is waiting on.
    if (o.my_tickets_open) {
        waiting.push(
            `Your ${o.my_tickets_open} IT ticket${
                o.my_tickets_open === 1 ? " is" : "s are"
            } still open.`,
        );
    }

    return { today, waiting };
}

/** The pieces of one line, spaced without a stray gap at the front. */
function joined(parts: ReactNode[]): ReactNode {
    return parts.map((part, i) => (
        <span key={i}>
            {i > 0 && " "}
            {part}
        </span>
    ));
}

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

    const lines = overview ? bandLines(overview) : null;

    /* Somebody with nothing published is not shown seven empty cards. For
       the founders that is permanent -- they carry no roster at all -- so they
       get the company's day in its place. Staff waiting on a roster keep the
       strip, because "nothing rostered yet" is the answer to their question. */
    const showWeek = Boolean(
        overview && (overview.week.some((d) => d.code) || !overview.is_management),
    );

    /* Today's shift, in the roster's own colours. Absent for the founders,
       who carry no roster -- the band simply loses that column rather than
       showing them a dash. */
    const todayShift = overview?.week.find((d) => d.is_today && d.code);
    const todayCard = todayShift?.code
        ? {
              code: todayShift.code,
              label: todayShift.label ?? todayShift.code,
              style: SHIFT_STYLES[todayShift.code as ShiftCode],
          }
        : null;

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

                    <div className="relative flex flex-wrap items-start justify-between gap-x-8 gap-y-6">
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
                            <div className="mt-3 max-w-3xl space-y-1 text-sm leading-relaxed">
                                {lines && lines.today.length > 0 && (
                                    <p className="text-teal-100/75">{joined(lines.today)}</p>
                                )}
                                {lines && lines.waiting.length > 0 && (
                                    <p className="text-teal-100/60">{joined(lines.waiting)}</p>
                                )}
                                {!overview && <p>&nbsp;</p>}
                            </div>
                        </div>

                        {/*
                            The right of the band.

                            It held the wordmark and nothing else, with a column
                            of empty navy underneath. Nurhuda: fill it. So the
                            wordmark keeps its corner and the space below carries
                            the two facts worth having without scrolling -- what
                            you are working today, and the next day nobody works.
                        */}
                        <div className="hidden shrink-0 flex-col items-end gap-5 lg:flex">
                            {/* 552x198, so 56px is still a downscale and still
                                crisp. It was 32px at 40% opacity, which read as a
                                watermark somebody had forgotten to remove. */}
                            <Wordmark className="h-11 opacity-70 xl:h-14" />

                            {(todayCard || overview?.next_holiday) && (
                                <div className="flex items-stretch divide-x divide-white/10 border-t border-white/10 pt-4 text-right">
                                    {todayCard && (
                                        <div className="px-5 first:pl-0 last:pr-0">
                                            <p className="dtg-eyebrow">Today</p>
                                            <p className="mt-1.5 flex items-center justify-end gap-2">
                                                <span
                                                    className="inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1 font-mono text-xs font-bold"
                                                    style={
                                                        todayCard.style
                                                            ? {
                                                                  background: todayCard.style.bg,
                                                                  color: todayCard.style.fg,
                                                              }
                                                            : undefined
                                                    }
                                                >
                                                    {todayCard.code}
                                                </span>
                                                <span className="text-sm font-semibold text-paper">
                                                    {todayCard.label}
                                                </span>
                                            </p>
                                        </div>
                                    )}

                                    {/* The holiday, not the distance to it.
                                        "+95d" is arithmetic nobody asked for;
                                        what you want to know is that the next
                                        one is Christmas. */}
                                    {overview?.next_holiday && (
                                        <div className="px-5 first:pl-0 last:pr-0">
                                            <p className="dtg-eyebrow">Next public holiday</p>
                                            <p className="mt-1.5 text-sm font-semibold text-paper">
                                                {overview.next_holiday.name}
                                            </p>
                                            <p className="text-micro text-muted">
                                                {new Date(
                                                    `${overview.next_holiday.date}T00:00:00`,
                                                ).toLocaleDateString("en-GB", {
                                                    weekday: "short",
                                                    day: "numeric",
                                                    month: "long",
                                                    year: "numeric",
                                                })}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
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
                    /* Two columns only when there is something to put in the
                       second one. The founders have no roster and no leave
                       balance, so this was a panel across two thirds of the
                       page and a third of empty navy beside it. */
                    <div
                        className={
                            showWeek
                                ? "grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
                                : "grid grid-cols-1 gap-4"
                        }
                    >
                        {showWeek ? (
                            <section className="dtg-panel flex flex-col overflow-hidden">
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
                                <div className="flex-1">
                                    <WeekStrip days={overview.week} />
                                </div>
                            </section>
                        ) : (
                            /*
                                The founders' half of the dashboard.

                                Peter and Mark carry no roster, so seven empty
                                day cards were the first thing they saw every
                                morning. Nurhuda: they do not need a schedule --
                                find them something else. What a founder actually
                                arrives wanting is the state of the company, so
                                that is what sits here: who is on the books, who
                                is out today, and what is queued against their
                                name. Every figure links to the page that
                                settles it.
                            */
                            <section className="dtg-panel overflow-hidden">
                                <header className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-3">
                                    <div>
                                        <p className="dtg-eyebrow">Your queue</p>
                                        <h2 className="mt-0.5 text-sm font-semibold text-paper">
                                            Waiting on you
                                        </h2>
                                    </div>
                                    <Link
                                        to="/schedules"
                                        className="text-label font-semibold uppercase tracking-label text-teal-300 transition-colors hover:text-signal"
                                    >
                                        Roster
                                    </Link>
                                </header>

                                <div className="grid grid-cols-2 divide-x divide-white/[0.06] sm:grid-cols-4">
                                    {/*
                                        One figure per question, one page per tile.

                                        This had two leave tiles -- "away today"
                                        and "leave to approve" -- which both
                                        counted leave, both read nought and both
                                        linked to the same page. Nurhuda: say it
                                        once. So leave is a single tile carrying
                                        the queue as its figure and today's
                                        absences underneath, and the slot it
                                        freed goes to scorecards, which are a
                                        different queue on a different page.
                                    */}
                                    {[
                                        {
                                            group: "Waiting on you",
                                            label: "Leave requests",
                                            value: overview.pending_approvals ?? 0,
                                            sub:
                                                (overview.pending_approvals ?? 0) === 0
                                                    ? "none to decide"
                                                    : "to approve or decline",
                                            to: "/leaves",
                                            tone:
                                                (overview.pending_approvals ?? 0) > 0
                                                    ? "text-signal"
                                                    : "text-muted",
                                        },
                                        {
                                            group: "Waiting on you",
                                            label: "KPI achievements",
                                            value: overview.kpi_awaiting ?? 0,
                                            sub:
                                                (overview.kpi_awaiting ?? 0) === 0
                                                    ? "none to sign"
                                                    : "to sign off",
                                            to: "/kpi",
                                            tone:
                                                (overview.kpi_awaiting ?? 0) > 0
                                                    ? "text-signal"
                                                    : "text-muted",
                                        },
                                        {
                                            group: "Waiting on you",
                                            label: "Payroll",
                                            value: overview.payroll_awaiting?.count ?? 0,
                                            sub:
                                                (overview.payroll_awaiting?.count ?? 0) === 0
                                                    ? "none to approve"
                                                    : `${overview.payroll_awaiting?.label}, to approve`,
                                            to: "/payroll",
                                            tone:
                                                (overview.payroll_awaiting?.count ?? 0) > 0
                                                    ? "text-signal"
                                                    : "text-muted",
                                        },
                                        {
                                            group: "Waiting on you",
                                            label: "Salary reviews",
                                            value: overview.salary_awaiting ?? 0,
                                            sub:
                                                (overview.salary_awaiting ?? 0) === 0
                                                    ? "none to sign"
                                                    : "to sign",
                                            to: "/salary",
                                            tone:
                                                (overview.salary_awaiting ?? 0) > 0
                                                    ? "text-signal"
                                                    : "text-muted",
                                        },
                                    ]
                                        // A null figure means this person is not
                                        // in that chain at all, so the tile is
                                        // absent rather than permanently nought.
                                        // Nurhuda is the author of a salary
                                        // review now, not a signatory, so hers
                                        // could never move off zero.
                                        .filter((f) => f.value !== null && f.value !== undefined)
                                        .map((f, i, all) => (
                                        <Link
                                            key={f.label}
                                            to={f.to}
                                            className={`group border-b border-white/[0.06] px-4 py-4 transition-colors last:border-b-0 hover:bg-white/[0.03] sm:border-b-0 ${
                                                /* A heavier rule where two
                                                   groups meet, so the split is
                                                   visible without reading. */
                                                i > 0 && f.group !== all[i - 1]!.group
                                                    ? "sm:border-l-2 sm:border-l-white/[0.14]"
                                                    : ""
                                            }`}
                                        >
                                            {/* The group heading is printed once,
                                                on the first tile that belongs to
                                                it \u2014 but not when it is the only
                                                group, because the panel header
                                                above already says it and the two
                                                together read as a stutter. */}
                                            {all.some((t) => t.group !== all[0]!.group) && (
                                                <p className="dtg-eyebrow mb-2 text-teal-300/70">
                                                    {i === 0 || f.group !== all[i - 1]!.group
                                                        ? f.group
                                                        : "\u00A0"}
                                                </p>
                                            )}
                                            <p className="text-xs font-semibold text-paper-soft">
                                                {f.label}
                                            </p>
                                            <p
                                                className={`mt-1.5 font-mono text-3xl font-bold leading-none ${f.tone}`}
                                            >
                                                {f.value}
                                            </p>
                                            <p className="mt-1.5 text-micro text-muted">{f.sub}</p>
                                        </Link>
                                    ))}
                                </div>
                            </section>
                        )}

                        {showWeek && (
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
                            {/* IT's queue, for whoever holds the flag.
                                
                                Here rather than in the panel above, because
                                that panel is the founders' and Bintang is not
                                one — the tile has to live where the person who
                                acts on it will actually see it. Null means
                                this person is not IT support at all. */}
                            {overview.tickets_open !== null && (
                                <Link to="/support" className="block">
                                    <StatTile
                                        label="IT support"
                                        value={overview.tickets_open}
                                        sub={
                                            overview.tickets_open > 0
                                                ? "tickets to look at"
                                                : "queue is clear"
                                        }
                                        icon="clipboard"
                                        accent={overview.tickets_open > 0 ? "attention" : "neutral"}
                                    />
                                </Link>
                            )}
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
                                        /* A remaining-days figure is something
                                           you look up once a year. "Next booked
                                           12 Oct" is the half of it somebody
                                           acts on, so it is carried here rather
                                           than left on the leave page. */
                                        footer={
                                            overview.pending_mine > 0 ? (
                                                <span className="text-gold">
                                                    {overview.pending_mine} awaiting a decision
                                                </span>
                                            ) : overview.leave.next_from ? (
                                                <span>
                                                    Next booked{" "}
                                                    {new Date(
                                                        `${overview.leave.next_from}T00:00:00`,
                                                    ).toLocaleDateString("en-GB", {
                                                        day: "numeric",
                                                        month: "short",
                                                    })}
                                                </span>
                                            ) : (
                                                <span>Nothing booked yet</span>
                                            )
                                        }
                                    />
                                </Link>
                            )}

                            {/* Everything waiting on this person, in one figure.

                                It counted leave alone, so a payroll run sitting
                                unapproved showed as "nothing to review" —
                                Nurhuda: "di akunku ini kan cm cuti... maksudku
                                payroll dari mas him". A tile called "Waiting on
                                you" that is not counting something waiting on
                                you is worse than no tile.

                                The sub-line names the mix rather than leaving a
                                bare number, and the link goes to whichever is
                                heaviest: a month's wages held up outranks a leave
                                request. The panel beside this splits the same
                                figures out per queue, for when the number is not
                                the question. */}
                            {showWeek && overview.is_management && overview.pending_approvals !== null && (() => {
                                const leave = overview.pending_approvals ?? 0;
                                const salary = overview.salary_awaiting ?? 0;
                                const payroll = overview.payroll_awaiting?.count ?? 0;
                                const finance = overview.approvals?.finance.length ?? 0;
                                const waiting = leave + salary + payroll + finance;
                                const parts = [
                                    payroll > 0
                                        ? `${overview.payroll_awaiting?.label ?? "payroll"} payroll`
                                        : null,
                                    finance > 0
                                        ? `${finance} finance request${finance === 1 ? "" : "s"}`
                                        : null,
                                    salary > 0
                                        ? `${salary} salary review${salary === 1 ? "" : "s"}`
                                        : null,
                                    leave > 0
                                        ? `${leave} leave request${leave === 1 ? "" : "s"}`
                                        : null,
                                ].filter(Boolean);
                                const to =
                                    payroll > 0
                                        ? "/payroll"
                                        : finance > 0
                                          ? "/finance-requests"
                                          : salary > 0
                                            ? "/salary"
                                            : "/leaves";
                                return (
                                    <Link to={to} className="block">
                                        <StatTile
                                            label="Waiting on you"
                                            value={waiting}
                                            sub={
                                                parts.length ? parts.join(" · ") : "nothing to review"
                                            }
                                            icon="clipboard"
                                            accent={waiting > 0 ? "attention" : "neutral"}
                                            footer={
                                                overview.on_leave_today ? (
                                                    <span>{overview.on_leave_today} on leave today</span>
                                                ) : undefined
                                            }
                                        />
                                    </Link>
                                );
                            })()}
                        </div>
                        )}
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
