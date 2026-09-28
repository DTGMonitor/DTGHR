import { useCallback, useEffect, useState } from "react";
import { FileText, Send } from "lucide-react";

import DocumentViewer from "@/components/contracts/DocumentViewer";
import { useDialog } from "@/components/ui/Dialog";
import {
    formatIssueDate,
    formatRelease,
    payslipService,
    type MonthPayslips as MonthSlips,
} from "@/services/payslipService";

/*
 * An approved month's payslips, under its approval.
 *
 * One line saying when they go out (or when they went out), each person's slip
 * one click away for the people who read payroll -- built from the current
 * figures, so finance can open it before the release moment too -- and, for the
 * director, a way to issue them now rather than waiting.
 */
export default function MonthPayslips({
    monthId,
    label,
    lines,
    canIssue,
    canOpen,
    onError,
}: {
    monthId: string;
    label: string;
    lines: { id: string; person_name: string }[];
    canIssue: boolean;
    /** A payslip is personal: only finance opens other people's. */
    canOpen: boolean;
    onError: (msg: string) => void;
}) {
    const dialog = useDialog();
    const [info, setInfo] = useState<MonthSlips | null>(null);
    const [busy, setBusy] = useState(false);
    const [viewing, setViewing] = useState<{ id: string; person_name: string } | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await payslipService.forMonth(monthId);
            setInfo(res.data);
        } catch {
            onError("Could not load this month's payslips.");
        }
    }, [monthId, onError]);

    useEffect(() => {
        setInfo(null);
        void load();
    }, [load]);

    if (!info) return null;

    const issue = async () => {
        const ok = await dialog.confirm({
            title: info.issued ? `Issue ${label} payslips again?` : `Issue ${label} payslips now?`,
            body: info.issued
                ? "Every slip for this month is rebuilt from the approved payroll, and each person sees the new one on their profile."
                : "Everybody on this month's payroll gets their payslip on their profile now, rather than at the release moment.",
            confirmLabel: "Issue now",
        });
        if (!ok) return;
        setBusy(true);
        try {
            const res = await payslipService.issueNow(monthId);
            setInfo(res.data);
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
            onError(typeof detail === "string" ? detail : "The payslips were not issued.");
        } finally {
            setBusy(false);
        }
    };

    const status = info.issued
        ? `Payslips issued ${formatIssueDate(info.issue_date ?? "")}`
        : info.automatic
          ? new Date(info.release_at).getTime() <= Date.now()
              ? "Payslips go out within the next few minutes."
              : `Payslips release on ${formatRelease(info.release_at)}`
          : "Payslips for this month are not released automatically.";

    return (
        <section className="dtg-panel px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-sm text-paper-soft">
                    <FileText className="h-4 w-4 text-teal-300" />
                    {status}
                </p>
                {canIssue && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void issue()}
                        className="dtg-btn-secondary px-3 py-1.5 text-xs"
                    >
                        <Send className="h-3.5 w-3.5" />
                        Issue now
                    </button>
                )}
            </div>

            {canOpen && lines.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-white/[0.08] pt-3">
                    {lines.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => setViewing(s)}
                            className="dtg-chip border-white/12 bg-white/[0.04] text-paper-soft transition-colors hover:border-teal-300/40 hover:text-paper"
                            title={`Open ${s.person_name}'s payslip`}
                        >
                            {s.person_name}
                        </button>
                    ))}
                </div>
            )}

            {viewing && (
                <DocumentViewer
                    src={payslipService.previewPath(monthId, viewing.id)}
                    filename={`Payslip ${label} - ${firstName(viewing.person_name)}.pdf`}
                    contentType="application/pdf"
                    onClose={() => setViewing(null)}
                />
            )}
        </section>
    );
}

/* "RINA SARI" -> "Rina", as the slip's own file name has it. */
function firstName(name: string): string {
    const first = name.trim().split(/\s+/)[0] ?? "";
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}
