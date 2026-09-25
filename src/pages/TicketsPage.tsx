import { useCallback, useEffect, useState } from "react";
import { LifeBuoy, Lock, Plus, ShieldCheck } from "lucide-react";

import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";
import { useAuth } from "@/contexts/AuthContext";
import CategoryInsights, { CATEGORY_NAMES, duration } from "@/components/tickets/CategoryInsights";
import {
    ticketService,
    type Ticket,
    type TicketCategory,
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
 */

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
    const [includeClosed, setIncludeClosed] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [raising, setRaising] = useState(false);

    const [form, setForm] = useState({
        subject: "",
        description: "",
        category: "connection" as TicketCategory,
        priority: "normal" as TicketPriority,
        location: "",
    });
    // An access request asks for a system, not a place, so the form changes.
    const accessRequest = form.category === "access_request";

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

    const open = async (id: string) => {
        try {
            const res = await ticketService.get(id);
            setOpenTicket(res.data);
        } catch {
            setError("Could not open that ticket.");
        }
    };

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
        try {
            await ticketService.raise({
                subject: form.subject.trim(),
                description: form.description.trim(),
                category: form.category,
                priority: form.priority,
                location: form.location.trim() || undefined,
            });
            setForm({
                subject: "",
                description: "",
                category: "connection",
                priority: "normal",
                location: "",
            });
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

    const move = async (ticket: Ticket, status: TicketStatus) => {
        let note: string | null = "";
        if (status === "resolved") {
            note = await dialog.prompt({
                title: `Resolve ${ticket.reference}`,
                body: "What fixed it? This is kept on the ticket, so the next person who hits the same thing can read it.",
                multiline: true,
                required: true,
                confirmLabel: "Resolve",
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

    const shown =
        tab === "history"
            ? (history?.items ?? []).filter((t) => !historyCategory || t.category === historyCategory)
            : tickets;

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
                <div className="flex items-end gap-2">
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
                        onClick={() => setRaising((v) => !v)}
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
                                setOpenTicket(null);
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
                        <article key={t.id} className="dtg-panel overflow-hidden">
                            <button
                                type="button"
                                onClick={() =>
                                    openTicket?.id === t.id ? setOpenTicket(null) : void open(t.id)
                                }
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
                                                    openTicket.status !== "resolved" && (
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
                                                    openTicket.status !== "resolved" && (
                                                        <button
                                                            type="button"
                                                            onClick={() => void move(openTicket, "waiting")}
                                                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                                        >
                                                            Wait on reporter
                                                        </button>
                                                    )}
                                                {openTicket.status !== "resolved" && (
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
