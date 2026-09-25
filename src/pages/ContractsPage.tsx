import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
import { employeeService } from "@/services/employeeService";
import {
    CURRENCIES,
    contractService,
    describeLeadTime,
    money,
    type Contract,
    type ContractKind,
} from "@/services/contractService";
import DocumentViewer from "@/components/contracts/DocumentViewer";
import { useDialog } from "@/components/ui/Dialog";
import type { Employee } from "@/types/employee";
import Alert from "@/components/ui/Alert";
import MoneyInput from "@/components/ui/MoneyInput";
import Spinner from "@/components/ui/Spinner";

/*
 * Contracts, in three drawers.
 *
 * Manpower, subscriptions and clients are the same shape — a counterparty, an
 * end date, a value — so they share a table and are split here, where the
 * split is what somebody actually wants: "show me what we pay for" is a
 * different morning from "show me who is up for renewal".
 *
 * The reminders are the point of the page. A contract that lapses because
 * nobody was watching costs more than any feature here saves, so each warning
 * has to be acknowledged by name rather than dismissed — and a client renewal
 * gets chased at two months, six weeks and one month, because agreeing one
 * with Telfer or FMI is a negotiation, not a signature.
 */

const TABS: { key: ContractKind; label: string; blurb: string }[] = [
    {
        key: "manpower",
        label: "Manpower",
        blurb: "Employment contracts and their end dates.",
    },
    {
        key: "subscription",
        label: "Subscriptions",
        blurb: "Tools the company pays for, and what they cost.",
    },
    {
        key: "client",
        label: "Clients",
        blurb: "Work we are contracted to deliver. Chased earliest.",
    },
];

function fmt(iso: string): string {
    return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

export default function ContractsPage() {
    const { user } = useAuth();
    const { confirm, prompt } = useDialog();
    const mayBeHere =
        Boolean(user?.is_management) ||
        Boolean(user?.is_superuser) ||
        Boolean(user?.can_manage_contracts) ||
        user?.role === "director" ||
        user?.role === "executive";

    const [rows, setRows] = useState<Contract[]>([]);
    const [canManage, setCanManage] = useState(false);
    const [people, setPeople] = useState<Employee[]>([]);
    const [tab, setTab] = useState<ContractKind>("manpower");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [composing, setComposing] = useState(false);
    const [viewing, setViewing] = useState<{
        contractId: string;
        documentId: string;
        filename: string;
        contentType: string;
    } | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await contractService.list();
            setRows(res.data.items);
            setCanManage(res.data.can_manage);
            if (res.data.can_manage) {
                const emps = await employeeService.list({ page: 1, page_size: 100 });
                setPeople(emps.data.items.filter((e) => e.is_active));
            }
        } catch {
            setError("Could not load contracts.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (mayBeHere) void load();
        else setLoading(false);
    }, [mayBeHere, load]);

    const act = async (key: string, fn: () => Promise<unknown>) => {
        setBusy(key);
        setError(null);
        try {
            await fn();
            await load();
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data
                ?.detail;
            setError(typeof detail === "string" ? detail : "That did not go through.");
        } finally {
            setBusy(null);
        }
    };

    /* Everything waiting on somebody, whichever drawer it is in. A warning
       you only see after picking the right tab is a warning you will miss. */
    const due = useMemo(
        () =>
            rows
                .flatMap((c) => c.reminders.filter((r) => r.is_due).map((r) => ({ c, r })))
                .sort((a, b) => a.c.days_remaining - b.c.days_remaining),
        [rows],
    );

    const shown = rows.filter((c) => c.kind === tab);

    if (user && !mayBeHere) return <Navigate to="/" replace />;

    return (
        <div className="dtg-fade-in space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Commitments</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                        Contracts
                    </h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        Manpower, subscriptions and clients, each with its own warning schedule.
                        A warning stays up until somebody acknowledges it.
                    </p>
                </div>
                {canManage && !composing && (
                    <button
                        onClick={() => setComposing(true)}
                        className="dtg-btn-primary px-4 py-2 text-sm"
                    >
                        New contract
                    </button>
                )}
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {/* ── What needs acknowledging ───────────────────────────────── */}
            {due.length > 0 && (
                <section className="dtg-panel overflow-hidden ring-1 ring-gold/30">
                    <header className="border-b border-white/[0.08] px-5 py-3.5">
                        <p className="dtg-eyebrow text-gold">Needs acknowledging</p>
                        <h2 className="mt-0.5 text-sm font-semibold text-paper">
                            {due.length} warning{due.length === 1 ? "" : "s"} waiting
                        </h2>
                    </header>
                    <ul className="divide-y divide-white/[0.06]">
                        {due.map(({ c, r }) => (
                            <li
                                key={r.id}
                                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                            >
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-paper">
                                        {c.title}
                                        <span className="ml-2 font-normal text-micro uppercase tracking-label text-muted">
                                            {c.kind}
                                        </span>
                                    </p>
                                    <p className="mt-0.5 text-xs text-paper-soft">
                                        Ends {fmt(c.end_date)} ·{" "}
                                        <span
                                            className={
                                                c.days_remaining < 0 ? "text-danger" : "text-gold"
                                            }
                                        >
                                            {c.days_remaining < 0
                                                ? `${Math.abs(c.days_remaining)} days ago`
                                                : `in ${c.days_remaining} days`}
                                        </span>{" "}
                                        · {describeLeadTime(r.days_before)} warning
                                    </p>
                                </div>
                                {canManage && (
                                    <button
                                        disabled={busy === r.id}
                                        onClick={async () => {
                                            const note = await prompt({
                                                title: `Acknowledge the ${describeLeadTime(r.days_before)} warning`,
                                                body: (
                                                    <>
                                                        <span className="font-semibold text-paper">
                                                            {c.title}
                                                        </span>{" "}
                                                        ends {fmt(c.end_date)}. Acknowledging it
                                                        takes it off the list and records who did
                                                        so.
                                                    </>
                                                ),
                                                label: "What is being done",
                                                placeholder: "Renewal sent to their procurement",
                                                multiline: true,
                                                confirmLabel: "Acknowledge",
                                            });
                                            if (note === null) return;
                                            void act(r.id, () =>
                                                contractService.acknowledge(
                                                    c.id,
                                                    r.id,
                                                    note || undefined,
                                                ),
                                            );
                                        }}
                                        className="dtg-btn-primary flex-shrink-0 px-3 py-1.5 text-xs"
                                    >
                                        Acknowledge
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* ── The three drawers ──────────────────────────────────────── */}
            <div className="flex flex-wrap gap-2">
                {TABS.map((t) => {
                    const count = rows.filter((c) => c.kind === t.key).length;
                    const waiting = rows
                        .filter((c) => c.kind === t.key)
                        .reduce((n, c) => n + c.open_reminders, 0);
                    return (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`rounded-lg border px-4 py-2.5 text-left transition-colors ${
                                tab === t.key
                                    ? "border-signal/50 bg-signal/10"
                                    : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                            }`}
                        >
                            <span className="flex items-center gap-2 text-sm font-semibold text-paper">
                                {t.label}
                                <span className="font-mono text-micro text-muted">{count}</span>
                                {waiting > 0 && (
                                    <span className="rounded-full bg-gold/20 px-1.5 font-mono text-micro text-gold">
                                        {waiting}
                                    </span>
                                )}
                            </span>
                            <span className="mt-0.5 block text-micro text-muted">{t.blurb}</span>
                        </button>
                    );
                })}
            </div>

            {composing && canManage && (
                <NewContract
                    kind={tab}
                    people={people}
                    onCancel={() => setComposing(false)}
                    onDone={async () => {
                        setComposing(false);
                        await load();
                    }}
                    onError={setError}
                />
            )}

            {loading ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : shown.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center">
                    <p className="text-sm text-paper-soft">
                        No {TABS.find((t) => t.key === tab)?.label.toLowerCase()} contracts yet.
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {shown.map((c) => (
                        <article key={c.id} className="dtg-panel overflow-hidden">
                            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-paper">{c.title}</p>
                                    <p className="mt-0.5 text-xs text-muted">
                                        {c.counterparty ? `${c.counterparty} · ` : ""}
                                        {c.start_date ? `${fmt(c.start_date)} — ` : "ends "}
                                        {fmt(c.end_date)}
                                    </p>
                                </div>
                                <div className="flex items-center gap-3">
                                    {c.amount !== null && (
                                        <span className="font-mono text-sm text-paper-soft">
                                            {money(c.amount, c.currency)}
                                            {c.billing_period ? ` / ${c.billing_period}` : ""}
                                        </span>
                                    )}
                                    <span
                                        className={`rounded-full border px-2.5 py-1 text-micro font-semibold uppercase tracking-label ${
                                            c.status !== "active"
                                                ? "border-white/15 bg-white/[0.04] text-muted"
                                                : c.days_remaining < 0
                                                  ? "border-danger/40 bg-danger/10 text-danger"
                                                  : c.days_remaining <= 60
                                                    ? "border-gold/30 bg-gold/10 text-gold"
                                                    : "border-signal/30 bg-signal/10 text-signal"
                                        }`}
                                    >
                                        {c.status !== "active"
                                            ? c.status
                                            : c.days_remaining < 0
                                              ? "expired"
                                              : `${c.days_remaining} days left`}
                                    </span>
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
                                {c.reminders.map((r) => (
                                    <span
                                        key={r.id}
                                        className="flex items-center gap-1.5 text-micro"
                                        title={
                                            r.acknowledged_at
                                                ? `Acknowledged${r.acknowledgement_note ? `: ${r.acknowledgement_note}` : ""}`
                                                : `Due ${fmt(r.due_on)}`
                                        }
                                    >
                                        <span
                                            className={`h-1.5 w-1.5 rounded-full ${
                                                r.is_due
                                                    ? "bg-gold"
                                                    : r.acknowledged_at
                                                      ? "bg-signal"
                                                      : "bg-white/20"
                                            }`}
                                        />
                                        <span
                                            className={
                                                r.is_due
                                                    ? "text-gold"
                                                    : r.acknowledged_at
                                                      ? "text-muted line-through"
                                                      : "text-muted"
                                            }
                                        >
                                            {describeLeadTime(r.days_before)}
                                        </span>
                                    </span>
                                ))}
                                {c.notes && (
                                    <span className="text-micro text-muted">· {c.notes}</span>
                                )}
                            </div>

                            {/* The signed document, so tracking a contract does
                                not mean finding the email it arrived in.
                                Client contracts only: an employment contract
                                belongs in the personnel file, and a
                                subscription is a receipt rather than an
                                agreement anybody reads again. */}
                            {c.kind === "client" && (
                            <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] px-5 py-3">
                                {c.documents.length === 0 ? (
                                    <span className="text-micro text-muted">No document attached</span>
                                ) : (
                                    c.documents.map((d) => (
                                        <span key={d.id} className="flex items-center gap-1">
                                            <button
                                                onClick={() =>
                                                    setViewing({
                                                        contractId: c.id,
                                                        documentId: d.id,
                                                        filename: d.filename,
                                                        contentType: d.content_type,
                                                    })
                                                }
                                                className="rounded border border-white/10 bg-white/[0.03] px-2.5 py-1 text-micro text-teal-200 transition-colors hover:bg-white/[0.07]"
                                            >
                                                {d.filename}
                                                <span className="ml-1.5 text-muted">
                                                    {Math.round(d.byte_size / 1024)} KB
                                                </span>
                                            </button>
                                            {canManage && (
                                                <button
                                                    onClick={async () => {
                                                        const ok = await confirm({
                                                            title: "Remove this document?",
                                                            body: `${d.filename} will be deleted from ${c.title}. This cannot be undone.`,
                                                            confirmLabel: "Remove",
                                                            tone: "danger",
                                                        });
                                                        if (!ok) return;
                                                        void act(d.id, () =>
                                                            contractService.removeDocument(c.id, d.id),
                                                        );
                                                    }}
                                                    className="px-1 text-micro text-muted hover:text-danger"
                                                    aria-label={`Remove ${d.filename}`}
                                                >
                                                    ×
                                                </button>
                                            )}
                                        </span>
                                    ))
                                )}
                                {canManage && (
                                    <label className="cursor-pointer rounded border border-dashed border-white/15 px-2.5 py-1 text-micro text-muted transition-colors hover:border-signal/40 hover:text-paper-soft">
                                        Attach
                                        <input
                                            type="file"
                                            accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                            className="hidden"
                                            onChange={(e) => {
                                                const file = e.target.files?.[0];
                                                e.target.value = "";
                                                if (!file) return;
                                                void act(c.id, () =>
                                                    contractService.uploadDocument(c.id, file),
                                                );
                                            }}
                                        />
                                    </label>
                                )}
                            </div>
                            )}

                            {canManage && (
                                <div className="flex flex-wrap gap-2 border-t border-white/[0.08] px-5 py-3">
                                    <button
                                        disabled={busy === c.id}
                                        onClick={async () => {
                                            const raw = await prompt({
                                                title: "Warning schedule",
                                                body: "Days before the end date, separated by commas. 60, 42, 30 is two months, six weeks and one month — each acknowledged separately.",
                                                label: "Days before",
                                                placeholder: "60, 42, 30",
                                                defaultValue: c.reminders
                                                    .map((r) => r.days_before)
                                                    .join(", "),
                                                confirmLabel: "Save schedule",
                                            });
                                            if (raw === null) return;
                                            const days = raw
                                                .split(",")
                                                .map((v) => Number(v.trim()))
                                                .filter((v) => Number.isFinite(v) && v >= 0);
                                            void act(c.id, () =>
                                                contractService.update(c.id, {
                                                    reminder_days: days,
                                                }),
                                            );
                                        }}
                                        className="dtg-btn-ghost px-3 py-1.5 text-xs"
                                    >
                                        Warning schedule
                                    </button>
                                    {c.status === "active" && (
                                        <button
                                            disabled={busy === c.id}
                                            onClick={() =>
                                                act(c.id, () =>
                                                    contractService.update(c.id, {
                                                        status: "renewed",
                                                    }),
                                                )
                                            }
                                            className="dtg-btn-ghost px-3 py-1.5 text-xs"
                                        >
                                            Mark renewed
                                        </button>
                                    )}
                                    <button
                                        disabled={busy === c.id}
                                        onClick={async () => {
                                            const ok = await confirm({
                                                title: `Delete the ${c.kind} contract for ${c.title}?`,
                                                body: "Its warning schedule and any attached documents go with it. To close a contract that simply ran its course, mark it renewed or ended instead.",
                                                confirmLabel: "Delete contract",
                                                tone: "danger",
                                            });
                                            if (!ok) return;
                                            void act(c.id, () => contractService.remove(c.id));
                                        }}
                                        className="dtg-btn-ghost px-3 py-1.5 text-xs text-danger"
                                    >
                                        Delete
                                    </button>
                                </div>
                            )}
                        </article>
                    ))}
                </div>
            )}

            {viewing && (
                <DocumentViewer
                    contractId={viewing.contractId}
                    documentId={viewing.documentId}
                    filename={viewing.filename}
                    contentType={viewing.contentType}
                    onClose={() => setViewing(null)}
                />
            )}
        </div>
    );
}

/** The add form. Defaults to the drawer you were looking at. */
function NewContract({
    kind,
    people,
    onCancel,
    onDone,
    onError,
}: {
    kind: ContractKind;
    people: Employee[];
    onCancel: () => void;
    onDone: () => Promise<void>;
    onError: (m: string) => void;
}) {
    const [form, setForm] = useState({
        kind,
        title: "",
        counterparty: "",
        employee_id: "",
        start_date: "",
        end_date: "",
        amount: "",
        currency: "IDR",
        billing_period: "",
        notes: "",
        reminders: kind === "client" ? "60, 42, 30" : "30",
    });
    const [saving, setSaving] = useState(false);

    const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

    const submit = async () => {
        setSaving(true);
        try {
            await contractService.create({
                kind: form.kind,
                title: form.title,
                counterparty: form.counterparty || null,
                employee_id: form.employee_id || null,
                start_date: form.start_date || null,
                end_date: form.end_date,
                amount: form.amount ? Number(form.amount) : null,
                currency: form.currency,
                billing_period: form.billing_period || null,
                notes: form.notes || null,
                reminder_days: form.reminders
                    .split(",")
                    .map((v) => Number(v.trim()))
                    .filter((v) => Number.isFinite(v) && v >= 0),
            });
            await onDone();
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data
                ?.detail;
            onError(typeof detail === "string" ? detail : "Check the dates and try again.");
        } finally {
            setSaving(false);
        }
    };

    const isPerson = form.kind === "manpower";

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">New contract</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">
                    {TABS.find((t) => t.key === form.kind)?.label}
                </h2>
            </header>

            <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
                <label className="block">
                    <span className="dtg-eyebrow">Kind</span>
                    <select
                        value={form.kind}
                        onChange={(e) => {
                            const k = e.target.value as ContractKind;
                            setForm((f) => ({
                                ...f,
                                kind: k,
                                reminders: k === "client" ? "60, 42, 30" : "30",
                            }));
                        }}
                        className="dtg-input mt-1.5 w-full"
                    >
                        {TABS.map((t) => (
                            <option key={t.key} value={t.key}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                </label>

                {isPerson ? (
                    <label className="block">
                        <span className="dtg-eyebrow">Employee</span>
                        <select
                            value={form.employee_id}
                            onChange={(e) => {
                                const emp = people.find((p) => p.id === e.target.value);
                                setForm((f) => ({
                                    ...f,
                                    employee_id: e.target.value,
                                    title: emp ? `${emp.first_name} ${emp.last_name}` : f.title,
                                }));
                            }}
                            className="dtg-input mt-1.5 w-full"
                        >
                            <option value="">Choose…</option>
                            {people.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.first_name} {p.last_name}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : (
                    <label className="block">
                        <span className="dtg-eyebrow">
                            {form.kind === "client" ? "Client" : "Vendor"}
                        </span>
                        <input
                            value={form.title}
                            onChange={(e) => set("title", e.target.value)}
                            placeholder={form.kind === "client" ? "Telfer" : "TeamViewer"}
                            className="dtg-input mt-1.5 w-full"
                        />
                    </label>
                )}

                <label className="block">
                    <span className="dtg-eyebrow">Starts</span>
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

                {!isPerson && (
                    <>
                        <label className="block">
                            <span className="dtg-eyebrow">Value</span>
                            {/* Currency beside the figure, not assumed. A
                                subscription is priced where the vendor lives,
                                and a number stored without its currency is a
                                number somebody reads as rupiah one day. */}
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
                                {/* The currency is chosen beside it, so no prefix; and a
                                    contract in AUD or USD may carry cents. */}
                                <div className="w-full">
                                    <MoneyInput
                                        value={form.amount}
                                        onChange={(raw) => set("amount", raw)}
                                        prefix={null}
                                        allowDecimals
                                        className="dtg-input w-full"
                                    />
                                </div>
                            </div>
                        </label>
                        <label className="block">
                            <span className="dtg-eyebrow">Billed</span>
                            <input
                                value={form.billing_period}
                                onChange={(e) => set("billing_period", e.target.value)}
                                placeholder="monthly, annual, one-off"
                                className="dtg-input mt-1.5 w-full"
                            />
                        </label>
                    </>
                )}

                <label className="block sm:col-span-2">
                    <span className="dtg-eyebrow">Warning schedule</span>
                    <input
                        value={form.reminders}
                        onChange={(e) => set("reminders", e.target.value)}
                        className="dtg-input mt-1.5 w-full font-mono"
                        placeholder="60, 42, 30"
                    />
                    <span className="mt-1 block text-micro text-muted">
                        Days before the end date. 60, 42, 30 is two months, six weeks and one
                        month — each acknowledged separately.
                    </span>
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
            </div>

            <div className="flex gap-2 border-t border-white/[0.08] px-5 py-3">
                <button
                    disabled={!form.title || !form.end_date || saving}
                    onClick={() => void submit()}
                    className="dtg-btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                >
                    {saving ? "Saving…" : "Add contract"}
                </button>
                <button onClick={onCancel} className="dtg-btn-ghost px-3 py-1.5 text-xs">
                    Cancel
                </button>
            </div>
        </section>
    );
}
