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

    /*
     * The legend follows the week, not the codebook.
     *
     * Nurhuda: do not explain night shift in a week with no night shift. The
     * full roster has a thirteen-code key because it has to; here only what
     * the person is actually working is worth a line, so the legend is built
     * from the days on screen and disappears entirely on a week with nothing
     * in it.
     */
    const codes = [...new Set(days.map((d) => d.code).filter((c): c is string => !!c))];

    /*
     * The strip fills whatever height the panel is given.
     *
     * The panel sits in a grid row beside the leave and approvals tiles, which
     * stack taller than it, so seven small cards left a band of empty navy
     * underneath them. Rather than shrink the panel -- the row would go ragged
     * -- the cards stretch into the space, and the shift block grows with them
     * into something you can read across the room.
     */
    return (
        <div className="flex h-full flex-col">
        <div className="grid flex-1 grid-cols-7 gap-1.5 p-3 sm:gap-2 sm:p-4">
            {days.map((d) => {
                const date = new Date(`${d.date}T00:00:00`);
                const style = d.code ? SHIFT_STYLES[d.code as ShiftCode] : undefined;
                const off = !d.code || d.code === "O" || d.code === "B";

                return (
                    <div
                        key={d.date}
                        className={`flex flex-col rounded-lg border p-2.5 text-center transition-colors ${
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
                            className={`text-[0.65rem] font-semibold uppercase tracking-wider ${
                                d.is_today ? "text-signal" : "text-muted"
                            }`}
                        >
                            {date.toLocaleDateString("en-GB", { weekday: "short" })}
                        </p>
                        <p className="mt-1 font-mono text-xl font-bold leading-none text-paper sm:text-2xl">
                            {date.getDate()}
                        </p>

                        {/* The shift block takes the rest of the card, so the
                            week reads as a bar chart of colour before you have
                            read a single letter. */}
                        <div className="mt-2.5 flex min-h-[2.25rem] flex-1 items-stretch justify-center">
                            {d.code && style ? (
                                <span
                                    className="inline-flex w-full items-center justify-center rounded-md text-sm font-bold"
                                    style={{ background: style.bg, color: style.fg }}
                                >
                                    {d.code}
                                </span>
                            ) : (
                                <span
                                    className={`flex w-full items-center justify-center rounded-md border border-dashed border-white/[0.08] text-sm ${
                                        off ? "text-muted" : "text-paper-soft"
                                    }`}
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
                                className="mt-1.5 truncate text-[0.6rem] leading-tight text-gold"
                                title={d.holiday}
                            >
                                {d.holiday}
                            </p>
                        )}
                    </div>
                );
            })}
        </div>

        {codes.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.06] px-4 py-3">
                {codes.map((code) => {
                    const style = SHIFT_STYLES[code as ShiftCode];
                    const label = days.find((d) => d.code === code)?.label ?? code;
                    return (
                        <span key={code} className="flex items-center gap-2">
                            <span
                                className="inline-flex h-5 w-7 items-center justify-center rounded text-[0.6rem] font-bold"
                                style={
                                    style
                                        ? { background: style.bg, color: style.fg }
                                        : { background: "rgba(255,255,255,0.08)" }
                                }
                            >
                                {code}
                            </span>
                            <span className="text-xs text-muted">{label}</span>
                        </span>
                    );
                })}
            </div>
        )}
        </div>
    );
}
