import { useCallback, useEffect, useState } from "react";
import { FileText, Send } from "lucide-react";

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
 * One line saying when they go out (or when they went out) and, for the
 * director, a way to issue them now rather than waiting. The slips themselves
 * are on the Payslips page.
 */
export default function MonthPayslips({
    monthId,
    label,
    canIssue,
    onError,
}: {
    monthId: string;
    label: string;
    canIssue: boolean;
    onError: (msg: string) => void;
}) {
    const dialog = useDialog();
    const [info, setInfo] = useState<MonthSlips | null>(null);
    const [busy, setBusy] = useState(false);

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


        </section>
    );
}
