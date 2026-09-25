import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import {
    ArrowLeftRight,
    Check,
    CornerUpLeft,
    Lock,
    Plus,
    Scissors,
    Send,
    Trash2,
} from "lucide-react";

import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";

/*
 * The monthly payroll run — the *Revised PT DTG - Salaries 2026* workbook,
 * one sheet at a time.
 *
 * The columns are the sheet's columns, in the sheet's order, G through Y.
 * That is the whole point: Himawan should be able to put this next to the
 * spreadsheet and read across. An earlier version collected the derived
 * columns at the end and dropped "Salaries Before Tax & BPJS" from the rows
 * altogether, and Nurhuda spotted it — "tampaknya beda juga dengan excel ya".
 *
 * Only the typed-in columns are editable. Everything derived comes back from
 * the server, so the arithmetic exists in exactly one place and the page never
 * has a second opinion about what somebody is paid.
 *
 * Rupiah only. Payroll is paid and reconciled in rupiah; a converted figure
 * beside it was one more number to mistrust.
 */

interface Line {
    id: string;
    employee_id: string | null;
    employee_active: boolean | null;
    /** The title on the staff record. Null for somebody HR Hub does not hold. */
    employee_position: string | null;
    labour_group: "service" | "admin";
    row_no: number;
    person_name: string;
    position: string | null;
    bank_name: string | null;
    bank_account_number: string | null;
    bank_account_name: string | null;
    tax_id: string | null;
    ptkp_status: string | null;
    base: number;
    health_allowance: number;
    responsibility_allowance: number;
    shift_allowance_rate: number;
    shift_days: number;
    overtime_allowance: number;
    public_holiday_days: number;
    public_holiday_rate_override: number | null;
    bonus_other: number;
    bpjs_employment: number;
    bpjs_health: number;
    income_tax: number;
    part_days: number | null;
    part_divisor: number | null;
    notes: string | null;
    base_paid: number;
    is_part_month: boolean;
    total_shift_allowance: number;
    public_holiday_rate: number;
    public_holiday_allowance: number;
    before_tax_and_bpjs: number;
    before_tax: number;
    total_expense: number;
}

interface GroupTotals {
    group: "service" | "admin";
    people: number;
    base: number;
    allowances: number;
    bonus_other: number;
    before_tax_and_bpjs: number;
    bpjs_employment: number;
    bpjs_health: number;
    before_tax: number;
    income_tax: number;
    total_expense: number;
    markup: number | null;
    invoiced: number | null;
    rounded: number;
}

type Status = "draft" | "submitted" | "endorsed" | "approved" | "changes_requested";

interface MonthRun {
    id: string;
    year: number;
    month: number;
    label: string;
    status: Status;
    service_markup_pct: number;
    notes: string | null;
    is_editable: boolean;
    awaiting: "director" | "executive" | null;
    submitted_at: string | null;
    endorsed_at: string | null;
    approved_at: string | null;
    revision_note: string | null;
    revision_at: string | null;
    days_in_month: number;
    lines: Line[];
    totals: GroupTotals[];
    grand_total: number;
}

interface MonthSummary {
    id: string;
    year: number;
    month: number;
    label: string;
    status: Status;
    people: number;
    total_expense: number;
}

const rp = (n: number | null | undefined) =>
    n === null || n === undefined
        ? "—"
        : new Intl.NumberFormat("en-GB", {
              style: "currency",
              currency: "IDR",
              maximumFractionDigits: 0,
          }).format(n);

/*
 * Grouped digits in the editable cells.
 *
 * A base salary is eight digits. Unformatted, 20000000 and 2000000 are a
 * glance apart and the glance is wrong, which on a payroll is somebody's
 * month. The cell shows grouped digits at rest and the bare number while it is
 * being typed in, so nothing has to be typed around a separator.
 */
const grouped = (n: number | null | undefined) =>
    !n ? "" : n.toLocaleString("en-GB", { maximumFractionDigits: 2 });

const ungrouped = (raw: string) => raw.replace(/[^0-9.-]/g, "");

const STATUS_CHIP: Record<Status, { label: string; className: string }> = {
    draft: { label: "Draft", className: "border-gold/30 bg-gold/10 text-gold" },
    submitted: {
        label: "With the director",
        className: "border-teal-300/30 bg-teal-300/10 text-teal-200",
    },
    endorsed: {
        label: "With the executive",
        className: "border-teal-300/30 bg-teal-300/10 text-teal-200",
    },
    approved: { label: "Approved", className: "border-signal/30 bg-signal/10 text-signal" },
    changes_requested: {
        label: "Sent back",
        className: "border-danger/40 bg-danger/10 text-danger",
    },
};

const GROUPS: { key: "service" | "admin"; title: string; blurb: string }[] = [
    {
        key: "service",
        title: "Service Labour",
        blurb: "The monitoring crew. Invoiced on to the client with the markup added.",
    },
    {
        key: "admin",
        title: "Admin Labour",
        blurb: "The company's own overhead. No markup, still rounded.",
    },
];

/*
 * The sheet's columns G through Y, in the sheet's order.
 *
 * `kind` says what each one is: `input` is typed, `derived` is worked out by
 * the server and shown read-only, `text` is a reference field carried on the
 * line. The derived ones sit where the sheet puts them rather than being
 * collected at the end, so the two read across.
 */
type Column =
    | { kind: "input"; key: keyof Line; label: string; short: string }
    | { kind: "derived"; key: keyof Line; label: string; short: string }
    | { kind: "text"; key: keyof Line; label: string; short: string };

const COLUMNS: Column[] = [
    { kind: "input", key: "base", label: "Base — the full month's salary", short: "Base" },
    {
        kind: "input",
        key: "health_allowance",
        label: "Health and wellbeing allowance",
        short: "Health",
    },
    {
        kind: "input",
        key: "responsibility_allowance",
        label: "Responsibility allowance",
        short: "Resp.",
    },
    {
        kind: "input",
        key: "shift_allowance_rate",
        label: "Shift allowance, per day",
        short: "Shift rate",
    },
    { kind: "input", key: "shift_days", label: "Shift days", short: "Days" },
    {
        kind: "derived",
        key: "total_shift_allowance",
        label: "Total shift allowance = rate × days",
        short: "Shift total",
    },
    { kind: "input", key: "overtime_allowance", label: "Overtime allowance", short: "Overtime" },
    { kind: "input", key: "public_holiday_days", label: "Public holidays worked", short: "PH" },
    {
        kind: "input",
        key: "public_holiday_rate_override",
        label: "Public holiday rate — leave empty for base ÷ days × 1.333333",
        short: "PH rate",
    },
    {
        kind: "derived",
        key: "public_holiday_allowance",
        label: "Public holiday allowance = holidays × rate",
        short: "PH pay",
    },
    { kind: "input", key: "bonus_other", label: "Bonus, THR, other allowance", short: "Bonus/THR" },
    {
        kind: "derived",
        key: "before_tax_and_bpjs",
        label: "Salaries before tax and BPJS = base + allowances + shift + overtime + PH + bonus",
        short: "Before tax & BPJS",
    },
    {
        kind: "input",
        key: "bpjs_employment",
        label: "Estimated BPJS Ketenagakerjaan",
        short: "BPJS TK",
    },
    { kind: "input", key: "bpjs_health", label: "Estimated BPJS Kesehatan", short: "BPJS Kes" },
    {
        kind: "derived",
        key: "before_tax",
        label: "Salaries before tax = the above + both BPJS",
        short: "Before tax",
    },
    { kind: "text", key: "tax_id", label: "Tax ID", short: "Tax ID" },
    { kind: "text", key: "ptkp_status", label: "Tax bearer (PTKP status)", short: "PTKP" },
    { kind: "input", key: "income_tax", label: "Estimated income tax", short: "Tax" },
];

export default function PayrollPage() {
    const { user } = useAuth();
    const dialog = useDialog();
    const isFinance = user?.role === "finance";
    const isExecutive = user?.role === "executive";
    const mayBeHere = isFinance || user?.role === "director" || user?.role === "executive";

    const [months, setMonths] = useState<MonthSummary[]>([]);
    const [monthId, setMonthId] = useState<string | null>(null);
    const [run, setRun] = useState<MonthRun | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const loadMonths = useCallback(async () => {
        const res = await api.get<MonthSummary[]>("/payroll/months");
        setMonths(res.data);
        setMonthId((current) => current ?? res.data[0]?.id ?? null);
    }, []);

    const loadRun = useCallback(async (id: string) => {
        const res = await api.get<MonthRun>(`/payroll/months/${id}`);
        setRun(res.data);
    }, []);

    useEffect(() => {
        if (!mayBeHere) {
            setLoading(false);
            return;
        }
        void (async () => {
            try {
                await loadMonths();
            } catch {
                setError("Could not load the payroll runs.");
            } finally {
                setLoading(false);
            }
        })();
    }, [mayBeHere, loadMonths]);

    useEffect(() => {
        if (!monthId) return;
        setLoading(true);
        void loadRun(monthId)
            .catch(() => setError("Could not load that month."))
            .finally(() => setLoading(false));
    }, [monthId, loadRun]);

    const complain = (e: unknown, fallback: string) => {
        const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
        setError(typeof detail === "string" ? detail : fallback);
    };

    /*
     * One cell at a time, and the whole month comes back.
     *
     * A single figure moves the group subtotal, the markup and the rounding
     * with it, so the server returns the recomputed month rather than the line
     * — the page never does the sheet's arithmetic for itself. Only `run` is
     * replaced, never the inputs' own values, so the cell being typed in keeps
     * focus and the page does not jump.
     */
    const patchLine = async (line: Line, body: Record<string, unknown>) => {
        setBusy(line.id);
        setError(null);
        try {
            const res = await api.put<MonthRun>(`/payroll/lines/${line.id}`, body);
            setRun(res.data);
        } catch (e) {
            complain(e, "That did not save.");
        } finally {
            setBusy(null);
        }
    };

    /*
     * A part month, as two numbers rather than a figure worked out elsewhere.
     *
     * The sheet writes it into the base cell as `=20000000*22/31`, which is
     * why Aris arrived in September still on 22/31 of a salary. Here the
     * salary and the proration are separate, so a new month pays a whole one
     * unless somebody says otherwise — and a joiner only needs the days typing
     * in. Written the way the sheet says it, "22/31", with a bare number
     * meaning out of the days in this month.
     */
    const setProration = async (line: Line) => {
        if (!run) return;
        const current = line.part_days
            ? `${line.part_days}${line.part_divisor ? `/${line.part_divisor}` : ""}`
            : "";
        const answer = await dialog.prompt({
            title: `${line.person_name} — part month`,
            body:
                `Days worked, as the sheet writes it: "22/31" means 22 days out of 31. ` +
                `A bare number means out of ${run.days_in_month}, the days in ${run.label}. ` +
                `Leave it empty to pay a full month.`,
            placeholder: "e.g. 22/31",
            defaultValue: current,
        });
        if (answer === null) return;

        const text = answer.trim();
        if (text === "") {
            await patchLine(line, { part_days: null, part_divisor: null });
            return;
        }
        const [daysText, divisorText] = text.split("/");
        const days = Number(daysText);
        const divisor = divisorText === undefined ? null : Number(divisorText);
        if (!Number.isFinite(days) || days <= 0 || (divisor !== null && !(divisor > 0))) {
            setError(`"${text}" is not a number of days. Try something like 22/31.`);
            return;
        }
        await patchLine(line, { part_days: days, part_divisor: divisor });
    };

    const openMonth = async () => {
        const newest = months[0];
        const year = newest
            ? newest.month === 12
                ? newest.year + 1
                : newest.year
            : new Date().getFullYear();
        const month = newest
            ? newest.month === 12
                ? 1
                : newest.month + 1
            : new Date().getMonth() + 1;
        const ok = await dialog.confirm({
            title: "Open the next payroll run?",
            body:
                `This starts ${new Date(year, month - 1).toLocaleString("en-GB", {
                    month: "long",
                })} ${year} from the month before: the same people on the same salaries, with ` +
                "bonuses and part-month prorations cleared, anybody who has left taken off, and " +
                "anybody who has joined added.",
            confirmLabel: "Open it",
        });
        if (!ok) return;
        try {
            const res = await api.post<MonthRun>("/payroll/months", {
                year,
                month,
                copy_previous: true,
            });
            await loadMonths();
            setMonthId(res.data.id);
            setRun(res.data);
        } catch (e) {
            complain(e, "Could not open that month.");
        }
    };

    /** One of submit / endorse / approve. */
    const advance = async (
        action: "submit" | "endorse" | "approve",
        title: string,
        body: string,
        confirmLabel: string,
    ) => {
        if (!run) return;
        const ok = await dialog.confirm({ title, body, confirmLabel });
        if (!ok) return;
        try {
            const res = await api.post<MonthRun>(`/payroll/months/${run.id}/${action}`);
            setRun(res.data);
            await loadMonths();
        } catch (e) {
            complain(e, "That did not go through.");
        }
    };

    /*
     * Back to finance, or -- the executive's alone -- back to the director.
     * Nurhuda reviews before Peter approves, and "peter tetep bisa balikin ke
     * saya atau mas him kalau ada yg tidak sesuai".
     */
    const sendBack = async (to: "finance" | "director" = "finance") => {
        if (!run) return;
        const note = await dialog.prompt(
            to === "director"
                ? {
                      title: `Send ${run.label} back to the director?`,
                      body:
                          "It goes back to Nurhuda's review, still locked, with your reason on it. " +
                          "She can pass it on again or send it to finance.",
                      placeholder: "e.g. Check Aris's bonus with me before I approve",
                      required: true,
                      tone: "danger",
                  }
                : {
                      title: `Send ${run.label} back to finance?`,
                      body:
                          "Say what needs changing. Himawan sees this on his dashboard, and it is the only " +
                          "thing telling him what to fix.",
                      placeholder: "e.g. Aris should be a full month in September",
                      required: true,
                      tone: "danger",
                  },
        );
        if (!note) return;
        try {
            const res = await api.post<MonthRun>(`/payroll/months/${run.id}/request-changes`, {
                note,
                send_to: to,
            });
            setRun(res.data);
            await loadMonths();
        } catch (e) {
            complain(e, "Could not send it back.");
        }
    };

    /*
     * Move somebody between the two groups for this month.
     *
     * Which group a person is in belongs to the month, not to them — Nurhuda
     * is Service Labour from January to March and Admin from July. It also
     * moves real money, so the confirmation says which way it goes. A back-up
     * engineer moves automatically with their shift days; this is every other
     * case, and overriding that one.
     */
    const moveGroup = async (line: Line) => {
        const to = line.labour_group === "service" ? "admin" : "service";
        const ok = await dialog.confirm({
            title: `Move ${line.person_name} to ${to === "service" ? "Service" : "Admin"} Labour?`,
            body:
                to === "service"
                    ? "Their cost joins the crew's and is invoiced on to the client with the markup added."
                    : "Their cost becomes the company's own overhead and is no longer invoiced to the client.",
            confirmLabel: "Move",
        });
        if (!ok) return;
        await patchLine(line, { labour_group: to });
    };

    const removeLine = async (line: Line) => {
        const ok = await dialog.confirm({
            title: `Take ${line.person_name} off ${run?.label}?`,
            body: "Removes the line from this month only. Other months are untouched.",
            confirmLabel: "Remove",
            tone: "danger",
        });
        if (!ok || !run) return;
        try {
            await api.delete(`/payroll/lines/${line.id}`);
            await loadRun(run.id);
        } catch (e) {
            complain(e, "Could not remove that line.");
        }
    };

    const addLine = async (group: "service" | "admin") => {
        if (!run) return;
        const name = await dialog.prompt({
            title: "Add somebody to this run",
            body: "Their name as it should appear on the payroll.",
            placeholder: "Full name",
            required: true,
        });
        if (!name) return;
        try {
            await api.post(`/payroll/months/${run.id}/lines`, {
                labour_group: group,
                person_name: name,
            });
            await loadRun(run.id);
        } catch (e) {
            complain(e, "Could not add that line.");
        }
    };

    const totalsByGroup = useMemo(
        () => Object.fromEntries((run?.totals ?? []).map((t) => [t.group, t])),
        [run],
    ) as Record<"service" | "admin", GroupTotals | undefined>;

    if (user && !mayBeHere) return <Navigate to="/" replace />;

    const editable = Boolean(run?.is_editable && isFinance);
    const myTurn = Boolean(run?.awaiting && user?.role === run.awaiting);

    return (
        <div className="dtg-fade-in space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Finance</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">Payroll</h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        One run per month, laid out as the salaries workbook has it. Finance
                        prepares it, the director reviews it, the executive approves it.
                    </p>
                </div>
                <div className="flex items-end gap-2">
                    <label className="block">
                        <span className="dtg-eyebrow">Month</span>
                        <select
                            value={monthId ?? ""}
                            onChange={(e) => setMonthId(e.target.value)}
                            className="dtg-input mt-1 w-60"
                        >
                            {months.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.label} · {STATUS_CHIP[m.status].label}
                                </option>
                            ))}
                        </select>
                    </label>
                    {isFinance && (
                        <button
                            type="button"
                            onClick={() => void openMonth()}
                            className="dtg-btn-secondary"
                        >
                            <Plus className="h-4 w-4" />
                            New month
                        </button>
                    )}
                </div>
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {loading ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : !run ? (
                <div className="dtg-panel px-5 py-14 text-center text-sm text-paper-soft">
                    No payroll runs yet.
                </div>
            ) : (
                <>
                    {/* The month's answer, and whose turn it is. */}
                    <section className="dtg-panel flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                        <div>
                            <p className="dtg-eyebrow">{run.label} — total cost</p>
                            <p className="mt-1.5 font-mono text-2xl font-bold leading-none text-paper">
                                {rp(run.grand_total)}
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                            <span
                                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-micro font-semibold uppercase tracking-label ${
                                    STATUS_CHIP[run.status].className
                                }`}
                            >
                                {run.status === "approved" && <Lock className="h-3 w-3" />}
                                {STATUS_CHIP[run.status].label}
                            </span>

                            {editable && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        void advance(
                                            "submit",
                                            `Send ${run.label} for approval?`,
                                            "It locks while it is being reviewed — a run that can still be " +
                                                "edited underneath somebody is not one they can have reviewed.",
                                            "Send it",
                                        )
                                    }
                                    className="dtg-btn-primary"
                                >
                                    <Send className="h-4 w-4" />
                                    Send for approval
                                </button>
                            )}

                            {myTurn && run.awaiting === "director" && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        void advance(
                                            "endorse",
                                            `Pass ${run.label} on for approval?`,
                                            "This says you have reviewed the figures. The executive gives " +
                                                "the final approval.",
                                            "Reviewed — pass it on",
                                        )
                                    }
                                    className="dtg-btn-primary"
                                >
                                    <Check className="h-4 w-4" />
                                    Reviewed, pass on
                                </button>
                            )}

                            {myTurn && run.awaiting === "executive" && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        void advance(
                                            "approve",
                                            `Approve ${run.label}?`,
                                            "This is what gets paid. It locks, and reopening it is recorded.",
                                            "Approve",
                                        )
                                    }
                                    className="dtg-btn-primary"
                                >
                                    <Check className="h-4 w-4" />
                                    Approve
                                </button>
                            )}

                            {(myTurn || (run.status === "approved" && !isFinance)) &&
                                (isExecutive &&
                                (run.awaiting === "executive" || run.status === "approved") ? (
                                    // The executive chooses who it goes back to.
                                    <>
                                        <button
                                            type="button"
                                            onClick={() => void sendBack("director")}
                                            className="dtg-btn-secondary"
                                        >
                                            <CornerUpLeft className="h-4 w-4" />
                                            Back to Director
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void sendBack("finance")}
                                            className="dtg-btn-secondary"
                                        >
                                            <CornerUpLeft className="h-4 w-4" />
                                            Back to Finance
                                        </button>
                                    </>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => void sendBack("finance")}
                                        className="dtg-btn-secondary"
                                    >
                                        <CornerUpLeft className="h-4 w-4" />
                                        {run.status === "approved" ? "Reopen" : "Send back"}
                                    </button>
                                ))}
                        </div>
                    </section>

                    {/* What was asked for, on the page where it has to be fixed:
                        finance's, or the director's when the executive sent it
                        back to her review. */}
                    {run.revision_note &&
                        (run.status === "changes_requested" || run.status === "submitted") && (
                            <Alert tone="danger">
                                <span className="font-semibold">
                                    {run.status === "submitted"
                                        ? "Sent back to the director:"
                                        : "Sent back:"}
                                </span>{" "}
                                {run.revision_note}
                            </Alert>
                        )}

                    {/* Who was left off or added when the month was opened. */}
                    {run.notes && <p className="px-1 text-micro text-muted">{run.notes}</p>}

                    {GROUPS.map((group) => {
                        const lines = run.lines.filter((l) => l.labour_group === group.key);
                        const totals = totalsByGroup[group.key];
                        return (
                            <section key={group.key} className="dtg-panel overflow-hidden">
                                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-3">
                                    <div>
                                        <h2 className="text-sm font-semibold text-paper">
                                            {group.title}
                                        </h2>
                                        <p className="mt-0.5 text-micro text-muted">{group.blurb}</p>
                                    </div>
                                    {editable && (
                                        <button
                                            type="button"
                                            onClick={() => void addLine(group.key)}
                                            className="dtg-btn-secondary"
                                        >
                                            <Plus className="h-4 w-4" />
                                            Add person
                                        </button>
                                    )}
                                </header>

                                {lines.length === 0 ? (
                                    <p className="px-5 py-8 text-center text-sm text-muted">
                                        Nobody on this group for {run.label}.
                                    </p>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full border-collapse text-xs">
                                            <thead>
                                                <tr className="border-b border-white/[0.08]">
                                                    <th className="dtg-eyebrow sticky left-0 z-10 bg-surface px-4 py-2 text-left">
                                                        Name
                                                    </th>
                                                    {COLUMNS.map((c) => (
                                                        <th
                                                            key={c.key}
                                                            title={c.label}
                                                            className={`dtg-eyebrow whitespace-nowrap px-2 py-2 text-right ${
                                                                c.kind === "derived" ? "text-muted" : ""
                                                            }`}
                                                        >
                                                            {c.short}
                                                        </th>
                                                    ))}
                                                    <th className="dtg-eyebrow sticky right-0 z-10 whitespace-nowrap bg-surface px-3 py-2 text-right">
                                                        Total cost
                                                    </th>
                                                    {editable && <th className="w-16" />}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {lines.map((line) => (
                                                    <tr
                                                        key={line.id}
                                                        className="border-b border-white/[0.04] last:border-0"
                                                    >
                                                        <td className="sticky left-0 z-10 bg-surface px-4 py-1.5 align-top">
                                                            <p className="whitespace-nowrap font-semibold text-paper">
                                                                {line.person_name}
                                                                {/*
                                                                    Only on a run somebody can still
                                                                    act on.

                                                                    The badge exists so a leaver gets
                                                                    taken off a month being prepared.
                                                                    On a closed month it said the
                                                                    opposite of the truth: August was
                                                                    Isabella's last month and she was
                                                                    employed for it, so marking that row
                                                                    "left" reads as an error in the
                                                                    record rather than a job to do.
                                                                */}
                                                                {editable && line.employee_active === false && (
                                                                    <span
                                                                        title="No longer employed — take this line off the run"
                                                                        className="ml-2 rounded-full border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-label text-danger"
                                                                    >
                                                                        Left
                                                                    </span>
                                                                )}
                                                            </p>
                                                            <p className="whitespace-nowrap text-micro text-muted">
                                                                {busy === line.id ? "Saving… · " : ""}
                                                                {/* HR Hub's title, not the rough
                                                                    category the spreadsheet carried.
                                                                    The snapshot is the fallback for
                                                                    anybody with no staff record. */}
                                                                {line.employee_position ?? line.position}
                                                                {line.bank_name ? ` · ${line.bank_name}` : ""}
                                                            </p>
                                                        </td>

                                                        {COLUMNS.map((c) => {
                                                            if (c.kind === "derived") {
                                                                return (
                                                                    <td
                                                                        key={c.key}
                                                                        className="whitespace-nowrap px-2 py-2.5 text-right align-top font-mono text-muted"
                                                                    >
                                                                        {rp(line[c.key] as number)}
                                                                    </td>
                                                                );
                                                            }
                                                            if (c.kind === "text") {
                                                                return (
                                                                    <td
                                                                        key={c.key}
                                                                        className="whitespace-nowrap px-2 py-2.5 text-right align-top font-mono text-micro text-muted"
                                                                    >
                                                                        {(line[c.key] as string | null) ?? "—"}
                                                                    </td>
                                                                );
                                                            }

                                                            // Empty means "not set" for the public
                                                            // holiday rate, which falls back to the
                                                            // derived one; everywhere else it means 0.
                                                            const nullable =
                                                                c.key === "public_holiday_rate_override";
                                                            return (
                                                                <td key={c.key} className="px-1 py-1.5 align-top">
                                                                    <input
                                                                        type="text"
                                                                        inputMode="decimal"
                                                                        // Uncontrolled: the row is
                                                                        // replaced on every save, and a
                                                                        // controlled value would fight
                                                                        // the cursor.
                                                                        defaultValue={grouped(
                                                                            line[c.key] as number | null,
                                                                        )}
                                                                        disabled={!editable}
                                                                        placeholder={
                                                                            nullable
                                                                                ? grouped(
                                                                                      line.public_holiday_rate,
                                                                                  )
                                                                                : undefined
                                                                        }
                                                                        onFocus={(e) => {
                                                                            e.target.value = ungrouped(
                                                                                e.target.value,
                                                                            );
                                                                            e.target.select();
                                                                        }}
                                                                        onBlur={(e) => {
                                                                            const typed = ungrouped(
                                                                                e.target.value,
                                                                            );
                                                                            const before = line[c.key] as
                                                                                | number
                                                                                | null;
                                                                            if (typed === "") {
                                                                                e.target.value = "";
                                                                                if (before) {
                                                                                    void patchLine(line, {
                                                                                        [c.key]: nullable
                                                                                            ? null
                                                                                            : 0,
                                                                                    });
                                                                                }
                                                                                return;
                                                                            }
                                                                            const value = Number(typed);
                                                                            if (!Number.isFinite(value)) return;
                                                                            e.target.value = grouped(value);
                                                                            if (value !== before) {
                                                                                void patchLine(line, {
                                                                                    [c.key]: value,
                                                                                });
                                                                            }
                                                                        }}
                                                                        className={`dtg-input px-2 py-1 text-right font-mono text-xs disabled:opacity-60 ${
                                                                            c.key === "base"
                                                                                ? "w-32"
                                                                                : "w-[6.5rem]"
                                                                        }`}
                                                                    />
                                                                    {/*
                                                                        The proration sits under the
                                                                        salary it changes. It was a chip
                                                                        beside the name — small, grey and
                                                                        eight columns away from the number
                                                                        it affects — and Nurhuda had to
                                                                        ask how it was even set, which is
                                                                        the answer about whether anybody
                                                                        would find it. It now says what it
                                                                        will do, and once set it shows the
                                                                        working and what is actually paid.
                                                                    */}
                                                                    {/*
                                                                        Always rendered, even when there
                                                                        is nothing to say, so every row in
                                                                        the table is the same height and
                                                                        the columns stay in line.

                                                                        It reads "→ 14,193,548 paid"
                                                                        rather than "= 14,193,548":
                                                                        the input above holds the full
                                                                        salary, and Nurhuda read the
                                                                        20,000,000 in Aris's August cell
                                                                        as the proration having vanished.
                                                                        The word "paid" is what
                                                                        distinguishes the two figures.
                                                                    */}
                                                                    {c.key === "base" &&
                                                                        (editable ? (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() =>
                                                                                    void setProration(line)
                                                                                }
                                                                                title="Pay part of this month only — for somebody who joined or left part way through"
                                                                                className={`mt-1 flex h-4 w-32 items-center justify-end gap-1 overflow-hidden whitespace-nowrap font-mono text-micro transition ${
                                                                                    line.is_part_month
                                                                                        ? "text-gold hover:text-gold/80"
                                                                                        : "text-muted hover:text-teal-200"
                                                                                }`}
                                                                            >
                                                                                <Scissors className="h-2.5 w-2.5 shrink-0" />
                                                                                {line.is_part_month ? (
                                                                                    <span>
                                                                                        {line.part_days}/
                                                                                        {line.part_divisor ??
                                                                                            run.days_in_month}{" "}
                                                                                        →{" "}
                                                                                        {grouped(
                                                                                            Math.round(
                                                                                                line.base_paid,
                                                                                            ),
                                                                                        )}
                                                                                    </span>
                                                                                ) : (
                                                                                    <span className="underline decoration-dotted underline-offset-2">
                                                                                        Part month?
                                                                                    </span>
                                                                                )}
                                                                            </button>
                                                                        ) : (
                                                                            <span className="mt-1 block h-4 w-32 whitespace-nowrap text-right font-mono text-micro text-gold">
                                                                                {line.is_part_month
                                                                                    ? `${line.part_days}/${
                                                                                          line.part_divisor ??
                                                                                          run.days_in_month
                                                                                      } → ${grouped(
                                                                                          Math.round(
                                                                                              line.base_paid,
                                                                                          ),
                                                                                      )}`
                                                                                    : " "}
                                                                            </span>
                                                                        ))}
                                                                </td>
                                                            );
                                                        })}

                                                        <td className="sticky right-0 z-10 whitespace-nowrap bg-surface px-3 py-2.5 text-right align-top font-mono font-bold text-paper">
                                                            {rp(line.total_expense)}
                                                        </td>

                                                        {editable && (
                                                            <td className="px-1 py-1.5 align-top">
                                                                <div className="flex items-center gap-0.5">
                                                                    <button
                                                                        type="button"
                                                                        title={`Move ${line.person_name} to ${
                                                                            line.labour_group === "service"
                                                                                ? "Admin"
                                                                                : "Service"
                                                                        } Labour`}
                                                                        onClick={() => void moveGroup(line)}
                                                                        className="rounded p-1 text-muted transition hover:bg-white/10 hover:text-paper"
                                                                    >
                                                                        <ArrowLeftRight className="h-3.5 w-3.5" />
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        title={`Remove ${line.person_name}`}
                                                                        onClick={() => void removeLine(line)}
                                                                        className="rounded p-1 text-muted transition hover:bg-danger/10 hover:text-danger"
                                                                    >
                                                                        <Trash2 className="h-3.5 w-3.5" />
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        )}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}

                                {/* The sheet's footer, in the sheet's order. */}
                                {totals && lines.length > 0 && (
                                    <div className="border-t border-white/[0.08] bg-white/[0.02] px-5 py-3">
                                        <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2 font-mono text-xs">
                                            <div>
                                                <dt className="dtg-eyebrow">Before tax and BPJS</dt>
                                                <dd className="mt-0.5 text-paper-soft">
                                                    {rp(totals.before_tax_and_bpjs)}
                                                </dd>
                                            </div>
                                            <div>
                                                <dt className="dtg-eyebrow">Before tax</dt>
                                                <dd className="mt-0.5 text-paper-soft">
                                                    {rp(totals.before_tax)}
                                                </dd>
                                            </div>
                                            <div>
                                                <dt className="dtg-eyebrow">Total expenses</dt>
                                                <dd className="mt-0.5 font-bold text-paper">
                                                    {rp(totals.total_expense)}
                                                </dd>
                                            </div>
                                            {totals.markup !== null && (
                                                <>
                                                    <div>
                                                        <dt className="dtg-eyebrow">
                                                            Add {run.service_markup_pct}%
                                                        </dt>
                                                        <dd className="mt-0.5 text-paper-soft">
                                                            {rp(totals.markup)}
                                                        </dd>
                                                    </div>
                                                    <div>
                                                        <dt className="dtg-eyebrow">Invoiced to PL</dt>
                                                        <dd className="mt-0.5 text-paper-soft">
                                                            {rp(totals.invoiced)}
                                                        </dd>
                                                    </div>
                                                </>
                                            )}
                                            <div>
                                                <dt className="dtg-eyebrow">Rounded up</dt>
                                                <dd className="mt-0.5 font-bold text-signal">
                                                    {rp(totals.rounded)}
                                                </dd>
                                            </div>
                                        </dl>
                                    </div>
                                )}
                            </section>
                        );
                    })}
                </>
            )}
        </div>
    );
}
