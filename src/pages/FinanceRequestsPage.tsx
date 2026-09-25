import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { Check, CornerUpLeft, FileText, Paperclip, Plus, Send, Trash2 } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import {
    CATEGORY_LABELS,
    financeService,
    type FinanceCategory,
    type FinanceRequest,
    type FinanceStatus,
} from "@/services/financeService";
import { money } from "@/services/salaryService";
import Alert from "@/components/ui/Alert";
import MoneyInput from "@/components/ui/MoneyInput";
import Spinner from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";
import DocumentViewer from "@/components/contracts/DocumentViewer";

/*
 * Finance requests.
 *
 * Nurhuda, September 2026: "tiap bulan mas him ada request kayak petty cash,
 * bayar tax, bpjs, atau apapun itu dan menunggu approval peter" -- what each
 * item is and how much, with a total. Himawan prepares a request; the
 * director reviews it; the CEO approves it, or the director does when Peter
 * has handed that over in Settings; then Himawan marks it paid.
 *
 * Which buttons show is read from what the server says -- `awaiting`,
 * `is_editable`, `can_create` -- so the page never offers an action the
 * server will refuse.
 */

const STATUS: Record<FinanceStatus, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "border-white/15 bg-white/[0.04] text-muted" },
    submitted: { label: "With the Director", cls: "border-teal-500/40 bg-teal-500/10 text-teal-200" },
    endorsed: { label: "With the CEO", cls: "border-teal-500/40 bg-teal-500/10 text-teal-200" },
    approved: { label: "Approved", cls: "border-signal/40 bg-signal/10 text-signal" },
    changes_requested: { label: "Sent back", cls: "border-danger/40 bg-danger/10 text-danger" },
    paid: { label: "Paid", cls: "border-white/15 bg-white/[0.04] text-paper-soft" },
};

const CATEGORIES = Object.keys(CATEGORY_LABELS) as FinanceCategory[];

/**
 * Today in the browser's own time zone. toISOString() gives the UTC date,
 * which before 07:00 in Jakarta is still yesterday -- "Paid on" defaulted to
 * yesterday and a request due today read as overdue.
 */
function todayISO(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const longDate = (iso: string) =>
    new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });

interface Line {
    category: FinanceCategory;
    description: string;
    /** A plain number string, from MoneyInput. */
    amount: string;
}

const blankLine = (): Line => ({ category: "petty_cash", description: "", amount: "" });

export default function FinanceRequestsPage() {
    const { user } = useAuth();
    const dialog = useDialog();
    const mayBeHere =
        user?.role === "finance" || user?.role === "director" || user?.role === "executive";

    const [requests, setRequests] = useState<FinanceRequest[]>([]);
    const [canCreate, setCanCreate] = useState(false);
    const [directorFinal, setDirectorFinal] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    /** "new", a request id being edited, or null. */
    const [editing, setEditing] = useState<string | null>(null);
    const [showPaid, setShowPaid] = useState(false);
    const [viewing, setViewing] = useState<{ src: string; filename: string; type: string } | null>(
        null,
    );

    const load = useCallback(async () => {
        try {
            const res = await financeService.list();
            setRequests(res.data.items);
            setCanCreate(res.data.can_create);
            setDirectorFinal(res.data.director_final_approval);
        } catch {
            setError("Could not load finance requests.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (mayBeHere) void load();
        else setLoading(false);
    }, [mayBeHere, load]);

    const complain = (e: unknown, fallback: string) => {
        const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
        setError(typeof detail === "string" ? detail : fallback);
    };

    const act = async (id: string, fn: () => Promise<unknown>, fallback: string) => {
        setBusy(id);
        setError(null);
        try {
            await fn();
            await load();
        } catch (e) {
            complain(e, fallback);
        } finally {
            setBusy(null);
        }
    };

    const sendBack = async (r: FinanceRequest, to: "finance" | "director") => {
        const note = await dialog.prompt({
            title:
                to === "director"
                    ? `Send ${r.reference} back to the Director?`
                    : `Send ${r.reference} back to finance?`,
            body:
                to === "director"
                    ? "It returns to the Director's review, locked, with your reason on it."
                    : "It returns to Himawan to change, with your reason on it.",
            placeholder: "e.g. Please attach the BPJS invoice",
            multiline: true,
            required: true,
            tone: "danger",
        });
        if (!note) return;
        void act(r.id, () => financeService.sendBack(r.id, note, to), "Could not send it back.");
    };

    const mine = requests.filter((r) => r.awaiting && r.awaiting === user?.role);
    const shown = requests.filter((r) => showPaid || r.status !== "paid");

    if (user && !mayBeHere) return <Navigate to="/" replace />;

    return (
        <div className="dtg-fade-in space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Finance</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                        Finance requests
                    </h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        Petty cash, tax, BPJS and other payments. Prepared by finance, reviewed by
                        the Director and{" "}
                        {directorFinal ? "approved by the Director" : "approved by the CEO"} before
                        payment.
                    </p>
                </div>
                <div className="flex items-end gap-3">
                    <label className="flex items-center gap-2 text-xs text-paper-soft">
                        <input
                            type="checkbox"
                            checked={showPaid}
                            onChange={(e) => setShowPaid(e.target.checked)}
                            className="h-3.5 w-3.5 rounded border-white/20 bg-white/5"
                        />
                        Show paid
                    </label>
                    {canCreate && editing === null && (
                        <button onClick={() => setEditing("new")} className="dtg-btn-primary">
                            <Plus className="h-4 w-4" />
                            New request
                        </button>
                    )}
                </div>
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {mine.length > 0 && (
                <Alert tone="warning">
                    {mine.length} request{mine.length === 1 ? " is" : "s are"} waiting on your{" "}
                    {user?.role === "director" ? "review" : "approval"}.
                </Alert>
            )}

            {editing === "new" && (
                <Editor
                    onCancel={() => setEditing(null)}
                    onSaved={async () => {
                        setEditing(null);
                        await load();
                    }}
                    onError={complain}
                />
            )}

            {loading ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : shown.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center text-sm text-paper-soft">
                    {canCreate ? "No requests yet. Start one with New request." : "No requests yet."}
                </div>
            ) : (
                <div className="space-y-3">
                    {shown.map((r) =>
                        editing === r.id ? (
                            <Editor
                                key={r.id}
                                request={r}
                                onCancel={() => setEditing(null)}
                                onSaved={async () => {
                                    setEditing(null);
                                    await load();
                                }}
                                onError={complain}
                            />
                        ) : (
                            <RequestCard
                                key={r.id}
                                r={r}
                                role={user?.role}
                                open={open === r.id}
                                busy={busy === r.id}
                                directorFinal={directorFinal}
                                onToggle={() => setOpen(open === r.id ? null : r.id)}
                                onEdit={() => setEditing(r.id)}
                                onAct={act}
                                onSendBack={sendBack}
                                onView={(docId, filename, type) =>
                                    setViewing({
                                        src: financeService.documentUrl(r.id, docId),
                                        filename,
                                        type,
                                    })
                                }
                                confirm={dialog.confirm}
                            />
                        ),
                    )}
                </div>
            )}

            {viewing && (
                <DocumentViewer
                    src={viewing.src}
                    filename={viewing.filename}
                    contentType={viewing.type}
                    onClose={() => setViewing(null)}
                />
            )}
        </div>
    );
}

/** One request: the summary line, and everything else when opened. */
function RequestCard({
    r,
    role,
    open,
    busy,
    directorFinal,
    onToggle,
    onEdit,
    onAct,
    onSendBack,
    onView,
    confirm,
}: {
    r: FinanceRequest;
    role: string | undefined;
    open: boolean;
    busy: boolean;
    directorFinal: boolean;
    onToggle: () => void;
    onEdit: () => void;
    onAct: (id: string, fn: () => Promise<unknown>, fallback: string) => Promise<void>;
    onSendBack: (r: FinanceRequest, to: "finance" | "director") => Promise<void>;
    onView: (documentId: string, filename: string, type: string) => void;
    confirm: ReturnType<typeof useDialog>["confirm"];
}) {
    const isFinance = role === "finance";
    const myTurn = r.awaiting !== null && r.awaiting === role;
    const style = STATUS[r.status];
    const fileInput = useRef<HTMLInputElement>(null);
    const [paidOn, setPaidOn] = useState(todayISO());
    const [paidNote, setPaidNote] = useState("");

    const overdue =
        r.due_date !== null && r.status !== "paid" && r.due_date < todayISO();

    const byCategory = useMemo(() => {
        const sums = new Map<FinanceCategory, number>();
        for (const item of r.items) sums.set(item.category, (sums.get(item.category) ?? 0) + item.amount);
        return [...sums.entries()];
    }, [r.items]);

    return (
        <article className={`dtg-panel overflow-hidden ${myTurn ? "ring-1 ring-signal/30" : ""}`}>
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full flex-wrap items-center justify-between gap-4 px-5 py-3.5 text-left transition hover:bg-white/[0.03]"
            >
                <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-paper">
                        <span className="font-mono text-micro text-muted">{r.reference}</span>
                        {r.title}
                        <span
                            className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${style.cls}`}
                        >
                            {style.label}
                        </span>
                    </p>
                    <p className="mt-0.5 text-micro text-muted">
                        {r.requested_by_name ?? "Finance"}
                        {r.due_date && (
                            <span className={overdue ? "text-danger" : ""}>
                                {" · "}due {longDate(r.due_date)}
                                {overdue && " (overdue)"}
                            </span>
                        )}
                        {r.documents.length > 0 &&
                            ` · ${r.documents.length} attachment${r.documents.length === 1 ? "" : "s"}`}
                    </p>
                </div>
                <p className="font-mono text-lg font-bold text-paper">{money(r.total)}</p>
            </button>

            {open && (
                <div className="space-y-4 border-t border-white/[0.08] px-5 py-4">
                    {r.revision_note &&
                        (r.status === "changes_requested" || r.status === "submitted") && (
                            <Alert tone="danger">
                                <span className="font-semibold">
                                    Sent back
                                    {r.status === "submitted" ? " to the Director" : ""}
                                    {r.revision_by_name ? ` by ${r.revision_by_name}` : ""}:
                                </span>{" "}
                                {r.revision_note}
                            </Alert>
                        )}

                    {/* The items, and the total by category. */}
                    <table className="w-full text-left text-xs">
                        <thead className="text-micro uppercase tracking-label text-muted">
                            <tr className="border-b border-white/[0.08]">
                                <th className="py-1.5 pr-3 font-semibold">Category</th>
                                <th className="py-1.5 pr-3 font-semibold">Description</th>
                                <th className="py-1.5 text-right font-semibold">Amount</th>
                            </tr>
                        </thead>
                        <tbody className="text-paper-soft">
                            {r.items.map((item, i) => (
                                <tr key={item.id ?? i} className="border-b border-white/[0.04]">
                                    <td className="py-1.5 pr-3 text-muted">
                                        {CATEGORY_LABELS[item.category]}
                                    </td>
                                    <td className="py-1.5 pr-3">{item.description}</td>
                                    <td className="py-1.5 text-right font-mono">{money(item.amount)}</td>
                                </tr>
                            ))}
                            <tr className="font-bold text-paper">
                                <td className="pt-2 pr-3" colSpan={2}>
                                    Total
                                </td>
                                <td className="pt-2 text-right font-mono">{money(r.total)}</td>
                            </tr>
                        </tbody>
                    </table>
                    {byCategory.length > 1 && (
                        <p className="text-micro text-muted">
                            {byCategory
                                .map(([cat, sum]) => `${CATEGORY_LABELS[cat]} ${money(sum)}`)
                                .join(" · ")}
                        </p>
                    )}

                    {r.notes && <p className="text-xs leading-relaxed text-paper-soft">{r.notes}</p>}

                    {/* Attachments. */}
                    <div>
                        <p className="dtg-eyebrow">Attachments</p>
                        <ul className="mt-1.5 space-y-1">
                            {r.documents.length === 0 && (
                                <li className="text-micro text-muted">None attached.</li>
                            )}
                            {r.documents.map((d) => (
                                <li key={d.id} className="flex items-center gap-2 text-xs">
                                    <FileText className="h-3.5 w-3.5 text-muted" />
                                    <button
                                        type="button"
                                        onClick={() => onView(d.id, d.filename, d.content_type)}
                                        className="text-teal-200 underline-offset-2 hover:underline"
                                    >
                                        {d.filename}
                                    </button>
                                    <span className="text-micro text-muted">
                                        {Math.max(1, Math.round(d.byte_size / 1024))} KB
                                    </span>
                                    {isFinance && r.is_editable && (
                                        <button
                                            type="button"
                                            aria-label={`Remove ${d.filename}`}
                                            onClick={() =>
                                                void onAct(
                                                    r.id,
                                                    () => financeService.removeDocument(r.id, d.id),
                                                    "Could not remove the attachment.",
                                                )
                                            }
                                            className="text-muted transition hover:text-danger"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                        {isFinance && (
                            <>
                                <input
                                    ref={fileInput}
                                    type="file"
                                    accept=".pdf,image/*,.doc,.docx"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        e.target.value = "";
                                        if (file)
                                            void onAct(
                                                r.id,
                                                () => financeService.upload(r.id, file),
                                                "Could not attach that file.",
                                            );
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={() => fileInput.current?.click()}
                                    className="dtg-btn-ghost mt-2 px-3 py-1.5 text-xs"
                                >
                                    <Paperclip className="h-3.5 w-3.5" />
                                    Attach invoice or receipt
                                </button>
                            </>
                        )}
                    </div>

                    {/* The trail, in plain words. */}
                    <ul className="space-y-0.5 text-micro text-muted">
                        {r.submitted_at && <li>Sent for review {longDate(r.submitted_at)}</li>}
                        {r.reviewed_at && (
                            <li>
                                Reviewed by {r.reviewed_by_name} {longDate(r.reviewed_at)}
                            </li>
                        )}
                        {r.approved_at && (
                            <li>
                                Approved by {r.approved_by_name} {longDate(r.approved_at)}
                            </li>
                        )}
                        {r.paid_on && (
                            <li>
                                Paid {longDate(r.paid_on)}
                                {r.payment_note ? ` — ${r.payment_note}` : ""}
                            </li>
                        )}
                    </ul>

                    {/* Only the buttons that will work. */}
                    <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                        {isFinance && r.is_editable && (
                            <>
                                <button
                                    disabled={busy}
                                    onClick={() =>
                                        void onAct(r.id, () => financeService.submit(r.id), "Could not send it.")
                                    }
                                    className="dtg-btn-primary px-3 py-1.5 text-xs"
                                >
                                    <Send className="h-3.5 w-3.5" />
                                    Send for review
                                </button>
                                <button onClick={onEdit} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                                    Edit
                                </button>
                                {r.status === "draft" && (
                                    <button
                                        disabled={busy}
                                        onClick={async () => {
                                            const ok = await confirm({
                                                title: `Discard ${r.reference}?`,
                                                body: "The draft and its attachments are deleted.",
                                                confirmLabel: "Discard",
                                                tone: "danger",
                                            });
                                            if (ok)
                                                void onAct(
                                                    r.id,
                                                    () => financeService.remove(r.id),
                                                    "Could not discard it.",
                                                );
                                        }}
                                        className="dtg-btn-ghost px-3 py-1.5 text-xs text-danger"
                                    >
                                        Discard
                                    </button>
                                )}
                            </>
                        )}

                        {myTurn && role === "director" && (
                            <>
                                <button
                                    disabled={busy}
                                    onClick={() =>
                                        void onAct(r.id, () => financeService.review(r.id), "Could not review it.")
                                    }
                                    className="dtg-btn-primary px-3 py-1.5 text-xs"
                                >
                                    <Check className="h-3.5 w-3.5" />
                                    {directorFinal ? "Review and approve" : "Reviewed, pass to CEO"}
                                </button>
                                <button
                                    onClick={() => void onSendBack(r, "finance")}
                                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                >
                                    <CornerUpLeft className="h-3.5 w-3.5" />
                                    Send back
                                </button>
                            </>
                        )}

                        {myTurn && role === "executive" && (
                            <button
                                disabled={busy}
                                onClick={() =>
                                    void onAct(r.id, () => financeService.approve(r.id), "Could not approve it.")
                                }
                                className="dtg-btn-primary px-3 py-1.5 text-xs"
                            >
                                <Check className="h-3.5 w-3.5" />
                                Approve
                            </button>
                        )}
                        {role === "executive" && (myTurn || r.status === "approved") && (
                            <>
                                <button
                                    onClick={() => void onSendBack(r, "director")}
                                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                >
                                    <CornerUpLeft className="h-3.5 w-3.5" />
                                    Back to Director
                                </button>
                                <button
                                    onClick={() => void onSendBack(r, "finance")}
                                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                >
                                    <CornerUpLeft className="h-3.5 w-3.5" />
                                    Back to Finance
                                </button>
                            </>
                        )}
                        {role === "director" && r.status === "approved" && (
                            <button
                                onClick={() => void onSendBack(r, "finance")}
                                className="dtg-btn-secondary px-3 py-1.5 text-xs"
                            >
                                <CornerUpLeft className="h-3.5 w-3.5" />
                                Reopen
                            </button>
                        )}

                        {isFinance && r.status === "approved" && (
                            <div className="flex flex-wrap items-end gap-2">
                                <label className="block">
                                    <span className="dtg-eyebrow">Paid on</span>
                                    <input
                                        type="date"
                                        value={paidOn}
                                        onChange={(e) => setPaidOn(e.target.value)}
                                        className="dtg-input mt-1 py-1.5 text-xs"
                                    />
                                </label>
                                <label className="block">
                                    <span className="dtg-eyebrow">Transfer reference</span>
                                    <input
                                        value={paidNote}
                                        onChange={(e) => setPaidNote(e.target.value)}
                                        placeholder="Optional"
                                        className="dtg-input mt-1 py-1.5 text-xs"
                                    />
                                </label>
                                <button
                                    disabled={busy || !paidOn}
                                    onClick={() =>
                                        void onAct(
                                            r.id,
                                            () => financeService.markPaid(r.id, paidOn, paidNote.trim() || null),
                                            "Could not mark it paid.",
                                        )
                                    }
                                    className="dtg-btn-primary px-3 py-1.5 text-xs"
                                >
                                    <Check className="h-3.5 w-3.5" />
                                    Mark as paid
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </article>
    );
}

/** Finance's form, for a new request or a draft being changed. */
function Editor({
    request,
    onCancel,
    onSaved,
    onError,
}: {
    request?: FinanceRequest;
    onCancel: () => void;
    onSaved: () => Promise<void>;
    onError: (e: unknown, fallback: string) => void;
}) {
    const [title, setTitle] = useState(request?.title ?? "");
    const [dueDate, setDueDate] = useState(request?.due_date ?? "");
    const [notes, setNotes] = useState(request?.notes ?? "");
    const [lines, setLines] = useState<Line[]>(
        request?.items.length
            ? request.items.map((i) => ({
                  category: i.category,
                  description: i.description,
                  amount: String(i.amount),
              }))
            : [blankLine()],
    );
    const [saving, setSaving] = useState(false);

    const total = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
    const ready =
        title.trim().length >= 3 &&
        lines.length > 0 &&
        lines.every((l) => l.description.trim() && Number(l.amount) > 0);

    const setLine = (i: number, patch: Partial<Line>) =>
        setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));

    const save = async () => {
        setSaving(true);
        const body = {
            title: title.trim(),
            notes: notes.trim() || null,
            due_date: dueDate || null,
            items: lines.map((l) => ({
                category: l.category,
                description: l.description.trim(),
                amount: Number(l.amount),
            })),
        };
        try {
            if (request) await financeService.update(request.id, body);
            else await financeService.create(body);
            await onSaved();
        } catch (e) {
            onError(e, "Could not save the request.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">{request ? request.reference : "New request"}</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">
                    {request ? "Edit request" : "Request a payment"}
                </h2>
            </header>

            <div className="space-y-4 p-5">
                <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                    <label className="block">
                        <span className="dtg-eyebrow">Title</span>
                        <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="e.g. October petty cash and statutory payments"
                            className="dtg-input mt-1.5 w-full"
                            maxLength={200}
                        />
                    </label>
                    <label className="block">
                        <span className="dtg-eyebrow">Due date</span>
                        <input
                            type="date"
                            value={dueDate}
                            onChange={(e) => setDueDate(e.target.value)}
                            className="dtg-input mt-1.5 w-full"
                        />
                    </label>
                </div>

                <div>
                    <p className="dtg-eyebrow">Items</p>
                    <div className="mt-1.5 space-y-2">
                        {lines.map((l, i) => (
                            <div key={i} className="grid gap-2 sm:grid-cols-[11rem_1fr_12rem_2rem]">
                                <select
                                    value={l.category}
                                    onChange={(e) =>
                                        setLine(i, { category: e.target.value as FinanceCategory })
                                    }
                                    className="dtg-input text-xs"
                                    aria-label="Category"
                                >
                                    {CATEGORIES.map((c) => (
                                        <option key={c} value={c} className="bg-surface">
                                            {CATEGORY_LABELS[c]}
                                        </option>
                                    ))}
                                </select>
                                <input
                                    value={l.description}
                                    onChange={(e) => setLine(i, { description: e.target.value })}
                                    placeholder="e.g. PPh 21, September"
                                    className="dtg-input text-xs"
                                    maxLength={300}
                                    aria-label="Description"
                                />
                                <MoneyInput
                                    value={l.amount}
                                    onChange={(raw) => setLine(i, { amount: raw })}
                                    className="dtg-input w-full text-xs"
                                />
                                <button
                                    type="button"
                                    disabled={lines.length === 1}
                                    onClick={() => setLines(lines.filter((_, n) => n !== i))}
                                    aria-label="Remove item"
                                    className="flex items-center justify-center text-muted transition hover:text-danger disabled:opacity-30"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            </div>
                        ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                        <button
                            type="button"
                            onClick={() => setLines([...lines, blankLine()])}
                            className="dtg-btn-ghost px-3 py-1.5 text-xs"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Add item
                        </button>
                        <p className="text-sm text-paper-soft">
                            Total <span className="ml-2 font-mono text-lg font-bold text-paper">{money(total)}</span>
                        </p>
                    </div>
                </div>

                <label className="block">
                    <span className="dtg-eyebrow">Notes</span>
                    <textarea
                        rows={2}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Anything the reviewer should know. Optional."
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>
                <p className="text-micro text-muted">
                    Invoices and receipts can be attached once the request is saved.
                </p>
            </div>

            <div className="flex gap-2 border-t border-white/[0.08] px-5 py-3">
                <button
                    disabled={!ready || saving}
                    onClick={() => void save()}
                    className="dtg-btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                >
                    {saving ? "Saving…" : "Save draft"}
                </button>
                <button onClick={onCancel} className="dtg-btn-ghost px-3 py-1.5 text-xs">
                    Cancel
                </button>
            </div>
        </section>
    );
}
