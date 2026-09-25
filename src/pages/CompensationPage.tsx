import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import Alert from "@/components/ui/Alert";
import MoneyInput from "@/components/ui/MoneyInput";
import Spinner from "@/components/ui/Spinner";

/*
 * What a pay decision costs, before anybody takes it.
 *
 * Split out of the KPI scorecard on Nurhuda's instruction. The scorecard says
 * how somebody performed; that is one input among several into what they are
 * paid, and keeping the money on the assessment made the assessment look like
 * a formula for a raise.
 *
 * The question this page exists to answer is Peter's: "if I raise everyone by
 * this much and give Nurhuda a bonus, what does that cost us for the year?"
 * So the totals are the headline and the per-person rows are the working.
 *
 * Gross rather than basic throughout. A raise to the basic moves the gross,
 * the BPJS estimates and often the tax with it, so costing a decision on the
 * basic alone understates it every time — which is exactly what the
 * Salary_Forecast sheet is careful about.
 */

interface Row {
    employee_id: string;
    employee_name: string;
    position: string | null;
    work_pattern: string | null;
    bonus_eligible: boolean;
    kpi_period: string | null;
    kpi_score: number | null;
    kpi_band: string | null;
    kpi_multiplier: number | null;
    current_basic: number | null;
    current_gross: number | null;
    increase_pct: number | null;
    additional_gross: number | null;
    bpjs_employment: number | null;
    bpjs_health: number | null;
    tax_bearer: string | null;
    income_tax: number | null;
    bonus_amount: number | null;
    proposed_basic: number | null;
    proposed_gross: number | null;
    monthly_cost: number | null;
    annual_cost: number | null;
    annual_cost_with_bonus: number | null;
}

interface Rate {
    idr_per_aud: number;
    as_of: string;
    stale: boolean;
}

interface Totals {
    roster_annual: number;
    office_annual: number;
    bonus_total: number;
    annual_total: number;
    monthly_total: number;
    people: number;
}

/**
 * The same amount in dollars, for the Australian side of the company.
 *
 * Written "AUD 31,229", not "$31,229": in an Australian locale the symbol is
 * a bare "$", which reads as US dollars to anybody else. Nurhuda: "saya paham
 * ini dolar AUD tp lebih enak dimention". The code also matches the "IDR"
 * written on the figure above it.
 */
const aud = (idr: number, rate: Rate) =>
    new Intl.NumberFormat("en-AU", {
        style: "currency",
        currency: "AUD",
        currencyDisplay: "code",
        maximumFractionDigits: 0,
    }).format(idr / rate.idr_per_aud);

const rp = (n: number | null | undefined) =>
    n === null || n === undefined
        ? "—"
        : new Intl.NumberFormat("en-GB", {
              style: "currency",
              currency: "IDR",
              maximumFractionDigits: 0,
          }).format(n);

/** The eight inputs, in the order the sheet asks for them. */
const FIELDS: { key: keyof Row; label: string; hint?: string }[] = [
    { key: "current_basic", label: "Current basic" },
    { key: "increase_pct", label: "Increase %", hint: "per person" },
    { key: "current_gross", label: "Current gross", hint: "before tax" },
    { key: "additional_gross", label: "Extra gross" },
    { key: "bpjs_employment", label: "BPJS TK" },
    { key: "bpjs_health", label: "BPJS Kes" },
    { key: "income_tax", label: "Income tax" },
];

/** Fields saved as text rather than as a number. */
const TEXT_FIELDS: ReadonlySet<keyof Row> = new Set<keyof Row>(["tax_bearer"]);

/** The server's totals, recomputed from rows so a save need not refetch. */
function sumTotals(rows: Row[]): Totals {
    const sum = (pick: (r: Row) => number | null, where: (r: Row) => boolean = () => true) =>
        Math.round(rows.filter(where).reduce((n, r) => n + (pick(r) ?? 0), 0) * 100) / 100;

    return {
        roster_annual: sum((r) => r.annual_cost_with_bonus, (r) => r.work_pattern === "roster"),
        office_annual: sum((r) => r.annual_cost_with_bonus, (r) => r.work_pattern !== "roster"),
        bonus_total: sum((r) => r.bonus_amount),
        annual_total: sum((r) => r.annual_cost_with_bonus),
        monthly_total: sum((r) => r.monthly_cost),
        people: rows.length,
    };
}

export default function CompensationPage() {
    const { user } = useAuth();
    const mayBeHere =
        Boolean(user?.is_superuser) ||
        Boolean(user?.is_management) ||
        user?.role === "director" ||
        user?.role === "executive";

    const nextYear = new Date().getFullYear() + 1;
    const [year, setYear] = useState(nextYear);
    const [rows, setRows] = useState<Row[]>([]);
    const [totals, setTotals] = useState<Totals | null>(null);
    const [rate, setRate] = useState<Rate | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get<{ items: Row[]; totals: Totals; rate: Rate | null }>(
                "/compensation",
                { params: { year } },
            );
            setRows(res.data.items);
            setTotals(res.data.totals);
            setRate(res.data.rate);
        } catch {
            setError("Could not load the forecast.");
        } finally {
            setLoading(false);
        }
    }, [year]);

    useEffect(() => {
        if (mayBeHere) void load();
        else setLoading(false);
    }, [mayBeHere, load]);

    /*
     * Merge the saved row rather than reloading the list.
     *
     * Every field used to call load(), which replaced all ten rows. React then
     * remounted the inputs — which are uncontrolled, so they took their
     * defaultValue again — and the page jumped back to the top. Nurhuda, part
     * way down Bintang's line: "kayak ke refresh dan keubah gt posisi
     * viewingnya."
     *
     * The PUT already returns the row with every derived figure recomputed
     * server-side, so one row changes and the rest are left exactly as they
     * are. The totals are then summed here from the same numbers the server
     * would have summed.
     */
    const save = async (row: Row, field: keyof Row, raw: string) => {
        // Tax borne by is a choice, not a figure. Read as a number it came to
        // NaN, the save gave up without a word, and the select snapped back
        // to "—" -- Nurhuda: "tax borne by gak bisa dipilih".
        const value: number | string | null =
            raw.trim() === "" ? null : TEXT_FIELDS.has(field) ? raw : Number(raw);
        if (typeof value === "number" && !Number.isFinite(value)) return;
        setBusy(row.employee_id);
        setError(null);
        try {
            const res = await api.put<Row>(
                `/compensation/${row.employee_id}`,
                { [field]: value },
                { params: { year } },
            );
            setRows((prev) => {
                const next = prev.map((r) =>
                    r.employee_id === row.employee_id
                        ? // The PUT response carries no KPI figures — they are
                          // read-only context, not part of what was saved — so
                          // the row's own are kept.
                          {
                              ...res.data,
                              kpi_period: r.kpi_period,
                              kpi_score: r.kpi_score,
                              kpi_band: r.kpi_band,
                              kpi_multiplier: r.kpi_multiplier,
                          }
                        : r,
                );
                setTotals(sumTotals(next));
                return next;
            });
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data
                ?.detail;
            setError(typeof detail === "string" ? detail : "That did not save.");
        } finally {
            setBusy(null);
        }
    };

    if (user && !mayBeHere) return <Navigate to="/" replace />;

    return (
        <div className="dtg-fade-in space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Compensation</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                        Pay forecast
                    </h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        What raising salaries and paying bonuses would cost for the year. KPI
                        scores come from each person's published achievement and are read-only
                        here — a score is an input to the decision, not the decision.
                    </p>
                </div>
                <select
                    value={year}
                    onChange={(e) => setYear(Number(e.target.value))}
                    className="dtg-input w-32"
                >
                    {[nextYear - 1, nextYear, nextYear + 1].map((y) => (
                        <option key={y} value={y}>
                            {y}
                        </option>
                    ))}
                </select>
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {/* The answer first. */}
            {totals && (
                <section className="dtg-panel grid grid-cols-2 divide-x divide-white/[0.06] lg:grid-cols-5">
                    {[
                        {
                            label: "Annual total",
                            value: rp(totals.annual_total),
                            aud: totals.annual_total,
                            strong: true,
                        },
                        { label: "Per month", value: rp(totals.monthly_total) },
                        { label: "Rotating crew", value: rp(totals.roster_annual) },
                        { label: "Office staff", value: rp(totals.office_annual) },
                        { label: "Bonuses", value: rp(totals.bonus_total) },
                    ].map((t) => (
                        <div key={t.label} className="px-4 py-4">
                            <p className="dtg-eyebrow">{t.label}</p>
                            <p
                                className={`mt-2 font-mono leading-none ${
                                    t.strong
                                        ? "text-xl font-bold text-paper"
                                        : "text-base text-paper-soft"
                                }`}
                            >
                                {t.value}
                            </p>
                            {/* Dollars for the parent company. Only where a
                                rate was actually obtained — a converted figure
                                nobody can vouch for is worse than none. */}
                            {t.aud !== undefined && rate && (
                                <p className="mt-1 font-mono text-micro text-teal-200">
                                    {aud(t.aud, rate)}
                                </p>
                            )}
                        </div>
                    ))}
                </section>
            )}

            {loading ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : (
                <div className="space-y-3">
                    {rows.map((r) => (
                        <article key={r.employee_id} className="dtg-panel overflow-hidden">
                            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-3">
                                <div>
                                    <p className="text-sm font-semibold text-paper">
                                        {r.employee_name}
                                        {r.bonus_eligible && (
                                            <span className="ml-2 rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-micro font-semibold uppercase tracking-label text-gold">
                                                Bonus
                                            </span>
                                        )}
                                    </p>
                                    <p className="mt-0.5 text-micro text-muted">
                                        {r.position}
                                        {r.kpi_score !== null && (
                                            <>
                                                {" · "}
                                                <span className="text-teal-200">
                                                    KPI {r.kpi_score.toFixed(1)}
                                                    {r.kpi_band ? ` · ${r.kpi_band}` : ""}
                                                    {r.kpi_multiplier !== null
                                                        ? ` · ×${r.kpi_multiplier}`
                                                        : ""}
                                                </span>
                                            </>
                                        )}
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="font-mono text-base font-bold text-paper">
                                        {rp(r.annual_cost_with_bonus)}
                                    </p>
                                    {/* A marker rather than a disabled row.
                                        Disabling the fields mid-save took the
                                        focus off whichever one Tab had just
                                        reached, and the next thing typed went
                                        nowhere. */}
                                    <p className="text-micro text-muted">
                                        {busy === r.employee_id ? "Saving…" : "a year, all in"}
                                    </p>
                                </div>
                            </header>

                            <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 sm:grid-cols-4 lg:grid-cols-7">
                                {FIELDS.map((f) => (
                                    <label key={f.key} className="block">
                                        <span className="dtg-eyebrow">{f.label}</span>
                                        {f.key === "increase_pct" ? (
                                            <input
                                                type="number"
                                                defaultValue={(r[f.key] as number | null) ?? ""}
                                                onBlur={(e) => {
                                                    const before = (r[f.key] as number | null) ?? "";
                                                    if (String(before) !== e.target.value) {
                                                        void save(r, f.key, e.target.value);
                                                    }
                                                }}
                                                className="dtg-input mt-1 w-full font-mono text-xs"
                                            />
                                        ) : (
                                            // Money, grouped as it is written: 8.000.000.
                                            <div className="mt-1">
                                                <MoneyInput
                                                    value={r[f.key] as number | null}
                                                    prefix={null}
                                                    placeholder=""
                                                    onCommit={(raw) => {
                                                        const before = (r[f.key] as number | null) ?? "";
                                                        if (String(before) !== raw) {
                                                            void save(r, f.key, raw);
                                                        }
                                                    }}
                                                    className="dtg-input w-full text-xs"
                                                />
                                            </div>
                                        )}
                                        {f.hint && (
                                            <span className="mt-0.5 block text-micro text-muted">
                                                {f.hint}
                                            </span>
                                        )}
                                    </label>
                                ))}

                                <label className="block">
                                    <span className="dtg-eyebrow">Tax borne by</span>
                                    <select
                                        value={r.tax_bearer ?? ""}
                                        onChange={(e) =>
                                            void save(r, "tax_bearer", e.target.value)
                                        }
                                        className="dtg-input mt-1 w-full text-xs"
                                    >
                                        <option value="">—</option>
                                        <option value="company">Company</option>
                                        <option value="employee">Employee</option>
                                    </select>
                                    <span className="mt-0.5 block text-micro text-muted">
                                        counts only if company
                                    </span>
                                </label>
                            </div>

                            {/* Bonus, only where one exists. */}
                            {r.bonus_eligible && (
                                <div className="flex flex-wrap items-end gap-4 border-t border-white/[0.06] px-5 py-3">
                                    <label className="block">
                                        <span className="dtg-eyebrow">Bonus paid</span>
                                        <div className="mt-1 w-48">
                                            <MoneyInput
                                                value={r.bonus_amount}
                                                placeholder=""
                                                onCommit={(raw) => {
                                                    if (String(r.bonus_amount ?? "") !== raw) {
                                                        void save(r, "bonus_amount", raw);
                                                    }
                                                }}
                                                className="dtg-input w-full text-xs"
                                            />
                                        </div>
                                    </label>
                                    <p className="pb-2 text-micro text-muted">
                                        Typed in, not calculated. The multiplier
                                        {r.kpi_multiplier !== null ? ` (×${r.kpi_multiplier})` : ""}{" "}
                                        is a recommendation; what is actually paid is a decision.
                                    </p>
                                </div>
                            )}

                            {/* The working, so a total is never just a number. */}
                            <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-white/[0.06] bg-white/[0.02] px-5 py-2.5 font-mono text-micro text-muted">
                                <span>
                                    basic {rp(r.current_basic)} → {rp(r.proposed_basic)}
                                </span>
                                <span>
                                    gross {rp(r.current_gross)} → {rp(r.proposed_gross)}
                                </span>
                                <span>monthly cost {rp(r.monthly_cost)}</span>
                                <span>× 12 = {rp(r.annual_cost)}</span>
                            </div>
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}
