import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Download, Eye, FileArchive } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import DocumentViewer from "@/components/contracts/DocumentViewer";
import MonthPayslips from "@/components/payslips/MonthPayslips";
import {
    payslipService,
    type TaxLine,
    type TaxMonth,
    type TaxYear,
} from "@/services/payslipService";

/*
 * Payslips: every person's slip for an approved month, in one place.
 *
 * Finance prepares the payroll and knows everyone's pay, so finance opens and
 * downloads anyone's slip here -- one month at a time, like the Tax page. It
 * replaces the row of names that used to sit under the Payroll page. Everyone
 * else reads only their own, on My Profile. The director has the same access
 * for now, while she reviews these screens (temporary).
 *
 * A slip is drawn from the approved payroll with the actual PPh 21 where
 * finance has entered one, so a slip opened here before the release moment is
 * what the person will receive.
 */

const PPH: Record<"estimate" | "actual" | "none", { label: string; className: string }> = {
    estimate: { label: "Estimate", className: "border-gold/35 bg-gold/10 text-gold" },
    actual: { label: "Actual", className: "border-signal/35 bg-signal/10 text-signal" },
    none: { label: "No PPh", className: "border-white/12 bg-white/[0.04] text-paper-soft" },
};

const detailOf = (e: unknown, fallback: string) => {
    const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
    return typeof detail === "string" ? detail : fallback;
};

const firstName = (name: string) => {
    const first = name.trim().split(/\s+/)[0] ?? name;
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
};

const pphOf = (l: TaxLine): keyof typeof PPH =>
    l.actual !== null ? "actual" : Number(l.estimate) === 0 ? "none" : "estimate";

export default function PayslipsPage() {
    const { user } = useAuth();
    const mayBeHere = user?.role === "finance" || user?.role === "director";
    const thisYear = new Date().getFullYear();

    const [year, setYear] = useState(thisYear);
    const [data, setData] = useState<TaxYear | null>(null);
    const [monthId, setMonthId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (y: number) => {
        setLoading(true);
        setError(null);
        try {
            const res = await payslipService.taxList(y);
            setData(res.data);
            setMonthId((cur) =>
                res.data.months.some((m) => m.month_id === cur) ? cur : (res.data.months[0]?.month_id ?? null),
            );
        } catch (e) {
            setError(detailOf(e, "Could not load the payslips."));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (mayBeHere) void load(year);
    }, [mayBeHere, year, load]);

    if (user && !mayBeHere) return <Navigate to="/" replace />;

    const month = data?.months.find((m) => m.month_id === monthId) ?? null;

    return (
        <div className="dtg-fade-in space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Finance</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">Payslips</h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        Everyone&apos;s payslip for an approved month. Each person also finds their own
                        on My Profile once it is released. The PPh 21 shown is the actual where one has
                        been entered on the Tax page, otherwise the estimate.
                    </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                    <label className="block">
                        <span className="dtg-eyebrow">Month</span>
                        <select
                            value={monthId ?? ""}
                            onChange={(e) => setMonthId(e.target.value)}
                            disabled={!data || data.months.length === 0}
                            className="dtg-input mt-1 w-48"
                        >
                            {(data?.months ?? []).map((m) => (
                                <option key={m.month_id} value={m.month_id}>
                                    {m.label}
                                </option>
                            ))}
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
            ) : !month ? (
                <div className="dtg-panel px-5 py-14 text-center text-sm text-paper-soft">
                    No approved payroll for {year} yet.
                </div>
            ) : (
                <>
                    <MonthPayslips
                        key={`status-${month.month_id}`}
                        monthId={month.month_id}
                        label={month.label}
                        canIssue={user?.role === "director"}
                        onError={setError}
                    />
                    <MonthTable key={month.month_id} month={month} onError={setError} />
                </>
            )}
        </div>
    );
}

function MonthTable({ month, onError }: { month: TaxMonth; onError: (msg: string) => void }) {
    const [zipping, setZipping] = useState(false);
    const [viewing, setViewing] = useState<TaxLine | null>(null);

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
                        {month.lines.length} {month.lines.length === 1 ? "person" : "people"}
                    </p>
                    <h2 className="mt-0.5 text-sm font-semibold text-paper">{month.label}</h2>
                </div>
                <button
                    type="button"
                    disabled={zipping}
                    onClick={() => void zip()}
                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                >
                    {zipping ? <Spinner className="h-3.5 w-3.5" /> : <FileArchive className="h-3.5 w-3.5" />}
                    Download all (ZIP)
                </button>
            </header>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem]">
                    <thead>
                        <tr className="border-b border-white/[0.08]">
                            <th className="dtg-th">Employee</th>
                            <th className="dtg-th">PPh 21</th>
                            <th className="dtg-th">Payslip</th>
                            <th className="dtg-th" />
                        </tr>
                    </thead>
                    <tbody>
                        {month.lines.map((l, i) => (
                            <Row
                                key={l.line_id}
                                line={l}
                                striped={i % 2 === 1}
                                onView={() => setViewing(l)}
                                onError={onError}
                            />
                        ))}
                    </tbody>
                </table>
            </div>

            {viewing && (
                <DocumentViewer
                    src={payslipService.previewPath(viewing.month_id, viewing.line_id)}
                    filename={`Payslip ${month.label} - ${firstName(viewing.person_name)}.pdf`}
                    contentType="application/pdf"
                    onClose={() => setViewing(null)}
                />
            )}
        </section>
    );
}

function Row({
    line,
    striped,
    onView,
    onError,
}: {
    line: TaxLine;
    striped: boolean;
    onView: () => void;
    onError: (msg: string) => void;
}) {
    const [downloading, setDownloading] = useState(false);
    const pph = PPH[pphOf(line)];
    const issued = line.slip_status !== "not_issued";

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

    return (
        <tr className={`border-b border-white/[0.05] ${striped ? "bg-white/[0.015]" : ""}`}>
            <td className="dtg-td font-medium text-paper">
                {line.person_name}
                {!line.employee_id && (
                    <span className="ml-2 text-[11px] font-normal text-muted">no HR Hub account</span>
                )}
            </td>
            <td className="dtg-td">
                <span className={`dtg-chip ${pph.className}`}>{pph.label}</span>
            </td>
            <td className="dtg-td">
                <span
                    className={`dtg-chip ${
                        issued
                            ? "border-signal/35 bg-signal/10 text-signal"
                            : "border-white/12 bg-white/[0.04] text-paper-soft"
                    }`}
                >
                    {issued ? "Issued" : "Not issued yet"}
                </span>
            </td>
            <td className="dtg-td">
                <div className="flex justify-end gap-2">
                    <button type="button" onClick={onView} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                        <Eye className="h-3.5 w-3.5" />
                        View
                    </button>
                    <button
                        type="button"
                        disabled={downloading}
                        onClick={() => void download()}
                        className="dtg-btn-secondary px-3 py-1.5 text-xs"
                    >
                        {downloading ? <Spinner className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                        Download
                    </button>
                </div>
            </td>
        </tr>
    );
}
