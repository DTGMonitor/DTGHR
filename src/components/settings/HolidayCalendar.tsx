import { useCallback, useEffect, useState } from "react";

import { scheduleService } from "@/services/scheduleService";
import type { PublicHoliday } from "@/types/schedule";
import Spinner from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";

/*
 * The public holiday calendar, editable.
 *
 * Nurhuda: what happens when 2027 turns out wrong — Christmas slides from the
 * 25th to the 26th? This. And nothing else needs touching, because holiday
 * loading, the week strip and the roster's PH cells are all computed from this
 * table each time they are read rather than copied alongside the roster. Move
 * the date and somebody who was working an ordinary Saturday is working a
 * holiday, with the loading to match, on the next page load.
 *
 * Lunar and Hijri dates genuinely do move when the SKB for a future year is
 * finally published, and cuti bersama is announced late, so this is ordinary
 * maintenance rather than an escape hatch.
 */
/** "25 December 2026" */
function longDate(iso: string): string {
    return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

export default function HolidayCalendar() {
    const { confirm } = useDialog();
    const thisYear = new Date().getFullYear();
    const [year, setYear] = useState(thisYear);
    const [rows, setRows] = useState<PublicHoliday[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState({ date: "", name: "", is_national: true });

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await scheduleService.publicHolidays(year);
            setRows(res.data);
        } catch {
            setError("Could not load the holiday calendar.");
        } finally {
            setLoading(false);
        }
    }, [year]);

    useEffect(() => {
        void load();
    }, [load]);

    const act = async (key: string, fn: () => Promise<unknown>) => {
        setBusy(key);
        setError(null);
        try {
            await fn();
            await load();
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data
                ?.detail;
            setError(typeof detail === "string" ? detail : "That change did not save.");
        } finally {
            setBusy(null);
        }
    };

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-3.5">
                <div>
                    <p className="dtg-eyebrow">Calendar</p>
                    <h2 className="mt-0.5 text-sm font-semibold text-paper">Public holidays</h2>
                    <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted">
                        Moving a date here moves it everywhere — the roster, the week strip and
                        the holidays-worked column all read this table live.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={year}
                        onChange={(e) => setYear(Number(e.target.value))}
                        className="dtg-input w-28 text-xs"
                    >
                        {[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => (
                            <option key={y} value={y}>
                                {y}
                            </option>
                        ))}
                    </select>
                    {!adding && (
                        <button
                            onClick={() => {
                                setDraft({ date: `${year}-01-01`, name: "", is_national: true });
                                setAdding(true);
                            }}
                            className="dtg-btn-ghost px-3 py-1.5 text-xs"
                        >
                            Add
                        </button>
                    )}
                </div>
            </header>

            {error && (
                <p className="border-b border-danger/20 bg-danger/[0.06] px-5 py-2.5 text-xs text-danger">
                    {error}
                </p>
            )}

            {adding && (
                <div className="flex flex-wrap items-end gap-3 border-b border-white/[0.08] bg-white/[0.02] px-5 py-3.5">
                    <label className="block">
                        <span className="dtg-eyebrow">Date</span>
                        <input
                            type="date"
                            value={draft.date}
                            onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
                            className="dtg-input mt-1.5 w-44 text-xs"
                        />
                    </label>
                    <label className="block flex-1">
                        <span className="dtg-eyebrow">Name</span>
                        <input
                            value={draft.name}
                            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                            placeholder="Christmas Day"
                            className="dtg-input mt-1.5 w-full min-w-[12rem] text-xs"
                        />
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 pb-2 text-xs text-paper-soft">
                        <input
                            type="checkbox"
                            checked={draft.is_national}
                            onChange={(e) =>
                                setDraft((d) => ({ ...d, is_national: e.target.checked }))
                            }
                            className="h-3.5 w-3.5 rounded border-white/20 bg-transparent"
                        />
                        National holiday
                    </label>
                    <button
                        disabled={!draft.date || !draft.name || busy === "add"}
                        onClick={() =>
                            act("add", async () => {
                                await scheduleService.addHoliday(draft);
                                setAdding(false);
                            })
                        }
                        className="dtg-btn-primary mb-1 px-3 py-1.5 text-xs disabled:opacity-40"
                    >
                        Save
                    </button>
                    <button
                        onClick={() => setAdding(false)}
                        className="dtg-btn-ghost mb-1 px-3 py-1.5 text-xs"
                    >
                        Cancel
                    </button>
                </div>
            )}

            {loading ? (
                <div className="flex items-center gap-2.5 px-5 py-10 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : rows.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-muted">
                    Nothing on the calendar for {year}.
                </p>
            ) : (
                <ul className="divide-y divide-white/[0.05]">
                    {rows.map((h) => (
                        <li
                            key={h.id}
                            className="flex flex-wrap items-center gap-3 px-5 py-2.5 hover:bg-white/[0.02]"
                        >
                            <input
                                type="date"
                                value={h.date}
                                disabled={busy === h.id}
                                onChange={(e) =>
                                    act(h.id, () =>
                                        scheduleService.updateHoliday(h.id, {
                                            date: e.target.value,
                                        }),
                                    )
                                }
                                className="dtg-input w-40 flex-shrink-0 font-mono text-xs"
                            />
                            <input
                                defaultValue={h.name}
                                disabled={busy === h.id}
                                onBlur={(e) => {
                                    if (e.target.value !== h.name && e.target.value.trim()) {
                                        void act(h.id, () =>
                                            scheduleService.updateHoliday(h.id, {
                                                name: e.target.value,
                                            }),
                                        );
                                    }
                                }}
                                className="dtg-input min-w-[12rem] flex-1 text-xs"
                            />
                            <label className="flex cursor-pointer items-center gap-2 text-micro text-muted">
                                <input
                                    type="checkbox"
                                    checked={h.is_national}
                                    disabled={busy === h.id}
                                    onChange={(e) =>
                                        act(h.id, () =>
                                            scheduleService.updateHoliday(h.id, {
                                                is_national: e.target.checked,
                                            }),
                                        )
                                    }
                                    className="h-3.5 w-3.5 rounded border-white/20 bg-transparent"
                                />
                                {/* Only national holidays earn loading; cuti
                                    bersama is a day off the government granted,
                                    not a holiday somebody worked through. */}
                                National
                            </label>
                            <button
                                disabled={busy === h.id}
                                onClick={async () => {
                                    const ok = await confirm({
                                        title: `Remove ${h.name}?`,
                                        body: `${longDate(h.date)} stops being a public holiday everywhere in the Hub — the roster, the week strip and the holidays-worked column.`,
                                        confirmLabel: "Remove",
                                        tone: "danger",
                                    });
                                    if (!ok) return;
                                    void act(h.id, () => scheduleService.removeHoliday(h.id));
                                }}
                                className="dtg-btn-ghost px-2 py-1 text-micro text-danger"
                            >
                                Remove
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
