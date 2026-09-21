import { SHIFT_STYLES, type ShiftCode } from "@/types/schedule";

export interface OverviewDay {
    date: string;
    code: string | null;
    label: string | null;
    holiday: string | null;
    is_today: boolean;
}

/*
 * The next seven days, as a row of cards.
 *
 * This is the question people actually arrive with -- "am I on tonight?" --
 * and it was nowhere on the dashboard. The colours are the roster's own, so
 * the strip and the full grid say the same thing in the same language rather
 * than inventing a second palette for the same codes.
 */
export default function WeekStrip({ days }: { days: OverviewDay[] }) {
    if (!days.length) {
        return (
            <p className="px-5 py-8 text-center text-sm text-muted">
                No roster row is linked to your account yet.
            </p>
        );
    }

    return (
        <div className="grid grid-cols-7 gap-1.5 p-3 sm:gap-2 sm:p-4">
            {days.map((d) => {
                const date = new Date(`${d.date}T00:00:00`);
                const style = d.code ? SHIFT_STYLES[d.code as ShiftCode] : undefined;
                const off = !d.code || d.code === "O" || d.code === "B";

                return (
                    <div
                        key={d.date}
                        className={`rounded-lg border p-2 text-center transition-colors ${
                            d.is_today
                                ? "border-signal/60 bg-signal/[0.07]"
                                : "border-white/[0.08] bg-white/[0.02]"
                        }`}
                        title={
                            [d.label, d.holiday].filter(Boolean).join(" · ") ||
                            "Not rostered"
                        }
                    >
                        <p
                            className={`text-[0.6rem] font-semibold uppercase tracking-wider ${
                                d.is_today ? "text-signal" : "text-muted"
                            }`}
                        >
                            {date.toLocaleDateString("en-GB", { weekday: "short" })}
                        </p>
                        <p className="mt-0.5 font-mono text-base font-semibold leading-none text-paper">
                            {date.getDate()}
                        </p>

                        <div className="mt-2 flex h-7 items-center justify-center">
                            {d.code && style ? (
                                <span
                                    className="inline-flex h-7 w-full items-center justify-center rounded text-[0.65rem] font-bold"
                                    style={{ background: style.bg, color: style.fg }}
                                >
                                    {d.code}
                                </span>
                            ) : (
                                <span
                                    className={`text-xs ${off ? "text-muted" : "text-paper-soft"}`}
                                    aria-label="Not rostered"
                                >
                                    –
                                </span>
                            )}
                        </div>

                        {/* A public holiday matters even on a day you are not
                            rostered, so it is marked regardless of the code. */}
                        {d.holiday && (
                            <p
                                className="mt-1 truncate text-[0.55rem] leading-tight text-gold"
                                title={d.holiday}
                            >
                                {d.holiday}
                            </p>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
