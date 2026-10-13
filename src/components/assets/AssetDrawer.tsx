import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Pencil } from "lucide-react";

import Alert from "@/components/ui/Alert";
import Drawer from "@/components/ui/Drawer";
import { useDialog } from "@/components/ui/Dialog";
import { assetService, type Asset, type AssetMove } from "@/services/assetService";
import type { ScheduleEmployee } from "@/types/schedule";
import { FLAG_LABEL, MOVES, STATUS_CHIP, day, daysSince, detail, money, when } from "./labels";

/*
 * One asset: what it is, who has it, everything that happened to it, and --
 * for IT -- the moves that apply to it now. The server says which moves those
 * are (`moves`); the drawer only asks for what each one needs.
 *
 * A holder opening their own item gets the same drawer with less in it: no
 * value, no location, and the history from when it became theirs. Their
 * buttons are the handover and the check-in.
 */

type Pending = { move: AssetMove; employeeId: string; location: string; note: string };

/** What each move asks for. A note is required where the server requires one. */
const NEEDS: Partial<Record<AssetMove, { person?: boolean; location?: boolean; noteRequired?: boolean; noteLabel: string }>> = {
    assign: { person: true, noteLabel: "Note for them (optional)" },
    transfer: { person: true, noteLabel: "Note for the new holder (optional)" },
    return: { location: true, noteLabel: "Note (optional)" },
    repair_out: { noteLabel: "What is wrong, where it went (optional)" },
    repair_back: { noteLabel: "What was done (optional)" },
    lost: { noteRequired: true, noteLabel: "What happened" },
    found: { location: true, noteLabel: "Note (optional)" },
    retire: { noteRequired: true, noteLabel: "Why it is retired" },
};

export default function AssetDrawer({
    asset,
    staff,
    onChange,
    onClose,
    onEdit,
}: {
    asset: Asset;
    staff: ScheduleEmployee[];
    onChange: (a: Asset) => void;
    onClose: () => void;
    onEdit?: (a: Asset) => void;
}) {
    const dialog = useDialog();
    const [pending, setPending] = useState<Pending | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const full = asset.moves !== undefined;

    const run = async (fn: () => Promise<{ data: Asset }>, fallback: string) => {
        setBusy(true);
        try {
            const res = await fn();
            onChange(res.data);
            setPending(null);
            setError(null);
        } catch (e) {
            setError(detail(e, fallback));
        } finally {
            setBusy(false);
        }
    };

    const submitMove = () => {
        if (!pending) return;
        const needs = NEEDS[pending.move] ?? { noteLabel: "" };
        if (needs.person && !pending.employeeId) {
            setError("Choose who has it.");
            return;
        }
        if (needs.noteRequired && !pending.note.trim()) {
            setError(`${needs.noteLabel} is needed.`);
            return;
        }
        const note = pending.note.trim() || undefined;
        if (pending.move === "assign" || pending.move === "transfer") {
            void run(() => assetService.assign(asset.id, pending.employeeId, note), "Could not assign it.");
        } else {
            void run(
                () =>
                    assetService.move(asset.id, pending.move as Exclude<AssetMove, "assign" | "transfer">, {
                        location: pending.location.trim() || undefined,
                        note,
                    }),
                "Could not do that.",
            );
        }
    };

    const confirmReceipt = async () => {
        if (!(await dialog.confirm({
            title: `Confirm you have ${asset.tag}`,
            body: "You become responsible for it until it is returned to IT or handed to someone else.",
            confirmLabel: "I have it",
        }))) return;
        void run(() => assetService.respond(asset.id, true), "Could not confirm that.");
    };

    const decline = async () => {
        const note = await dialog.prompt({
            title: `You did not receive ${asset.tag}?`,
            body: "Tell IT what happened, for example who still has it. It stays recorded against you until IT sorts it out.",
            multiline: true,
            required: true,
            confirmLabel: "Tell IT",
        });
        if (!note) return;
        void run(() => assetService.respond(asset.id, false, note), "Could not send that.");
    };

    const answer = async (haveIt: boolean) => {
        if (!asset.checkin) return;
        let note: string | null = null;
        if (!haveIt) {
            note = await dialog.prompt({
                title: `${asset.tag} is not with you`,
                body: "Where is it, or what happened to it? IT is told straight away.",
                multiline: true,
                required: true,
                confirmLabel: "Tell IT",
            });
            if (!note) return;
        }
        setBusy(true);
        try {
            await assetService.answer(asset.checkin.item_id, haveIt, note ?? undefined);
            // Read it back in whichever shape this viewer gets.
            onChange((await assetService.get(asset.id)).data);
            setError(null);
        } catch (e) {
            setError(detail(e, "Could not answer that."));
        } finally {
            setBusy(false);
        }
    };

    const clearFlag = async () => {
        const note = await dialog.prompt({
            title: `Clear the flag on ${asset.tag}`,
            body: "Say how it was sorted out. It is kept on the history.",
            multiline: true,
            confirmLabel: "Clear flag",
        });
        if (note === null) return;
        void run(() => assetService.clearFlag(asset.id, note.trim() || undefined), "Could not clear the flag.");
    };

    const status = STATUS_CHIP[asset.status];
    const needs = pending ? NEEDS[pending.move] : undefined;
    const field = "dtg-input";

    return (
        <Drawer title={`${asset.tag} · ${asset.name}`} eyebrow={asset.category.name} onClose={onClose}>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
                {error && <Alert tone="danger">{error}</Alert>}

                <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${status.cls}`}>
                        {status.label}
                    </span>
                    {asset.handover_pending && (
                        <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-micro font-semibold uppercase tracking-label text-gold">
                            Handover pending
                        </span>
                    )}
                    {asset.holder && (
                        <span className="text-sm text-paper-soft">
                            {asset.status === "lost" ? "Lost from " : "With "}
                            <span className="font-semibold text-paper">{asset.holder.name ?? "—"}</span>
                            {asset.holder.since && ` since ${day(asset.holder.since)}`}
                            {asset.handover_pending && asset.holder.since && ` · waiting ${daysSince(asset.holder.since)} days`}
                        </span>
                    )}
                </div>

                {asset.flag && (
                    <Alert tone="warning">
                        <span className="font-semibold">{FLAG_LABEL[asset.flag.kind]}.</span>{" "}
                        {asset.flag.note}
                        {asset.can_manage && (
                            <button type="button" onClick={() => void clearFlag()} className="ml-2 font-semibold underline-offset-2 hover:underline">
                                Clear flag
                            </button>
                        )}
                    </Alert>
                )}

                {/* The holder's side: the handover, and the open check-in. */}
                {asset.can_respond && (
                    <div className="dtg-panel-inset space-y-3 px-4 py-3">
                        <p className="text-sm text-paper-soft">
                            IT has recorded this as handed to you. Confirm you have it, or tell IT if you did not
                            receive it.
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <button type="button" disabled={busy} onClick={() => void confirmReceipt()} className="dtg-btn-primary px-3 py-1.5 text-xs">
                                I have it
                            </button>
                            <button type="button" disabled={busy} onClick={() => void decline()} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                                I didn't receive it
                            </button>
                        </div>
                    </div>
                )}
                {asset.checkin?.can_answer && (
                    <div className="dtg-panel-inset space-y-3 px-4 py-3">
                        <p className="text-sm text-paper-soft">
                            {asset.checkin.round_name}: is this item with you? Answer by {day(asset.checkin.due_date)}.
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <button type="button" disabled={busy} onClick={() => void answer(true)} className="dtg-btn-primary px-3 py-1.5 text-xs">
                                I have it
                            </button>
                            <button type="button" disabled={busy} onClick={() => void answer(false)} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                                Not with me
                            </button>
                        </div>
                    </div>
                )}

                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    {(
                        [
                            ["Brand", asset.brand],
                            ["Model", asset.model],
                            ["Serial number", asset.serial_number],
                            asset.category.tracks_calibration ? ["Calibration due", day(asset.calibration_due)] : null,
                            full ? ["Location", asset.location] : null,
                            full ? ["Purchased", day(asset.purchase_date)] : null,
                            full ? ["Purchase value", money(asset.purchase_value, asset.currency)] : null,
                            full ? ["Warranty until", day(asset.warranty_until)] : null,
                        ].filter(Boolean) as [string, string | null][]
                    ).map(([k, v]) => (
                        <div key={k}>
                            <dt className="text-micro uppercase tracking-label text-muted">{k}</dt>
                            <dd className="mt-0.5 break-words text-paper">{v || "—"}</dd>
                        </div>
                    ))}
                </dl>
                {full && asset.notes && (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-paper-soft">{asset.notes}</p>
                )}

                {/* IT's moves. */}
                {asset.can_manage && (
                    <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                            {MOVES.filter((m) => asset.moves?.includes(m.move)).map((m) => (
                                <button
                                    key={m.move}
                                    type="button"
                                    disabled={busy}
                                    onClick={() => setPending({ move: m.move, employeeId: "", location: "", note: "" })}
                                    className={`${
                                        m.tone === "primary" ? "dtg-btn-primary" : m.tone === "danger" ? "dtg-btn-danger" : "dtg-btn-secondary"
                                    } px-3 py-1.5 text-xs`}
                                >
                                    {m.label}
                                </button>
                            ))}
                            {onEdit && asset.status !== "retired" && (
                                <button type="button" onClick={() => onEdit(asset)} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                                    <Pencil className="h-3.5 w-3.5" />
                                    Edit details
                                </button>
                            )}
                        </div>

                        {pending && needs && (
                            <div className="dtg-panel-inset space-y-3 px-4 py-4">
                                <p className="text-sm font-semibold text-paper">
                                    {MOVES.find((m) => m.move === pending.move)?.label} {asset.tag}
                                </p>
                                {needs.person && (
                                    <div>
                                        <label className="dtg-label">Who has it</label>
                                        <select
                                            value={pending.employeeId}
                                            onChange={(e) => setPending({ ...pending, employeeId: e.target.value })}
                                            className={field}
                                        >
                                            <option value="" className="bg-surface">Choose a person…</option>
                                            {staff
                                                .filter((p) => p.id !== asset.holder?.employee_id)
                                                .map((p) => (
                                                    <option key={p.id} value={p.id} className="bg-surface">
                                                        {p.first_name} {p.last_name}
                                                    </option>
                                                ))}
                                        </select>
                                        <p className="mt-1 text-micro text-muted">
                                            They are asked to confirm they have it
                                        </p>
                                    </div>
                                )}
                                {needs.location && (
                                    <div>
                                        <label className="dtg-label">Where it is now</label>
                                        <input
                                            value={pending.location}
                                            onChange={(e) => setPending({ ...pending, location: e.target.value })}
                                            placeholder={asset.location ?? "e.g. Jakarta office, store room"}
                                            maxLength={160}
                                            className={field}
                                        />
                                    </div>
                                )}
                                <div>
                                    <label className="dtg-label">{needs.noteLabel}</label>
                                    <textarea
                                        value={pending.note}
                                        onChange={(e) => setPending({ ...pending, note: e.target.value })}
                                        rows={2}
                                        className={field}
                                    />
                                </div>
                                {pending.move === "retire" && (
                                    <p className="flex items-center gap-1.5 text-micro text-muted">
                                        <AlertTriangle className="h-3.5 w-3.5" />
                                        Retired is final. The item and its history stay on the register.
                                    </p>
                                )}
                                <div className="flex gap-2">
                                    <button type="button" disabled={busy} onClick={submitMove} className="dtg-btn-primary px-3 py-1.5 text-xs">
                                        Save
                                    </button>
                                    <button type="button" onClick={() => setPending(null)} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {full && (asset.tickets?.length ?? 0) > 0 && (
                    <div>
                        <p className="dtg-eyebrow">Linked tickets</p>
                        <ul className="mt-2 space-y-1 text-sm">
                            {asset.tickets!.map((t) => (
                                <li key={t.id}>
                                    <Link to={`/support?open=${t.id}`} className="dtg-link font-mono text-xs">
                                        {t.reference}
                                    </Link>{" "}
                                    <span className="text-paper-soft">{t.subject}</span>{" "}
                                    <span className="text-micro text-muted">({t.status.replace("_", " ")})</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div>
                    <p className="dtg-eyebrow">History</p>
                    <ol className="mt-3 space-y-2.5 border-l border-white/[0.08] pl-4">
                        {[...asset.events].reverse().map((e) => (
                            <li key={e.id} className="relative">
                                <span className="absolute -left-[1.3rem] top-1.5 h-1.5 w-1.5 rounded-full bg-white/25" />
                                <p className="text-micro text-muted">
                                    <span className="font-semibold text-paper-soft">{e.actor_name}</span>
                                    {" · "}
                                    {when(e.created_at)}
                                </p>
                                <p className="whitespace-pre-wrap text-xs leading-relaxed text-paper-soft">
                                    {e.body}
                                    {e.kind === "transferred" && e.from_holder_name && (
                                        <span className="text-muted"> (from {e.from_holder_name})</span>
                                    )}
                                </p>
                            </li>
                        ))}
                    </ol>
                </div>
            </div>
        </Drawer>
    );
}
