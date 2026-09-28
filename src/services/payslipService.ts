import api from "@/lib/api";
import { payslipPdf } from "@/lib/routes/payslips";

/*
 * Payslips: issued from the approved payroll at the month's release moment
 * (by default the last day of the month, 23:59 WIB), read on My Profile, and
 * released early from the Payroll page by the director.
 */

export interface MyPayslip {
    id: string;
    year: number;
    month: number;
    label: string;
    issue_date: string;
    net_pay: number;
    file_name: string;
}

export interface MonthPayslips {
    month_id: string;
    status: string;
    release_at: string;
    /** Released on schedule: automatic release is on and the month is covered by it. */
    automatic: boolean;
    issued: boolean;
    issue_date: string | null;
    slips: { id: string; person_name: string; employee_id: string | null; file_name: string }[];
}

export interface PayslipSettings {
    auto_enabled: boolean;
    /** Null is the last day of the month. */
    release_day: number | null;
    release_time: string;
    start_month: string;
    updated_at: string;
    next_release: { year: number; month: number; label: string; release_at: string };
}

export const payslipService = {
    mine: () => api.get<MyPayslip[]>("/payslips/mine"),
    forMonth: (monthId: string) => api.get<MonthPayslips>(`/payroll/months/${monthId}/payslips`),
    issueNow: (monthId: string, employeeId?: string) =>
        api.post<MonthPayslips>(`/payroll/months/${monthId}/payslips/issue`, {
            employee_id: employeeId ?? null,
        }),
    settings: () => api.get<PayslipSettings>("/payslips/settings"),
    saveSettings: (patch: Partial<Pick<PayslipSettings, "auto_enabled" | "release_day" | "release_time">>) =>
        api.put<PayslipSettings>("/payslips/settings", patch),
    /** The viewer's source: DocumentViewer fetches it as a blob. */
    pdfPath: (id: string) => `/payslips/${id}/pdf`,

    /** Save a slip as `Payslip August 2026 - Nurhuda.pdf`. */
    async download(id: string): Promise<void> {
        const { blob, filename } = await payslipPdf(id);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
};

const WIB = "Asia/Jakarta";

/** `30 Sep 2026, 23:59 WIB` for a release moment. */
export function formatRelease(iso: string): string {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat("en-GB", {
        timeZone: WIB,
        day: "numeric",
        month: "short",
        year: "numeric",
    }).format(d);
    const time = new Intl.DateTimeFormat("en-GB", {
        timeZone: WIB,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(d);
    return `${day}, ${time} WIB`;
}

/** `31 Aug 2026` for a calendar date (`YYYY-MM-DD`). */
export function formatIssueDate(date: string): string {
    const [y, m, d] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        day: "numeric",
        month: "short",
        year: "numeric",
    }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** `IDR 33,000,000`, as the rest of the app writes money. */
export function formatIdr(n: number): string {
    return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
    }).format(n);
}

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

/*
 * The release moment of a month under settings not yet saved, so Settings can
 * say what a change would mean before it is made. The same rule as
 * payslips_release_at(): the day clamped to the month's end (none is the last
 * day), at the time, in WIB -- which has no daylight saving, so UTC+7 always.
 */
export function releaseAt(year: number, month: number, day: number | null, time: string): Date {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const d = Math.min(day ?? last, last);
    const [hh, mm] = time.split(":").map(Number) as [number, number];
    return new Date(Date.UTC(year, month - 1, d, hh - 7, mm));
}

/** The next month whose slips are still to be released, from now. */
export function nextRelease(
    day: number | null,
    time: string,
    now = new Date(),
): { label: string; at: Date } {
    // Today in Jakarta.
    const local = new Date(now.getTime() + 7 * 3600 * 1000);
    let year = local.getUTCFullYear();
    let month = local.getUTCMonth() + 1;
    let at = releaseAt(year, month, day, time);
    if (at.getTime() <= now.getTime()) {
        month += 1;
        if (month === 13) {
            month = 1;
            year += 1;
        }
        at = releaseAt(year, month, day, time);
    }
    return { label: `${MONTHS[month - 1]} ${year}`, at };
}
