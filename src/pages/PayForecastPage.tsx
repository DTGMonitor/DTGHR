import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";

import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import {
    computeForecast,
    isErr,
    type ActualKey,
    type ForecastInputs,
    type GroupKey,
    type Row,
    type Val,
} from "@/lib/payForecast";

/*
 * The pay forecast: the DTG forecast workbook, July 2026 to December 2027.
 *
 * Four tabs for the workbook's four sheets. The typed numbers are stored; the
 * rest is computed by src/lib/payForecast.ts exactly as the workbook computes
 * it (checked cell by cell). Editing changes the typed numbers only -- the
 * months the workbook fills by formula stay formulas -- and the Actual rows of
 * Budget vs Actual are what finance enters each month from the P&L.
 */

type Tab = "gm" | "bva" | "salary" | "revenue";
const TABS: { key: Tab; label: string }[] = [
    { key: "gm", label: "GM Summary" },
    { key: "bva", label: "Budget vs Actual" },
    { key: "salary", label: "Salary" },
    { key: "revenue", label: "Revenue" },
];

interface Saved {
    inputs: ForecastInputs | null;
    updated_at: string | null;
    updated_by_name: string | null;
}

// --- Excel's number formats -----------------------------------------------------
// #,##0;[Red]\(#,##0\);\-   and   0.0%;[Red]\(0.0%\);\-

const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
function fmt(v: Val, pct = false): { text: string; tone: "neg" | "err" | "" } {
    if (isErr(v)) return { text: v.error, tone: "err" };
    if (v === "") return { text: "", tone: "" };
    const shown = pct ? Math.round(v * 1000) / 10 : Math.round(v);
    if (shown === 0) return { text: "-", tone: "" };
    const body = pct ? `${Math.abs(shown).toFixed(1)}%` : int.format(Math.abs(shown));
    return v < 0 ? { text: `(${body})`, tone: "neg" } : { text: body, tone: "" };
}

function parseNumber(s: string): number | null {
    const t = s.replace(/[,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

// --- One sheet row ----------------------------------------------------------------

interface SheetRow {
    label: string;
    note?: string | null;
    row: Row;
    pct?: boolean;
    strong?: boolean;
    /** Where the typed numbers live, when the row has any; null for a formula month. */
    edit?: {
        typed: (number | null)[];
        set: (i: number, v: number | null) => void;
        /** Months whose blank means "=Budget" rather than empty. */
        follows?: boolean[];
    };
}

function Sheet({
    inputs,
    rows,
    editing,
}: {
    inputs: ForecastInputs;
    rows: (SheetRow | { gap: true } | { heading: string })[];
    editing: boolean;
}) {
    const first2027 = inputs.first_2027;
    return (
        <div className="dtg-panel overflow-x-auto">
            <table className="w-max min-w-full border-collapse text-xs">
                <thead>
                    <tr className="border-b border-white/10">
                        <th className="sticky left-0 z-10 min-w-[15rem] bg-surface px-3 py-2.5 text-left font-semibold text-muted" />
                        {inputs.months.map((m, i) => (
                            <th
                                key={m}
                                className={`whitespace-nowrap px-2.5 py-2.5 text-right font-semibold ${
                                    i < first2027 ? "bg-teal-900/50 text-teal-100" : "text-paper-soft"
                                }`}
                            >
                                {m}
                            </th>
                        ))}
                        <th className="whitespace-nowrap bg-white/[0.04] px-3 py-2.5 text-right font-bold text-paper">
                            {inputs.fy_label}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r, k) => {
                        if ("gap" in r) return <tr key={k} className="h-3" />;
                        if ("heading" in r)
                            return (
                                <tr key={k}>
                                    <td
                                        colSpan={inputs.months.length + 2}
                                        className="sticky left-0 bg-band/40 px-3 py-2 text-micro font-semibold uppercase tracking-label text-teal-100"
                                    >
                                        {r.heading}
                                    </td>
                                </tr>
                            );
                        return (
                            <tr
                                key={k}
                                className={`border-b border-white/[0.05] ${r.strong ? "bg-white/[0.03]" : ""}`}
                            >
                                <th
                                    scope="row"
                                    className="sticky left-0 z-10 bg-surface px-3 py-2 text-left align-top font-normal"
                                >
                                    <span className={r.strong ? "font-semibold text-paper" : "text-paper"}>
                                        {r.label}
                                    </span>
                                    {r.note && (
                                        <span className="mt-0.5 block max-w-[15rem] whitespace-normal text-micro leading-snug text-muted">
                                            {r.note}
                                        </span>
                                    )}
                                </th>
                                {r.row.values.map((v, i) => {
                                    // Typed cells are editable; formula months are not.
                                    // An Actual cell is always typed, even when blank.
                                    const typed = r.edit?.typed[i] ?? null;
                                    const canEdit =
                                        editing && r.edit !== undefined && (typed !== null || r.edit.follows !== undefined);
                                    const f = fmt(v, r.pct);
                                    return (
                                        <td
                                            key={i}
                                            className={`whitespace-nowrap px-1.5 py-1 text-right font-mono tabular-nums ${
                                                i < first2027 ? "bg-teal-900/20" : ""
                                            } ${r.strong ? "font-semibold" : ""} ${
                                                f.tone === "neg" || f.tone === "err" ? "text-danger" : "text-paper"
                                            }`}
                                        >
                                            {canEdit ? (
                                                <CellInput
                                                    value={typed}
                                                    placeholder={
                                                        r.edit?.follows?.[i] && typed === null ? f.text : ""
                                                    }
                                                    onChange={(n) => r.edit!.set(i, n)}
                                                />
                                            ) : (
                                                <span className="px-1">{f.text}</span>
                                            )}
                                        </td>
                                    );
                                })}
                                {(() => {
                                    const f = fmt(r.row.fy, r.pct);
                                    return (
                                        <td
                                            className={`whitespace-nowrap bg-white/[0.04] px-3 py-1 text-right font-mono font-semibold tabular-nums ${
                                                f.tone ? "text-danger" : "text-paper"
                                            }`}
                                        >
                                            {f.text}
                                        </td>
                                    );
                                })()}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/** A typed number. Shown rounded while not focused; the stored value is exact. */
function CellInput({
    value,
    placeholder,
    onChange,
}: {
    value: number | null;
    placeholder: string;
    onChange: (v: number | null) => void;
}) {
    const [focus, setFocus] = useState(false);
    const [draft, setDraft] = useState("");
    const bad = focus && Number.isNaN(parseNumber(draft));
    return (
        <input
            inputMode="decimal"
            value={focus ? draft : value === null ? "" : fmt(value).text}
            placeholder={placeholder}
            onFocus={() => {
                setDraft(value === null ? "" : String(value));
                setFocus(true);
            }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
                setFocus(false);
                const n = parseNumber(draft);
                if (!Number.isNaN(n) && n !== value) onChange(n);
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                    setDraft(value === null ? "" : String(value));
                    (e.target as HTMLInputElement).blur();
                }
            }}
            className={`w-24 rounded border bg-deep px-1.5 py-1 text-right font-mono text-xs text-paper placeholder:text-muted/60 focus:outline-none focus:ring-1 ${
                bad ? "border-danger focus:ring-danger" : "border-white/10 focus:border-signal/60 focus:ring-signal/40"
            }`}
        />
    );
}

// --- The page ---------------------------------------------------------------------

export default function PayForecastPage() {
    const { user } = useAuth();
    const mayBeHere =
        Boolean(user?.is_superuser) ||
        Boolean(user?.is_management) ||
        user?.role === "director" ||
        user?.role === "executive";

    const [saved, setSaved] = useState<Saved | null>(null);
    const [draft, setDraft] = useState<ForecastInputs | null>(null);
    // #bva, #salary, #revenue open that sheet: a link can point at one.
    const [tab, setTab] = useState<Tab>(() => {
        const h = window.location.hash.slice(1);
        return TABS.some((t) => t.key === h) ? (h as Tab) : "gm";
    });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get<Saved>("/pay-forecast");
            setSaved(res.data);
            setDraft(null);
            setError(null);
        } catch {
            setError("Could not load the forecast.");
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        if (mayBeHere) void load();
        else setLoading(false);
    }, [mayBeHere, load]);

    const inputs = draft ?? saved?.inputs ?? null;
    const f = useMemo(() => (inputs ? computeForecast(inputs) : null), [inputs]);
    const editing = draft !== null;

    /** Change one typed number in the draft. */
    const edit = (mutate: (d: ForecastInputs) => void) =>
        setDraft((d) => {
            const next = structuredClone(d ?? saved!.inputs!);
            mutate(next);
            return next;
        });

    const save = async () => {
        if (!draft) return;
        setSaving(true);
        try {
            const res = await api.put<Saved>("/pay-forecast", { inputs: draft, seen: saved?.updated_at });
            setSaved(res.data);
            setDraft(null);
            setError(null);
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
            setError(typeof detail === "string" ? detail : "The forecast did not save.");
        } finally {
            setSaving(false);
        }
    };

    if (user && !mayBeHere) return <Navigate to="/" replace />;

    const line = (
        label: string,
        row: Row,
        typed: (number | null)[],
        set: (i: number, v: number | null) => void,
        note?: string | null,
    ): SheetRow => ({ label, row, note, edit: { typed, set } });

    let body: React.ReactNode = null;
    if (inputs && f) {
        const g = f.gm;
        if (tab === "gm") {
            const typedRow = (k: "labour_pl" | "labour_pt" | "overhead" | "other_costs") => ({
                typed: inputs.gm[k].values,
                // Only typed months are offered for editing; formula months stay formulas.
                set: (i: number, v: number | null) => edit((d) => void (d.gm[k].values[i] = v ?? 0)),
            });
            body = (
                <>
                    <Sheet
                        inputs={inputs}
                        editing={editing}
                        rows={[
                            { label: "Revenue PL", row: g.revenuePl },
                            { label: "Revenue PT", row: g.revenuePt },
                            { label: "TOTAL REVENUE", row: g.revenue, strong: true },
                            { label: "Labour PL", note: inputs.gm.labour_pl.note, row: g.labourPl, edit: typedRow("labour_pl") },
                            { label: "Labour PT", note: inputs.gm.labour_pt.note, row: g.labourPt, edit: typedRow("labour_pt") },
                            { label: "Overhead", note: inputs.gm.overhead.note, row: g.overhead, edit: typedRow("overhead") },
                            { label: "DTG PL - other costs", note: inputs.gm.other_costs.note, row: g.otherCosts, edit: typedRow("other_costs") },
                            { label: "TOTAL COGS", row: g.cogs, strong: true },
                            { label: "GM (AUD)", row: g.gm, strong: true },
                            { label: "GM (%)", row: g.gmPct, pct: true, strong: true },
                        ]}
                    />
                    <section className="grid gap-3 md:grid-cols-2">
                        {inputs.gm.notes.map((n) => (
                            <div key={n.title} className="dtg-panel p-4">
                                <p className="dtg-eyebrow">{n.title}</p>
                                <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-paper-soft">
                                    {n.items.map((it, i) => (
                                        <li key={i} className="flex gap-2">
                                            <span className="text-teal-300">•</span>
                                            <span>{it}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </section>
                </>
            );
        } else if (tab === "bva") {
            const b = f.bva;
            const actual = (k: ActualKey, label: string, rows: [Row, Row], strong = false): SheetRow[] => [
                { label: `${label} - Budget`, row: rows[0], strong },
                {
                    label: `${label} - Actual`,
                    row: rows[1],
                    strong,
                    edit: {
                        typed: inputs.bva.actuals[k],
                        follows: inputs.bva.actual_follows_budget[k],
                        set: (i, v) => edit((d) => void (d.bva.actuals[k][i] = v)),
                    },
                },
            ];
            const computed = (label: string, rows: [Row, Row], pct = false): SheetRow[] => [
                { label: `${label} - Budget`, row: rows[0], strong: true, pct },
                { label: `${label} - Actual`, row: rows[1], strong: true, pct },
            ];
            body = (
                <Sheet
                    inputs={inputs}
                    editing={editing}
                    rows={[
                        ...actual("revenue_pl", "Revenue PL", b.revenuePl),
                        ...actual("revenue_pt", "Revenue PT", b.revenuePt),
                        ...computed("TOTAL REVENUE", b.revenue),
                        { label: "REVENUE VARIANCE (%)", row: b.revenueVar, pct: true },
                        { gap: true },
                        ...actual("labour_pl", "Labour PL", b.labourPl),
                        ...actual("labour_pt", "Labour PT", b.labourPt),
                        ...actual("overhead", "Overhead", b.overhead),
                        ...actual("other_costs", "DTG PL - other costs", b.otherCosts),
                        ...computed("TOTAL COGS", b.cogs),
                        { label: "COST VARIANCE (%)", row: b.costVar, pct: true },
                        { gap: true },
                        ...computed("GM (AUD)", b.gm),
                        ...computed("GM (%)", b.gmPct, true),
                        { label: "GM VARIANCE (%)", row: b.gmVar, pct: true },
                    ]}
                />
            );
        } else if (tab === "salary") {
            const s = inputs.salary;
            const fs = f.salary;
            const rows: (SheetRow | { gap: true } | { heading: string })[] = [];
            const SUBTOTAL: Record<GroupKey, string> = { pl: "PL", pt: "PT", support: "Support", focus: "Focus" };
            s.groups.forEach((grp, gi) => {
                const computed = fs.groups[gi]!;
                rows.push({ heading: grp.title });
                grp.rows.forEach((l, ri) =>
                    rows.push(
                        line(l.name, computed.rows[ri]!, l.values, (i, v) =>
                            edit((d) => void (d.salary.groups[gi]!.rows[ri]!.values[i] = v ?? 0)),
                        l.note),
                    ),
                );
                rows.push({ label: `SUBTOTAL ${SUBTOTAL[grp.key]}`, row: computed.subtotal, strong: true });
            });
            const KEYS: GroupKey[] = ["pl", "pt", "support", "focus"];
            rows.push({ heading: s.thr_title });
            KEYS.forEach((k) =>
                rows.push(line(s.thr[k].name, fs.thr[k], s.thr[k].values, (i, v) =>
                    edit((d) => void (d.salary.thr[k].values[i] = v ?? 0)), s.thr[k].note)),
            );
            rows.push({ label: "TOTAL THR", note: s.thr_total_note, row: fs.thrTotal, strong: true });
            rows.push({ heading: s.bonus_title });
            KEYS.forEach((k) =>
                rows.push(line(s.bonus[k].name, fs.bonus[k], s.bonus[k].values, (i, v) =>
                    edit((d) => void (d.salary.bonus[k].values[i] = v ?? 0)), s.bonus[k].note)),
            );
            rows.push({ label: "TOTAL BONUS", note: s.bonus_total_note, row: fs.bonusTotal, strong: true });
            body = <Sheet inputs={inputs} editing={editing} rows={rows} />;
        } else {
            const r = inputs.revenue;
            const fr = f.revenue;
            body = (
                <Sheet
                    inputs={inputs}
                    editing={editing}
                    rows={[
                        { heading: r.pl_title },
                        ...r.pl.map((l, i) =>
                            line(l.name, fr.pl[i]!, l.values, (m, v) => edit((d) => void (d.revenue.pl[i]!.values[m] = v ?? 0)), l.note),
                        ),
                        { label: "REVENUE PL", note: "Subtotal", row: fr.plTotal, strong: true },
                        { heading: r.pt_title },
                        ...r.pt.map((l, i) =>
                            line(l.name, fr.pt[i]!, l.values, (m, v) => edit((d) => void (d.revenue.pt[i]!.values[m] = v ?? 0)), l.note),
                        ),
                        { label: "REVENUE PT", note: "Subtotal", row: fr.ptTotal, strong: true },
                        { label: "TOTAL REVENUE", note: "Revenue PL + Revenue PT", row: fr.total, strong: true },
                    ]}
                />
            );
        }
    }

    const subtitle =
        tab === "gm" ? inputs?.subtitle
        : tab === "bva" ? inputs?.bva.subtitle
        : tab === "salary" ? inputs?.salary.subtitle
        : inputs?.revenue.subtitle;
    const unit = tab === "salary" ? "IDR per month" : "AUD";
    const tiles = f
        ? [
              { label: `Revenue ${inputs!.fy_label}`, v: f.gm.revenue.fy },
              { label: `COGS ${inputs!.fy_label}`, v: f.gm.cogs.fy },
              { label: `Gross margin ${inputs!.fy_label}`, v: f.gm.gm.fy, strong: true },
              { label: "GM %", v: f.gm.gmPct.fy, pct: true, strong: true },
          ]
        : [];

    return (
        <div className="dtg-fade-in space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Finance</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">Pay forecast</h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        {inputs?.title ?? "Revenue, cost and gross margin, with the salary and revenue behind them."}
                    </p>
                    {saved?.updated_at && (
                        <p className="mt-1 text-micro text-muted">
                            Last saved {new Date(saved.updated_at).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                            {saved.updated_by_name ? ` by ${saved.updated_by_name}` : ""}
                        </p>
                    )}
                </div>
                {inputs && (
                    <div className="flex gap-2">
                        {editing ? (
                            <>
                                <button onClick={() => setDraft(null)} className="dtg-btn-secondary" disabled={saving}>
                                    Cancel
                                </button>
                                <button onClick={() => void save()} className="dtg-btn-primary" disabled={saving}>
                                    {saving ? "Saving…" : "Save changes"}
                                </button>
                            </>
                        ) : (
                            <button onClick={() => setDraft(structuredClone(saved!.inputs!))} className="dtg-btn-secondary">
                                Edit figures
                            </button>
                        )}
                    </div>
                )}
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {loading ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : !inputs ? (
                <div className="dtg-panel px-5 py-14 text-center text-sm text-paper-soft">
                    No forecast has been loaded yet.
                </div>
            ) : (
                <>
                    <section className="dtg-panel grid grid-cols-2 divide-white/[0.06] lg:grid-cols-4 lg:divide-x">
                        {tiles.map((t) => {
                            const x = fmt(t.v, t.pct);
                            return (
                                <div key={t.label} className="px-4 py-4">
                                    <p className="dtg-eyebrow">{t.label}</p>
                                    <p
                                        className={`mt-2 font-mono leading-none ${t.strong ? "text-xl font-bold" : "text-base"} ${
                                            x.tone ? "text-danger" : t.strong ? "text-paper" : "text-paper-soft"
                                        }`}
                                    >
                                        {t.pct ? x.text : `AUD ${x.text}`}
                                    </p>
                                </div>
                            );
                        })}
                    </section>

                    <div role="tablist" className="flex flex-wrap gap-1 border-b border-white/10">
                        {TABS.map((t) => (
                            <button
                                key={t.key}
                                role="tab"
                                aria-selected={tab === t.key}
                                onClick={() => setTab(t.key)}
                                className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors ${
                                    tab === t.key
                                        ? "border-signal font-semibold text-paper"
                                        : "border-transparent font-medium text-paper-soft hover:border-teal-500 hover:text-paper"
                                }`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>

                    <p className="text-xs leading-relaxed text-muted">
                        <span className="font-semibold text-paper-soft">{unit}.</span> {subtitle}
                        {editing && (
                            <span className="ml-1 text-teal-200">
                                Editing: only the typed numbers change; formula months recalculate.
                                {tab === "bva" && " A blank Actual in July to September follows the Budget, as in the workbook."}
                            </span>
                        )}
                    </p>

                    {body}
                </>
            )}
        </div>
    );
}

