import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileSearch, MapPin, Pencil, Plus, Search } from "lucide-react";

import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";
import { useAuth } from "@/contexts/AuthContext";
import {
    DECISIONS,
    RESPONSE_CHIP,
    STATUS_CHIP,
    activeUntil,
    errorDetail,
    formatDay,
    formatEventAt,
    fromWibInput,
    investigationService,
    periodText,
    suspensionText,
    toWibInput,
    todayWib,
    wibDate,
    type Decision,
    type Investigation,
    type InvestigationPayload,
    type InvestigationStatus,
    type MonitoringPerson,
    type MonitoringSite,
    type Outcome,
    type OutcomePayload,
} from "@/services/investigationService";

/*
 * Monitoring investigations.
 *
 * When something goes wrong in the 24/7 radar monitoring -- a missed alarm, a
 * late report, a radar left offline -- the investigators record what
 * happened and decide on action under the Discipline Policy. This page is
 * theirs alone (Nurhuda and Peter), and it doubles as the history of
 * monitoring problems by site. The engineer a decision is about reads it on
 * their own profile, under Conduct, and responds there.
 */

type View = { mode: "list" } | { mode: "view"; id: string } | { mode: "edit"; id: string | null };

const STATUSES: InvestigationStatus[] = ["draft", "in_review", "changes_requested", "issued", "closed"];

const siteLabel = (name: string, client: string | null) => (client ? `${name} — ${client}` : name);

const outcomeSummary = (inv: Investigation) =>
    inv.outcomes.length === 0
        ? "—"
        : inv.outcomes.map((o) => `${o.decision_label} — ${o.employee_first_name}`).join("; ");

export default function InvestigationsPage() {
    const { user } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const [items, setItems] = useState<Investigation[]>([]);
    const [sites, setSites] = useState<MonitoringSite[]>([]);
    const [people, setPeople] = useState<MonitoringPerson[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showSites, setShowSites] = useState(false);

    // Filters.
    const [siteFilter, setSiteFilter] = useState<string>("");
    const [statusFilter, setStatusFilter] = useState<InvestigationStatus | "">("");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [q, setQ] = useState("");
    const [sort, setSort] = useState<"newest" | "oldest" | "site">("newest");

    // Which case is open lives in the URL, so an email can link straight to it.
    const openId = searchParams.get("open");
    const editing = searchParams.get("edit");
    const view: View = editing
        ? { mode: "edit", id: editing === "new" ? null : editing }
        : openId
          ? { mode: "view", id: openId }
          : { mode: "list" };
    const go = (next: View) => {
        if (next.mode === "list") setSearchParams({});
        else if (next.mode === "view") setSearchParams({ open: next.id });
        else setSearchParams({ edit: next.id ?? "new" });
        window.scrollTo({ top: 0 });
    };

    const load = useCallback(async () => {
        try {
            const [list, ppl] = await Promise.all([investigationService.list(), investigationService.people()]);
            setItems(list.data.items);
            setSites(list.data.sites);
            setPeople(ppl.data);
            setError(null);
        } catch (e) {
            setError(errorDetail(e, "Could not load the investigations."));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (user?.can_investigate) void load();
    }, [user?.can_investigate, load]);

    const replace = (inv: Investigation) =>
        setItems((list) =>
            list.some((i) => i.id === inv.id) ? list.map((i) => (i.id === inv.id ? inv : i)) : [inv, ...list],
        );

    const shown = useMemo(() => {
        const needle = q.trim().toLowerCase();
        const filtered = items.filter((i) => {
            if (siteFilter && i.site_id !== siteFilter) return false;
            if (statusFilter && i.status !== statusFilter) return false;
            const day = wibDate(i.event_at);
            if (from && day < from) return false;
            if (to && day > to) return false;
            if (needle) {
                const hay = [
                    i.reference, i.title, i.radar, i.site_name, i.site_client, i.ds_name,
                    i.ns_name, i.findings, i.investigation_result, i.recommendation,
                    ...i.outcomes.map((o) => `${o.employee_name} ${o.decision_label}`),
                ]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        });
        const order = new Map(sites.map((s, n) => [s.id, n]));
        return filtered.sort((a, b) => {
            if (sort === "site") {
                const d = (order.get(a.site_id) ?? 0) - (order.get(b.site_id) ?? 0);
                if (d !== 0) return d;
            }
            const t = a.event_at.localeCompare(b.event_at);
            return sort === "oldest" ? t : -t;
        });
    }, [items, sites, siteFilter, statusFilter, from, to, q, sort]);

    const counts = useMemo(() => {
        const m = new Map<string, number>();
        for (const i of items) m.set(i.site_id, (m.get(i.site_id) ?? 0) + 1);
        return m;
    }, [items]);

    if (user && !user.can_investigate) return <Navigate to="/" replace />;

    if (loading) {
        return (
            <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading investigations…
            </div>
        );
    }

    if (view.mode === "edit") {
        const existing = view.id ? items.find((i) => i.id === view.id) ?? null : null;
        return (
            <CaseEditor
                key={view.id ?? "new"}
                initial={existing}
                sites={sites}
                people={people}
                onSaved={(inv, stay) => {
                    replace(inv);
                    if (!stay) go({ mode: "view", id: inv.id });
                    else if (!view.id) go({ mode: "edit", id: inv.id });
                }}
                onCancel={() => (view.id ? go({ mode: "view", id: view.id }) : go({ mode: "list" }))}
            />
        );
    }

    if (view.mode === "view") {
        const inv = items.find((i) => i.id === view.id);
        if (!inv) {
            return (
                <div className="dtg-panel px-5 py-16 text-center">
                    <p className="text-sm text-paper-soft">That investigation could not be found.</p>
                    <button type="button" onClick={() => go({ mode: "list" })} className="dtg-btn-secondary mt-4">
                        <ArrowLeft className="h-4 w-4" />
                        All investigations
                    </button>
                </div>
            );
        }
        return (
            <CaseView
                inv={inv}
                onChanged={replace}
                onDeleted={() => {
                    setItems((list) => list.filter((i) => i.id !== inv.id));
                    go({ mode: "list" });
                }}
                onEdit={() => go({ mode: "edit", id: inv.id })}
                onBack={() => go({ mode: "list" })}
            />
        );
    }

    return (
        <div className="dtg-fade-in space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Monitoring</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">Monitoring investigations</h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        Incidents in the radar monitoring — what happened, what the data shows, and the
                        decision under the Discipline Policy. Only investigators see this page; each engineer
                        sees their own decision on their profile once it is issued.
                    </p>
                </div>
                <div className="flex gap-2">
                    <button type="button" onClick={() => setShowSites((v) => !v)} className="dtg-btn-secondary">
                        <MapPin className="h-4 w-4" />
                        Sites
                    </button>
                    <button type="button" onClick={() => go({ mode: "edit", id: null })} className="dtg-btn-primary">
                        <Plus className="h-4 w-4" />
                        New investigation
                    </button>
                </div>
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {showSites && <SitesManager sites={sites} onChange={setSites} />}

            {/* Per-site counts, doubling as a quick filter. */}
            <div className="flex flex-wrap gap-1.5">
                {[{ id: "", label: "All sites", n: items.length }, ...sites
                    .filter((s) => s.is_active || counts.get(s.id))
                    .map((s) => ({ id: s.id, label: siteLabel(s.name, s.client), n: counts.get(s.id) ?? 0 }))].map(
                    (chip) => (
                        <button
                            key={chip.id || "all"}
                            type="button"
                            onClick={() => setSiteFilter(chip.id)}
                            className={`rounded-full border px-3 py-1 text-micro font-semibold transition-colors ${
                                siteFilter === chip.id
                                    ? "border-signal/50 bg-signal/15 text-signal"
                                    : "border-white/15 text-paper-soft hover:text-paper"
                            }`}
                        >
                            {chip.label} <span className="font-mono text-muted">{chip.n}</span>
                        </button>
                    ),
                )}
            </div>

            {/* The same by stage: what is being written, waiting for review, sent back, out. */}
            <div className="flex flex-wrap gap-1.5">
                {[{ key: "" as const, label: "Any status", n: items.length }, ...STATUSES.map((s) => ({
                    key: s,
                    label: STATUS_CHIP[s].label,
                    n: items.filter((i) => i.status === s).length,
                }))].map((chip) => (
                    <button
                        key={chip.key || "any"}
                        type="button"
                        onClick={() => setStatusFilter(chip.key)}
                        className={`rounded-full border px-3 py-1 text-micro font-semibold transition-colors ${
                            statusFilter === chip.key
                                ? "border-signal/50 bg-signal/15 text-signal"
                                : "border-white/15 text-paper-soft hover:text-paper"
                        }`}
                    >
                        {chip.label} <span className="font-mono text-muted">{chip.n}</span>
                    </button>
                ))}
            </div>

            <div className="dtg-panel flex flex-wrap items-end gap-3 p-4">
                <label className="block min-w-[14rem] flex-1">
                    <span className="dtg-label">Search</span>
                    <span className="relative block">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                        <input
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder="Reference, title, radar, engineer…"
                            className="dtg-input w-full pl-8 text-sm"
                        />
                    </span>
                </label>
                <label className="block">
                    <span className="dtg-label">Status</span>
                    <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as InvestigationStatus | "")}
                        className="dtg-input w-36 text-sm"
                    >
                        <option value="">Any</option>
                        {STATUSES.map((s) => (
                            <option key={s} value={s}>
                                {STATUS_CHIP[s].label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block">
                    <span className="dtg-label">From</span>
                    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="dtg-input w-40 text-sm" />
                </label>
                <label className="block">
                    <span className="dtg-label">To</span>
                    <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="dtg-input w-40 text-sm" />
                </label>
                <label className="block">
                    <span className="dtg-label">Sort</span>
                    <select
                        value={sort}
                        onChange={(e) => setSort(e.target.value as typeof sort)}
                        className="dtg-input w-44 text-sm"
                    >
                        <option value="newest">Event date, newest first</option>
                        <option value="oldest">Event date, oldest first</option>
                        <option value="site">Site</option>
                    </select>
                </label>
            </div>

            {shown.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center">
                    <FileSearch className="mx-auto h-6 w-6 text-muted" />
                    <p className="mt-3 text-sm text-paper-soft">
                        {items.length === 0 ? "No investigations recorded yet." : "Nothing matches these filters."}
                    </p>
                </div>
            ) : (
                <section className="dtg-panel overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[60rem]">
                            <thead>
                                <tr className="border-b border-white/[0.08]">
                                    <th className="dtg-th">Reference</th>
                                    <th className="dtg-th">Event (WIB)</th>
                                    <th className="dtg-th">Site</th>
                                    <th className="dtg-th">Radar</th>
                                    <th className="dtg-th">Title</th>
                                    <th className="dtg-th">DS / NS</th>
                                    <th className="dtg-th">Outcome</th>
                                    <th className="dtg-th">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((i, n) => (
                                    <tr
                                        key={i.id}
                                        onClick={() => go({ mode: "view", id: i.id })}
                                        className={`cursor-pointer border-b border-white/[0.05] transition-colors hover:bg-white/[0.04] ${
                                            n % 2 ? "bg-white/[0.015]" : ""
                                        }`}
                                    >
                                        <td className="dtg-td font-mono text-xs text-paper">{i.reference}</td>
                                        <td className="dtg-td whitespace-nowrap text-xs text-paper-soft">
                                            {formatEventAt(i.event_at)}
                                        </td>
                                        <td className="dtg-td text-xs text-paper-soft">
                                            <span className="text-paper">{i.site_name}</span>
                                            {i.site_client && <span className="block text-micro text-muted">{i.site_client}</span>}
                                        </td>
                                        <td className="dtg-td font-mono text-xs text-paper-soft">{i.radar ?? "—"}</td>
                                        <td className="dtg-td text-sm font-medium text-paper">{i.title}</td>
                                        <td className="dtg-td text-xs text-paper-soft">
                                            {i.ds_name ?? "—"} / {i.ns_name ?? "—"}
                                        </td>
                                        <td className="dtg-td text-xs text-paper-soft">{outcomeSummary(i)}</td>
                                        <td className="dtg-td">
                                            <StatusChip status={i.status} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </div>
    );
}

function StatusChip({ status }: { status: InvestigationStatus }) {
    return (
        <span
            className={`inline-flex rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${STATUS_CHIP[status].cls}`}
        >
            {STATUS_CHIP[status].label}
        </span>
    );
}

/* The number and the title on one line, "2 · People", as the report reads. */
function Section({ eyebrow, title, children }: { eyebrow?: string; title: string; children: ReactNode }) {
    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <h2 className="text-sm font-semibold text-paper">
                    {eyebrow && (
                        <span className="font-mono text-muted">
                            {eyebrow}
                            <span className="px-1.5">·</span>
                        </span>
                    )}
                    {title}
                </h2>
            </header>
            <div className="px-5 py-4">{children}</div>
        </section>
    );
}

function Prose({ text, empty = "Not recorded." }: { text: string | null; empty?: string }) {
    return text ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-paper-soft">{text}</p>
    ) : (
        <p className="text-sm italic text-muted">{empty}</p>
    );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div>
            <p className="dtg-label">{label}</p>
            <div className="text-sm text-paper">{children}</div>
        </div>
    );
}

// ── Read view ───────────────────────────────────────────────────────────

function CaseView({
    inv,
    onChanged,
    onDeleted,
    onEdit,
    onBack,
}: {
    inv: Investigation;
    onChanged: (inv: Investigation) => void;
    onDeleted: () => void;
    onEdit: () => void;
    onBack: () => void;
}) {
    const dialog = useDialog();
    const { user } = useAuth();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState("");

    const act = async (fn: () => Promise<{ data: Investigation }>) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fn();
            onChanged(res.data);
            return true;
        } catch (e) {
            setError(errorDetail(e, "That did not work."));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const writing = inv.status === "draft" || inv.status === "changes_requested";
    const released = inv.status === "issued" || inv.status === "closed";
    const mySubmission = inv.submitted_by_id !== null && inv.submitted_by_id === user?.id;

    const submit = async () => {
        const ok = await dialog.confirm({
            title: `Submit ${inv.reference} for review?`,
            body: "The other investigators are emailed. One of them approves it, which releases each decision to the engineer it is about, or sends it back with a note. It is read-only while in review.",
            confirmLabel: "Submit for review",
        });
        if (ok) await act(() => investigationService.submit(inv.id));
    };
    const approve = async () => {
        const ok = await dialog.confirm({
            title: `Approve ${inv.reference}?`,
            body: "The case is issued: each engineer named in a decision sees their own decision on their profile and is emailed to respond.",
            confirmLabel: "Approve and issue",
        });
        if (ok) await act(() => investigationService.approve(inv.id));
    };
    const sendBack = async () => {
        const text = await dialog.prompt({
            title: `Send ${inv.reference} back`,
            body: "Say what needs to change. The note is posted in the discussion and emailed to the investigator who submitted it.",
            multiline: true,
            required: true,
            confirmLabel: "Send back",
        });
        if (text) await act(() => investigationService.sendBack(inv.id, text));
    };
    const postComment = async () => {
        if (!note.trim()) return;
        if (await act(() => investigationService.comment(inv.id, note.trim()))) setNote("");
    };
    const close = async () => {
        const pending = inv.outcomes.filter((o) => o.response_status === "pending").length;
        const ok = await dialog.confirm({
            title: `Close ${inv.reference}?`,
            body:
                pending > 0
                    ? `${pending} response${pending === 1 ? " is" : "s are"} still awaited. Once closed, nobody can respond until it is reopened.`
                    : "The case becomes read-only. You can reopen it later.",
            confirmLabel: "Close",
        });
        if (ok) await act(() => investigationService.close(inv.id));
    };
    const reopen = () => act(() => investigationService.reopen(inv.id));
    const remove = async () => {
        const ok = await dialog.confirm({
            title: `Delete draft ${inv.reference}?`,
            body: "The draft and its decisions are removed permanently.",
            confirmLabel: "Delete",
            tone: "danger",
        });
        if (!ok) return;
        setBusy(true);
        try {
            await investigationService.remove(inv.id);
            onDeleted();
        } catch (e) {
            setError(errorDetail(e, "Could not delete the draft."));
            setBusy(false);
        }
    };
    const resolve = async (o: Outcome) => {
        const note = await dialog.prompt({
            title: `Reply to ${o.employee_first_name}`,
            body: "Your answer is shown to them beside their response. To change the decision itself, edit the case.",
            multiline: true,
            required: true,
            defaultValue: o.resolution_note ?? "",
            confirmLabel: "Save note",
        });
        if (note) await act(() => investigationService.resolve(o.id, note));
    };

    return (
        <div className="dtg-fade-in space-y-5">
            <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1.5 text-micro font-semibold uppercase tracking-label text-teal-300 transition-colors hover:text-teal-100"
            >
                <ArrowLeft className="h-3.5 w-3.5" />
                All investigations
            </button>

            <header className="dtg-panel flex flex-wrap items-start justify-between gap-4 p-6">
                <div className="min-w-0">
                    <p className="dtg-eyebrow flex items-center gap-2">
                        <span className="font-mono">{inv.reference}</span>
                        <StatusChip status={inv.status} />
                    </p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">{inv.title}</h1>
                    <p className="mt-1 text-xs text-muted">
                        Recorded by {inv.created_by_name ?? "—"}
                        {inv.submitted_by_name && inv.submitted_at
                            ? ` · submitted by ${inv.submitted_by_name}, ${formatDay(wibDate(inv.submitted_at))}`
                            : ""}
                        {inv.closed_at ? ` · closed ${formatEventAt(inv.closed_at)}` : ""}
                    </p>
                    {inv.approved_by_name && inv.approved_at && (
                        <p className="mt-1 text-xs font-semibold text-signal">
                            Approved by {inv.approved_by_name}, {formatDay(wibDate(inv.approved_at))}
                        </p>
                    )}
                    {inv.status === "in_review" && (
                        <p className="mt-1 text-xs text-teal-200">
                            {mySubmission
                                ? "Waiting for another investigator to review it."
                                : "Waiting for your review: approve it, or send it back with a note."}
                        </p>
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    {inv.status !== "closed" && inv.status !== "in_review" && (
                        <button type="button" disabled={busy} onClick={onEdit} className="dtg-btn-secondary">
                            <Pencil className="h-4 w-4" />
                            Edit
                        </button>
                    )}
                    {inv.status === "draft" && (
                        <button type="button" disabled={busy} onClick={() => void remove()} className="dtg-btn-danger">
                            Delete draft
                        </button>
                    )}
                    {writing && (
                        <button type="button" disabled={busy} onClick={() => void submit()} className="dtg-btn-primary">
                            Submit for review
                        </button>
                    )}
                    {inv.status === "in_review" && !mySubmission && (
                        <>
                            <button type="button" disabled={busy} onClick={() => void sendBack()} className="dtg-btn-secondary">
                                Send back
                            </button>
                            <button type="button" disabled={busy} onClick={() => void approve()} className="dtg-btn-primary">
                                Approve and issue
                            </button>
                        </>
                    )}
                    {inv.status === "issued" && (
                        <button type="button" disabled={busy} onClick={() => void close()} className="dtg-btn-primary">
                            Close
                        </button>
                    )}
                    {inv.status === "closed" && (
                        <button type="button" disabled={busy} onClick={() => void reopen()} className="dtg-btn-secondary">
                            Reopen
                        </button>
                    )}
                </div>
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            <Section eyebrow="1" title="Event">
                <div className="grid gap-4 sm:grid-cols-3">
                    <Fact label="Date and time">{formatEventAt(inv.event_at)}</Fact>
                    <Fact label="Site">{siteLabel(inv.site_name, inv.site_client)}</Fact>
                    <Fact label="Radar">
                        <span className="font-mono">{inv.radar ?? "—"}</span>
                    </Fact>
                </div>
            </Section>

            <Section eyebrow="2" title="People">
                <div className="grid gap-4 sm:grid-cols-3">
                    <Fact label="Day shift (DS) engineer">{inv.ds_name ?? "—"}</Fact>
                    <Fact label="Night shift (NS) engineer">{inv.ns_name ?? "—"}</Fact>
                    <Fact label="Handover notes">{inv.handover_note ?? "—"}</Fact>
                </div>
            </Section>

            <Section eyebrow="3" title="Findings">
                <Prose text={inv.findings} />
            </Section>
            <Section eyebrow="4" title="Technical support summary">
                <Prose text={inv.technical_summary} />
            </Section>
            <Section eyebrow="5" title="Investigation result">
                <Prose text={inv.investigation_result} />
            </Section>
            <Section eyebrow="6" title="Recommendation">
                <Prose text={inv.recommendation} />
            </Section>

            <Section eyebrow="7" title="Decision">
                {inv.outcomes.length === 0 ? (
                    <p className="text-sm italic text-muted">No decision recorded yet.</p>
                ) : (
                    <div className="space-y-4">
                        {inv.outcomes.map((o) => (
                            <article key={o.id} className="dtg-panel-inset rounded-lg border border-white/[0.08] p-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <p className="text-sm font-semibold text-paper">{o.employee_name}</p>
                                        <p className="mt-0.5 text-sm text-signal">{o.decision_label}</p>
                                        <p className="mt-0.5 text-micro text-muted">
                                            {o.effective_from ? `From ${formatDay(o.effective_from)} · ` : ""}
                                            {periodText(o)}
                                            {o.decision === "suspension" ? ` · ${suspensionText(o)}` : ""}
                                        </p>
                                    </div>
                                    {released && (
                                        <span
                                            className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${RESPONSE_CHIP[o.response_status].cls}`}
                                        >
                                            {RESPONSE_CHIP[o.response_status].label}
                                        </span>
                                    )}
                                </div>
                                {o.reason && (
                                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-paper-soft">{o.reason}</p>
                                )}
                                {o.further_action_note && (
                                    <p className="mt-2 whitespace-pre-wrap text-sm text-paper-soft">
                                        <span className="font-semibold text-paper">Further action: </span>
                                        {o.further_action_note}
                                    </p>
                                )}
                                {o.revised_at && (
                                    <p className="mt-2 text-micro text-muted">Revised {formatEventAt(o.revised_at)}</p>
                                )}

                                {released && (
                                    <div className="mt-3 space-y-2 border-t border-white/[0.08] pt-3">
                                        <p className="dtg-label">Response</p>
                                        {o.response_status === "pending" ? (
                                            <p className="text-sm italic text-muted">Not yet responded.</p>
                                        ) : (
                                            <>
                                                <p className="text-xs text-muted">
                                                    {RESPONSE_CHIP[o.response_status].label}
                                                    {o.responded_at ? ` on ${formatEventAt(o.responded_at)}` : ""}
                                                </p>
                                                {o.response_text && (
                                                    <p className="whitespace-pre-wrap text-sm text-paper-soft">“{o.response_text}”</p>
                                                )}
                                            </>
                                        )}
                                        {o.resolution_note && (
                                            <Alert tone="info">
                                                <span className="font-semibold">Investigators’ reply: </span>
                                                {o.resolution_note}
                                            </Alert>
                                        )}
                                        {inv.status === "issued" && o.response_status !== "pending" && (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => void resolve(o)}
                                                className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                            >
                                                {o.resolution_note ? "Edit reply" : "Reply with a resolution note"}
                                            </button>
                                        )}
                                    </div>
                                )}
                            </article>
                        ))}
                    </div>
                )}
            </Section>

            {/* The investigators' own thread. The engineers never see it. */}
            <Section title="Discussion">
                <p className="mb-3 text-micro text-muted">
                    Visible to the investigators only. Comments are not emailed.
                </p>
                {inv.comments.length === 0 ? (
                    <p className="text-sm italic text-muted">No comments yet.</p>
                ) : (
                    <ol className="space-y-3 border-l border-white/[0.08] pl-4">
                        {inv.comments.map((c) => (
                            <li key={c.id}>
                                <p className="text-micro text-muted">
                                    <span className="font-semibold text-paper-soft">{c.author_name}</span>
                                    {" · "}
                                    {formatEventAt(c.created_at)}
                                </p>
                                <p className="whitespace-pre-wrap text-sm leading-relaxed text-paper-soft">{c.body}</p>
                            </li>
                        ))}
                    </ol>
                )}
                <div className="mt-4 space-y-2">
                    <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={3}
                        maxLength={4000}
                        placeholder="Add a comment for the other investigators…"
                        className="dtg-input w-full text-sm"
                    />
                    <button
                        type="button"
                        disabled={busy || !note.trim()}
                        onClick={() => void postComment()}
                        className="dtg-btn-secondary px-3 py-1.5 text-xs"
                    >
                        Post comment
                    </button>
                </div>
            </Section>
        </div>
    );
}

// ── Editor ──────────────────────────────────────────────────────────────

const input =
    "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-paper placeholder-muted transition focus:border-signal/60 focus:outline-none focus:ring-1 focus:ring-signal/40";

function blankCase(sites: MonitoringSite[]): InvestigationPayload {
    return {
        event_at: "",
        site_id: sites.find((s) => s.is_active)?.id ?? "",
        radar: "",
        title: "",
        ds_employee_id: null,
        ns_employee_id: null,
        handover_note: "",
        findings: "",
        technical_summary: "",
        investigation_result: "",
        recommendation: "",
    };
}

function fromCase(inv: Investigation): InvestigationPayload {
    return {
        event_at: toWibInput(inv.event_at),
        site_id: inv.site_id,
        radar: inv.radar ?? "",
        title: inv.title,
        ds_employee_id: inv.ds_employee_id,
        ns_employee_id: inv.ns_employee_id,
        handover_note: inv.handover_note ?? "",
        findings: inv.findings ?? "",
        technical_summary: inv.technical_summary ?? "",
        investigation_result: inv.investigation_result ?? "",
        recommendation: inv.recommendation ?? "",
    };
}

/** Names already on the case stay selectable even if they have since left the team. */
function personOptions(people: MonitoringPerson[], extra: { id: string | null; name: string | null }[]) {
    const list = people.map((p) => ({ id: p.id, name: p.name }));
    for (const x of extra) if (x.id && !list.some((p) => p.id === x.id)) list.push({ id: x.id, name: x.name ?? "—" });
    return list;
}

function CaseEditor({
    initial,
    sites,
    people,
    onSaved,
    onCancel,
}: {
    initial: Investigation | null;
    sites: MonitoringSite[];
    people: MonitoringPerson[];
    onSaved: (inv: Investigation, stay: boolean) => void;
    onCancel: () => void;
}) {
    const dialog = useDialog();
    const [form, setForm] = useState<InvestigationPayload>(() => (initial ? fromCase(initial) : blankCase(sites)));
    const [current, setCurrent] = useState<Investigation | null>(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);

    const set = <K extends keyof InvestigationPayload>(k: K, v: InvestigationPayload[K]) =>
        setForm((f) => ({ ...f, [k]: v }));

    const save = async (): Promise<Investigation | null> => {
        setSaving(true);
        setError(null);
        try {
            const payload = { ...form, event_at: fromWibInput(form.event_at) };
            const res = current
                ? await investigationService.update(current.id, payload)
                : await investigationService.create(payload);
            setCurrent(res.data);
            return res.data;
        } catch (e) {
            setError(errorDetail(e, "Could not save the investigation."));
            return null;
        } finally {
            setSaving(false);
        }
    };

    const saveAndStay = async () => {
        const inv = await save();
        if (inv) onSaved(inv, true);
    };
    const saveAndView = async () => {
        const inv = await save();
        if (inv) onSaved(inv, false);
    };
    const saveAndSubmit = async () => {
        const ok = await dialog.confirm({
            title: "Submit this investigation for review?",
            body: "The other investigators are emailed. One of them approves it, which releases each decision to the engineer it is about, or sends it back with a note. It is read-only while in review.",
            confirmLabel: "Submit for review",
        });
        if (!ok) return;
        const inv = await save();
        if (!inv) return;
        setSaving(true);
        try {
            const res = await investigationService.submit(inv.id);
            onSaved(res.data, false);
        } catch (e) {
            setError(errorDetail(e, "Could not submit the investigation."));
            setSaving(false);
        }
    };

    const siteOptions = sites.filter((s) => s.is_active || s.id === form.site_id);
    const options = personOptions(people, [
        { id: initial?.ds_employee_id ?? null, name: initial?.ds_name ?? null },
        { id: initial?.ns_employee_id ?? null, name: initial?.ns_name ?? null },
    ]);
    const status = current?.status ?? "draft";

    return (
        <div className="dtg-fade-in space-y-5">
            <button
                type="button"
                onClick={onCancel}
                className="inline-flex items-center gap-1.5 text-micro font-semibold uppercase tracking-label text-teal-300 transition-colors hover:text-teal-100"
            >
                <ArrowLeft className="h-3.5 w-3.5" />
                {initial ? "Back to the case" : "All investigations"}
            </button>

            <header>
                <p className="dtg-eyebrow flex items-center gap-2">
                    {current ? <span className="font-mono">{current.reference}</span> : "New investigation"}
                    {current && <StatusChip status={current.status} />}
                </p>
                <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                    {current ? `Edit ${current.reference}` : "New investigation"}
                </h1>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                    Laid out as the report reads. Save a draft at any point; decisions are added once the draft
                    is saved. When it is ready, submit it for review: another investigator approves it before the
                    engineers see anything.
                </p>
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            <Section eyebrow="1" title="Event">
                <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block">
                        <span className="dtg-label">Date and time (WIB)</span>
                        <input
                            type="datetime-local"
                            value={form.event_at}
                            max={`${todayWib()}T23:59`}
                            onChange={(e) => set("event_at", e.target.value)}
                            className={input}
                        />
                    </label>
                    <label className="block">
                        <span className="dtg-label">Site</span>
                        <select value={form.site_id} onChange={(e) => set("site_id", e.target.value)} className={input}>
                            <option value="" className="bg-surface">
                                Choose a site…
                            </option>
                            {siteOptions.map((s) => (
                                <option key={s.id} value={s.id} className="bg-surface">
                                    {siteLabel(s.name, s.client)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="block">
                        <span className="dtg-label">Radar</span>
                        <input
                            value={form.radar}
                            onChange={(e) => set("radar", e.target.value)}
                            placeholder="e.g. SSR-XT-001"
                            maxLength={80}
                            className={`${input} font-mono`}
                        />
                    </label>
                    <label className="block">
                        <span className="dtg-label">Title</span>
                        <input
                            value={form.title}
                            onChange={(e) => set("title", e.target.value)}
                            placeholder="e.g. Amber alarm acknowledged late"
                            maxLength={200}
                            className={input}
                        />
                    </label>
                </div>
            </Section>

            <Section eyebrow="2" title="People">
                <div className="grid gap-4 sm:grid-cols-2">
                    {(
                        [
                            ["ds_employee_id", "ns_employee_id", "Day shift (DS) engineer"],
                            ["ns_employee_id", "ds_employee_id", "Night shift (NS) engineer"],
                        ] as const
                    ).map(([key, other, label]) => (
                        <label key={key} className="block">
                            <span className="dtg-label">{label}</span>
                            <select
                                value={form[key] ?? ""}
                                onChange={(e) => set(key, e.target.value || null)}
                                className={input}
                            >
                                <option value="" className="bg-surface">
                                    None
                                </option>
                                {options
                                    .filter((p) => p.id !== form[other])
                                    .map((p) => (
                                        <option key={p.id} value={p.id!} className="bg-surface">
                                            {p.name}
                                        </option>
                                    ))}
                            </select>
                        </label>
                    ))}
                    <label className="block sm:col-span-2">
                        <span className="dtg-label">Handover notes</span>
                        <input
                            value={form.handover_note}
                            onChange={(e) => set("handover_note", e.target.value)}
                            placeholder="e.g. Handover from Aris at 18:00"
                            maxLength={500}
                            className={input}
                        />
                    </label>
                </div>
                <p className="mt-3 text-micro text-muted">
                    Only active members of the monitoring team can be named, and the two must be different people. Either
                    may be left empty, but at least one is needed to submit. The team is set in Settings.
                </p>
            </Section>

            <TextSection
                n="3"
                title="Findings"
                help="What was found, including the on-duty engineer's own account. Not shown to the engineer."
                value={form.findings}
                onChange={(v) => set("findings", v)}
            />
            <TextSection
                n="4"
                title="Technical support summary"
                help="The objective picture: what the data and the system logs show. Not shown to the engineer."
                value={form.technical_summary}
                onChange={(v) => set("technical_summary", v)}
            />
            <TextSection
                n="5"
                title="Investigation result"
                help="The conclusion. Shown to each engineer given a decision."
                value={form.investigation_result}
                onChange={(v) => set("investigation_result", v)}
            />
            <TextSection
                n="6"
                title="Recommendation"
                help="What should change to prevent a repeat. Shown to each engineer given a decision."
                value={form.recommendation}
                onChange={(v) => set("recommendation", v)}
            />

            <Section eyebrow="7" title="Decision">
                {!current ? (
                    <p className="text-sm text-muted">Save the draft first, then add a decision for each engineer.</p>
                ) : (
                    <div className="space-y-4">
                        {current.outcomes.map((o) => (
                            <OutcomeCard
                                key={`${o.id}:${o.revised_at ?? ""}:${o.response_status}`}
                                inv={current}
                                outcome={o}
                                people={people}
                                onSaved={(inv) => {
                                    setCurrent(inv);
                                    onSaved(inv, true);
                                }}
                            />
                        ))}
                        {adding ? (
                            <OutcomeCard
                                inv={current}
                                outcome={null}
                                people={people}
                                onSaved={(inv) => {
                                    setCurrent(inv);
                                    setAdding(false);
                                    onSaved(inv, true);
                                }}
                                onCancel={() => setAdding(false)}
                            />
                        ) : (
                            current.status !== "closed" && current.status !== "in_review" && (
                                <button type="button" onClick={() => setAdding(true)} className="dtg-btn-secondary">
                                    <Plus className="h-4 w-4" />
                                    Add a decision
                                </button>
                            )
                        )}
                    </div>
                )}
            </Section>

            <div className="flex flex-wrap items-center gap-3">
                <button type="button" disabled={saving} onClick={() => void saveAndStay()} className="dtg-btn-secondary">
                    {saving && <Spinner className="h-4 w-4" />}
                    {status === "issued" ? "Save" : "Save draft"}
                </button>
                <button type="button" disabled={saving} onClick={() => void saveAndView()} className="dtg-btn-secondary">
                    Save and view
                </button>
                {(status === "draft" || status === "changes_requested") && current && (
                    <button type="button" disabled={saving} onClick={() => void saveAndSubmit()} className="dtg-btn-primary">
                        Save and submit for review
                    </button>
                )}
                <button type="button" onClick={onCancel} className="text-sm text-paper-soft transition hover:text-paper">
                    Cancel
                </button>
            </div>
        </div>
    );
}

function TextSection({
    n,
    title,
    help,
    value,
    onChange,
}: {
    n: string;
    title: string;
    help: string;
    value: string;
    onChange: (v: string) => void;
}) {
    return (
        <Section eyebrow={n} title={title}>
            <p className="mb-2 text-micro text-muted">{help}</p>
            <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={5} className={input} />
        </Section>
    );
}

function OutcomeCard({
    inv,
    outcome,
    people,
    onSaved,
    onCancel,
}: {
    inv: Investigation;
    outcome: Outcome | null;
    people: MonitoringPerson[];
    onSaved: (inv: Investigation) => void;
    onCancel?: () => void;
}) {
    const dialog = useDialog();
    const [form, setForm] = useState<OutcomePayload>(() => ({
        employee_id: outcome?.employee_id ?? "",
        decision: outcome?.decision ?? "verbal_warning",
        reason: outcome?.reason ?? "",
        effective_from: outcome?.effective_from ?? null,
        suspension_days: outcome?.suspension_days ?? null,
        suspension_paid: outcome?.suspension_paid ?? false,
        further_action_note: outcome?.further_action_note ?? "",
    }));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const locked = inv.status === "closed" || inv.status === "in_review";
    const issued = inv.status === "issued" || inv.status === "closed";

    const set = <K extends keyof OutcomePayload>(k: K, v: OutcomePayload[K]) => setForm((f) => ({ ...f, [k]: v }));

    const taken = new Set(inv.outcomes.filter((o) => o.id !== outcome?.id).map((o) => o.employee_id));
    const options = personOptions(
        people.filter((p) => !taken.has(p.id)),
        outcome ? [{ id: outcome.employee_id, name: outcome.employee_name }] : [],
    );
    const policy = DECISIONS.find((d) => d.value === form.decision);
    const from = form.effective_from || (issued ? null : todayWib());
    const until = activeUntil(form.decision as Decision, from, form.suspension_days);

    const save = async () => {
        if (issued && outcome) {
            const ok = await dialog.confirm({
                title: `Revise ${outcome.employee_first_name}'s decision?`,
                body: "If the decision, reason, dates or terms change, their response is reset to awaiting and they are emailed to respond again.",
                confirmLabel: "Save revision",
            });
            if (!ok) return;
        }
        setSaving(true);
        setError(null);
        try {
            const payload: OutcomePayload = {
                ...form,
                effective_from: form.effective_from || null,
                suspension_days: form.decision === "suspension" ? form.suspension_days : null,
                suspension_paid: form.decision === "suspension" ? form.suspension_paid : null,
            };
            const res = outcome
                ? await investigationService.updateOutcome(inv.id, outcome.id, payload)
                : await investigationService.addOutcome(inv.id, payload);
            onSaved(res.data);
        } catch (e) {
            setError(errorDetail(e, "Could not save the decision."));
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!outcome) return;
        const ok = await dialog.confirm({
            title: `Remove ${outcome.employee_first_name}'s decision?`,
            tone: "danger",
            confirmLabel: "Remove",
        });
        if (!ok) return;
        try {
            const res = await investigationService.removeOutcome(outcome.id);
            onSaved(res.data);
        } catch (e) {
            setError(errorDetail(e, "Could not remove the decision."));
        }
    };

    return (
        <article className="rounded-lg border border-white/[0.1] bg-white/[0.02] p-4">
            {error && (
                <Alert tone="danger" className="mb-3">
                    {error}
                </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                    <span className="dtg-label">Engineer</span>
                    <select
                        value={form.employee_id}
                        disabled={locked || (issued && Boolean(outcome))}
                        onChange={(e) => set("employee_id", e.target.value)}
                        className={input}
                    >
                        <option value="" className="bg-surface">
                            Choose…
                        </option>
                        {options.map((p) => (
                            <option key={p.id} value={p.id!} className="bg-surface">
                                {p.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block">
                    <span className="dtg-label">Decision</span>
                    <select
                        value={form.decision}
                        disabled={locked}
                        onChange={(e) => set("decision", e.target.value as Decision)}
                        className={input}
                    >
                        {DECISIONS.map((d) => (
                            <option key={d.value} value={d.value} className="bg-surface">
                                {d.label}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {policy && (
                <p className="mt-2 text-micro leading-relaxed text-teal-100/80">
                    <span className="font-semibold">{policy.label}</span> — {policy.help}
                </p>
            )}

            <label className="mt-4 block">
                <span className="dtg-label">Reason{form.decision === "no_action" ? " (optional)" : ""}</span>
                <textarea
                    value={form.reason}
                    disabled={locked}
                    onChange={(e) => set("reason", e.target.value)}
                    rows={3}
                    className={input}
                />
            </label>

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <label className="block">
                    <span className="dtg-label">Effective from</span>
                    <input
                        type="date"
                        value={form.effective_from ?? ""}
                        disabled={locked}
                        onChange={(e) => set("effective_from", e.target.value || null)}
                        className={input}
                    />
                    {!form.effective_from && !issued && (
                        <span className="mt-1 block text-micro text-muted">Empty means the day it is issued.</span>
                    )}
                </label>
                <div>
                    <span className="dtg-label">Active until</span>
                    <p className="py-2.5 text-sm text-paper-soft">
                        {until
                            ? `${formatDay(until)}${!form.effective_from && !issued ? " (if issued today)" : ""}`
                            : form.decision === "suspension"
                              ? "Enter the days"
                              : "No active period"}
                    </p>
                </div>
                {form.decision === "suspension" && (
                    <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                            <span className="dtg-label">Days</span>
                            <input
                                type="number"
                                min={1}
                                max={365}
                                value={form.suspension_days ?? ""}
                                disabled={locked}
                                onChange={(e) =>
                                    set("suspension_days", e.target.value === "" ? null : Number(e.target.value))
                                }
                                className={input}
                            />
                        </label>
                        <label className="block">
                            <span className="dtg-label">Pay</span>
                            <select
                                value={form.suspension_paid ? "paid" : "unpaid"}
                                disabled={locked}
                                onChange={(e) => set("suspension_paid", e.target.value === "paid")}
                                className={input}
                            >
                                <option value="unpaid" className="bg-surface">
                                    Without pay
                                </option>
                                <option value="paid" className="bg-surface">
                                    With pay
                                </option>
                            </select>
                        </label>
                    </div>
                )}
            </div>

            {form.decision === "further_action" && (
                <label className="mt-4 block">
                    <span className="dtg-label">Further action</span>
                    <textarea
                        value={form.further_action_note}
                        disabled={locked}
                        onChange={(e) => set("further_action_note", e.target.value)}
                        rows={2}
                        placeholder="What is to happen, and under which provision of labour law."
                        className={input}
                    />
                </label>
            )}

            {outcome && issued && (
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.08] pt-3 text-xs text-paper-soft">
                    <span
                        className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${RESPONSE_CHIP[outcome.response_status].cls}`}
                    >
                        {RESPONSE_CHIP[outcome.response_status].label}
                    </span>
                    {outcome.response_text && <span className="italic">“{outcome.response_text}”</span>}
                    {outcome.resolution_note && <span className="text-muted">Reply: {outcome.resolution_note}</span>}
                </div>
            )}

            {!locked && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button type="button" disabled={saving} onClick={() => void save()} className="dtg-btn-primary px-3 py-1.5 text-xs">
                        {saving && <Spinner className="h-3.5 w-3.5" />}
                        {outcome ? (issued ? "Save revision" : "Save decision") : "Add decision"}
                    </button>
                    {onCancel && (
                        <button type="button" onClick={onCancel} className="text-xs text-paper-soft hover:text-paper">
                            Cancel
                        </button>
                    )}
                    {outcome && !issued && (
                        <button type="button" onClick={() => void remove()} className="ml-auto text-xs text-danger hover:underline">
                            Remove
                        </button>
                    )}
                </div>
            )}
        </article>
    );
}

// ── Sites ───────────────────────────────────────────────────────────────

function SitesManager({ sites, onChange }: { sites: MonitoringSite[]; onChange: (s: MonitoringSite[]) => void }) {
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState({ name: "", client: "" });
    const [edits, setEdits] = useState<Record<string, { name: string; client: string }>>({});

    const run = async (fn: () => Promise<{ data: MonitoringSite[] }>) => {
        setError(null);
        try {
            const res = await fn();
            onChange(res.data);
            return true;
        } catch (e) {
            setError(errorDetail(e, "That change did not save."));
            return false;
        }
    };

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">Configuration</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">Monitoring sites</h2>
                <p className="mt-1 text-xs text-muted">
                    Sites are deactivated rather than deleted, so past investigations keep their place.
                </p>
            </header>
            {error && <p className="px-5 pt-3 text-sm text-danger">{error}</p>}
            <div className="divide-y divide-white/[0.05]">
                {sites.map((s) => {
                    const e = edits[s.id] ?? { name: s.name, client: s.client ?? "" };
                    const dirty = e.name !== s.name || e.client !== (s.client ?? "");
                    return (
                        <div key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                            <input
                                value={e.name}
                                onChange={(ev) => setEdits((m) => ({ ...m, [s.id]: { ...e, name: ev.target.value } }))}
                                className="dtg-input w-48 text-sm"
                                aria-label="Site name"
                            />
                            <input
                                value={e.client}
                                onChange={(ev) => setEdits((m) => ({ ...m, [s.id]: { ...e, client: ev.target.value } }))}
                                className="dtg-input w-48 text-sm"
                                placeholder="Client"
                                aria-label="Client"
                            />
                            {dirty && (
                                <button
                                    type="button"
                                    onClick={async () => {
                                        if (await run(() => investigationService.updateSite(s.id, e)))
                                            setEdits((m) => {
                                                const { [s.id]: _, ...rest } = m;
                                                return rest;
                                            });
                                    }}
                                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                >
                                    Save
                                </button>
                            )}
                            <label className="ml-auto flex items-center gap-2 text-xs text-paper-soft">
                                <input
                                    type="checkbox"
                                    checked={s.is_active}
                                    onChange={(ev) =>
                                        void run(() =>
                                            investigationService.updateSite(s.id, {
                                                name: s.name,
                                                client: s.client ?? "",
                                                is_active: ev.target.checked,
                                            }),
                                        )
                                    }
                                    className="h-3.5 w-3.5 rounded border-white/20 bg-white/5"
                                />
                                Active
                            </label>
                        </div>
                    );
                })}
                <form
                    onSubmit={async (ev) => {
                        ev.preventDefault();
                        if (await run(() => investigationService.addSite(draft))) setDraft({ name: "", client: "" });
                    }}
                    className="flex flex-wrap items-center gap-3 px-5 py-3"
                >
                    <input
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        placeholder="New site"
                        className="dtg-input w-48 text-sm"
                    />
                    <input
                        value={draft.client}
                        onChange={(e) => setDraft({ ...draft, client: e.target.value })}
                        placeholder="Client"
                        className="dtg-input w-48 text-sm"
                    />
                    <button type="submit" disabled={!draft.name.trim()} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                        <Plus className="h-3.5 w-3.5" />
                        Add site
                    </button>
                </form>
            </div>
        </section>
    );
}
