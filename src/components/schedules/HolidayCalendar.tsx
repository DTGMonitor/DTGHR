import { useEffect, useMemo, useState } from "react";
import { scheduleService } from "@/services/scheduleService";
import type { PublicHoliday } from "@/types/schedule";
import { isoDate } from "@/lib/dates";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * The whole year's Indonesian holiday calendar: twelve month tiles with each
 * holiday marked, national in green and cuti bersama in amber, and the names
 * listed underneath. Weeks start on Monday, as they do on the SKB calendar.
 */
export default function HolidayCalendar({ years, initialYear }: { years: number[]; initialYear: number }) {
    const [year, setYear] = useState<number>(years.includes(initialYear) ? initialYear : years[0] ?? initialYear);
    const [holidays, setHolidays] = useState<PublicHoliday[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        scheduleService
            .publicHolidays(year)
            .then((res) => !cancelled && setHolidays(res.data))
            .catch(() => !cancelled && setHolidays([]))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [year]);

    const byDate = useMemo(() => new Map(holidays.map((h) => [h.date, h])), [holidays]);
    const national = holidays.filter((h) => h.is_national).length;
    const todayIso = isoDate(new Date());

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5">
                    {years.map((y) => (
                        <button
                            key={y}
                            onClick={() => setYear(y)}
                            className={`rounded-md px-3 py-1 text-xs font-medium transition ${y === year ? "bg-indigo-500/25 text-indigo-200" : "text-gray-400 hover:text-gray-200"}`}
                        >
                            {y}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-4 text-[11px] text-gray-400">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500/70" /> {national} libur nasional
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm bg-amber-500/60" /> {holidays.length - national} cuti bersama
                    </span>
                </div>
            </div>

            {loading ? (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                    {[...Array(12)].map((_, i) => (
                        <div key={i} className="h-48 animate-pulse rounded-xl bg-white/5" />
                    ))}
                </div>
            ) : holidays.length === 0 ? (
                <p className="mt-4 text-sm text-gray-500">No holidays on file for {year}.</p>
            ) : (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                    {Array.from({ length: 12 }, (_, month) => (
                        <MonthTile
                            key={month}
                            year={year}
                            month={month}
                            byDate={byDate}
                            todayIso={todayIso}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function MonthTile({
    year,
    month,
    byDate,
    todayIso,
}: {
    year: number;
    month: number;
    byDate: Map<string, PublicHoliday>;
    todayIso: string;
}) {
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // Monday-first
    const cells: (number | null)[] = [
        ...Array<null>(lead).fill(null),
        ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ];
    const iso = (day: number) => isoDate(new Date(year, month, day));
    const inMonth = Array.from({ length: daysInMonth }, (_, i) => byDate.get(iso(i + 1))).filter(
        (h): h is PublicHoliday => !!h
    );

    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5">
            <p className="mb-1.5 text-xs font-semibold text-gray-300">
                {first.toLocaleDateString("en-GB", { month: "long" })}
            </p>
            <div className="grid grid-cols-7 gap-px text-center text-[9px]">
                {WEEKDAYS.map((w, i) => (
                    <span key={i} className={i >= 5 ? "text-gray-500" : "text-gray-600"}>
                        {w}
                    </span>
                ))}
                {cells.map((day, i) => {
                    if (day === null) return <span key={`x${i}`} />;
                    const h = byDate.get(iso(day));
                    const weekend = i % 7 >= 5;
                    const isToday = iso(day) === todayIso;
                    return (
                        <span
                            key={day}
                            title={h ? `${h.name}${h.is_national ? "" : " (cuti bersama)"}` : undefined}
                            className={`rounded-sm py-0.5 ${h?.is_national
                                ? "bg-emerald-500/70 font-bold text-black"
                                : h
                                    ? "bg-amber-500/60 font-bold text-black"
                                    : weekend
                                        ? "text-gray-500"
                                        : "text-gray-400"
                                } ${isToday ? "outline outline-1 outline-indigo-400" : ""}`}
                        >
                            {day}
                        </span>
                    );
                })}
            </div>
            {inMonth.length > 0 && (
                <ul className="mt-2 space-y-0.5 border-t border-white/5 pt-1.5">
                    {inMonth.map((h) => (
                        <li key={h.id} className="flex gap-1.5 text-[10px] leading-tight text-gray-400">
                            <span className={`w-4 flex-shrink-0 text-right font-semibold ${h.is_national ? "text-emerald-300" : "text-amber-300"}`}>
                                {Number(h.date.slice(8))}
                            </span>
                            <span className="truncate" title={h.name}>{h.name}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
