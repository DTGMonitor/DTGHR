/**
 * Placeholder content for the dashboard panels that have no backend yet:
 * payroll, KPIs and announcements. Every panel that reads from here is
 * labelled "Sample data" in the UI. Replace each export with a service call
 * once the matching table exists.
 */

export interface PayslipSample {
    period: string;
    payDate: string;
    currency: "IDR";
    basic: number;
    allowances: { label: string; amount: number }[];
    deductions: { label: string; amount: number }[];
}

export const SAMPLE_PAYSLIP: PayslipSample = {
    period: "August 2026",
    payDate: "2026-08-25",
    currency: "IDR",
    basic: 12_500_000,
    allowances: [
        { label: "Site allowance", amount: 3_000_000 },
        { label: "Transport", amount: 750_000 },
        { label: "PH loading", amount: 1_150_000 },
    ],
    deductions: [
        { label: "BPJS Kesehatan", amount: 125_000 },
        { label: "BPJS Ketenagakerjaan", amount: 375_000 },
        { label: "PPh 21", amount: 1_210_000 },
    ],
};

/** Payroll runs on the 25th; when that is a weekend, the Friday before. */
export function nextPayday(from: Date): Date {
    const candidate = (y: number, m: number) => {
        const d = new Date(y, m, 25);
        const dow = d.getDay();
        if (dow === 6) d.setDate(24);
        if (dow === 0) d.setDate(23);
        return d;
    };
    const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const thisMonth = candidate(from.getFullYear(), from.getMonth());
    return thisMonth >= today ? thisMonth : candidate(from.getFullYear(), from.getMonth() + 1);
}

export interface KpiSample {
    label: string;
    /** 0-100: progress against the target for the period. */
    progress: number;
    target: string;
    actual: string;
}

export const SAMPLE_KPI_PERIOD = "Q3 2026";
export const SAMPLE_KPI_SCORE = 86;

export const SAMPLE_KPIS: KpiSample[] = [
    { label: "Monitoring reports on time", progress: 94, target: "100%", actual: "94%" },
    { label: "Instrument uptime", progress: 88, target: "98%", actual: "86.2%" },
    { label: "Safety observations logged", progress: 75, target: "12", actual: "9" },
    { label: "Training hours", progress: 60, target: "20 h", actual: "12 h" },
];

export interface AnnouncementSample {
    id: string;
    title: string;
    body: string;
    date: string;
    tag: "HR" | "Safety" | "IT" | "Company";
    pinned?: boolean;
}

export const SAMPLE_ANNOUNCEMENTS: AnnouncementSample[] = [
    {
        id: "a1",
        title: "2027 public holiday calendar published",
        body: "The SKB 3 Menteri for 2027 is out: 18 national holidays and 8 cuti bersama. They are already on the roster.",
        date: "2026-09-16",
        tag: "HR",
        pinned: true,
    },
    {
        id: "a2",
        title: "Quarterly safety stand-down — 30 September",
        body: "All site crews join the 07:00 briefing. Night shift will be briefed at handover.",
        date: "2026-09-12",
        tag: "Safety",
    },
    {
        id: "a3",
        title: "Sign in with your Microsoft account",
        body: "HR Hub now supports DTG Microsoft sign-in. Your existing password keeps working until IT retires it.",
        date: "2026-09-05",
        tag: "IT",
    },
    {
        id: "a4",
        title: "Q3 performance check-ins",
        body: "Line managers will schedule 30-minute KPI check-ins during the first two weeks of October.",
        date: "2026-08-28",
        tag: "Company",
    },
];
