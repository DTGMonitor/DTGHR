import { useEffect, useState } from "react";
import { Download, Eye } from "lucide-react";

import DocumentViewer from "@/components/contracts/DocumentViewer";
import Spinner from "@/components/ui/Spinner";
import {
    formatIdr,
    formatIssueDate,
    payslipService,
    type MyPayslip,
} from "@/services/payslipService";

/*
 * Your own payslips, on your own profile.
 *
 * A slip appears once the month's payroll is approved and its release moment
 * has passed (the last day of the month, 23:59 WIB, unless the director has
 * moved it). A month reopened after approval disappears from here until it is
 * approved and released again, so what is listed is always what was paid.
 */
export default function MyPayslips() {
    const [slips, setSlips] = useState<MyPayslip[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [viewing, setViewing] = useState<MyPayslip | null>(null);
    const [downloading, setDownloading] = useState<string | null>(null);

    useEffect(() => {
        payslipService
            .mine()
            .then((res) => setSlips(res.data))
            .catch(() => setError("Could not load your payslips."));
    }, []);

    const download = async (slip: MyPayslip) => {
        setDownloading(slip.id);
        setError(null);
        try {
            await payslipService.download(slip.id);
        } catch {
            setError("That payslip could not be downloaded.");
        } finally {
            setDownloading(null);
        }
    };

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">Pay</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">Payslips</h2>
            </header>

            {error && <p className="px-5 pt-4 text-sm text-danger">{error}</p>}

            {!slips && !error ? (
                <div className="flex items-center gap-2.5 px-5 py-10 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : slips && slips.length === 0 ? (
                <p className="px-5 py-10 text-sm text-paper-soft">
                    No payslips yet. They appear here once payroll is approved and released at the
                    end of the month.
                </p>
            ) : slips ? (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[32rem]">
                        <thead>
                            <tr className="border-b border-white/[0.08]">
                                <th className="dtg-th">Period</th>
                                <th className="dtg-th">Issued</th>
                                <th className="dtg-th text-right">Net pay</th>
                                <th className="dtg-th" />
                            </tr>
                        </thead>
                        <tbody>
                            {slips.map((s, i) => (
                                <tr
                                    key={s.id}
                                    className={`border-b border-white/[0.05] ${
                                        i % 2 ? "bg-white/[0.015]" : ""
                                    }`}
                                >
                                    <td className="dtg-td font-medium text-paper">{s.label}</td>
                                    <td className="dtg-td text-paper-soft">
                                        {formatIssueDate(s.issue_date)}
                                    </td>
                                    <td className="dtg-td text-right font-mono text-paper">
                                        {formatIdr(s.net_pay)}
                                    </td>
                                    <td className="dtg-td">
                                        <div className="flex justify-end gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setViewing(s)}
                                                className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                            >
                                                <Eye className="h-3.5 w-3.5" />
                                                View
                                            </button>
                                            <button
                                                type="button"
                                                disabled={downloading === s.id}
                                                onClick={() => void download(s)}
                                                className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                            >
                                                {downloading === s.id ? (
                                                    <Spinner className="h-3.5 w-3.5" />
                                                ) : (
                                                    <Download className="h-3.5 w-3.5" />
                                                )}
                                                Download
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}

            {viewing && (
                <DocumentViewer
                    src={payslipService.pdfPath(viewing.id)}
                    filename={viewing.file_name}
                    contentType="application/pdf"
                    onClose={() => setViewing(null)}
                />
            )}
        </section>
    );
}

