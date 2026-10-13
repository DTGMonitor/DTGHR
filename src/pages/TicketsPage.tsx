import { useCallback, useEffect, useMemo, useState } from "react";
import { LifeBuoy, Link2, Lock, Plus, ShieldCheck } from "lucide-react";

import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";
import { revealElement, useOpenParam } from "@/lib/useOpenParam";
import { useAuth } from "@/contexts/AuthContext";
import AssetLink from "@/components/tickets/AssetLink";
import AutoClose from "@/components/tickets/AutoClose";
import CategoryInsights, { CATEGORY_NAMES, duration } from "@/components/tickets/CategoryInsights";
import ChannelShare from "@/components/tickets/ChannelShare";
import { SORT_MODES, isSortMode, sortTickets, type SortMode } from "@/components/tickets/sortTickets";
import { scheduleService } from "@/services/scheduleService";
import type { ScheduleEmployee } from "@/types/schedule";
import {
    ticketService,
    type Ticket,
    type TicketCategory,
    type TicketChannel,
    type TicketHistory,
    type TicketPriority,
    type TicketStatus,
} from "@/services/ticketService";

/*
 * IT support.
 *
 * One page doing two jobs, because they are the same object seen from two
 * sides: everybody raises tickets here, and whoever holds the IT support flag
 * also works the queue here. Splitting it into "my tickets" and "the queue"
 * would mean Bintang, who is both, checking two pages.
 *
 * Which side somebody is on comes from the server on every response, so the
 * page never has its own opinion about who may resolve a ticket.
 *
 * Administrators are on neither side of the queue. Nurhuda: IT support is
 * Bintang's, and what she wants is his record -- "seems like activity log
 * for Bintang". So they get a second tab, the resolved history, with who
 * fixed what and how long it took. IT support has it too, for the same
 * reason their manager does.
 *
 * The reporter is kept in the loop (20261014000100): they are notified of
 * every public move, confirm a fix or say it is still broken, and a ticket
 * waiting on them closes on its own after 5 quiet days unless either side
 * keeps it open longer. Requests that still arrive by WhatsApp are logged
 * here for the person who asked, so the history can show the move to the
 * portal.
 */

const CHANNELS: { value: Exclude<TicketChannel, "portal">; label: string }[] = [
    { value: "whatsapp", label: "WhatsApp" },
    { value: "in_person", label: "In person" },
    { value: "phone", label: "Phone" },
    { value: "email", label: "Email" },
];

/** The reporter may reopen a closed ticket for this long. */
const REOPEN_DAYS = 14;

const CATEGORIES: { value: TicketCategory; label: string; hint: string }[] = [
    { value: "connection", label: "Connectivity", hint: "Internet, VPN or site network" },
    { value: "hardware", label: "Hardware", hint: "Laptop, phone, printer or field equipment" },
    { value: "software", label: "Software", hint: "Applications, files or error messages" },
    { value: "access", label: "Account & sign-in", hint: "Sign-in problems, password reset, locked account" },
    {
        value: "access_request",
        label: "Access request",
        hint: "New access to the NAS, OneDrive/SharePoint, this platform or another system",
    },
    { value: "other", label: "Other", hint: "Anything not listed above" },
];

const PRIORITIES: { value: TicketPriority; label: string; hint: string }[] = [
    { value: "low", label: "Low", hint: "Minor; work can continue" },
    { value: "normal", label: "Normal", hint: "Affecting my work" },
    { value: "high", label: "High", hint: "Unable to work" },
    { value: "urgent", label: "Urgent", hint: "Several people or operations affected" },
];

/*
 * The systems an access request is for. Nurhuda, September 2026: "request
 * access ke NAS/OneDrive/atau minta akses apa gt di platform ini". Stored in
 * the ticket's location, which for an access request is the system.
 */
const SYSTEMS = [
    "NAS",
    "OneDrive / SharePoint",
    "Microsoft 365 / email",
    "DTG platform (this site)",
    "Other",
];

const STATUS_CHIP: Record<TicketStatus, { label: string; cls: string }> = {
    open: { label: "Open", cls: "border-gold/30 bg-gold/10 text-gold" },
    in_progress: {
        label: "In progress",
        cls: "border-teal-300/30 bg-teal-300/10 text-teal-200",
    },
    waiting: { label: "Waiting on you", cls: "border-danger/40 bg-danger/10 text-danger" },
    resolved: { label: "Resolved", cls: "border-signal/30 bg-signal/10 text-signal" },
    closed: { label: "Closed", cls: "border-white/15 bg-white/[0.04] text-muted" },
};

const PRIORITY_CLS: Record<TicketPriority, string> = {
    low: "text-muted",
    normal: "text-paper-soft",
    high: "text-gold",
    urgent: "text-danger",
};

const when = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });

const hoursBetween = (from: string, to: string) =>
    (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;

const EMPTY_FORM = {
    subject: "",
    description: "",
    category: "connection" as TicketCategory,
    priority: "normal" as TicketPriority,
    location: "",
    /** IT logging a request that came some other way. */
    forSomeone: false,
    reporterId: "",
    channel: "whatsapp" as Exclude<TicketChannel, "portal">,
    /** "Raise it again": the closed ticket this comes back to. */
    related: null as { id: string; reference: string } | null,
};

export default function TicketsPage() {
    const dialog = useDialog();
    const { user } = useAuth();
    const [tickets, setTickets] = useState<Ticket[]>([]);
    const [isSupport, setIsSupport] = useState(false);
    const [canViewHistory, setCanViewHistory] = useState(false);
    const [tab, setTab] = useState<"tickets" | "history">("tickets");
    const [history, setHistory] = useState<TicketHistory | null>(null);
    const [historyCategory, setHistoryCategory] = useState<TicketCategory | null>(null);
    const [openTicket, setOpenTicket] = useState<Ticket | null>(null);
    // Which ticket is open lives in the URL (?open=<id>), so a notification
    // can land on it.
    const [openId, setOpenId] = useOpenParam();
    // The order, in the URL beside ?open=, so it survives a reload.
    const [sortParam, setSortParam] = useOpenParam("sort");
    const [includeClosed, setIncludeClosed] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [raising, setRaising] = useState(false);
    const [staff, setStaff] = useState<ScheduleEmployee[]>([]);

    const [form, setForm] = useState(EMPTY_FORM);
    // An access request asks for a system, not a place, so the form changes.
    const accessRequest = form.category === "access_request";

    // IT reads the queue by what needs them; a reporter, newest first.
    const sort: SortMode = isSortMode(sortParam) ? sortParam : isSupport ? "needs_me" : "newest";

    // The people IT can log a request for: the roster's names, which every
    // member of staff may read, not the directory, which is management's.
    useEffect(() => {
        if (!form.forSomeone || staff.length) return;
        scheduleService
            .visibleEmployees()
            .then((res) =>
                setStaff(
                    [...res.data].sort((a, b) =>
                        `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`),
                    ),
                ),
            )
            .catch(() => setError("Could not load the staff list."));
    }, [form.forSomeone, staff.length]);

    const load = useCallback(async () => {
        try {
            const res = await ticketService.list({ include_closed: includeClosed });
            setTickets(res.data.items);
            setIsSupport(res.data.is_support);
            setCanViewHistory(res.data.can_view_history);
        } catch {
            setError("Could not load tickets.");
        } finally {
            setLoading(false);
        }
    }, [includeClosed]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (tab !== "history") return;
        ticketService
            .history()
            .then((res) => setHistory(res.data))
            .catch(() => setError("Could not load the history."));
    }, [tab]);

    // Replying is for IT and for whoever raised it. An administrator reading
    // somebody else's finished ticket in the history is reviewing, not
    // joining the conversation.
    const mayReply = (t: Ticket) =>
        t.can_work || (t.reporter_id !== null && t.reporter_id === user?.employee_id);

    useEffect(() => {
        if (!openId) {
            setOpenTicket(null);
            return;
        }
        if (openTicket?.id === openId) return;
        let live = true;
        ticketService
            .get(openId)
            .then((res) => {
                if (!live) return;
                setTab("tickets");
                // A finished ticket is only listed with the closed ones shown.
                if (res.data.status === "resolved" || res.data.status === "closed") setIncludeClosed(true);
                setOpenTicket(res.data);
                revealElement(`ticket-${res.data.id}`);
            })
            .catch(() => {
                if (!live) return;
                setError("That ticket could not be found.");
                setOpenId(null);
            });
        return () => {
            live = false;
        };
    }, [openId]);

    const complain = (e: unknown, fallback: string) => {
        const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
        setError(typeof detail === "string" ? detail : fallback);
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.subject.trim() || !form.description.trim()) {
            setError("Please add a summary and the details.");
            return;
        }
        if (form.forSomeone && !form.reporterId) {
            setError("Choose who the request is from.");
            return;
        }
        try {
            await ticketService.raise({
                subject: form.subject.trim(),
                description: form.description.trim(),
                category: form.category,
                priority: form.priority,
                location: form.location.trim() || undefined,
                reporter_id: form.forSomeone ? form.reporterId : undefined,
                channel: form.forSomeone ? form.channel : undefined,
                related_ticket_id: form.related?.id,
            });
            setForm(EMPTY_FORM);
            setRaising(false);
            setError(null);
            await load();
        } catch (err) {
            complain(err, "Could not raise that ticket.");
        }
    };

    const addComment = async (ticket: Ticket, internal: boolean) => {
        const body = await dialog.prompt({
            title: internal ? "Internal note" : `Reply on ${ticket.reference}`,
            body: internal
                ? "Only IT sees this. The person who raised the ticket does not."
                : "Everybody on this ticket sees this.",
            multiline: true,
            required: true,
        });
        if (!body) return;
        try {
            const res = await ticketService.comment(ticket.id, body, internal);
            setOpenTicket(res.data);
            await load();
        } catch (err) {
            complain(err, "Could not add that.");
        }
    };

    // Every action returns the ticket as it now is.
    const show = async (res: { data: Ticket }) => {
        setOpenTicket(res.data);
        setError(null);
        await load();
    };

    const move = async (ticket: Ticket, status: TicketStatus) => {
        let note: string | null = "";
        if (status === "resolved") {
            note = await dialog.prompt({
                title: `Resolve ${ticket.reference}`,
                body: "What fixed it? This is kept on the ticket, so the next person who hits the same thing can read it. The reporter is told, and asked to confirm.",
                multiline: true,
                required: true,
                confirmLabel: "Resolve",
            });
            if (!note) return;
        }
        if (status === "waiting") {
            // The question is what the reporter is notified with.
            note = await dialog.prompt({
                title: `Ask ${ticket.reporter_name ?? "the reporter"}`,
                body: "What do you need from them? They are notified with this, and the ticket closes on its own after 5 days without a reply.",
                multiline: true,
                required: true,
                confirmLabel: "Send and wait",
            });
            if (!note) return;
        }
        try {
            const res = await ticketService.setStatus(ticket.id, status, note || undefined);
            setOpenTicket(res.data);
            await load();
        } catch (err) {
            complain(err, "Could not change the status.");
        }
    };

    // The reporter's own way out: they fixed it, or no longer need it.
    const closeMine = async (ticket: Ticket) => {
        const note = await dialog.prompt({
            title: `Close ${ticket.reference}`,
            body: "Let IT know why, e.g. you fixed it yourself or it is no longer needed.",
            multiline: true,
            required: true,
            confirmLabel: "Close ticket",
        });
        if (!note) return;
        try {
            const res = await ticketService.setStatus(ticket.id, "closed", note);
            setOpenTicket(res.data);
            await load();
        } catch (err) {
            complain(err, "Could not close that ticket.");
        }
    };

    // The reporter, on a resolved ticket: it is fixed.
    const confirmFix = async (ticket: Ticket) => {
        const note = await dialog.prompt({
            title: `Confirm ${ticket.reference} is fixed`,
            body: "The ticket closes and the fix stays on it. Anything to add for IT? Optional.",
            multiline: true,
            confirmLabel: "Confirm and close",
        });
        if (note === null) return;
        try {
            await show(await ticketService.setStatus(ticket.id, "closed", note.trim() || undefined));
        } catch (err) {
            complain(err, "Could not confirm that.");
        }
    };

    // The reporter, on a resolved ticket (still broken) or a recently closed
    // one (it came back). IT reopens a closed ticket the same way.
    const reopen = async (ticket: Ticket) => {
        const resolved = ticket.status === "resolved";
        const reason = await dialog.prompt({
            title: resolved ? `${ticket.reference} is still broken` : `Reopen ${ticket.reference}`,
            body: resolved
                ? "What is still wrong? IT is told and the ticket goes back to them."
                : "Why does it need reopening? IT is told and the ticket goes back to them.",
            multiline: true,
            required: true,
            confirmLabel: resolved ? "Send back to IT" : "Reopen",
        });
        if (!reason) return;
        try {
            await show(await ticketService.reopen(ticket.id, reason));
        } catch (err) {
            complain(err, "Could not reopen that ticket.");
        }
    };

    // A new ticket, linked to the closed one it comes back to.
    const raiseAgain = (ticket: Ticket) => {
        setForm({
            ...EMPTY_FORM,
            subject: ticket.subject,
            category: ticket.category,
            priority: ticket.priority,
            location: ticket.location ?? "",
            related: { id: ticket.id, reference: ticket.reference },
        });
        setRaising(true);
        setOpenId(null);
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const triage = async (ticket: Ticket, change: { priority?: TicketPriority; category?: TicketCategory }) => {
        try {
            await show(await ticketService.triage(ticket.id, change));
        } catch (err) {
            complain(err, "Could not change that.");
        }
    };

    // IT names the earlier ticket by its reference.
    const linkTo = async (ticket: Ticket) => {
        const reference = await dialog.prompt({
            title: `Link ${ticket.reference} to an earlier ticket`,
            body: "The reference of the ticket this one comes back to, e.g. NET-0014.",
            placeholder: "NET-0014",
            required: true,
            confirmLabel: "Link",
        });
        if (!reference) return;
        try {
            const all = await ticketService.list({ include_closed: true });
            const target = all.data.items.find(
                (t) => t.reference.toUpperCase() === reference.trim().toUpperCase(),
            );
            if (!target) {
                setError(`There is no ticket ${reference.trim().toUpperCase()}.`);
                return;
            }
            await show(await ticketService.link(ticket.id, target.id));
        } catch (err) {
            complain(err, "Could not link that.");
        }
    };

    const unlink = async (ticket: Ticket) => {
        try {
            await show(await ticketService.link(ticket.id, null));
        } catch (err) {
            complain(err, "Could not unlink that.");
        }
    };

    const isMine = (t: Ticket) => t.reporter_id !== null && t.reporter_id === user?.employee_id;
    const mayReopenClosed = (t: Ticket) =>
        t.status === "closed" &&
        (t.can_work ||
            (isMine(t) &&
                t.closed_at !== null &&
                Date.now() - new Date(t.closed_at).getTime() < REOPEN_DAYS * 86_400_000));

    const sorted = useMemo(() => sortTickets(tickets, sort), [tickets, sort]);
    const shown =
        tab === "history"
            ? (history?.items ?? []).filter((t) => !historyCategory || t.category === historyCategory)
            : sorted;

    const input =
        "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-paper placeholder-muted transition focus:border-signal/60 focus:outline-none focus:ring-1 focus:ring-signal/40";

    return (
        <div className="dtg-fade-in space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Support</p>
                    <h1 className="mt-1.5 flex items-center gap-2 text-2xl font-bold tracking-tight text-paper">
                        IT support
                        {isSupport && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-signal/30 bg-signal/10 px-2 py-0.5 text-micro font-semibold uppercase tracking-label text-signal">
                                <ShieldCheck className="h-3 w-3" />
                                IT support
                            </span>
                        )}
                    </h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        {tab === "history"
                            ? "Resolved requests, who resolved them and how long each took. Closed requests, such as duplicates, are listed but not counted as resolved."
                            : isSupport
                              ? "All requests and their full history. Internal notes are visible to IT support only."
                              : "Report an IT issue or request access to a system. You can follow progress and replies here."}
                    </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                    {tab === "tickets" && (
                        <label className="flex items-center gap-2 text-xs text-paper-soft">
                            Sort
                            <select
                                value={sort}
                                onChange={(e) => setSortParam(e.target.value)}
                                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-paper focus:border-signal/60 focus:outline-none"
                            >
                                {SORT_MODES.map((m) => (
                                    <option key={m.value} value={m.value} className="bg-surface">
                                        {m.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    {tab === "tickets" && (
                        <label className="flex items-center gap-2 text-xs text-paper-soft">
                            <input
                                type="checkbox"
                                checked={includeClosed}
                                onChange={(e) => setIncludeClosed(e.target.checked)}
                                className="h-3.5 w-3.5 rounded border-white/20 bg-white/5"
                            />
                            Show finished
                        </label>
                    )}
                    <button
                        type="button"
                        onClick={() => {
                            if (raising) setForm(EMPTY_FORM);
                            setRaising((v) => !v);
                        }}
                        className="dtg-btn-primary"
                    >
                        <Plus className="h-4 w-4" />
                        New ticket
                    </button>
                </div>
            </header>

            {canViewHistory && (
                <div role="tablist" className="flex flex-wrap gap-1 border-b border-white/10">
                    {(
                        [
                            ["tickets", isSupport ? "Queue" : "My tickets"],
                            ["history", "Resolved history"],
                        ] as const
                    ).map(([key, label]) => (
                        <button
                            key={key}
                            role="tab"
                            aria-selected={tab === key}
                            onClick={() => {
                                setOpenId(null);
                                setTab(key);
                            }}
                            className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors ${
                                tab === key
                                    ? "border-signal font-semibold text-paper"
                                    : "border-transparent font-medium text-paper-soft hover:border-teal-500 hover:text-paper"
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            )}

            {error && <Alert tone="danger">{error}</Alert>}

            {raising && (
                <form onSubmit={submit} className="dtg-panel space-y-4 px-5 py-5">
                    {form.related && (
                        <Alert tone="info">
                            Raising this again: it will be linked to {form.related.reference}, so IT can see
                            what fixed it last time.{" "}
                            <button
                                type="button"
                                onClick={() => setForm({ ...form, related: null })}
                                className="font-semibold underline-offset-2 hover:underline"
                            >
                                Don't link it
                            </button>
                        </Alert>
                    )}

                    {/* IT logging a request that came by chat, in person, by
                        phone or by email. The person who asked is told, and
                        follows it here from then on. */}
                    {isSupport && (
                        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                            <label className="flex items-center gap-2 text-sm text-paper">
                                <input
                                    type="checkbox"
                                    checked={form.forSomeone}
                                    onChange={(e) => setForm({ ...form, forSomeone: e.target.checked })}
                                    className="h-3.5 w-3.5 rounded border-white/20 bg-white/5"
                                />
                                Raising this for someone else
                            </label>
                            {form.forSomeone && (
                                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                                    <div>
                                        <label className="dtg-label">Who asked</label>
                                        <select
                                            value={form.reporterId}
                                            onChange={(e) => setForm({ ...form, reporterId: e.target.value })}
                                            className={input}
                                        >
                                            <option value="" className="bg-surface">
                                                Choose a person…
                                            </option>
                                            {staff
                                                .filter((p) => p.id !== user?.employee_id)
                                                .map((p) => (
                                                    <option key={p.id} value={p.id} className="bg-surface">
                                                        {p.first_name} {p.last_name}
                                                    </option>
                                                ))}
                                        </select>
                                        <p className="mt-1 text-micro text-muted">
                                            They are notified, and follow it here from now on
                                        </p>
                                    </div>
                                    <div>
                                        <label className="dtg-label">How it came in</label>
                                        <select
                                            value={form.channel}
                                            onChange={(e) =>
                                                setForm({
                                                    ...form,
                                                    channel: e.target.value as typeof form.channel,
                                                })
                                            }
                                            className={input}
                                        >
                                            {CHANNELS.map((c) => (
                                                <option key={c.value} value={c.value} className="bg-surface">
                                                    {c.label}
                                                </option>
                                            ))}
                                        </select>
                                        <p className="mt-1 text-micro text-muted">
                                            Counted in the history, to track the move to the portal
                                        </p>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <div>
                        <label className="dtg-label">
                            {accessRequest ? "What access do you need?" : "Summary"}
                        </label>
                        <input
                            value={form.subject}
                            onChange={(e) => setForm({ ...form, subject: e.target.value })}
                            placeholder={
                                accessRequest
                                    ? "e.g. Read and write access to the Monitoring folder"
                                    : "e.g. VPN disconnects every few minutes"
                            }
                            className={input}
                            maxLength={200}
                        />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-3">
                        <div>
                            <label className="dtg-label">Category</label>
                            <select
                                value={form.category}
                                onChange={(e) => {
                                    const category = e.target.value as TicketCategory;
                                    // A place typed for a fault is not a system, and
                                    // the other way round.
                                    const crossing =
                                        (category === "access_request") !== accessRequest;
                                    setForm({
                                        ...form,
                                        category,
                                        location: crossing ? "" : form.location,
                                    });
                                }}
                                className={input}
                            >
                                {CATEGORIES.map((c) => (
                                    <option key={c.value} value={c.value} className="bg-surface">
                                        {c.label}
                                    </option>
                                ))}
                            </select>
                            <p className="mt-1 text-micro text-muted">
                                {CATEGORIES.find((c) => c.value === form.category)?.hint}
                            </p>
                        </div>
                        <div>
                            <label className="dtg-label">Priority</label>
                            <select
                                value={form.priority}
                                onChange={(e) =>
                                    setForm({ ...form, priority: e.target.value as TicketPriority })
                                }
                                className={input}
                            >
                                {PRIORITIES.map((p) => (
                                    <option key={p.value} value={p.value} className="bg-surface">
                                        {p.label}
                                    </option>
                                ))}
                            </select>
                            <p className="mt-1 text-micro text-muted">
                                {PRIORITIES.find((p) => p.value === form.priority)?.hint}
                            </p>
                        </div>
                        {accessRequest ? (
                            <div>
                                <label className="dtg-label">System</label>
                                <select
                                    value={form.location}
                                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                                    className={input}
                                >
                                    <option value="" className="bg-surface">
                                        Choose a system…
                                    </option>
                                    {SYSTEMS.map((sys) => (
                                        <option key={sys} value={sys} className="bg-surface">
                                            {sys}
                                        </option>
                                    ))}
                                </select>
                                <p className="mt-1 text-micro text-muted">Where the access is needed</p>
                            </div>
                        ) : (
                            <div>
                                <label className="dtg-label">Location or device</label>
                                <input
                                    value={form.location}
                                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                                    placeholder="e.g. site laptop, office, working from home"
                                    className={input}
                                    maxLength={160}
                                />
                                <p className="mt-1 text-micro text-muted">Optional</p>
                            </div>
                        )}
                    </div>

                    <div>
                        <label className="dtg-label">
                            {accessRequest ? "Reason and scope" : "Details"}
                        </label>
                        <textarea
                            value={form.description}
                            onChange={(e) => setForm({ ...form, description: e.target.value })}
                            rows={4}
                            placeholder={
                                accessRequest
                                    ? "What the access is for, which folders or features, and whether it is temporary."
                                    : "What you were doing, what happened, when it started, and anything already tried."
                            }
                            className={input}
                        />
                    </div>

                    <div className="flex items-center gap-3">
                        <button type="submit" className="dtg-btn-primary">
                            Submit request
                        </button>
                        <button
                            type="button"
                            onClick={() => setRaising(false)}
                            className="text-sm text-paper-soft transition hover:text-paper"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            )}

            {tab === "history" && history && <CategoryInsights categories={history.categories} />}

            {tab === "history" && history && <ChannelShare months={history.channels} />}

            {/* The finished requests, filtered to one category when that is the
                question -- "enak groupingnya". */}
            {tab === "history" && history && history.items.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {[
                        { key: null, label: "All", n: history.items.length },
                        ...history.categories
                            .map((c) => ({
                                key: c.category,
                                label: `${c.prefix} · ${CATEGORY_NAMES[c.category]}`,
                                n: history.items.filter((t) => t.category === c.category).length,
                            }))
                            .filter((c) => c.n > 0),
                    ].map((chip) => (
                        <button
                            key={chip.key ?? "all"}
                            type="button"
                            onClick={() => setHistoryCategory(chip.key)}
                            className={`rounded-full border px-3 py-1 text-micro font-semibold transition-colors ${
                                historyCategory === chip.key
                                    ? "border-signal/50 bg-signal/15 text-signal"
                                    : "border-white/15 text-paper-soft hover:text-paper"
                            }`}
                        >
                            {chip.label} <span className="font-mono text-muted">{chip.n}</span>
                        </button>
                    ))}
                </div>
            )}

            {tab === "history" && history && history.resolvers.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {history.resolvers.map((r) => (
                        <div key={r.name} className="dtg-panel px-5 py-4">
                            <p className="text-sm font-semibold text-paper">{r.name}</p>
                            <p className="mt-2 flex items-baseline gap-2">
                                <span className="text-2xl font-bold tabular-nums text-signal">
                                    {r.resolved}
                                </span>
                                <span className="text-xs text-paper-soft">
                                    resolved
                                </span>
                            </p>
                            <p className="mt-0.5 text-micro text-muted">
                                {duration(r.average_hours)} on average from raised to fixed
                            </p>
                        </div>
                    ))}
                </div>
            )}

            {loading || (tab === "history" && history === null) ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : shown.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center">
                    <LifeBuoy className="mx-auto h-6 w-6 text-muted" />
                    <p className="mt-3 text-sm text-paper-soft">
                        {tab === "history"
                            ? "Nothing has been resolved yet."
                            : isSupport
                              ? "No open requests."
                              : "You have no requests yet."}
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {shown.map((t) => (
                        <article key={t.id} id={`ticket-${t.id}`} className="dtg-panel overflow-hidden">
                            <button
                                type="button"
                                onClick={() => setOpenId(openTicket?.id === t.id ? null : t.id)}
                                className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-left transition hover:bg-white/[0.03]"
                            >
                                <div className="min-w-0">
                                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-paper">
                                        <span className="font-mono text-micro text-muted">
                                            {t.reference}
                                        </span>
                                        {t.subject}
                                        <span
                                            className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${
                                                STATUS_CHIP[t.status].cls
                                            }`}
                                        >
                                            {STATUS_CHIP[t.status].label}
                                        </span>
                                    </p>
                                    <p className="mt-0.5 text-micro text-muted">
                                        {CATEGORIES.find((c) => c.value === t.category)?.label}
                                        {" · "}
                                        <span className={PRIORITY_CLS[t.priority]}>
                                            {PRIORITIES.find((p) => p.value === t.priority)?.label}
                                        </span>
                                        {t.reporter_name ? ` · ${t.reporter_name}` : ""}
                                        {t.channel !== "portal"
                                            ? ` · via ${CHANNELS.find((c) => c.value === t.channel)?.label ?? t.channel}`
                                            : ""}
                                        {t.location ? ` · ${t.location}` : ""}
                                        {" · "}
                                        {when(t.created_at)}
                                    </p>
                                </div>
                                {tab === "history" && t.resolved_by && t.resolved_at ? (
                                    <span className="text-micro text-muted">
                                        fixed by {t.resolved_by} in{" "}
                                        {duration(hoursBetween(t.created_at, t.resolved_at))}
                                    </span>
                                ) : (
                                    t.assignee_name && (
                                        <span className="text-micro text-muted">
                                            with {t.assignee_name}
                                        </span>
                                    )
                                )}
                            </button>

                            {openTicket?.id === t.id && (
                                <div className="border-t border-white/[0.08] px-5 py-4">
                                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-paper-soft">
                                        {openTicket.description}
                                    </p>

                                    {openTicket.resolution && (
                                        <Alert tone="success">
                                            <span className="font-semibold">Fixed:</span>{" "}
                                            {openTicket.resolution}
                                        </Alert>
                                    )}

                                    {/* What it comes back to, and what came back
                                        to it. A colleague's ticket shows only its
                                        reference and status. */}
                                    {(openTicket.related || openTicket.recurrences.length > 0) && (
                                        <div className="mt-3 space-y-1 text-xs text-paper-soft">
                                            {openTicket.related && (
                                                <p className="flex flex-wrap items-center gap-1.5">
                                                    <Link2 className="h-3.5 w-3.5 text-muted" />
                                                    Comes back to{" "}
                                                    {openTicket.related.id ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => setOpenId(openTicket.related!.id)}
                                                            className="font-mono text-signal hover:underline"
                                                        >
                                                            {openTicket.related.reference}
                                                        </button>
                                                    ) : (
                                                        <span className="font-mono">
                                                            {openTicket.related.reference}
                                                        </span>
                                                    )}
                                                    <span className="text-muted">
                                                        ({STATUS_CHIP[openTicket.related.status].label.toLowerCase()})
                                                    </span>
                                                    {openTicket.related.resolution && (
                                                        <span>
                                                            · fixed last time: {openTicket.related.resolution}
                                                        </span>
                                                    )}
                                                </p>
                                            )}
                                            {openTicket.recurrences.length > 0 && (
                                                <p className="flex flex-wrap items-center gap-1.5">
                                                    <Link2 className="h-3.5 w-3.5 text-muted" />
                                                    Came back as{" "}
                                                    {openTicket.recurrences.map((r, i) => (
                                                        <span key={r.reference}>
                                                            {i > 0 && ", "}
                                                            {r.id ? (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setOpenId(r.id)}
                                                                    className="font-mono text-signal hover:underline"
                                                                >
                                                                    {r.reference}
                                                                </button>
                                                            ) : (
                                                                <span className="font-mono">{r.reference}</span>
                                                            )}
                                                        </span>
                                                    ))}
                                                </p>
                                            )}
                                        </div>
                                    )}

                                    <AssetLink
                                        ticket={openTicket}
                                        onChange={(t) => void show({ data: t })}
                                        onError={(e) => complain(e, "Could not link that asset.")}
                                    />

                                    {(openTicket.can_work || isMine(openTicket)) && (
                                        <AutoClose
                                            ticket={openTicket}
                                            onChange={(t) => void show({ data: t })}
                                            onError={(e) => complain(e, "Could not keep it open longer.")}
                                        />
                                    )}

                                    {/* IT corrects how it was filed. The
                                        reference stays as it is. */}
                                    {openTicket.can_work && (
                                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-paper-soft">
                                            <select
                                                aria-label="Priority"
                                                value={openTicket.priority}
                                                onChange={(e) =>
                                                    void triage(openTicket, {
                                                        priority: e.target.value as TicketPriority,
                                                    })
                                                }
                                                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-paper"
                                            >
                                                {PRIORITIES.map((p) => (
                                                    <option key={p.value} value={p.value} className="bg-surface">
                                                        {p.label} priority
                                                    </option>
                                                ))}
                                            </select>
                                            <select
                                                aria-label="Category"
                                                value={openTicket.category}
                                                onChange={(e) =>
                                                    void triage(openTicket, {
                                                        category: e.target.value as TicketCategory,
                                                    })
                                                }
                                                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-paper"
                                            >
                                                {CATEGORIES.map((c) => (
                                                    <option key={c.value} value={c.value} className="bg-surface">
                                                        {c.label}
                                                    </option>
                                                ))}
                                            </select>
                                            {openTicket.related ? (
                                                <button
                                                    type="button"
                                                    onClick={() => void unlink(openTicket)}
                                                    className="text-xs text-paper-soft transition hover:text-paper"
                                                >
                                                    Unlink from {openTicket.related.reference}
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => void linkTo(openTicket)}
                                                    className="inline-flex items-center gap-1 text-xs text-paper-soft transition hover:text-paper"
                                                >
                                                    <Link2 className="h-3.5 w-3.5" />
                                                    Link to an earlier ticket
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    {/* The trail. Append-only, so it reads as a
                                        history rather than a current state. */}
                                    <ol className="mt-4 space-y-2.5 border-l border-white/[0.08] pl-4">
                                        {openTicket.events.map((e) => (
                                            <li key={e.id} className="relative">
                                                <span className="absolute -left-[1.3rem] top-1.5 h-1.5 w-1.5 rounded-full bg-white/25" />
                                                <p className="text-micro text-muted">
                                                    <span className="font-semibold text-paper-soft">
                                                        {e.actor_name}
                                                    </span>
                                                    {" · "}
                                                    {when(e.created_at)}
                                                    {e.is_internal && (
                                                        <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-white/15 px-1.5 py-0.5 uppercase tracking-label text-muted">
                                                            <Lock className="h-2.5 w-2.5" />
                                                            Internal
                                                        </span>
                                                    )}
                                                </p>
                                                <p className="whitespace-pre-wrap text-xs leading-relaxed text-paper-soft">
                                                    {e.body}
                                                </p>
                                            </li>
                                        ))}
                                    </ol>

                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                        {mayReply(openTicket) && (
                                            <button
                                                type="button"
                                                onClick={() => void addComment(openTicket, false)}
                                                className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                            >
                                                Reply
                                            </button>
                                        )}

                                        {!openTicket.can_work &&
                                            openTicket.reporter_id !== null &&
                                            openTicket.reporter_id === user?.employee_id &&
                                            openTicket.status !== "resolved" &&
                                            openTicket.status !== "closed" && (
                                                <button
                                                    type="button"
                                                    onClick={() => void closeMine(openTicket)}
                                                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                                >
                                                    Close ticket
                                                </button>
                                            )}

                                        {/* The reporter has the last word on a fix. */}
                                        {!openTicket.can_work &&
                                            isMine(openTicket) &&
                                            openTicket.status === "resolved" && (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={() => void confirmFix(openTicket)}
                                                        className="dtg-btn-primary px-3 py-1.5 text-xs"
                                                    >
                                                        It's fixed
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => void reopen(openTicket)}
                                                        className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                                    >
                                                        Still broken
                                                    </button>
                                                </>
                                            )}

                                        {/* Closed: reopen while it is recent, or
                                            raise it again, linked, at any time. */}
                                        {openTicket.status === "closed" && mayReopenClosed(openTicket) && (
                                            <button
                                                type="button"
                                                onClick={() => void reopen(openTicket)}
                                                className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                            >
                                                Reopen
                                            </button>
                                        )}
                                        {openTicket.status === "closed" && isMine(openTicket) && (
                                            <button
                                                type="button"
                                                onClick={() => raiseAgain(openTicket)}
                                                className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                            >
                                                Raise it again
                                            </button>
                                        )}

                                        {openTicket.can_work && (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={() => void addComment(openTicket, true)}
                                                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                                >
                                                    Internal note
                                                </button>
                                                {openTicket.status !== "in_progress" &&
                                                    openTicket.status !== "resolved" &&
                                                    openTicket.status !== "closed" && (
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                void move(openTicket, "in_progress")
                                                            }
                                                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                                        >
                                                            Start work
                                                        </button>
                                                    )}
                                                {openTicket.status !== "waiting" &&
                                                    openTicket.status !== "resolved" &&
                                                    openTicket.status !== "closed" && (
                                                        <button
                                                            type="button"
                                                            onClick={() => void move(openTicket, "waiting")}
                                                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                                        >
                                                            Ask the reporter
                                                        </button>
                                                    )}
                                                {openTicket.status !== "resolved" && openTicket.status !== "closed" && (
                                                    <button
                                                        type="button"
                                                        onClick={() => void move(openTicket, "resolved")}
                                                        className="dtg-btn-primary px-3 py-1.5 text-xs"
                                                    >
                                                        Resolve
                                                    </button>
                                                )}
                                                {openTicket.status === "resolved" && (
                                                    <button
                                                        type="button"
                                                        onClick={() => void move(openTicket, "open")}
                                                        className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                                    >
                                                        Reopen
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            )}
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}
