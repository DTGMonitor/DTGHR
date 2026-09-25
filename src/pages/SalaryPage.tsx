import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
import { employeeService } from "@/services/employeeService";
import { kpiService } from "@/services/kpiService";
import {
    money,
    salaryService,
    type KpiSummaryRow,
    type SalaryReview,
    type SalaryStatus,
} from "@/services/salaryService";
import type { Employee } from "@/types/employee";
import IncreaseGuidance, { type MarketReference } from "@/components/salary/IncreaseGuidance";
import Alert from "@/components/ui/Alert";
import MoneyInput from "@/components/ui/MoneyInput";
import Spinner from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";

/*
 * Salary reviews.
 *
 * The Director proposes a figure and the CEO
 * approves it -- the chain Nurhuda chose over "Peter approves and I am told"
 * and over "either of us signs". Nothing reaches Peter she has not seen.
 *
 * Peter, September 2026: salary reviews and increases are discretionary, on
 * company performance as well as individual performance, and none of the
 * calculation is shared with staff. So this page has no employee view at all,
 * and no line on it saying so: Nurhuda, "pasti juga ga akan masuk di orang
 * lain kecuali ke saya, Peter atau Mark". The server returns 404 to everybody
 * who is not the director or an executive; this is the second lock, not the
 * only one.
 *
 * Nurhuda, September 2026: the reward block moved here off the scorecard, and
 * every KPI result is summarised "biar satu tempat" -- score, band, integrity
 * gate and where each salary review stands. The KPI multiplier did not come
 * with it: it is a bonus instrument. The increase comes from management's
 * table of a percentage per KPI band (see IncreaseGuidance), applied by the
 * server once a scorecard is approved, and a review starts from that figure
 * in one click. Inflation and AUD->IDR ride along in the rationale as a
 * second point of view.
 */

/** A new review started from a KPI row. */
interface Prefill {
    employeeId: string;
    current: number | null;
    proposed: number | null;
    rationale: string;
    /** The band's recommended increase, so the proposed figure can follow the current one. */
    recommendedPct: number | null;
    bandCode: string | null;
}

/** Current salary raised by a percentage, to the nearest thousand rupiah. */
function raiseBy(current: number, pct: number): number {
    // Nobody is paid Rp 12.345.678.
    return Math.round((current * (1 + pct / 100)) / 1000) * 1000;
}

const STATUS_STYLE: Record<SalaryStatus, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "border-white/15 bg-white/[0.04] text-muted" },
    submitted: { label: "With the CEO", cls: "border-teal-500/40 bg-teal-500/10 text-teal-200" },
    approved: { label: "Approved", cls: "border-signal/40 bg-signal/10 text-signal" },
    declined: { label: "Sent back", cls: "border-danger/40 bg-danger/10 text-danger" },
};

/** Today, as the date input wants it. */
function todayISO(): string {
    // The browser's own date, not UTC's, which before 07:00 WIB is yesterday.
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function SalaryPage() {
    const { user } = useAuth();
    const { prompt } = useDialog();
    // The director and the executives -- Nurhuda, Peter and Mark -- and
    // nobody else, finance included, matching the server. Anyone else who
    // types the address is sent home rather than shown an empty page.
    const mayBeHere = user?.role === "director" || user?.role === "executive";

    const [rows, setRows] = useState<SalaryReview[]>([]);
    const [perms, setPerms] = useState({ prepare: false, approve: false });
    const [people, setPeople] = useState<Employee[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [composing, setComposing] = useState(false);
    const [prefill, setPrefill] = useState<Prefill | null>(null);
    const [summary, setSummary] = useState<KpiSummaryRow[]>([]);
    const [reference, setReference] = useState<MarketReference>({ explain: "" });

    const load = useCallback(async () => {
        try {
            const [res, kpi] = await Promise.all([
                salaryService.list(),
                salaryService.kpiSummary(),
            ]);
            setSummary(kpi.data.items);
            setRows(res.data.items);
            setPerms({
                prepare: res.data.can_prepare,
                approve: res.data.can_approve,
            });
            // Only finance opens new reviews, so only finance needs the list of
            // people to open one against.
            if (res.data.can_prepare) {
                const emps = await employeeService.list({ page: 1, page_size: 100 });
                setPeople(emps.data.items.filter((e) => e.is_active));
            }
        } catch {
            setError("Could not load salary reviews.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (mayBeHere) void load();
        else setLoading(false);
    }, [mayBeHere, load]);

    const act = async (id: string, fn: () => Promise<unknown>) => {
        setBusy(id);
        setError(null);
        try {
            await fn();
            await load();
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: string } } }).response?.data
                ?.detail;
            setError(detail ?? "That did not go through.");
        } finally {
            setBusy(null);
        }
    };

    const decline = async (id: string, who: string) => {
        // The reason is required, because a review that comes back with no
        // explanation is a review finance cannot rework. The dialog enforces
        // it in place rather than letting the save fail afterwards.
        const note = await prompt({
            title: "Send it back to finance",
            body: `The review for ${who} returns to finance as a draft, carrying your reason with it.`,
            label: "What needs to change",
            placeholder: "Too big a step; split it over two cycles",
            multiline: true,
            required: true,
            confirmLabel: "Send back",
            tone: "danger",
        });
        if (note === null) return;
        void act(id, () => salaryService.decline(id, note));
    };

    if (user && !mayBeHere) return <Navigate to="/" replace />;

    const mine = rows.filter(
        (r) =>
            perms.approve && r.status === "submitted",
    );

    return (
        <div className="dtg-fade-in space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Compensation</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                        Salary reviews
                    </h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        The Director proposes the figure and the CEO approves it.
                    </p>
                </div>
                {perms.prepare && !composing && (
                    <button
                        onClick={() => {
                            setPrefill(null);
                            setComposing(true);
                        }}
                        className="dtg-btn-primary px-4 py-2 text-sm"
                    >
                        New review
                    </button>
                )}
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {mine.length > 0 && (
                <Alert tone="warning">
                    {mine.length} review{mine.length === 1 ? " is" : "s are"} waiting on your
                    signature.
                </Alert>
            )}

            {composing && perms.prepare && (
                <NewReview
                    key={prefill?.employeeId ?? "blank"}
                    people={people}
                    prefill={prefill}
                    onCancel={() => setComposing(false)}
                    onDone={async () => {
                        setComposing(false);
                        await load();
                    }}
                    onError={setError}
                />
            )}

            {!loading && (
                <IncreaseGuidance onReference={setReference} onBandsSaved={() => void load()} />
            )}

            {!loading && summary.length > 0 && (
                <KpiSummary
                    rows={summary}
                    canPrepare={perms.prepare && !composing}
                    busy={busy}
                    onGate={(row, cleared) =>
                        void act(row.employee_id, () =>
                            kpiService.updateReview(row.kpi_review_id!, {
                                critical_gate_cleared: cleared,
                            }),
                        )
                    }
                    onStart={(row) => {
                        const rec = row.recommended_increase_pct;
                        const kpi = row.is_complete
                            ? `KPI ${row.period_label}: ${row.total_score?.toFixed(1)}/${row.max_score}, ${row.band_label}.`
                            : "";
                        setPrefill({
                            employeeId: row.employee_id,
                            current: row.current_salary,
                            proposed:
                                row.current_salary !== null && rec !== null
                                    ? raiseBy(row.current_salary, rec)
                                    : null,
                            recommendedPct: rec,
                            bandCode: row.band_code,
                            rationale: [
                                kpi,
                                rec !== null && `Recommended ${rec}% for band ${row.band_code}.`,
                                reference.explain,
                            ]
                                .filter(Boolean)
                                .join(" "),
                        });
                        setComposing(true);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                />
            )}

            {loading ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : rows.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center">
                    <p className="text-sm text-paper-soft">No salary reviews yet.</p>
                    <p className="mt-1.5 text-xs text-muted">
                        {perms.prepare
                            ? "Open one when a figure is ready to propose."
                            : "Finance will send one through when there is a figure to consider."}
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {rows.map((r) => {
                        const style = STATUS_STYLE[r.status];
                        const delta = r.proposed_amount - r.current_amount;
                        const pct =
                            r.current_amount > 0 ? (delta / r.current_amount) * 100 : 0;
                        const waiting =
                            perms.approve && r.status === "submitted";

                        return (
                            <article
                                key={r.id}
                                className={`dtg-panel overflow-hidden ${
                                    waiting ? "ring-1 ring-signal/30" : ""
                                }`}
                            >
                                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
                                    <div>
                                        <p className="text-sm font-semibold text-paper">
                                            {r.employee_name}
                                        </p>
                                        <p className="font-mono text-micro text-muted">
                                            {r.employee_position ?? "—"} · effective{" "}
                                            {new Date(
                                                `${r.effective_date}T00:00:00`,
                                            ).toLocaleDateString("en-GB", {
                                                day: "numeric",
                                                month: "long",
                                                year: "numeric",
                                            })}
                                        </p>
                                    </div>
                                    <span
                                        className={`rounded-full border px-2.5 py-1 text-micro font-semibold uppercase tracking-label ${style.cls}`}
                                    >
                                        {style.label}
                                    </span>
                                </div>

                                <div className="flex flex-wrap items-end gap-x-10 gap-y-4 px-5 py-4">
                                    <div>
                                        <p className="dtg-eyebrow">Current</p>
                                        <p className="mt-1 font-mono text-lg text-paper-soft">
                                            {money(r.current_amount, r.currency)}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="dtg-eyebrow">Proposed</p>
                                        <p className="mt-1 font-mono text-lg font-bold text-paper">
                                            {money(r.proposed_amount, r.currency)}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="dtg-eyebrow">Change</p>
                                        <p
                                            className={`mt-1 font-mono text-lg font-bold ${
                                                delta > 0
                                                    ? "text-signal"
                                                    : delta < 0
                                                      ? "text-danger"
                                                      : "text-muted"
                                            }`}
                                        >
                                            {delta === 0
                                                ? "no change"
                                                : `${delta > 0 ? "+" : ""}${pct.toFixed(1)}%`}
                                        </p>
                                    </div>
                                </div>

                                {(r.rationale || r.endorsement_note || r.decline_reason) && (
                                    <div className="space-y-2 border-t border-white/[0.06] px-5 py-3.5">
                                        {r.rationale && (
                                            <p className="text-xs leading-relaxed text-paper-soft">
                                                <span className="font-semibold">Rationale </span>
                                                {r.rationale}
                                            </p>
                                        )}
                                        {r.endorsement_note && (
                                            <p className="text-xs leading-relaxed text-teal-200/80">
                                                <span className="font-semibold">Endorsed </span>
                                                {r.endorsement_note}
                                            </p>
                                        )}
                                        {r.decline_reason && (
                                            <p className="text-xs leading-relaxed text-danger">
                                                <span className="font-semibold">Sent back </span>
                                                {r.decline_reason}
                                            </p>
                                        )}
                                    </div>
                                )}

                                {/* Only the buttons that will work. The server
                                    decides who may act; this matches it rather
                                    than offering an action that 404s. */}
                                <div className="flex flex-wrap gap-2 border-t border-white/[0.08] px-5 py-3">
                                    {perms.prepare && r.status === "draft" && (
                                        <>
                                            <button
                                                disabled={busy === r.id}
                                                onClick={() =>
                                                    act(r.id, () => salaryService.submit(r.id))
                                                }
                                                className="dtg-btn-primary px-3 py-1.5 text-xs"
                                            >
                                                Send to the director
                                            </button>
                                            <button
                                                disabled={busy === r.id}
                                                onClick={() =>
                                                    act(r.id, () => salaryService.remove(r.id))
                                                }
                                                className="dtg-btn-ghost px-3 py-1.5 text-xs text-danger"
                                            >
                                                Discard
                                            </button>
                                        </>
                                    )}
                                    {perms.approve && r.status === "submitted" && (
                                        <>
                                            <button
                                                disabled={busy === r.id}
                                                onClick={() =>
                                                    act(r.id, () => salaryService.approve(r.id))
                                                }
                                                className="dtg-btn-primary px-3 py-1.5 text-xs"
                                            >
                                                Approve
                                            </button>
                                            <button
                                                disabled={busy === r.id}
                                                onClick={() => void decline(r.id, r.employee_name)}
                                                className="dtg-btn-ghost px-3 py-1.5 text-xs text-danger"
                                            >
                                                Send back
                                            </button>
                                        </>
                                    )}
                                    {r.status === "approved" && (
                                        <p className="text-xs text-muted">
                                            Approved
                                            {r.approved_at
                                                ? ` on ${new Date(r.approved_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
                                                : ""}
                                            . Nothing further is needed.
                                        </p>
                                    )}
                                </div>
                            </article>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/** Finance's form for opening a review. */
function NewReview({
    people,
    prefill,
    onCancel,
    onDone,
    onError,
}: {
    people: Employee[];
    prefill: Prefill | null;
    onCancel: () => void;
    onDone: () => Promise<void>;
    onError: (msg: string) => void;
}) {
    const startingSalary = prefill?.current != null ? String(prefill.current) : "";
    const [employeeId, setEmployeeId] = useState(prefill?.employeeId ?? "");
    const [effective, setEffective] = useState(todayISO());
    const [current, setCurrent] = useState(startingSalary);
    const [proposed, setProposed] = useState(
        prefill?.proposed != null ? String(prefill.proposed) : startingSalary,
    );
    const [rationale, setRationale] = useState(prefill?.rationale ?? "");
    const [saving, setSaving] = useState(false);

    // Nurhuda: with a 3% recommendation, typing the current basic should fill
    // in the proposed one. It follows the current figure until somebody types
    // a proposed figure of their own, and then it is theirs.
    const pct = prefill?.recommendedPct ?? null;
    const [proposedByHand, setProposedByHand] = useState(false);
    const changeCurrent = (raw: string) => {
        setCurrent(raw);
        if (pct !== null && !proposedByHand) {
            setProposed(raw === "" ? "" : String(raiseBy(Number(raw), pct)));
        }
    };
    const change =
        current !== "" && proposed !== "" && Number(current) > 0
            ? ((Number(proposed) - Number(current)) / Number(current)) * 100
            : null;

    const submit = async () => {
        setSaving(true);
        try {
            await salaryService.create({
                employee_id: employeeId,
                effective_date: effective,
                current_amount: Number(current),
                proposed_amount: Number(proposed),
                rationale: rationale.trim() || null,
            });
            await onDone();
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data
                ?.detail;
            onError(
                typeof detail === "string"
                    ? detail
                    : "Check the figures — a change needs a rationale.",
            );
        } finally {
            setSaving(false);
        }
    };

    const ready = employeeId && effective && current !== "" && proposed !== "";

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">New review</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">Propose a figure</h2>
            </header>

            <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
                <label className="block">
                    <span className="dtg-eyebrow">Employee</span>
                    <select
                        value={employeeId}
                        onChange={(e) => setEmployeeId(e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    >
                        <option value="">Choose…</option>
                        {people.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.first_name} {p.last_name} — {p.position}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">Effective from</span>
                    <input
                        type="date"
                        value={effective}
                        onChange={(e) => setEffective(e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                    />
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">Current monthly basic</span>
                    <div className="mt-1.5">
                        <MoneyInput
                            value={current}
                            onChange={changeCurrent}
                            className="dtg-input w-full"
                        />
                    </div>
                </label>

                <label className="block">
                    <span className="dtg-eyebrow">Proposed monthly basic</span>
                    <div className="mt-1.5">
                        <MoneyInput
                            value={proposed}
                            onChange={(raw) => {
                                setProposedByHand(true);
                                setProposed(raw);
                            }}
                            className="dtg-input w-full"
                        />
                    </div>
                    <span className="mt-1 block text-micro text-muted">
                        {change !== null && `${change > 0 ? "+" : ""}${change.toFixed(1)}% on the current figure. `}
                        {pct !== null &&
                            (proposedByHand
                                ? `Set by hand; band ${prefill?.bandCode} recommends ${pct}%.`
                                : `Filled in from band ${prefill?.bandCode}'s ${pct}%. Type over it to change.`)}
                    </span>
                </label>

                <label className="block sm:col-span-2">
                    <span className="dtg-eyebrow">Rationale</span>
                    <textarea
                        rows={3}
                        value={rationale}
                        onChange={(e) => setRationale(e.target.value)}
                        className="dtg-input mt-1.5 w-full"
                        placeholder="Why this figure. Required when it differs from the current one — in a year nobody remembers the conversation."
                    />
                </label>
            </div>

            <div className="flex gap-2 border-t border-white/[0.08] px-5 py-3">
                <button
                    disabled={!ready || saving}
                    onClick={() => void submit()}
                    className="dtg-btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                >
                    {saving ? "Saving…" : "Save as draft"}
                </button>
                <button onClick={onCancel} className="dtg-btn-ghost px-3 py-1.5 text-xs">
                    Cancel
                </button>
            </div>
        </section>
    );
}

const KPI_STATUS: Record<NonNullable<KpiSummaryRow["kpi_status"]>, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "border-white/15 bg-white/[0.04] text-muted" },
    submitted: { label: "With approver", cls: "border-teal-500/40 bg-teal-500/10 text-teal-200" },
    returned: { label: "Returned", cls: "border-danger/40 bg-danger/10 text-danger" },
    approved: { label: "Approved", cls: "border-signal/40 bg-signal/10 text-signal" },
    published: { label: "Published", cls: "border-signal/40 bg-signal/10 text-signal" },
};

/**
 * The bonus workbook's "critical / integrity gate", named for what it asks.
 *
 * Nurhuda read "Cleared" as "the review is finished", which it is not. It is
 * a yes/no on whether anything serious happened in the period -- falsified
 * data, a suppressed alarm, a missed critical detection, a critical TARP
 * breach. Yes for almost everybody, almost always.
 */
const GATE_HELP =
    "Yes unless there was a serious violation this period: falsified data, a suppressed alarm, a missed critical detection or a critical TARP breach. No means no KPI top-up, whatever the score. It is not about whether the review is finished.";

function GateLabel({ cleared }: { cleared: boolean }) {
    return (
        <span className={cleared ? "text-paper-soft" : "font-semibold text-danger"}>
            {cleared ? "Yes" : "No — violation recorded"}
        </span>
    );
}

/**
 * Every KPI result in one table, with what used to sit on each scorecard --
 * the violation check -- and the recommended increase and salary review.
 */
function KpiSummary({
    rows,
    canPrepare,
    busy,
    onGate,
    onStart,
}: {
    rows: KpiSummaryRow[];
    canPrepare: boolean;
    busy: string | null;
    onGate: (row: KpiSummaryRow, cleared: boolean) => void;
    onStart: (row: KpiSummaryRow) => void;
}) {
    const chip = "rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label";

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">Reward</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">KPI results</h2>
                <p className="mt-1 text-micro leading-relaxed text-muted">
                    The latest scorecard for each person, and the increase its band earns from
                    the table above, once the scorecard is approved. Not shared with the
                    employee. A recorded serious violation means no KPI-linked increase, whatever
                    the score.
                </p>
            </header>

            <div className="overflow-x-auto">
                <table className="w-full min-w-[56rem] text-left text-xs">
                    <thead className="text-micro uppercase tracking-label text-muted">
                        <tr className="border-b border-white/[0.08]">
                            <th className="px-5 py-2.5 font-semibold">Person</th>
                            <th className="px-3 py-2.5 font-semibold">Scorecard</th>
                            <th className="px-3 py-2.5 font-semibold">Score</th>
                            <th className="px-3 py-2.5 font-semibold" title={GATE_HELP}>
                                No serious violation <span className="cursor-help text-teal-300">ⓘ</span>
                            </th>
                            <th className="px-3 py-2.5 font-semibold">Recommended increase</th>
                            <th className="px-5 py-2.5 font-semibold">Salary review</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => {
                            const rec = r.recommended_increase_pct;
                            const status = r.kpi_status ? KPI_STATUS[r.kpi_status] : null;
                            const review = r.salary_review_status
                                ? STATUS_STYLE[r.salary_review_status]
                                : null;
                            // A review still in flight blocks a second one;
                            // a finished one does not.
                            const inFlight =
                                r.salary_review_status === "draft" ||
                                r.salary_review_status === "submitted";

                            return (
                                <tr
                                    key={r.employee_id}
                                    className="border-b border-white/[0.05] align-top last:border-0"
                                >
                                    <td className="px-5 py-3">
                                        <p className="font-semibold text-paper">{r.employee_name}</p>
                                        <p className="text-micro text-muted">
                                            {r.employee_position ?? "—"}
                                        </p>
                                    </td>

                                    {/* No scorecard: one note across the row, and
                                        nothing under Recommended increase. Nurhuda:
                                        there is nothing to recommend, so the column
                                        should not look as if there were. */}
                                    {r.kpi_review_id === null ? (
                                        <td colSpan={4} className="px-3 py-3 text-muted">
                                            {r.kpi_exemption_reason
                                                ? `Not assessed — ${r.kpi_exemption_reason}`
                                                : "No scorecard yet."}
                                        </td>
                                    ) : (
                                        <>
                                            <td className="px-3 py-3">
                                                <p className="text-paper-soft">{r.period_label}</p>
                                                {status && (
                                                    <span className={`mt-1 inline-block ${chip} ${status.cls}`}>
                                                        {status.label}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-3 py-3">
                                                <p className="font-mono text-sm font-bold text-paper">
                                                    {r.total_score?.toFixed(1)}
                                                    <span className="font-normal text-muted">
                                                        /{r.max_score}
                                                    </span>
                                                </p>
                                                <p className="text-micro text-muted">
                                                    {r.is_complete ? r.band_label : "Not fully rated"}
                                                </p>
                                            </td>
                                            <td className="px-3 py-3">
                                                {r.can_edit_gate ? (
                                                    <label className="inline-flex cursor-pointer items-center gap-2">
                                                        <input
                                                            type="checkbox"
                                                            className="h-3.5 w-3.5 rounded border-white/20 bg-white/5"
                                                            checked={r.critical_gate_cleared}
                                                            disabled={busy === r.employee_id}
                                                            onChange={(e) => onGate(r, e.target.checked)}
                                                        />
                                                        <GateLabel cleared={r.critical_gate_cleared} />
                                                    </label>
                                                ) : (
                                                    <GateLabel cleared={r.critical_gate_cleared} />
                                                )}
                                                {r.hard_gate_triggered && (
                                                    <p className="mt-1 text-micro text-danger">
                                                        Hard gate raised
                                                    </p>
                                                )}
                                            </td>
                                            <td className="px-3 py-3">
                                                {rec !== null && (
                                                    <p className="font-mono text-sm font-bold text-signal">
                                                        {rec}%
                                                    </p>
                                                )}
                                                <p className="max-w-[14rem] text-micro leading-relaxed text-muted">
                                                    {r.recommendation_note}
                                                </p>
                                            </td>
                                        </>
                                    )}

                                    <td className="px-5 py-3">
                                        {review && (
                                            <div className="mb-1.5">
                                                <span className={`${chip} ${review.cls}`}>
                                                    {review.label}
                                                </span>
                                                {r.salary_review_proposed_amount !== null && (
                                                    <p className="mt-1 font-mono text-micro text-paper-soft">
                                                        {money(r.salary_review_proposed_amount)}
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                        {canPrepare && !inFlight && (
                                            <button
                                                onClick={() => onStart(r)}
                                                className="dtg-btn-secondary px-2.5 py-1 text-micro"
                                            >
                                                Start review
                                            </button>
                                        )}
                                        {!review && !canPrepare && <span className="text-muted">—</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
