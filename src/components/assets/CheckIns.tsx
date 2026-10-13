import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";

import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import { useDialog } from "@/components/ui/Dialog";
import { assetService, type Round, type RoundSummary } from "@/services/assetService";
import { CHECKIN_CHIP, day, detail, when } from "./labels";

/*
 * Check-in rounds. IT starts one; every holder answers for what they hold;
 * IT marks what is on the shelf or away for repair; IT closes it. A closed
 * round is the record that, on that date, everything was where the register
 * said -- or a list of what was not. Finance and management read them.
 */

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function CheckIns({
    roundId,
    onOpenRound,
    onOpenAsset,
}: {
    roundId: string | null;
    onOpenRound: (id: string | null) => void;
    onOpenAsset: (id: string) => void;
}) {
    const dialog = useDialog();
    const [rounds, setRounds] = useState<RoundSummary[] | null>(null);
    const [canManage, setCanManage] = useState(false);
    const [lastStarted, setLastStarted] = useState<string | null>(null);
    const [round, setRound] = useState<Round | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [name, setName] = useState("");
    const [due, setDue] = useState(isoDay(new Date(Date.now() + 14 * 86_400_000)));

    const load = useCallback(async () => {
        try {
            const res = await assetService.rounds();
            setRounds(res.data.items);
            setCanManage(res.data.can_manage);
            setLastStarted(res.data.last_started_at);
        } catch (e) {
            setError(detail(e, "Could not load the check-ins."));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // The round open on screen: the one in the URL, else the open one.
    const open = rounds?.find((r) => r.is_open) ?? null;
    const shownId = roundId ?? open?.id ?? null;
    useEffect(() => {
        if (!shownId) {
            setRound(null);
            return;
        }
        assetService
            .round(shownId)
            .then((res) => setRound(res.data))
            .catch((e) => setError(detail(e, "Could not load that round.")));
    }, [shownId]);

    const start = async () => {
        try {
            const res = await assetService.startRound(name.trim() || undefined, due);
            setRound(res.data);
            setStarting(false);
            setName("");
            onOpenRound(res.data.id);
            await load();
        } catch (e) {
            setError(detail(e, "Could not start the round."));
        }
    };

    const close = async (r: Round) => {
        const pending = r.counts.pending;
        if (!(await dialog.confirm({
            title: `Close ${r.name}`,
            body:
                pending > 0
                    ? `${pending} item${pending === 1 ? " is" : "s are"} still waiting and will be recorded as no reply. The round cannot be reopened.`
                    : "Everything has been answered. The round is kept as it is now and cannot be reopened.",
            confirmLabel: "Close round",
        }))) return;
        try {
            setRound((await assetService.closeRound(r.id)).data);
            await load();
        } catch (e) {
            setError(detail(e, "Could not close the round."));
        }
    };

    const seen = async (itemId: string) => {
        try {
            setRound((await assetService.markSeen(itemId)).data);
            await load();
        } catch (e) {
            setError(detail(e, "Could not mark that."));
        }
    };

    if (rounds === null) {
        return (
            <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading…
            </div>
        );
    }

    const overdue = round?.is_open && round.due_date < isoDay(new Date());

    return (
        <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}

            {canManage && !open && (
                <div className="dtg-panel px-5 py-4">
                    {!starting ? (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-sm text-paper-soft">
                                {lastStarted
                                    ? `The last check-in started on ${day(lastStarted)}.`
                                    : "No check-in has been run yet."}{" "}
                                Every holder is asked to confirm what they have.
                            </p>
                            <button type="button" onClick={() => setStarting(true)} className="dtg-btn-primary">
                                <ClipboardCheck className="h-4 w-4" />
                                Start a check-in
                            </button>
                        </div>
                    ) : (
                        <div className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
                            <div>
                                <label className="dtg-label">Name</label>
                                <input
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder={`Check-in ${new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" })}`}
                                    maxLength={120}
                                    className="dtg-input"
                                />
                            </div>
                            <div>
                                <label className="dtg-label">Answer by</label>
                                <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="dtg-input" />
                            </div>
                            <div className="flex gap-2">
                                <button type="button" onClick={() => void start()} className="dtg-btn-primary">
                                    Start
                                </button>
                                <button type="button" onClick={() => setStarting(false)} className="dtg-btn-secondary">
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {round && (
                <section className="dtg-panel overflow-hidden">
                    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.08] px-5 py-4">
                        <div>
                            <p className="dtg-eyebrow">{round.is_open ? "Open check-in" : "Closed check-in"}</p>
                            <h2 className="mt-1 text-base font-semibold text-paper">{round.name}</h2>
                            <p className="mt-0.5 text-micro text-muted">
                                Started {when(round.started_at)}
                                {round.started_by_name && ` by ${round.started_by_name}`} · answer by {day(round.due_date)}
                                {overdue && <span className="text-danger"> · overdue</span>}
                                {round.closed_at &&
                                    ` · closed ${when(round.closed_at)}${round.closed_by_name ? ` by ${round.closed_by_name}` : ""}`}
                            </p>
                        </div>
                        {round.is_open && round.can_manage && (
                            <button type="button" onClick={() => void close(round)} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                                Close round
                            </button>
                        )}
                    </header>

                    <div className="flex flex-wrap gap-4 border-b border-white/[0.08] px-5 py-3 text-sm">
                        {(["confirmed", "missing", "seen", round.is_open ? "pending" : "no_reply"] as const).map((k) => (
                            <span key={k} className="text-paper-soft">
                                <span className="font-mono text-base font-bold text-paper">{round.counts[k]}</span>{" "}
                                {CHECKIN_CHIP[k].label.toLowerCase()}
                            </span>
                        ))}
                        <span className="text-muted">of {round.counts.total}</span>
                    </div>

                    <ul className="divide-y divide-white/[0.06]">
                        {round.items.map((i) => (
                            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5">
                                <button type="button" onClick={() => onOpenAsset(i.asset_id)} className="min-w-0 text-left">
                                    <p className="text-sm text-paper">
                                        <span className="font-mono text-micro text-muted">{i.tag}</span> {i.name}
                                    </p>
                                    <p className="text-micro text-muted">
                                        {i.holder_name ?? "Unheld: for IT"}
                                        {i.responded_by_name && ` · ${i.responded_by_name}, ${when(i.responded_at!)}`}
                                        {i.note && ` · “${i.note}”`}
                                    </p>
                                </button>
                                <div className="flex items-center gap-2">
                                    {round.is_open && round.can_manage && i.state === "pending" && !i.holder_employee_id && (
                                        <button type="button" onClick={() => void seen(i.id)} className="dtg-btn-secondary px-2.5 py-1 text-xs">
                                            Seen
                                        </button>
                                    )}
                                    <span className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${CHECKIN_CHIP[i.state].cls}`}>
                                        {CHECKIN_CHIP[i.state].label}
                                    </span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {rounds.length > 0 && (
                <div className="dtg-panel overflow-hidden">
                    <p className="dtg-eyebrow border-b border-white/[0.08] px-5 py-3">All check-ins</p>
                    <ul className="divide-y divide-white/[0.06]">
                        {rounds.map((r) => (
                            <li key={r.id}>
                                <button
                                    type="button"
                                    onClick={() => onOpenRound(r.id)}
                                    className={`flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3 text-left transition hover:bg-white/[0.03] ${
                                        r.id === round?.id ? "bg-white/[0.04]" : ""
                                    }`}
                                >
                                    <span className="text-sm text-paper">
                                        {r.name}
                                        {r.is_open && (
                                            <span className="ml-2 rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-micro font-semibold uppercase tracking-label text-gold">
                                                Open
                                            </span>
                                        )}
                                    </span>
                                    <span className="text-micro text-muted">
                                        {day(r.started_at)} · {r.counts.confirmed + r.counts.seen}/{r.counts.total} accounted for
                                        {r.counts.missing > 0 && ` · ${r.counts.missing} missing`}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {rounds.length === 0 && !canManage && (
                <div className="dtg-panel px-5 py-14 text-center text-sm text-paper-soft">No check-in has been run yet.</div>
            )}
        </div>
    );
}
