import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Download, FileArchive } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import MoneyInput from "@/components/ui/MoneyInput";
import {
    formatIdr,
    payslipService,
    type TaxLine,
    type TaxMonth,
    type TaxSlipStatus,
    type TaxYear,
} from "@/services/payslipService";

/*
 * Tax (PPh 21): the estimate the payroll was approved with, and the actual.
 *
 * Finance sends the payroll for approval with an estimated PPh 21, pitched so
 * the money requested is never short. The actual is known later, and the
 * payslip has to show it so that it agrees with the annual A1 form. The tax
 * is borne by the company, so net pay does not change -- only the tax lines
 * and the totals on the slip. The approved payroll itself is never edited.
 */

const STATUS: Record<TaxSlipStatus, { label: string; className: string }> = {
    not_issued: { label: "Not issued", className: "border-white/12 bg-white/[0.04] text-paper-soft" },
    estimate: { label: "Estimate", className: "border-gold/35 bg-gold/10 text-gold" },
    actual: { label: "Actual", className: "border-signal/35 bg-signal/10 text-signal" },
};

const detailOf = (e: unknown, fallback: string) => {
    const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
    return typeof detail === "string" ? detail : fallback;
};

export default function PayrollTaxPage() {
    const { user } = useAuth();
    const mayBeHere =
        user?.role === "finance" || user?.role === "director" || user?.role === "executive";
    // A payslip is personal: only finance opens other people's.
    const canDownload = user?.role === "finance";
    const thisYear = new Date().getFullYear();

    const [year, setYear] = useState(thisYear);
    const [data, setData] = useState<TaxYear | null>(null);
    // One month at a time: a year of tables was too long to find anyone in.
    const [monthId, setMonthId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (y: number) => {
        setLoading(true);
        setError(null);
        try {
            const res = await payslipService.taxList(y);
            setData(res.data);
            // Keep the chosen month if the year still has it; else the latest.
            setMonthId((cur) =>
                res.data.months.some((m) => m.month_id === cur) ? cur : (res.data.months[0]?.month_id ?? null),
            );
        } catch (e) {
            setError(detailOf(e, "Could not load the tax figures."));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (mayBeHere) void load(year);
    }, [mayBeHere, year, load]);

    if (user && !mayBeHere) return <Navigate to="/" replace />;

    /* One row changed: swap it in without reloading the page. */
    const replaceLine = (next: TaxLine) =>
        setData((d) =>
            d && {
                ...d,
                months: d.months.map((m) =>
                    m.month_id !== next.month_id
                        ? m
                        : { ...m, lines: m.lines.map((l) => (l.line_id === next.line_id ? next : l)) },
                ),
            },
        );

    return (
        <div className="dtg-fade-in space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Finance</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                        Tax (PPh 21)
                    </h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        Estimates are what the executive approved on the payroll. Actuals are what
                        the payslip and the A1 form show. Until an actual is entered, the payslip
                        carries the estimate and says so. Net pay does not change: the tax is
                        borne by the company.
                    </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                    <label className="block">
                        <span className="dtg-eyebrow">Month</span>
                        <select
                            value={monthId ?? ""}
                            onChange={(e) => setMonthId(e.target.value)}
                            disabled={!data || data.months.length === 0}
                            className="dtg-input mt-1 w-56"
                        >
                            {(data?.months ?? []).map((m) => {
                                const open = m.lines.filter((l) => l.actual === null && l.estimate !== 0).length;
                                return (
                                    <option key={m.month_id} value={m.month_id}>
                                        {m.label}
                                        {open > 0 ? ` · ${open} on estimate` : " · done"}
                                    </option>
                                );
                            })}
                        </select>
                    </label>
                    <label className="block">
                        <span className="dtg-eyebrow">Year</span>
                        <select
                            value={year}
                            onChange={(e) => setYear(Number(e.target.value))}
                            className="dtg-input mt-1 w-28"
                        >
                            {Array.from({ length: 5 }, (_, i) => thisYear + 1 - i).map((y) => (
                                <option key={y} value={y}>
                                    {y}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {loading ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : !data || data.months.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center text-sm text-paper-soft">
                    No approved payroll for {year} yet.
                </div>
            ) : (
                data.months
                    .filter((m) => m.month_id === monthId)
                    .map((m) => (
                        <MonthTable
                            key={m.month_id}
                            month={m}
                            canEdit={data.can_edit}
                            canDownload={canDownload}
                            onLine={replaceLine}
                            onError={setError}
                        />
                    ))
            )}
        </div>
    );
}

function MonthTable({
    month,
    canEdit,
    canDownload,
    onLine,
    onError,
}: {
    month: TaxMonth;
    canEdit: boolean;
    canDownload: boolean;
    onLine: (line: TaxLine) => void;
    onError: (msg: string) => void;
}) {
    const [zipping, setZipping] = useState(false);
    const missing = month.lines.filter((l) => l.actual === null && l.estimate !== 0).length;

    const zip = async () => {
        setZipping(true);
        try {
            await payslipService.downloadMonthZip(
                month.month_id,
                month.label,
                month.lines.map((l) => l.line_id),
            );
        } catch (e) {
            onError(detailOf(e, "The payslips could not be downloaded."));
        } finally {
            setZipping(false);
        }
    };

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-3.5">
                <div>
                    <p className="dtg-eyebrow">
                        {missing === 0
                            ? "Every actual entered"
                            : `${missing} ${missing === 1 ? "person" : "people"} on the estimate`}
                    </p>
                    <h2 className="mt-0.5 text-sm font-semibold text-paper">{month.label}</h2>
                </div>
                {canDownload && (
                    <button
                        type="button"
                        disabled={zipping}
                        onClick={() => void zip()}
                        className="dtg-btn-secondary px-3 py-1.5 text-xs"
                    >
                        {zipping ? <Spinner className="h-3.5 w-3.5" /> : <FileArchive className="h-3.5 w-3.5" />}
                        Download all (ZIP)
                    </button>
                )}
            </header>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem]">
                    <thead>
                        <tr className="border-b border-white/[0.08]">
                            <th className="dtg-th">Employee</th>
                            <th className="dtg-th text-right">Estimate</th>
                            <th className="dtg-th text-right">Actual</th>
                            <th className="dtg-th text-right">Difference</th>
                            <th className="dtg-th">Payslip</th>
                            {canDownload && <th className="dtg-th" />}
                        </tr>
                    </thead>
                    <tbody>
                        {month.lines.map((l, i) => (
                            <Row
                                key={l.line_id}
                                line={l}
                                striped={i % 2 === 1}
                                canEdit={canEdit}
                                canDownload={canDownload}
                                onLine={onLine}
                                onError={onError}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function Row({
    line,
    striped,
    canEdit,
    canDownload,
    onLine,
    onError,
}: {
    line: TaxLine;
    striped: boolean;
    canEdit: boolean;
    canDownload: boolean;
    onLine: (line: TaxLine) => void;
    onError: (msg: string) => void;
}) {
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const status = STATUS[line.slip_status];

    /* Saved when the field is left (or Enter is pressed); empty clears it. */
    const commit = async (raw: string) => {
        const current = line.actual === null ? "" : String(Number(line.actual));
        if (raw === current) return;
        setSaving(true);
        try {
            const res =
                raw === ""
                    ? await payslipService.taxClear(line.line_id)
                    : await payslipService.taxSet(line.line_id, Number(raw));
            onLine(res.data);
            // Say so: the payslip is rebuilt with it straight away.
            setSaved(true);
            window.setTimeout(() => setSaved(false), 3000);
        } catch (e) {
            onError(detailOf(e, "That did not save."));
        } finally {
            setSaving(false);
        }
    };

    const download = async () => {
        setDownloading(true);
        try {
            await payslipService.downloadPreview(line.month_id, line.line_id);
        } catch (e) {
            onError(detailOf(e, "That payslip could not be downloaded."));
        } finally {
            setDownloading(false);
        }
    };

    const diff = line.difference === null ? null : Number(line.difference);

    return (
        <tr className={`border-b border-white/[0.05] ${striped ? "bg-white/[0.015]" : ""}`}>
            <td className="dtg-td font-medium text-paper">{line.person_name}</td>
            <td className="dtg-td text-right font-mono text-paper-soft">{formatIdr(line.estimate)}</td>
            <td className="dtg-td text-right">
                {canEdit ? (
                    <div
                        className="ml-auto w-44"
                        onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                    >
                        <MoneyInput
                            value={line.actual === null ? "" : Number(line.actual)}
                            onCommit={(raw) => void commit(raw)}
                            placeholder="Not entered"
                            disabled={saving}
                            className="dtg-input w-full text-right text-sm"
                        />
                        {saved && <p className="mt-1 text-[11px] text-signal">Saved</p>}
                    </div>
                ) : (
                    <span className="font-mono text-paper">
                        {line.actual === null ? "—" : formatIdr(Number(line.actual))}
                    </span>
                )}
            </td>
            <td
                className={`dtg-td text-right font-mono ${
                    diff === null ? "text-muted" : diff > 0 ? "text-danger" : "text-paper-soft"
                }`}
            >
                {diff === null ? "—" : `${diff > 0 ? "+" : ""}${formatIdr(diff)}`}
            </td>
            <td className="dtg-td">
                <span className={`dtg-chip ${status.className}`}>{status.label}</span>
            </td>
            {canDownload && (
                <td className="dtg-td text-right">
                    <button
                        type="button"
                        disabled={downloading}
                        onClick={() => void download()}
                        className="dtg-btn-secondary px-3 py-1.5 text-xs"
                    >
                        {downloading ? <Spinner className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                        Download slip
                    </button>
                </td>
            )}
        </tr>
    );
}
