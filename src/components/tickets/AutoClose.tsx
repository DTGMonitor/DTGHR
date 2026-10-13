import { useState } from "react";
import { Clock } from "lucide-react";

import { ticketService, type Ticket } from "@/services/ticketService";

/*
 * A waiting or resolved ticket closes on its own after 5 days without an
 * update. This says when, and lets the reporter or IT keep it open longer:
 * 5 more days, 10 more, or to a date, up to 30 days from today. The server
 * holds the same limits; these only keep the choices inside them.
 */

const DAY = 86_400_000;
const MAX_DAYS = 30;

const longDate = (d: Date) =>
    d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "Closes in 3 days", "Closes within a day", "Closes within the hour". */
export function closesIn(iso: string): string {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 3_600_000) return "Closes within the hour";
    if (ms <= DAY) return "Closes within a day";
    return `Closes in ${Math.ceil(ms / DAY)} days`;
}

const dateInput = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function AutoClose({
    ticket,
    onChange,
    onError,
}: {
    ticket: Ticket;
    onChange: (t: Ticket) => void;
    onError: (e: unknown) => void;
}) {
    const [open, setOpen] = useState(false);
    const [date, setDate] = useState("");
    const [reason, setReason] = useState("");
    const [saving, setSaving] = useState(false);

    if (!ticket.auto_close_at) return null;
    const deadline = new Date(ticket.auto_close_at);
    const now = Date.now();
    const latest = now + MAX_DAYS * DAY - 60_000;
    const from = Math.max(deadline.getTime(), now);
    const plus = (days: number) => from + days * DAY;

    const save = async (until: number) => {
        setSaving(true);
        try {
            const res = await ticketService.extend(
                ticket.id,
                new Date(Math.min(until, latest)).toISOString(),
                reason.trim() || undefined,
            );
            onChange(res.data);
            setOpen(false);
            setDate("");
            setReason("");
        } catch (e) {
            onError(e);
        } finally {
            setSaving(false);
        }
    };

    // A chosen date means the end of that day, or the 30-day limit if sooner.
    const chosen = date ? new Date(`${date}T23:59:00`).getTime() : null;

    return (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-xs text-paper-soft">
                    <Clock className="h-3.5 w-3.5 text-gold" />
                    <span>
                        <span className="font-semibold text-paper">{closesIn(ticket.auto_close_at)}</span>
                        {" · "}
                        {longDate(deadline)}, unless there is an update
                    </span>
                </p>
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className="text-xs font-semibold text-signal transition hover:text-paper"
                >
                    {open ? "Cancel" : "Keep open longer"}
                </button>
            </div>

            {open && (
                <div className="mt-3 space-y-2.5 border-t border-white/[0.08] pt-3">
                    <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={500}
                        placeholder="Why, optional: e.g. on site until the 20th"
                        className="dtg-input w-full text-xs"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                        {[5, 10].map((n) => (
                            <button
                                key={n}
                                type="button"
                                disabled={saving || plus(n) > latest}
                                onClick={() => void save(plus(n))}
                                className="dtg-btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
                                title={plus(n) > latest ? "Beyond 30 days from today" : longDate(new Date(plus(n)))}
                            >
                                +{n} days
                            </button>
                        ))}
                        <span className="text-micro text-muted">or until</span>
                        <input
                            type="date"
                            value={date}
                            min={dateInput(new Date(from + DAY))}
                            max={dateInput(new Date(latest))}
                            onChange={(e) => setDate(e.target.value)}
                            className="dtg-input px-2 py-1 text-xs"
                        />
                        <button
                            type="button"
                            disabled={saving || chosen === null || chosen <= deadline.getTime()}
                            onClick={() => chosen !== null && void save(chosen)}
                            className="dtg-btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                        >
                            Keep open
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
