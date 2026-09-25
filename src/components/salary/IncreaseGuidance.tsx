import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Alert from "@/components/ui/Alert";
import {
    BAND_CODES,
    BAND_NAMES,
    salaryGuidanceService,
    type AnnualAverage,
    type GuidanceData,
} from "@/services/salaryGuidanceService";

/*
 * Increase guidance.
 *
 * Nurhuda, September 2026, after trying a baseline built from the economy:
 * the increase is set by KPI band, from a table management keeps by hand --
 * "yg dibawah 2M 3%, yg 2H itu 5% dan 3 itu 7%" to start -- and the table
 * below applies it to each person once their scorecard is approved. Inflation
 * alone is too small to be an offer, and a business has to keep a margin.
 *
 * Indonesia CPI and AUD->IDR stay here as a second point of view for Peter,
 * never in the figure. Each is the average of the last twelve year-on-year
 * changes: comparing one month with the same month a year earlier gave a
 * different answer for every month picked -- January to January is not
 * February to February -- and an average of twelve does not swing with the
 * choice. It opens on the latest month BPS has published; a different end
 * month can be picked, and the twelve months are listed underneath.
 *
 * Both are gathered automatically -- CPI from BPS, AUD->IDR from the ECB --
 * and there is no form to type figures in: Nurhuda asked what the old one
 * was for, and with both sources automatic it only invited a question.
 *
 * "CPI", not "inflation", on the labels: it is the word Peter uses. In
 * Australia the headline inflation figure is called the CPI.
 */

export interface MarketReference {
    /** One line of the comparison, for a review's rationale. Empty until loaded. */
    explain: string;
}

const monthName = (iso: string) =>
    new Date(`${iso.slice(0, 7)}-01T00:00:00`).toLocaleDateString("en-GB", {
        month: "short",
        year: "numeric",
    });

const pct = (v: number | null, signed = false) =>
    v === null ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(2).replace(/\.?0+$/, "")}%`;

const rupiah = (v: number | null) => (v === null ? "—" : v.toLocaleString("id-ID"));

export default function IncreaseGuidance({
    onReference,
    onBandsSaved,
}: {
    onReference: (r: MarketReference) => void;
    /** The recommendations are worked out server-side, so the table reloads. */
    onBandsSaved: () => void;
}) {
    const [data, setData] = useState<GuidanceData | null>(null);
    /** "YYYY-MM", or "" for the latest month BPS has published. */
    const [end, setEnd] = useState("");
    const [year, setYear] = useState<AnnualAverage | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        const res = await salaryGuidanceService.data();
        setData(res.data);
    }, []);

    useEffect(() => {
        reload().catch(() => setError("Could not load the increase table."));
    }, [reload]);

    // The month picker fires on every step, so the request waits until the
    // choice has settled, and only the latest one may paint the cards. An
    // older one answering late once put August's figures under a January
    // range. On failure the cards go blank rather than keep a stale figure.
    const latest = useRef(0);

    useEffect(() => {
        const ticket = ++latest.current;
        const timer = setTimeout(
            () => {
                salaryGuidanceService
                    .annualAverage(end ? `${end}-01` : undefined)
                    .then((res) => {
                        if (ticket !== latest.current) return;
                        setError(null);
                        setYear(res.data);
                    })
                    .catch(() => {
                        if (ticket !== latest.current) return;
                        setYear(null);
                        setError("Could not load the CPI and exchange-rate figures.");
                    });
            },
            end ? 400 : 0,
        );
        return () => clearTimeout(timer);
    }, [end]);

    const range = year ? `${monthName(year.start)}–${monthName(year.end)}` : "";

    const reference = useMemo<MarketReference>(() => {
        if (!year) return { explain: "" };
        const parts = [
            year.cpi_average !== null && `Indonesia CPI ${pct(year.cpi_average, true)}`,
            year.aud_idr_average !== null && `AUD→IDR ${pct(year.aud_idr_average, true)}`,
        ].filter(Boolean);
        if (parts.length === 0) return { explain: "" };
        return {
            explain: `For comparison, 12-month averages ${range}: ${parts.join(", ")}.`,
        };
    }, [year, range]);

    useEffect(() => onReference(reference), [reference, onReference]);

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">Increase guidance</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">Increase by KPI band</h2>
                <p className="mt-1 max-w-2xl text-micro leading-relaxed text-muted">
                    Management&apos;s table. The KPI results below take the figure for their band
                    automatically once the scorecard is approved. Indonesia CPI and AUD→IDR are
                    a second point of view, and never enter the figure.
                </p>
            </header>

            <div className="space-y-5 p-5">
                {error && <Alert tone="danger">{error}</Alert>}

                {data && (
                    <BandTable
                        initial={data.band_increases}
                        onSaved={async () => {
                            await reload();
                            onBandsSaved();
                        }}
                        onError={setError}
                    />
                )}

                <div className="border-t border-white/[0.08] pt-4">
                    <div className="flex flex-wrap items-end justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-paper">Second point of view</p>
                            <p className="mt-0.5 max-w-xl text-micro leading-relaxed text-muted">
                                The average of the last twelve year-on-year changes, so the
                                figure does not depend on which month is picked. Gathered
                                automatically from BPS and the ECB.
                            </p>
                        </div>
                        <label className="block">
                            <span className="dtg-eyebrow">12 months ending</span>
                            <input
                                type="month"
                                value={end || (year ? year.end.slice(0, 7) : "")}
                                onChange={(e) => setEnd(e.target.value)}
                                className="dtg-input mt-1 w-44"
                            />
                        </label>
                    </div>

                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Card
                            title="Indonesia CPI — 12-month average"
                            value={pct(year?.cpi_average ?? null, true)}
                            detail={
                                year
                                    ? `Average of BPS's year-on-year CPI, ${range}.`
                                    : "Year-on-year consumer prices, from BPS."
                            }
                        />
                        <Card
                            title="AUD → IDR — 12-month average"
                            value={pct(year?.aud_idr_average ?? null, true)}
                            detail={
                                year
                                    ? `Average change against the same month a year before, ${range} (ECB). Positive: the rupiah weakened.`
                                    : "Year-on-year exchange rate, from the ECB."
                            }
                        />
                    </div>

                    {year && year.missing.length > 0 && (
                        <p className="mt-3 text-micro leading-relaxed text-gold">
                            Left out of the average, not published yet:{" "}
                            {year.missing.join(", ")}. BPS releases each month early the
                            following month.
                        </p>
                    )}

                    {year && (
                        <details className="mt-3">
                            <summary className="cursor-pointer text-micro font-semibold uppercase tracking-label text-teal-300 hover:text-teal-100">
                                Month by month
                            </summary>
                            <div className="mt-2 overflow-x-auto">
                                <table className="w-full min-w-[34rem] text-left font-mono text-micro">
                                    <thead className="uppercase tracking-label text-muted">
                                        <tr className="border-b border-white/[0.08]">
                                            <th className="py-1.5 pr-3 font-semibold">Month</th>
                                            <th className="py-1.5 pr-3 text-right font-semibold">
                                                CPI y/y
                                            </th>
                                            <th className="py-1.5 pr-3 text-right font-semibold">
                                                Rp per AUD, a year before
                                            </th>
                                            <th className="py-1.5 pr-3 text-right font-semibold">
                                                Rp per AUD
                                            </th>
                                            <th className="py-1.5 text-right font-semibold">
                                                AUD→IDR y/y
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="text-paper-soft">
                                        {year.months.map((m) => (
                                            <tr key={m.month} className="border-b border-white/[0.04]">
                                                <td className="py-1 pr-3">{monthName(m.month)}</td>
                                                <td className="py-1 pr-3 text-right">
                                                    {pct(m.cpi_yoy, true)}
                                                </td>
                                                <td className="py-1 pr-3 text-right text-muted">
                                                    {rupiah(m.aud_idr_year_before)}
                                                </td>
                                                <td className="py-1 pr-3 text-right text-muted">
                                                    {rupiah(m.aud_idr)}
                                                </td>
                                                <td className="py-1 text-right">
                                                    {pct(m.aud_idr_yoy, true)}
                                                </td>
                                            </tr>
                                        ))}
                                        <tr className="font-bold text-paper">
                                            <td className="pt-1.5 pr-3">Average</td>
                                            <td className="pt-1.5 pr-3 text-right">
                                                {pct(year.cpi_average, true)}
                                            </td>
                                            <td />
                                            <td />
                                            <td className="pt-1.5 text-right">
                                                {pct(year.aud_idr_average, true)}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </details>
                    )}
                </div>
            </div>
        </section>
    );
}

/** Management's percentage per band, edited in place. */
function BandTable({
    initial,
    onSaved,
    onError,
}: {
    initial: Record<string, number>;
    onSaved: () => Promise<void>;
    onError: (msg: string) => void;
}) {
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(BAND_CODES.map((c) => [c, String(initial[c] ?? 0)])),
    );
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const dirty = BAND_CODES.some((c) => Number(values[c] || 0) !== (initial[c] ?? 0));

    const save = async () => {
        setSaving(true);
        try {
            await salaryGuidanceService.saveBands(
                Object.fromEntries(BAND_CODES.map((c) => [c, Number(values[c] || 0)])),
            );
            await onSaved();
            setSaved(true);
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data
                ?.detail;
            onError(typeof detail === "string" ? detail : "Could not save the table.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            <div className="grid gap-2 sm:grid-cols-5">
                {BAND_CODES.map((code) => (
                    <label key={code} className="dtg-panel-inset block px-3.5 py-3">
                        <span className="dtg-eyebrow">Band {code}</span>
                        <span className="mt-0.5 block text-micro text-muted">{BAND_NAMES[code]}</span>
                        <span className="mt-2 flex items-center gap-1">
                            <input
                                type="number"
                                step="0.5"
                                min={0}
                                max={50}
                                value={values[code]}
                                onChange={(e) => {
                                    setSaved(false);
                                    setValues({ ...values, [code]: e.target.value });
                                }}
                                className="dtg-input w-full py-1.5 text-right font-mono text-lg font-bold text-signal"
                            />
                            <span className="font-mono text-sm text-muted">%</span>
                        </span>
                    </label>
                ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
                <button
                    onClick={() => void save()}
                    disabled={!dirty || saving}
                    className="dtg-btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
                >
                    {saving ? "Saving…" : "Save table"}
                </button>
                {saved && !dirty && (
                    <span className="text-micro text-signal">Saved and applied below.</span>
                )}
            </div>
        </div>
    );
}

/** One comparison figure. */
function Card({ title, value, detail }: { title: string; value: string; detail: string }) {
    return (
        <div className="dtg-panel-inset px-4 py-3.5">
            <p className="dtg-eyebrow">{title}</p>
            <p className="mt-1.5 font-mono text-2xl font-bold text-paper">{value}</p>
            <p className="mt-0.5 text-micro leading-relaxed text-muted">{detail}</p>
        </div>
    );
}
