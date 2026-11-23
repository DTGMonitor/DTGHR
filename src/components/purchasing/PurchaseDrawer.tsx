import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, CornerUpLeft, FileText, Paperclip, Printer, Send, Trash2, X } from "lucide-react";

import Alert from "@/components/ui/Alert";
import Drawer from "@/components/ui/Drawer";
import MoneyInput from "@/components/ui/MoneyInput";
import { useDialog } from "@/components/ui/Dialog";
import DocumentViewer from "@/components/contracts/DocumentViewer";
import {
    purchaseService,
    type CheckerCandidate,
    type DocumentKind,
    type Milestone,
    type Purchase,
    type PurchaseAction,
    type PurchaseEvent,
    type PurchaseSettings,
} from "@/services/purchaseService";
import { vendorService, type Vendor } from "@/services/vendorService";
import { DOC_KIND, EVENT_LABEL, LINE_TYPE, MILESTONES, OUTCOME, STATUS_CHIP, TIER_LABEL, day, detail, rp, todayISO, when } from "./labels";
import LineEditor, { rowsFrom, toInput, type LineRow } from "./LineEditor";

/*
 * One purchase: where it stands, its lines, its file, its history, and the
 * step the caller may take now. The server lists those steps in `can`; each
 * panel below appears only for its step, and asks only for what that step
 * needs. A checker's copy has no prices in it at all.
 */

type Run = (fn: () => Promise<{ data: Purchase }>, fallback: string) => Promise<boolean>;

export default function PurchaseDrawer({
    purchase: p,
    me,
    role,
    settings,
    onChange,
    onEdit,
    onDeleted,
    onClose,
}: {
    purchase: Purchase;
    /** The caller's user id. */
    me: string | undefined;
    role: string | undefined;
    settings: PurchaseSettings | null;
    onChange: (p: Purchase) => void;
    onEdit: (p: Purchase) => void;
    onDeleted: () => void;
    onClose: () => void;
}) {
    const dialog = useDialog();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [viewing, setViewing] = useState<{ id: string; filename: string; type: string } | null>(null);
    const priced = p.shape !== "checker";

    const run: Run = async (fn, fallback) => {
        setBusy(true);
        try {
            const res = await fn();
            onChange(res.data);
            setError(null);
            return true;
        } catch (e) {
            setError(detail(e, fallback));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const upload = (kind: DocumentKind, file: File) =>
        run(() => purchaseService.upload(p.id, kind, file), "Could not attach that file.");

    const prompted = async (
        title: string,
        body: string,
        fn: (note: string) => Promise<{ data: Purchase }>,
        opts: { required?: boolean; danger?: boolean; confirmLabel?: string } = {},
    ) => {
        const note = await dialog.prompt({
            title,
            body,
            multiline: true,
            required: opts.required ?? true,
            tone: opts.danger ? "danger" : undefined,
            confirmLabel: opts.confirmLabel,
        });
        if (note === null) return;
        await run(() => fn(note.trim()), "Could not do that.");
    };

    const lastNote = [...p.events].reverse().find((e) => ["returned", "sent_back", "delivery_rejected"].includes(e.kind));
    const showNote =
        lastNote &&
        ((lastNote.kind === "returned" && p.status === "draft") ||
            (lastNote.kind === "sent_back" && p.status === "sourcing") ||
            (lastNote.kind === "delivery_rejected" && p.status === "ordered"));

    const chip = STATUS_CHIP[p.status];
    const title = `${p.reference ?? "Request"} · ${p.title}`;
    const actions = (
        <Actions p={p} me={me} role={role} settings={settings} busy={busy} run={run} prompted={prompted} upload={upload}
                 onEdit={onEdit} onDeleted={onDeleted} setError={setError} confirm={dialog.confirm} />
    );
    const documents = (
        <Documents
            p={p}
            role={role}
            busy={busy}
            onUpload={upload}
            onView={(d) => setViewing(d)}
            onRemove={(id) => void run(() => purchaseService.removeDocument(p.id, id), "Could not remove it.")}
        />
    );
    const viewer = viewing && (
        <DocumentViewer
            src={purchaseService.documentUrl(p.id, viewing.id)}
            filename={viewing.filename}
            contentType={viewing.type}
            onClose={() => setViewing(null)}
        />
    );

    // The requester follows it in general terms: where it is, what they asked
    // for, and what they attached. The rest is finance's.
    if (p.shape === "requester") {
        return (
            <Drawer title={title} eyebrow="Your purchase request" onClose={onClose}>
                <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
                    {error && <Alert tone="danger">{error}</Alert>}
                    <Progress p={p} />
                    {actions}
                    {p.purpose && <p className="whitespace-pre-wrap text-sm leading-relaxed text-paper-soft">{p.purpose}</p>}
                    <p className="text-sm text-paper-soft">
                        Needed by <span className="text-paper">{day(p.needed_by)}</span>
                        {p.order_number && <> · Order <span className="font-mono text-paper">{p.order_number}</span></>}
                    </p>
                    <RequestedItems p={p} />
                    {documents}
                    <MilestoneHistory p={p} />
                </div>
                {viewer}
            </Drawer>
        );
    }

    return (
        <Drawer title={title} eyebrow={p.order_number ? `Order ${p.order_number}` : "Purchasing"} onClose={onClose}>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
                {error && <Alert tone="danger">{error}</Alert>}

                <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${chip.cls}`}>
                        {chip.label}
                    </span>
                    {p.urgent && <Flag tone="gold">Urgent</Flag>}
                    {p.late_entry && <Flag tone="danger">Late entry</Flag>}
                    {p.self_approved && <Flag tone="gold">Self-approved</Flag>}
                    {p.related_party && <Flag tone="gold">Related party</Flag>}
                    {p.sole_source && <Flag tone="gold">Sole source</Flag>}
                    {p.tier && <span className="text-micro text-muted">{TIER_LABEL[p.tier]}</span>}
                </div>

                {showNote && lastNote && (
                    <Alert tone="warning">
                        <span className="font-semibold">
                            {EVENT_LABEL[lastNote.kind]} by {lastNote.actor_name}:
                        </span>{" "}
                        {lastNote.note}
                    </Alert>
                )}
                {p.status === "cancelled" && p.cancel_reason && (
                    <Alert tone="danger">Cancelled: {p.cancel_reason}</Alert>
                )}
                {p.urgent && p.urgent_detail && !p.urgent_detail.confirmed_at && p.status !== "draft" && p.status !== "submitted" && p.status !== "cancelled" && (
                    <Alert tone="warning">
                        Urgent approval given by {p.urgent_detail.channel === "phone" ? "phone" : "WhatsApp"}
                        {p.urgent_detail.approved_at && ` on ${when(p.urgent_detail.approved_at)}`}. The approver
                        has not confirmed it here yet; it can't be paid until they do.
                    </Alert>
                )}

                <Summary p={p} />

                {/* The step the caller may take now. */}
                {actions}

                {p.items && p.items.length > 0 && <RequestedItems p={p} />}
                <Lines p={p} priced={priced} />
                {documents}
                <History events={p.events} />
            </div>
            {viewer}
        </Drawer>
    );
}

/** The requester's progress: five milestones with dates, or the outcome. */
function Progress({ p }: { p: Purchase }) {
    const m = p.milestone;
    const reached = (k: Milestone) => Boolean(m.dates?.[k]);
    const current = m.current ? MILESTONES.findIndex((x) => x.key === m.current) : -1;
    return (
        <div className="space-y-3">
            {m.outcome && (
                <Alert tone={OUTCOME[m.outcome].tone}>
                    <span className="font-semibold">{OUTCOME[m.outcome].label}.</span>{" "}
                    {m.outcome === "petty_cash"
                        ? "Buy it, keep the receipt, and bring it to finance the same day."
                        : m.note}
                    {m.outcome === "returned" && " Change your request and submit it again."}
                </Alert>
            )}
            {p.status === "draft" && !m.outcome && (
                <Alert tone="info">This is a draft. Submit it when it's ready.</Alert>
            )}
            <ol className="grid grid-cols-5 gap-1">
                {MILESTONES.map((x, i) => {
                    const done = reached(x.key);
                    const here = i === current && !m.outcome;
                    return (
                        <li key={x.key} className="space-y-1.5">
                            <div className={`h-1.5 rounded-full ${done ? (here ? "bg-signal" : "bg-signal/60") : "bg-white/10"}`} />
                            <p className={`text-micro font-semibold uppercase tracking-label ${here ? "text-signal" : done ? "text-paper-soft" : "text-muted"}`}>
                                {x.label}
                            </p>
                            <p className="text-micro text-muted">{done ? day(m.dates[x.key]) : ""}</p>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

/** What the requester asked for, with their notes. */
function RequestedItems({ p }: { p: Purchase }) {
    const items = p.items ?? [];
    return (
        <div>
            <p className="dtg-eyebrow">{p.shape === "requester" ? "What you asked for" : "What the requester asked for"}</p>
            <ul className="mt-2 space-y-1.5">
                {items.length === 0 && <li className="text-micro text-muted">No items.</li>}
                {items.map((i) => (
                    <li key={i.id} className="text-sm">
                        <span className="text-paper">{i.description}</span>{" "}
                        <span className="font-mono text-xs text-muted">× {i.quantity}</span>
                        {i.note && <span className="block text-xs text-paper-soft">{i.note}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function MilestoneHistory({ p }: { p: Purchase }) {
    const label = (k: string) =>
        MILESTONES.find((x) => x.key === k)?.label ?? OUTCOME[k as keyof typeof OUTCOME]?.label ?? k;
    return (
        <div>
            <p className="dtg-eyebrow">History</p>
            <ol className="mt-3 space-y-2 border-l border-white/[0.08] pl-4">
                {[...p.events].reverse().map((e, i) => (
                    <li key={`${e.kind}-${i}`} className="relative">
                        <span className="absolute -left-[1.3rem] top-1.5 h-1.5 w-1.5 rounded-full bg-white/25" />
                        <p className="text-xs text-paper-soft">
                            <span className="font-semibold text-paper">{label(e.kind)}</span> · {when(e.created_at)}
                            {e.note && <span className="text-muted">: {e.note}</span>}
                        </p>
                    </li>
                ))}
            </ol>
        </div>
    );
}

function Flag({ tone, children }: { tone: "gold" | "danger"; children: React.ReactNode }) {
    const cls = tone === "gold" ? "border-gold/30 bg-gold/10 text-gold" : "border-danger/40 bg-danger/10 text-danger";
    return <span className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${cls}`}>{children}</span>;
}

function Summary({ p }: { p: Purchase }) {
    const rows: [string, React.ReactNode][] = [
        ["Requested by", p.requester.name ?? "—"],
        ["Needed by", day(p.needed_by)],
    ];
    if (p.shape !== "checker") {
        rows.push(["Cost code", p.cost_code || "—"]);
        rows.push(["Estimated", rp(p.estimated_total)]);
        if (p.approval_amount != null) rows.push(["To approve", rp(p.approval_amount)]);
        if (p.approved_amount != null)
            rows.push(["Approved", `${rp(p.approved_amount)}${p.approved_by_name ? ` by ${p.approved_by_name}` : ""}`]);
    }
    rows.push(["Vendor", p.vendor?.name ?? "—"]);
    if (p.order_number) rows.push(["Order", `${p.order_number} · ${day(p.ordered_at)}`]);
    if (p.checker) rows.push(["Checker", p.checker.name ?? "—"]);
    if (p.grn_at) rows.push(["Received", day(p.grn_at)]);
    if (p.invoice) rows.push(["Invoice", `${p.invoice.number} · ${rp(p.invoice.total)} (net ${rp(p.invoice.net_payable)})`]);
    if (p.finance_request)
        rows.push([
            "Payment",
            <Link key="fr" to={`/finance-requests?open=${p.finance_request.id}`} className="dtg-link font-mono text-xs">
                {p.finance_request.reference} ({p.finance_request.status.replace("_", " ")})
            </Link>,
        ]);
    if (p.paid_on) rows.push(["Paid", day(p.paid_on)]);

    return (
        <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                {rows.map(([k, v]) => (
                    <div key={k}>
                        <dt className="text-micro uppercase tracking-label text-muted">{k}</dt>
                        <dd className="mt-0.5 break-words text-paper">{v}</dd>
                    </div>
                ))}
            </dl>
            {p.purpose && <p className="whitespace-pre-wrap text-sm leading-relaxed text-paper-soft">{p.purpose}</p>}
            {p.related_party && p.related_party_note && (
                <p className="text-xs text-paper-soft">
                    <span className="font-semibold text-gold">Related party:</span> {p.related_party_note}
                </p>
            )}
            {p.sole_source && p.sole_source_note && (
                <p className="text-xs text-paper-soft">
                    <span className="font-semibold text-gold">Sole source:</span> {p.sole_source_note}
                </p>
            )}
            {p.budget_exception_note && (
                <p className="text-xs text-paper-soft">
                    <span className="font-semibold text-gold">Budget exception:</span> {p.budget_exception_note}
                </p>
            )}
        </div>
    );
}

function Lines({ p, priced }: { p: Purchase; priced: boolean }) {
    return (
        <div>
            <p className="dtg-eyebrow">Lines</p>
            <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[30rem] text-left text-xs">
                    <thead className="text-micro uppercase tracking-label text-muted">
                        <tr className="border-b border-white/[0.08]">
                            <th className="py-1.5 pr-3 font-semibold">Type</th>
                            <th className="py-1.5 pr-3 font-semibold">Description</th>
                            <th className="py-1.5 pr-3 text-right font-semibold">Qty</th>
                            {p.grn_at && <th className="py-1.5 pr-3 text-right font-semibold">Received</th>}
                            {priced && <th className="py-1.5 text-right font-semibold">Amount</th>}
                        </tr>
                    </thead>
                    <tbody className="text-paper-soft">
                        {(p.lines ?? []).length === 0 && (
                            <tr>
                                <td colSpan={5} className="py-2 text-micro text-muted">
                                    No lines yet: finance writes them from the requested items when registering.
                                </td>
                            </tr>
                        )}
                        {(p.lines ?? []).map((l) => (
                            <tr key={l.id} className="border-b border-white/[0.04] align-top">
                                <td className="py-1.5 pr-3 text-muted">
                                    {LINE_TYPE[l.line_type].label}
                                    {l.asset_category && <span className="block text-micro">{l.asset_category.name}</span>}
                                </td>
                                <td className="py-1.5 pr-3">
                                    {l.description}
                                    {l.specification && (
                                        <span className="block whitespace-pre-wrap text-micro text-muted">{l.specification}</span>
                                    )}
                                    {l.client_po && (
                                        <span className="block text-micro text-muted">
                                            For {l.client_po.client_name} PO {l.client_po.po_number}
                                        </span>
                                    )}
                                    {!l.client_po && l.client_ref && (
                                        <span className="block text-micro text-muted">For {l.client_ref}</span>
                                    )}
                                    {l.condition_note && <span className="block text-micro text-muted">{l.condition_note}</span>}
                                    {l.line_type === "asset" && p.grn_at && l.assets_registered !== undefined && (
                                        <span className="block text-micro text-muted">
                                            {l.assets_registered} of {l.qty_received ?? 0} registered by IT
                                        </span>
                                    )}
                                </td>
                                <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono">
                                    {l.quantity} {l.unit}
                                </td>
                                {p.grn_at && <td className="py-1.5 pr-3 text-right font-mono">{l.qty_received ?? "—"}</td>}
                                {priced && (
                                    <td className="whitespace-nowrap py-1.5 text-right font-mono">
                                        {rp(l.line_total)}
                                        <span className="block text-micro text-muted">@ {rp(l.unit_price)}</span>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/** The kinds this caller may attach now, mirroring purchases_doc_kinds. */
function attachable(p: Purchase, role: string | undefined): DocumentKind[] {
    if (!p.can.includes("add_document")) return [];
    if (role === "finance")
        return ["quote", "comparison", "contract", "invoice", "tax_invoice", "budget_exception", "approval_evidence",
                "delivery_note", "delivery_photo", "request", "other"];
    if (p.shape === "checker") return ["delivery_photo", "delivery_note"];
    return ["request", "approval_evidence", "other"];
}

function Documents({
    p,
    role,
    busy,
    onUpload,
    onView,
    onRemove,
}: {
    p: Purchase;
    role: string | undefined;
    busy: boolean;
    onUpload: (kind: DocumentKind, file: File) => Promise<boolean>;
    onView: (d: { id: string; filename: string; type: string }) => void;
    onRemove: (id: string) => void;
}) {
    const kinds = attachable(p, role);
    const [kind, setKind] = useState<DocumentKind>(kinds[0] ?? "other");
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (kinds.length && !kinds.includes(kind)) setKind(kinds[0] ?? "other");
    }, [kinds.join(",")]);

    return (
        <div>
            <p className="dtg-eyebrow">The purchase file</p>
            <ul className="mt-1.5 space-y-1">
                {p.documents.length === 0 && <li className="text-micro text-muted">Nothing attached yet.</li>}
                {p.documents.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2 text-xs">
                        <FileText className="h-3.5 w-3.5 text-muted" />
                        <span className="text-micro uppercase tracking-label text-muted">{DOC_KIND[d.kind]}</span>
                        <button
                            type="button"
                            onClick={() => onView({ id: d.id, filename: d.filename, type: d.content_type })}
                            className="text-teal-200 underline-offset-2 hover:underline"
                        >
                            {d.filename}
                        </button>
                        <span className="text-micro text-muted">
                            {d.uploaded_by_name} · {day(d.created_at)}
                        </span>
                        {d.can_delete && (
                            <button type="button" aria-label={`Remove ${d.filename}`} onClick={() => onRemove(d.id)} className="text-muted hover:text-danger">
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {kinds.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)} className="dtg-input w-auto py-1.5 text-xs">
                        {kinds.map((k) => (
                            <option key={k} value={k} className="bg-surface">
                                {DOC_KIND[k]}
                            </option>
                        ))}
                    </select>
                    <input
                        ref={input}
                        type="file"
                        accept=".pdf,image/*,.doc,.docx,.xls,.xlsx"
                        capture={kind === "delivery_photo" ? "environment" : undefined}
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (file) void onUpload(kind, file);
                        }}
                    />
                    <button type="button" disabled={busy} onClick={() => input.current?.click()} className="dtg-btn-ghost px-3 py-1.5 text-xs">
                        <Paperclip className="h-3.5 w-3.5" />
                        Attach
                    </button>
                </div>
            )}
        </div>
    );
}

function describe(e: PurchaseEvent): string {
    const d = (e.detail && !Array.isArray(e.detail) ? e.detail : {}) as Record<string, unknown>;
    const s = (k: string) => (d[k] === undefined || d[k] === null ? "" : String(d[k]));
    switch (e.kind) {
        case "document_added":
        case "document_removed":
            return `${EVENT_LABEL[e.kind]} ${DOC_KIND[s("kind") as DocumentKind]?.toLowerCase() ?? "a document"}: ${s("filename")}`;
        case "registered":
            return `Registered as ${s("reference")}`;
        case "vendor_chosen":
            return `Vendor chosen: ${s("vendor")}`;
        case "sent_for_approval":
            return `Sent for approval: ${rp(Number(d.amount))}, ${s("tier")} tier`;
        case "approved":
            return `Approved ${rp(Number(d.amount))}`;
        case "ordered":
            return `Order ${s("order_number")} issued; checker ${s("checker")}`;
        case "checker_changed":
            return `Checker changed from ${s("from")} to ${s("to")}`;
        case "matched":
            return `Matched; ${s("finance_request")} for ${rp(Number(d.net_payable))} sent for payment`;
        case "paid":
            return `Paid on ${day(s("paid_on"))}`;
        default:
            return EVENT_LABEL[e.kind] ?? e.kind;
    }
}

function History({ events }: { events: PurchaseEvent[] }) {
    return (
        <div>
            <p className="dtg-eyebrow">History</p>
            <ol className="mt-3 space-y-2.5 border-l border-white/[0.08] pl-4">
                {[...events].reverse().map((e) => (
                    <li key={e.id} className="relative">
                        <span className="absolute -left-[1.3rem] top-1.5 h-1.5 w-1.5 rounded-full bg-white/25" />
                        <p className="text-micro text-muted">
                            <span className="font-semibold text-paper-soft">{e.actor_name}</span> · {when(e.created_at)}
                        </p>
                        <p className="whitespace-pre-wrap text-xs leading-relaxed text-paper-soft">
                            {describe(e)}
                            {e.note && <span className="text-muted">: {e.note}</span>}
                        </p>
                    </li>
                ))}
            </ol>
        </div>
    );
}

// ── The step panels ─────────────────────────────────────────────────────

function Actions({
    p,
    me,
    role,
    settings,
    busy,
    run,
    prompted,
    upload,
    onEdit,
    onDeleted,
    setError,
    confirm,
}: {
    p: Purchase;
    me: string | undefined;
    role: string | undefined;
    settings: PurchaseSettings | null;
    busy: boolean;
    run: Run;
    prompted: (
        title: string,
        body: string,
        fn: (note: string) => Promise<{ data: Purchase }>,
        opts?: { required?: boolean; danger?: boolean; confirmLabel?: string },
    ) => Promise<void>;
    upload: (kind: DocumentKind, file: File) => Promise<boolean>;
    onEdit: (p: Purchase) => void;
    onDeleted: () => void;
    setError: (m: string | null) => void;
    confirm: ReturnType<typeof useDialog>["confirm"];
}) {
    const can = (a: PurchaseAction) => p.can.includes(a);
    const btn = "px-3 py-1.5 text-xs";

    const remove = async () => {
        if (!(await confirm({ title: "Delete this draft?", body: "The draft and its attachments are deleted.", confirmLabel: "Delete", tone: "danger" })))
            return;
        try {
            await purchaseService.remove(p.id);
            onDeleted();
        } catch (e) {
            setError(detail(e, "Could not delete it."));
        }
    };

    const requesterCancel = p.status === "draft" || p.status === "submitted";

    return (
        <div className="space-y-3">
            {(can("edit") || can("submit") || can("delete") || can("cancel") || p.order_number) && (
                <div className="flex flex-wrap gap-2">
                    {can("submit") && (
                        <button type="button" disabled={busy} onClick={() => void run(() => purchaseService.submit(p.id), "Could not submit it.")}
                                className={`dtg-btn-primary ${btn}`}>
                            <Send className="h-3.5 w-3.5" />
                            Submit to finance
                        </button>
                    )}
                    {can("edit") && (
                        <button type="button" onClick={() => onEdit(p)} className={`dtg-btn-secondary ${btn}`}>
                            Edit
                        </button>
                    )}
                    {can("delete") && (
                        <button type="button" disabled={busy} onClick={() => void remove()} className={`dtg-btn-ghost ${btn} text-danger`}>
                            Delete draft
                        </button>
                    )}
                    {can("cancel") && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                                void prompted(
                                    "Cancel this purchase?",
                                    requesterCancel && role !== "finance"
                                        ? "Say why, if you like. Cancelling is final."
                                        : "Say why it is cancelled. Cancelling is final.",
                                    (reason) => purchaseService.cancel(p.id, reason || null),
                                    { required: !(requesterCancel && role !== "finance"), danger: true, confirmLabel: "Cancel purchase" },
                                )
                            }
                            className={`dtg-btn-ghost ${btn} text-danger`}
                        >
                            <X className="h-3.5 w-3.5" />
                            Cancel purchase
                        </button>
                    )}
                    {p.order_number && p.shape === "full" && (
                        <button type="button" onClick={() => printOrder(p)} className={`dtg-btn-ghost ${btn}`}>
                            <Printer className="h-3.5 w-3.5" />
                            Print order
                        </button>
                    )}
                </div>
            )}

            {can("register") && <RegisterPanel p={p} settings={settings} busy={busy} run={run} prompted={prompted} />}
            {can("source") && <SourcePanel p={p} busy={busy} run={run} />}
            {can("approve") && <ApprovePanel p={p} me={me} busy={busy} prompted={prompted} />}
            {can("confirm_urgent") && (
                <div className="dtg-panel-inset space-y-2 px-4 py-3">
                    <p className="text-sm text-paper-soft">
                        You approved this urgent purchase by {p.urgent_detail?.channel === "phone" ? "phone" : "WhatsApp"}
                        {p.urgent_detail?.approved_at && ` on ${when(p.urgent_detail.approved_at)}`}: {p.vendor?.name},{" "}
                        {rp(p.approved_amount)}. Confirm it here so it can be paid.
                    </p>
                    <button type="button" disabled={busy} onClick={() => void run(() => purchaseService.confirmUrgent(p.id), "Could not confirm it.")}
                            className={`dtg-btn-primary ${btn}`}>
                        <Check className="h-3.5 w-3.5" />
                        Confirm my approval
                    </button>
                </div>
            )}
            {can("decide_amount") && (
                <div className="dtg-panel-inset space-y-2 px-4 py-3">
                    <p className="text-sm text-paper-soft">
                        The invoice is {rp(p.amount_review_amount)} against the approved {rp(p.approved_amount)}.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={busy} onClick={() => void run(() => purchaseService.decideAmount(p.id, true), "Could not approve it.")}
                                className={`dtg-btn-primary ${btn}`}>
                            Approve {rp(p.amount_review_amount)}
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void prompted("Decline the higher amount?", "Finance asks the vendor for a corrected invoice.",
                                (note) => purchaseService.decideAmount(p.id, false, note || undefined), { required: false, danger: true })}
                            className={`dtg-btn-secondary ${btn}`}
                        >
                            Decline
                        </button>
                    </div>
                </div>
            )}
            {(can("issue_order") || can("change_checker")) && <OrderPanel p={p} busy={busy} run={run} />}
            {can("receive") && <ReceivePanel p={p} busy={busy} run={run} upload={upload} />}
            {(can("match") || can("ask_amount")) && <MatchPanel p={p} busy={busy} run={run} />}
        </div>
    );
}

function RegisterPanel({
    p,
    settings,
    busy,
    run,
    prompted,
}: {
    p: Purchase;
    settings: PurchaseSettings | null;
    busy: boolean;
    run: Run;
    prompted: (title: string, body: string, fn: (note: string) => Promise<{ data: Purchase }>, opts?: { required?: boolean; danger?: boolean }) => Promise<void>;
}) {
    const dialog = useDialog();
    const [budget, setBudget] = useState(true);
    const [exception, setException] = useState("");
    const [costCode, setCostCode] = useState(p.cost_code ?? "");
    const [vendors, setVendors] = useState<Vendor[]>([]);
    const [vendorId, setVendorId] = useState("");
    const [amount, setAmount] = useState("");
    // An urgent request is approved as it is registered, so finance writes
    // the lines now. Otherwise they are seeded from the items and detailed
    // while sourcing.
    const [rows, setRows] = useState<LineRow[]>(() =>
        (p.items ?? []).map((i) => ({
            line_type: "expense",
            description: i.description,
            specification: i.note ?? "",
            quantity: String(i.quantity),
            unit: "pcs",
            unit_price: "",
            asset_category_id: "",
            client_po_id: "",
        })),
    );

    useEffect(() => {
        if (p.urgent) vendorService.list().then((res) => setVendors(res.data.items)).catch(() => undefined);
    }, [p.urgent]);

    const pettyCash = async () => {
        const raw = await dialog.prompt({
            title: "Close as petty cash?",
            body: `What do you expect it to cost? It must be at most ${rp(settings?.petty_cash_limit)}. The requester buys it and brings the receipt the same day.`,
            placeholder: "e.g. 350000",
            required: true,
            confirmLabel: "Petty cash",
        });
        if (raw === null) return;
        const estimate = Number(raw.replace(/[^\d]/g, ""));
        void run(() => purchaseService.closePettyCash(p.id, estimate), "Could not close it.");
    };

    return (
        <div className="dtg-panel-inset space-y-3 px-4 py-4">
            <p className="text-sm font-semibold text-paper">Register the request</p>
            <label className="flex items-center gap-2 text-sm text-paper-soft">
                <input type="checkbox" checked={budget} onChange={(e) => setBudget(e.target.checked)} className="h-3.5 w-3.5" />
                Budget is available
            </label>
            {!budget && (
                <div>
                    <label className="dtg-label">The approver's written exception</label>
                    <textarea value={exception} onChange={(e) => setException(e.target.value)} rows={2} className="dtg-input" />
                    <p className="mt-1 text-micro text-muted">Attach the written exception as a "Budget exception" document first.</p>
                </div>
            )}
            <div>
                <label className="dtg-label">Cost code</label>
                <input value={costCode} onChange={(e) => setCostCode(e.target.value)} maxLength={60} className="dtg-input" />
            </div>
            {p.urgent && (
                <>
                    <Alert tone="info">
                        Urgent: approved by {p.urgent_detail?.channel === "phone" ? "phone" : "WhatsApp"}
                        {p.urgent_detail?.approved_at && ` on ${when(p.urgent_detail.approved_at)}`}
                        {p.urgent_detail?.note && `: ${p.urgent_detail.note}`}. Registering it approves it.
                    </Alert>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                            <label className="dtg-label">Vendor the approver named</label>
                            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="dtg-input">
                                <option value="" className="bg-surface">Choose the vendor…</option>
                                {vendors.map((v) => (
                                    <option key={v.id} value={v.id} className="bg-surface">{v.name}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="dtg-label">Amount the approver approved</label>
                            <MoneyInput value={amount} onChange={setAmount} className="dtg-input" />
                        </div>
                    </div>
                    <div>
                        <p className="dtg-label">What is bought</p>
                        <LineEditor rows={rows} onChange={setRows} />
                    </div>
                </>
            )}
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                        void run(
                            () =>
                                purchaseService.register(p.id, {
                                    budget_confirmed: budget,
                                    budget_exception_note: budget ? null : exception.trim() || null,
                                    cost_code: costCode.trim() || null,
                                    ...(p.urgent
                                        ? { vendor_id: vendorId || null, amount: amount ? Number(amount) : null, lines: toInput(rows) }
                                        : {}),
                                }),
                            "Could not register it.",
                        )
                    }
                    className="dtg-btn-primary px-3 py-1.5 text-xs"
                >
                    {p.urgent ? "Register as approved" : "Register"}
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void prompted("Return to the requester?", "Say what they should change. It goes back to their draft.",
                        (note) => purchaseService.returnToRequester(p.id, note))}
                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                >
                    <CornerUpLeft className="h-3.5 w-3.5" />
                    Return
                </button>
                <button type="button" disabled={busy} onClick={() => void pettyCash()} className="dtg-btn-ghost px-3 py-1.5 text-xs">
                    Petty cash
                </button>
            </div>
        </div>
    );
}

function SourcePanel({ p, busy, run }: { p: Purchase; busy: boolean; run: Run }) {
    const [vendors, setVendors] = useState<Vendor[]>([]);
    const [vendorId, setVendorId] = useState(p.vendor?.id ?? "");
    const [amount, setAmount] = useState(String(p.approval_amount ?? p.estimated_total ?? ""));
    const [related, setRelated] = useState<"" | "yes" | "no">(p.related_party == null ? "" : p.related_party ? "yes" : "no");
    const [relatedNote, setRelatedNote] = useState(p.related_party_note ?? "");
    const [sole, setSole] = useState(p.sole_source ?? false);
    const [soleNote, setSoleNote] = useState(p.sole_source_note ?? "");
    const [shareholders, setShareholders] = useState(p.shareholders_informed_on ?? "");
    const [rows, setRows] = useState<LineRow[]>(() => rowsFrom(p));

    useEffect(() => {
        vendorService.list().then((res) => setVendors(res.data.items)).catch(() => undefined);
    }, [p.id]);

    const save = () =>
        run(
            () =>
                purchaseService.source(p.id, {
                    vendor_id: vendorId || null,
                    approval_amount: amount ? Number(amount) : null,
                    related_party: related === "" ? null : related === "yes",
                    related_party_note: relatedNote.trim() || null,
                    sole_source: sole,
                    sole_source_note: soleNote.trim() || null,
                    shareholders_informed_on: shareholders || null,
                    lines: toInput(rows),
                }),
            "Could not save that.",
        );

    const route = p.route;
    const missing = p.missing ?? [];

    return (
        <div className="dtg-panel-inset space-y-3 px-4 py-4">
            <p className="text-sm font-semibold text-paper">Lines, quotes, vendor and amount</p>
            <p className="text-micro text-muted">
                Turn the requested items into what is actually bought, attach the quotes (and the comparison sheet) as
                the purchase file below, save, then send it for approval.
            </p>
            <LineEditor rows={rows} onChange={setRows} />
            <div className="grid gap-3 sm:grid-cols-2">
                <div>
                    <label className="dtg-label">Vendor</label>
                    <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="dtg-input">
                        <option value="" className="bg-surface">Choose a vendor…</option>
                        {vendors.map((v) => (
                            <option key={v.id} value={v.id} className="bg-surface">{v.name}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="dtg-label">Amount for approval</label>
                    <MoneyInput value={amount} onChange={setAmount} className="dtg-input" />
                </div>
            </div>

            <div>
                <p className="dtg-label">Is anyone involved related to the vendor?</p>
                <div className="flex gap-3 text-sm text-paper-soft">
                    {(["no", "yes"] as const).map((v) => (
                        <label key={v} className="flex items-center gap-1.5">
                            <input type="radio" checked={related === v} onChange={() => setRelated(v)} />
                            {v === "no" ? "No" : "Yes"}
                        </label>
                    ))}
                </div>
                {related === "yes" && (
                    <textarea value={relatedNote} onChange={(e) => setRelatedNote(e.target.value)} rows={2}
                              placeholder="Who is related, and how" className="dtg-input mt-2" />
                )}
            </div>
            <div>
                <label className="flex items-center gap-2 text-sm text-paper-soft">
                    <input type="checkbox" checked={sole} onChange={(e) => setSole(e.target.checked)} className="h-3.5 w-3.5" />
                    Sole source (only one vendor can supply it)
                </label>
                {sole && (
                    <textarea value={soleNote} onChange={(e) => setSoleNote(e.target.value)} rows={2}
                              placeholder="Why only this vendor, and a price benchmark" className="dtg-input mt-2" />
                )}
            </div>
            {route?.tier === "contract" && (
                <div>
                    <label className="dtg-label">Shareholders informed on</label>
                    <input type="date" value={shareholders} onChange={(e) => setShareholders(e.target.value)} className="dtg-input" />
                </div>
            )}

            {route && (
                <p className="text-xs text-paper-soft">
                    Route: {rp(route.amount)}
                    {route.vendor_month > 0 && ` + ${rp(route.vendor_month)} already approved from this vendor this month`}{" "}
                    = <span className="font-semibold text-paper">{rp(route.route_value)}</span> → {TIER_LABEL[route.tier]}
                </p>
            )}
            {missing.length > 0 && <Alert tone="warning">Before it goes for approval: {missing.join(", ")}.</Alert>}
            <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void save()} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                    Save
                </button>
                <button
                    type="button"
                    disabled={busy || missing.length > 0}
                    onClick={() => void run(() => purchaseService.sendForApproval(p.id), "Could not send it.")}
                    className="dtg-btn-primary px-3 py-1.5 text-xs"
                >
                    <Send className="h-3.5 w-3.5" />
                    Send for approval
                </button>
            </div>
        </div>
    );
}

function ApprovePanel({
    p,
    me,
    busy,
    prompted,
}: {
    p: Purchase;
    me: string | undefined;
    busy: boolean;
    prompted: (title: string, body: string, fn: (note: string) => Promise<{ data: Purchase }>, opts?: { required?: boolean; danger?: boolean; confirmLabel?: string }) => Promise<void>;
}) {
    return (
        <div className="dtg-panel-inset space-y-3 px-4 py-4">
            <p className="text-sm font-semibold text-paper">
                Approve {p.vendor?.name} for {rp(p.approval_amount)}?
            </p>
            <p className="text-xs text-paper-soft">
                {p.tier && TIER_LABEL[p.tier]}. Vendor this month including this purchase: {rp(p.route_value)}. The
                quotes and the comparison are in the purchase file below.
            </p>
            {p.requester.id === me && (
                <Alert tone="info">
                    This is your own request. Approving it is allowed, and it is marked self-approved for the monthly
                    review.
                </Alert>
            )}
            {p.related_party && <Alert tone="warning">Related party declared: {p.related_party_note}</Alert>}
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void prompted(`Approve ${p.reference}?`, "Your approval is recorded in writing. Add a note if you like.",
                        (note) => purchaseService.approve(p.id, note || undefined), { required: false, confirmLabel: "Approve" })}
                    className="dtg-btn-primary px-3 py-1.5 text-xs"
                >
                    <Check className="h-3.5 w-3.5" />
                    Approve
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void prompted("Send it back to finance?", "Say what should change: re-quote, a revised specification…",
                        (note) => purchaseService.sendBack(p.id, note))}
                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                >
                    <CornerUpLeft className="h-3.5 w-3.5" />
                    Send back
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void prompted("Reject this purchase?", "Say why. Rejecting cancels it.",
                        (reason) => purchaseService.reject(p.id, reason), { danger: true, confirmLabel: "Reject" })}
                    className="dtg-btn-ghost px-3 py-1.5 text-xs text-danger"
                >
                    Reject
                </button>
            </div>
        </div>
    );
}

function OrderPanel({ p, busy, run }: { p: Purchase; busy: boolean; run: Run }) {
    const [candidates, setCandidates] = useState<CheckerCandidate[]>([]);
    const [checker, setChecker] = useState("");
    const issuing = p.can.includes("issue_order");

    useEffect(() => {
        purchaseService.checkers(p.id).then((res) => setCandidates(res.data)).catch(() => undefined);
    }, [p.id]);

    return (
        <div className="dtg-panel-inset space-y-3 px-4 py-4">
            <p className="text-sm font-semibold text-paper">{issuing ? "Issue the order" : "Change the checker"}</p>
            <div>
                <label className="dtg-label">Checker: who counts and inspects the delivery</label>
                <select value={checker} onChange={(e) => setChecker(e.target.value)} className="dtg-input">
                    <option value="" className="bg-surface">Choose a person…</option>
                    {candidates
                        .filter((c) => c.user_id !== p.checker?.id)
                        .map((c) => (
                            <option key={c.user_id} value={c.user_id} className="bg-surface">
                                {c.name}
                                {c.position ? ` · ${c.position}` : ""}
                            </option>
                        ))}
                </select>
                <p className="mt-1 text-micro text-muted">Never the requester, never finance. Rotate who does it.</p>
            </div>
            <button
                type="button"
                disabled={busy || !checker}
                onClick={() =>
                    void run(
                        () => (issuing ? purchaseService.issueOrder(p.id, checker) : purchaseService.changeChecker(p.id, checker)),
                        "Could not save that.",
                    )
                }
                className="dtg-btn-primary px-3 py-1.5 text-xs"
            >
                {issuing ? "Issue order" : "Change checker"}
            </button>
        </div>
    );
}

function ReceivePanel({
    p,
    busy,
    run,
    upload,
}: {
    p: Purchase;
    busy: boolean;
    run: Run;
    upload: (kind: DocumentKind, file: File) => Promise<boolean>;
}) {
    const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries((p.lines ?? []).map((l) => [l.id, String(l.quantity)])));
    const [cond, setCond] = useState<Record<string, string>>({});
    const [matches, setMatches] = useState<"" | "yes" | "no">("");
    const [note, setNote] = useState("");
    const photo = useRef<HTMLInputElement>(null);
    const round = [...p.events].reverse().find((e) => e.kind === "ordered" || e.kind === "delivery_rejected");
    const photos = p.documents.filter((d) => d.kind === "delivery_photo" && (!round || d.created_at >= round.created_at)).length;

    return (
        <div className="dtg-panel-inset space-y-3 px-4 py-4">
            <p className="text-sm font-semibold text-paper">Goods received</p>
            <p className="text-xs text-paper-soft">
                Count and inspect the delivery against order {p.order_number}. Take at least one photo.
            </p>
            {(p.lines ?? []).map((l) => (
                <div key={l.id} className="grid items-end gap-2 sm:grid-cols-[1fr_6rem]">
                    <div>
                        <p className="text-xs text-paper">
                            {l.description} <span className="text-muted">(ordered {l.quantity} {l.unit})</span>
                        </p>
                        <input value={cond[l.id] ?? ""} onChange={(e) => setCond({ ...cond, [l.id]: e.target.value })}
                               placeholder="Condition (optional)" className="dtg-input mt-1 py-1 text-xs" />
                    </div>
                    <input type="number" min={0} max={l.quantity} value={qty[l.id]}
                           onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} className="dtg-input py-1 text-xs" />
                </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
                <input ref={photo} type="file" accept="image/*" capture="environment" className="hidden"
                       onChange={(e) => {
                           const f = e.target.files?.[0];
                           e.target.value = "";
                           if (f) void upload("delivery_photo", f);
                       }} />
                <button type="button" disabled={busy} onClick={() => photo.current?.click()} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                    <Paperclip className="h-3.5 w-3.5" />
                    Add a photo
                </button>
                <span className="text-micro text-muted">{photos} photo{photos === 1 ? "" : "s"} for this delivery</span>
            </div>
            <div>
                <p className="dtg-label">Does it match the order and the specification?</p>
                <div className="flex gap-3 text-sm text-paper-soft">
                    <label className="flex items-center gap-1.5">
                        <input type="radio" checked={matches === "yes"} onChange={() => setMatches("yes")} /> Yes
                    </label>
                    <label className="flex items-center gap-1.5">
                        <input type="radio" checked={matches === "no"} onChange={() => setMatches("no")} /> No: return it to the vendor
                    </label>
                </div>
            </div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                      placeholder={matches === "no" ? "What is wrong (required)" : "Note (optional)"} className="dtg-input" />
            <button
                type="button"
                disabled={busy || !matches || photos === 0}
                onClick={() =>
                    void run(
                        () =>
                            purchaseService.receive(p.id, {
                                matches: matches === "yes",
                                note: note.trim() || undefined,
                                lines: (p.lines ?? []).map((l) => ({
                                    line_id: l.id,
                                    qty_received: Number(qty[l.id]) || 0,
                                    condition: cond[l.id]?.trim() || undefined,
                                })),
                            }),
                        "Could not record it.",
                    )
                }
                className="dtg-btn-primary px-3 py-1.5 text-xs"
            >
                {matches === "no" ? "Reject delivery" : "Record goods received"}
            </button>
        </div>
    );
}

function MatchPanel({ p, busy, run }: { p: Purchase; busy: boolean; run: Run }) {
    const [number, setNumber] = useState("");
    const [date, setDate] = useState(todayISO());
    const [total, setTotal] = useState("");
    const [ppn, setPpn] = useState("");
    const [pph, setPph] = useState("");
    const [reviewNote, setReviewNote] = useState("");
    const net = (Number(total) || 0) - (Number(pph) || 0);
    const above = (Number(total) || 0) > (p.approved_amount ?? 0);
    const has = (k: DocumentKind) => p.documents.some((d) => d.kind === k);
    const shortLines = (p.lines ?? []).filter((l) => (l.qty_received ?? 0) < l.quantity);

    return (
        <div className="dtg-panel-inset space-y-3 px-4 py-4">
            <p className="text-sm font-semibold text-paper">Match PO + GRN + invoice</p>
            {shortLines.length > 0 && (
                <Alert tone="warning">
                    Received less than ordered on: {shortLines.map((l) => `${l.description} (${l.qty_received ?? 0} of ${l.quantity})`).join(", ")}.
                </Alert>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
                <div>
                    <label className="dtg-label">Invoice number</label>
                    <input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={60} className="dtg-input" />
                </div>
                <div>
                    <label className="dtg-label">Invoice date</label>
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="dtg-input" />
                </div>
                <div>
                    <label className="dtg-label">Invoice total (incl. PPN)</label>
                    <MoneyInput value={total} onChange={setTotal} className="dtg-input" />
                </div>
                <div>
                    <label className="dtg-label">PPN</label>
                    <MoneyInput value={ppn} onChange={setPpn} className="dtg-input" />
                </div>
                <div>
                    <label className="dtg-label">PPh withheld</label>
                    <MoneyInput value={pph} onChange={setPph} className="dtg-input" />
                </div>
                <div className="text-sm text-paper-soft">
                    <p className="dtg-label">Net payable</p>
                    <p className="font-mono text-paper">{rp(net)}</p>
                    <p className="text-micro text-muted">Approved {rp(p.approved_amount)}</p>
                </div>
            </div>
            <p className="text-micro text-muted">
                Attach the invoice{Number(ppn) > 0 ? " and the faktur pajak" : ""} below.{" "}
                {has("invoice") ? "Invoice attached." : "No invoice yet."}
                {Number(ppn) > 0 && (has("tax_invoice") ? " Faktur attached." : " No faktur yet.")}
            </p>
            {above ? (
                <div className="space-y-2">
                    <Alert tone="warning">
                        <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                        The invoice is above the approved amount. Get a corrected invoice, or ask the approver to approve{" "}
                        {rp(Number(total))}.
                    </Alert>
                    {p.can.includes("ask_amount") && (
                        <>
                            <textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={2}
                                      placeholder="Why the amount is higher" className="dtg-input" />
                            <button
                                type="button"
                                disabled={busy || !reviewNote.trim()}
                                onClick={() => void run(() => purchaseService.askAmount(p.id, Number(total), reviewNote.trim()), "Could not ask the approver.")}
                                className="dtg-btn-secondary px-3 py-1.5 text-xs"
                            >
                                Ask the approver to approve {rp(Number(total))}
                            </button>
                        </>
                    )}
                </div>
            ) : (
                p.can.includes("match") && (
                    <button
                        type="button"
                        disabled={busy || !number.trim() || !total}
                        onClick={() =>
                            void run(
                                () =>
                                    purchaseService.match(p.id, {
                                        invoice_number: number.trim(),
                                        invoice_date: date,
                                        invoice_total: Number(total),
                                        ppn_amount: Number(ppn) || 0,
                                        pph_amount: Number(pph) || 0,
                                    }),
                                "Could not match it.",
                            )
                        }
                        className="dtg-btn-primary px-3 py-1.5 text-xs"
                    >
                        <Send className="h-3.5 w-3.5" />
                        Match and send for payment
                    </button>
                )
            )}
        </div>
    );
}

// ── The printed order ───────────────────────────────────────────────────

const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function printOrder(p: Purchase) {
    const w = window.open("", "_blank", "width=820,height=900");
    if (!w) return;
    const rows = (p.lines ?? [])
        .map(
            (l) => `<tr><td>${esc(l.description)}</td><td class="r">${esc(l.quantity)} ${esc(l.unit)}</td>
                    <td class="r">${esc(rp(l.unit_price))}</td><td class="r">${esc(rp(l.line_total))}</td></tr>`,
        )
        .join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.order_number)}</title>
<style>
body{font-family:system-ui,sans-serif;color:#111;margin:40px;font-size:13px}
h1{font-size:20px;margin:0 0 4px} table{width:100%;border-collapse:collapse;margin-top:16px}
th,td{border-bottom:1px solid #ccc;padding:6px 4px;text-align:left} .r{text-align:right}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-top:16px} .muted{color:#555}
</style></head><body>
<h1>Purchase order ${esc(p.order_number)}</h1>
<p class="muted">PT DTGeotech · ${esc(p.reference)} · ${esc(day(p.ordered_at))}</p>
<div class="meta">
<div><b>Vendor</b><br>${esc(p.vendor?.name)}${p.vendor?.npwp ? `<br>NPWP ${esc(p.vendor.npwp)}` : ""}</div>
<div><b>For</b><br>${esc(p.title)}${p.needed_by ? `<br>Needed by ${esc(day(p.needed_by))}` : ""}</div>
</div>
<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><th colspan="3" class="r">Approved amount</th><th class="r">${esc(rp(p.approved_amount))}</th></tr></tfoot></table>
<p style="margin-top:24px">Approved by ${esc(p.approved_by_name ?? "—")}${p.approved_at ? ` on ${esc(day(p.approved_at))}` : ""}.
Delivery is checked by ${esc(p.checker?.name ?? "—")}. Payment only to the vendor's registered bank account.</p>
<script>window.onload=function(){window.print()}</script>
</body></html>`);
    w.document.close();
}
