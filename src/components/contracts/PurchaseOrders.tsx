import { useCallback, useEffect, useState } from "react";

import {
    CURRENCIES,
    money,
    purchaseOrderService,
    type Contract,
    type PurchaseOrder,
    type PurchaseOrderFilters,
    type PurchaseOrderStatus,
} from "@/services/contractService";
import { useDialog } from "@/components/ui/Dialog";
import Alert from "@/components/ui/Alert";
import MoneyInput from "@/components/ui/MoneyInput";
import Spinner from "@/components/ui/Spinner";

/*
 * Client purchase orders.
 *
 * A PO usually sits under a client contract -- the account -- but a one-off
 * job can arrive on a PO alone, so the link is optional. What matters once
 * there are a few accounts is when each PO was issued and when it runs out,
 * so both dates are columns and either can be sorted on.
 */

export interface ViewDocument {
    src: string;
    filename: string;
    contentType: string;
}

const STATUSES: { key: PurchaseOrderStatus; label: string }[] = [
    { key: "active", label: "Active" },
    { key: "completed", label: "Completed" },
    { key: "cancelled", label: "Cancelled" },
];

function fmt(iso: string | null): string {
    if (!iso) return "—";
    return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

function detailOf(e: unknown, fallback: string): string {
    const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
    return typeof detail === "string" ? detail : fallback;
}

export default function PurchaseOrders({
    contracts,
    contractFilter,
    composeFor,
    onComposeHandled,
    highlight,
    onChanged,
    onView,
}: {
    /** Client contracts, for the link and the filter. */
    contracts: Contract[];
    /** Start filtered to this contract (from a contract's PO list). */
    contractFilter: string;
    /** Open the add form linked to this contract. */
    composeFor: string | null;
    onComposeHandled: () => void;
    /** A PO to scroll to and mark, from the "Coming up" panel. */
    highlight: string | null;
    /** Something changed: the contracts and "Coming up" reload. */
    onChanged: () => void;
    onView: (doc: ViewDocument) => void;
}) {
    const { confirm } = useDialog();
    const [filters, setFilters] = useState<PurchaseOrderFilters>({
        sort: "po_date",
        contract_id: contractFilter || undefined,
    });
    const [rows, setRows] = useState<PurchaseOrder[]>([]);
    const [canManage, setCanManage] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<PurchaseOrder | "new" | null>(null);
    const [linkTo, setLinkTo] = useState<string>("");

    useEffect(() => {
        setFilters((f) => ({ ...f, contract_id: contractFilter || undefined }));
    }, [contractFilter]);

    useEffect(() => {
        if (composeFor !== null) {
            setLinkTo(composeFor);
            setEditing("new");
            onComposeHandled();
        }
    }, [composeFor, onComposeHandled]);

    const load = useCallback(async () => {
        try {
            const res = await purchaseOrderService.list(filters);
            setRows(res.data.items);
            setCanManage(res.data.can_manage);
        } catch (e) {
            setError(detailOf(e, "Could not load purchase orders."));
        } finally {
            setLoading(false);
        }
    }, [filters]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (!highlight || loading) return;
        document.getElementById(`po-${highlight}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [highlight, loading, rows]);

    const act = async (key: string, fn: () => Promise<unknown>) => {
        setBusy(key);
        setError(null);
        try {
            await fn();
            await load();
            onChanged();
        } catch (e) {
            setError(detailOf(e, "That did not go through."));
        } finally {
            setBusy(null);
        }
    };

    const set = (k: keyof PurchaseOrderFilters, v: string) =>
        setFilters((f) => ({ ...f, [k]: v || undefined }));

    return (
        <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}

            {/* ── Filters ───────────────────────────────────────────────── */}
            <div className="dtg-panel grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
                <label className="block">
                    <span className="dtg-eyebrow">Client</span>
                    <input
                        value={filters.client ?? ""}
                        onChange={(e) => set("client", e.target.value)}
                        placeholder="Any"
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>
                <label className="block">
                    <span className="dtg-eyebrow">Contract</span>
                    <select
                        value={filters.contract_id ?? ""}
                        onChange={(e) => set("contract_id", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    >
                        <option value="">Any</option>
                        {contracts.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.title}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block">
                    <span className="dtg-eyebrow">Status</span>
                    <select
                        value={filters.status ?? ""}
                        onChange={(e) => set("status", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    >
                        <option value="">Any</option>
                        {STATUSES.map((s) => (
                            <option key={s.key} value={s.key}>
                                {s.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block">
                    <span className="dtg-eyebrow">PO date from</span>
                    <input
                        type="date"
                        value={filters.from ?? ""}
                        onChange={(e) => set("from", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>
                <label className="block">
                    <span className="dtg-eyebrow">PO date to</span>
                    <input
                        type="date"
                        value={filters.to ?? ""}
                        onChange={(e) => set("to", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>
                <label className="block">
                    <span className="dtg-eyebrow">Sort by</span>
                    <select
                        value={filters.sort ?? "po_date"}
                        onChange={(e) => set("sort", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    >
                        <option value="po_date">PO date, newest first</option>
                        <option value="end_date">End date, soonest first</option>
                    </select>
                </label>
            </div>

            {canManage && editing === null && (
                <div>
                    <button
                        onClick={() => {
                            setLinkTo(filters.contract_id ?? "");
                            setEditing("new");
                        }}
                        className="dtg-btn-primary px-4 py-2 text-sm"
                    >
                        New PO
                    </button>
                </div>
            )}

            {editing !== null && canManage && (
                <PoForm
                    key={editing === "new" ? `new-${linkTo}` : editing.id}
                    po={editing === "new" ? null : editing}
                    linkTo={linkTo}
                    contracts={contracts}
                    onCancel={() => setEditing(null)}
                    onDone={async () => {
                        setEditing(null);
                        await load();
                        onChanged();
                    }}
                    onError={setError}
                />
            )}

            {/* ── The table ─────────────────────────────────────────────── */}
            {loading ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : rows.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center">
                    <p className="text-sm text-paper-soft">No purchase orders match.</p>
                </div>
            ) : (
                <div className="dtg-panel overflow-x-auto">
                    <table className="w-full min-w-[56rem] text-left text-xs">
                        <thead className="text-micro uppercase tracking-label text-muted">
                            <tr className="border-b border-white/[0.08]">
                                <th className="px-4 py-2.5 font-semibold">PO number</th>
                                <th className="px-3 py-2.5 font-semibold">Client</th>
                                <th className="px-3 py-2.5 font-semibold">Contract</th>
                                <th className="px-3 py-2.5 font-semibold">PO date</th>
                                <th className="px-3 py-2.5 font-semibold">Ends</th>
                                <th className="px-3 py-2.5 text-right font-semibold">Value</th>
                                <th className="px-3 py-2.5 font-semibold">Status</th>
                                <th className="px-3 py-2.5 font-semibold">Documents</th>
                                {canManage && <th className="px-4 py-2.5" />}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((p) => (
                                <tr
                                    key={p.id}
                                    id={`po-${p.id}`}
                                    className={`border-b border-white/[0.04] align-top ${
                                        highlight === p.id ? "bg-gold/[0.07]" : ""
                                    }`}
                                >
                                    <td className="px-4 py-3">
                                        <p className="font-mono font-semibold text-paper">{p.po_number}</p>
                                        {p.description && (
                                            <p className="mt-0.5 max-w-[14rem] text-micro text-muted">
                                                {p.description}
                                            </p>
                                        )}
                                    </td>
                                    <td className="px-3 py-3 text-paper-soft">{p.client_name}</td>
                                    <td className="px-3 py-3 text-paper-soft">{p.contract_title ?? "—"}</td>
                                    <td className="px-3 py-3 font-mono text-paper-soft">{fmt(p.po_date)}</td>
                                    <td className="px-3 py-3">
                                        <span className="font-mono text-paper-soft">{fmt(p.end_date)}</span>
                                        {p.status === "active" && p.days_remaining !== null && (
                                            <span
                                                className={`mt-0.5 block text-micro ${
                                                    p.days_remaining < 0
                                                        ? "text-danger"
                                                        : p.days_remaining <= 60
                                                          ? "text-gold"
                                                          : "text-muted"
                                                }`}
                                            >
                                                {p.days_remaining < 0
                                                    ? `ended ${Math.abs(p.days_remaining)} days ago`
                                                    : `${p.days_remaining} days left`}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-3 py-3 text-right font-mono text-paper-soft">
                                        {p.value !== null ? money(p.value, p.currency) : "—"}
                                    </td>
                                    <td className="px-3 py-3">
                                        <span
                                            className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${
                                                p.status === "active"
                                                    ? "border-signal/30 bg-signal/10 text-signal"
                                                    : "border-white/15 bg-white/[0.04] text-muted"
                                            }`}
                                        >
                                            {p.status}
                                        </span>
                                    </td>
                                    <td className="px-3 py-3">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            {p.documents.map((d) => (
                                                <span key={d.id} className="flex items-center">
                                                    <button
                                                        onClick={() =>
                                                            onView({
                                                                src: `/purchase-orders/${p.id}/documents/${d.id}`,
                                                                filename: d.filename,
                                                                contentType: d.content_type,
                                                            })
                                                        }
                                                        className="max-w-[10rem] truncate rounded border border-white/10 bg-white/[0.03] px-2 py-0.5 text-micro text-teal-200 hover:bg-white/[0.07]"
                                                        title={d.filename}
                                                    >
                                                        {d.filename}
                                                    </button>
                                                    {canManage && (
                                                        <button
                                                            onClick={async () => {
                                                                const ok = await confirm({
                                                                    title: "Remove this document?",
                                                                    body: `${d.filename} will be deleted from PO ${p.po_number}. This cannot be undone.`,
                                                                    confirmLabel: "Remove",
                                                                    tone: "danger",
                                                                });
                                                                if (!ok) return;
                                                                void act(d.id, () =>
                                                                    purchaseOrderService.removeDocument(p.id, d.id),
                                                                );
                                                            }}
                                                            className="px-1 text-micro text-muted hover:text-danger"
                                                            aria-label={`Remove ${d.filename}`}
                                                        >
                                                            ×
                                                        </button>
                                                    )}
                                                </span>
                                            ))}
                                            {canManage && (
                                                <label className="cursor-pointer rounded border border-dashed border-white/15 px-2 py-0.5 text-micro text-muted hover:border-signal/40 hover:text-paper-soft">
                                                    {busy === p.id ? "…" : "Attach"}
                                                    <input
                                                        type="file"
                                                        accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                                        className="hidden"
                                                        onChange={(e) => {
                                                            const file = e.target.files?.[0];
                                                            e.target.value = "";
                                                            if (!file) return;
                                                            void act(p.id, () =>
                                                                purchaseOrderService.uploadDocument(p.id, file),
                                                            );
                                                        }}
                                                    />
                                                </label>
                                            )}
                                            {!canManage && p.documents.length === 0 && (
                                                <span className="text-micro text-muted">—</span>
                                            )}
                                        </div>
                                    </td>
                                    {canManage && (
                                        <td className="whitespace-nowrap px-4 py-3 text-right">
                                            <button
                                                onClick={() => setEditing(p)}
                                                className="dtg-btn-ghost px-2.5 py-1 text-micro"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                disabled={busy === p.id}
                                                onClick={async () => {
                                                    const ok = await confirm({
                                                        title: `Delete PO ${p.po_number}?`,
                                                        body: "Its documents go with it. To close a PO that has simply been delivered, mark it completed instead.",
                                                        confirmLabel: "Delete PO",
                                                        tone: "danger",
                                                    });
                                                    if (!ok) return;
                                                    void act(p.id, () => purchaseOrderService.remove(p.id));
                                                }}
                                                className="dtg-btn-ghost ml-1 px-2.5 py-1 text-micro text-danger"
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

/** Add or edit a PO; files picked here are attached once it is saved. */
function PoForm({
    po,
    linkTo,
    contracts,
    onCancel,
    onDone,
    onError,
}: {
    po: PurchaseOrder | null;
    linkTo: string;
    contracts: Contract[];
    onCancel: () => void;
    onDone: () => Promise<void>;
    onError: (m: string) => void;
}) {
    const initialContract = po ? (po.contract_id ?? "") : linkTo;
    const linked = contracts.find((c) => c.id === initialContract);
    const [form, setForm] = useState({
        contract_id: initialContract,
        po_number: po?.po_number ?? "",
        client_name: po?.client_name ?? "",
        description: po?.description ?? "",
        po_date: po?.po_date ?? "",
        start_date: po?.start_date ?? "",
        end_date: po?.end_date ?? "",
        value: po?.value !== null && po?.value !== undefined ? String(po.value) : "",
        currency: po?.currency ?? linked?.currency ?? "IDR",
        status: po?.status ?? ("active" as PurchaseOrderStatus),
        notes: po?.notes ?? "",
    });
    const [files, setFiles] = useState<File[]>([]);
    const [saving, setSaving] = useState(false);

    const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
    const contract = contracts.find((c) => c.id === form.contract_id);
    const clientHint = contract ? contract.counterparty || contract.title : "PT Harmony";

    const submit = async () => {
        setSaving(true);
        try {
            const body = {
                contract_id: form.contract_id || null,
                po_number: form.po_number,
                client_name: form.client_name || null,
                description: form.description || null,
                po_date: form.po_date,
                start_date: form.start_date || null,
                end_date: form.end_date || null,
                value: form.value ? Number(form.value) : null,
                currency: form.currency,
                status: form.status,
                notes: form.notes || null,
            };
            const saved = po
                ? await purchaseOrderService.update(po.id, body)
                : await purchaseOrderService.create(body);
            for (const file of files) {
                await purchaseOrderService.uploadDocument(saved.data.id, file);
            }
            await onDone();
        } catch (e) {
            onError(detailOf(e, "Check the PO number and dates and try again."));
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">{po ? "Edit purchase order" : "New purchase order"}</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">
                    {po ? po.po_number : "A client's PO"}
                </h2>
            </header>

            <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
                <label className="block">
                    <span className="dtg-eyebrow">Under contract</span>
                    <select
                        value={form.contract_id}
                        onChange={(e) => {
                            const c = contracts.find((x) => x.id === e.target.value);
                            setForm((f) => ({
                                ...f,
                                contract_id: e.target.value,
                                currency: !po && c ? c.currency : f.currency,
                            }));
                        }}
                        className="dtg-input mt-1.5 w-full"
                    >
                        <option value="">None — a PO on its own</option>
                        {contracts.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.title}
                                {c.counterparty ? ` (${c.counterparty})` : ""}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">PO number</span>
                    <input
                        value={form.po_number}
                        onChange={(e) => set("po_number", e.target.value)}
                        placeholder="4500123"
                        className="dtg-input mt-1.5 w-full font-mono"
                    />
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">Client</span>
                    <input
                        value={form.client_name}
                        onChange={(e) => set("client_name", e.target.value)}
                        placeholder={clientHint}
                        className="dtg-input mt-1.5 w-full"
                    />
                    {contract && !form.client_name && (
                        <span className="mt-1 block text-micro text-muted">
                            Left empty, it is the contract's client.
                        </span>
                    )}
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">PO date (issued)</span>
                    <input
                        type="date"
                        value={form.po_date}
                        onChange={(e) => set("po_date", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">Covers from</span>
                    <input
                        type="date"
                        value={form.start_date}
                        onChange={(e) => set("start_date", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">Ends</span>
                    <input
                        type="date"
                        value={form.end_date}
                        onChange={(e) => set("end_date", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">Value</span>
                    <div className="mt-1.5 flex gap-2">
                        <select
                            value={form.currency}
                            onChange={(e) => set("currency", e.target.value)}
                            className="dtg-input w-24 flex-shrink-0 font-mono"
                        >
                            {CURRENCIES.map((cur) => (
                                <option key={cur} value={cur}>
                                    {cur}
                                </option>
                            ))}
                        </select>
                        <div className="w-full">
                            <MoneyInput
                                value={form.value}
                                onChange={(raw) => set("value", raw)}
                                prefix={null}
                                allowDecimals
                                className="dtg-input w-full"
                            />
                        </div>
                    </div>
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">Status</span>
                    <select
                        value={form.status}
                        onChange={(e) => set("status", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    >
                        {STATUSES.map((s) => (
                            <option key={s.key} value={s.key}>
                                {s.label}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="block sm:col-span-2">
                    <span className="dtg-eyebrow">Description</span>
                    <input
                        value={form.description}
                        onChange={(e) => set("description", e.target.value)}
                        placeholder="Monitoring services, Q4"
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>

                <label className="block sm:col-span-2">
                    <span className="dtg-eyebrow">Notes</span>
                    <textarea
                        rows={2}
                        value={form.notes}
                        onChange={(e) => set("notes", e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>

                <label className="block sm:col-span-2">
                    <span className="dtg-eyebrow">Attach the PO</span>
                    <input
                        type="file"
                        multiple
                        accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                        onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                        className="mt-1.5 block w-full text-xs text-paper-soft"
                    />
                    <span className="mt-1 block text-micro text-muted">
                        PDF, image or Word, up to 10 MB each.
                    </span>
                </label>
            </div>

            <div className="flex gap-2 border-t border-white/[0.08] px-5 py-3">
                <button
                    disabled={
                        !form.po_number.trim() ||
                        !form.po_date ||
                        (!form.client_name.trim() && !form.contract_id) ||
                        saving
                    }
                    onClick={() => void submit()}
                    className="dtg-btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                >
                    {saving ? "Saving…" : po ? "Save PO" : "Add PO"}
                </button>
                <button onClick={onCancel} className="dtg-btn-ghost px-3 py-1.5 text-xs">
                    Cancel
                </button>
            </div>
        </section>
    );
}
