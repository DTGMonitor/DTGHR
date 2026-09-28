import { useEffect, useState } from "react";

import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import {
    RESPONSE_CHIP,
    errorDetail,
    formatDay,
    formatEventAt,
    investigationService,
    periodText,
    suspensionText,
    type MyOutcome,
} from "@/services/investigationService";

/*
 * Your own conduct record, on your own profile.
 *
 * An investigation's decision about you appears here once it is issued: the
 * event, the investigation's result and recommendation, and your decision
 * with its reason and active period. Nothing about anybody else named in the
 * same case, and not the investigators' internal findings. Each case is
 * reviewed individually, and you can respond before it is finalised --
 * acknowledge it, accept it, or dispute it in writing.
 */
export default function MyConduct() {
    const [items, setItems] = useState<MyOutcome[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        investigationService
            .mine()
            .then((res) => setItems(res.data))
            .catch(() => setError("Could not load your conduct record."));
    }, []);

    const replace = (o: MyOutcome) => setItems((list) => (list ?? []).map((x) => (x.id === o.id ? o : x)));

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">Monitoring</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">Investigation outcomes</h2>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
                    Decisions about you from monitoring investigations, under the Discipline Policy. Only you
                    and the investigators can see them.
                </p>
            </header>

            {error && <p className="px-5 pt-4 text-sm text-danger">{error}</p>}

            {!items && !error ? (
                <div className="flex items-center gap-2.5 px-5 py-10 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : items && items.length === 0 ? (
                <p className="px-5 py-10 text-sm text-paper-soft">Nothing recorded. There are no investigation outcomes for you.</p>
            ) : items ? (
                <div className="divide-y divide-white/[0.06]">
                    {items.map((o) => (
                        <OutcomeItem key={o.id} o={o} onChanged={replace} />
                    ))}
                </div>
            ) : null}
        </section>
    );
}

function OutcomeItem({ o, onChanged }: { o: MyOutcome; onChanged: (o: MyOutcome) => void }) {
    const [mode, setMode] = useState<"idle" | "dispute">("idle");
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const send = async (response: "acknowledged" | "accepted" | "disputed") => {
        if (response === "disputed" && text.trim().length < 10) {
            setError("Please explain why you dispute this decision (at least 10 characters).");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const res = await investigationService.respond(o.id, response, response === "disputed" ? text.trim() : undefined);
            onChanged(res.data);
            setMode("idle");
            setText("");
        } catch (e) {
            setError(errorDetail(e, "Your response did not save."));
        } finally {
            setBusy(false);
        }
    };

    const chip = RESPONSE_CHIP[o.response_status];

    return (
        <article className="px-5 py-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-micro text-muted">
                        <span className="font-mono">{o.reference}</span> · {formatEventAt(o.event_at)} · {o.site_name}
                        {o.site_client ? ` — ${o.site_client}` : ""}
                        {o.radar ? ` · ${o.radar}` : ""}
                    </p>
                    <h3 className="mt-1 text-sm font-semibold text-paper">{o.title}</h3>
                </div>
                <span
                    className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${chip.cls}`}
                >
                    {o.response_status === "pending" && !o.can_respond ? "No response" : chip.label}
                </span>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                    <p className="dtg-label">Investigation result</p>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-paper-soft">
                        {o.investigation_result ?? "—"}
                    </p>
                </div>
                <div>
                    <p className="dtg-label">Recommendation</p>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-paper-soft">{o.recommendation ?? "—"}</p>
                </div>
            </div>

            <div className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="dtg-label">Decision</p>
                <p className="text-sm font-semibold text-signal">{o.decision_label}</p>
                <p className="mt-0.5 text-micro text-muted">
                    {o.effective_from ? `From ${formatDay(o.effective_from)} · ` : ""}
                    {periodText(o)}
                    {o.decision === "suspension" ? ` · ${suspensionText(o)}` : ""}
                </p>
                {o.reason && <p className="mt-2 whitespace-pre-wrap text-sm text-paper-soft">{o.reason}</p>}
                {o.further_action_note && <p className="mt-2 whitespace-pre-wrap text-sm text-paper-soft">{o.further_action_note}</p>}
                {o.revised_at && <p className="mt-2 text-micro text-muted">Revised {formatEventAt(o.revised_at)}</p>}
            </div>

            {o.response_status !== "pending" && (
                <div className="mt-3 text-sm text-paper-soft">
                    <p className="text-micro text-muted">
                        You {o.response_status} this{o.responded_at ? ` on ${formatEventAt(o.responded_at)}` : ""}.
                    </p>
                    {o.response_text && <p className="mt-1 whitespace-pre-wrap">“{o.response_text}”</p>}
                </div>
            )}
            {o.resolution_note && (
                <Alert tone="info" className="mt-3">
                    <span className="font-semibold">Investigators’ reply: </span>
                    {o.resolution_note}
                </Alert>
            )}

            {o.can_respond && (
                <div className="mt-4 space-y-3">
                    {error && <Alert tone="danger">{error}</Alert>}
                    {mode === "dispute" ? (
                        <>
                            <label className="block">
                                <span className="dtg-label">Why do you dispute this decision?</span>
                                <textarea
                                    value={text}
                                    onChange={(e) => setText(e.target.value)}
                                    rows={4}
                                    maxLength={2000}
                                    className="dtg-input w-full text-sm"
                                    placeholder="Your account, and anything the investigators should consider."
                                />
                                <span className="mt-1 block text-micro text-muted">{text.trim().length} / 2000</span>
                            </label>
                            <div className="flex gap-2">
                                <button type="button" disabled={busy} onClick={() => void send("disputed")} className="dtg-btn-primary">
                                    Send appeal
                                </button>
                                <button type="button" onClick={() => setMode("idle")} className="text-sm text-paper-soft hover:text-paper">
                                    Cancel
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <button type="button" disabled={busy} onClick={() => void send("acknowledged")} className="dtg-btn-secondary">
                                Acknowledge
                            </button>
                            <button type="button" disabled={busy} onClick={() => void send("accepted")} className="dtg-btn-secondary">
                                Accept
                            </button>
                            <button type="button" disabled={busy} onClick={() => setMode("dispute")} className="dtg-btn-secondary">
                                Appeal (dispute)
                            </button>
                            <span className="text-micro text-muted">
                                Acknowledge: I have read it. Accept: I accept the decision. Appeal: I dispute it, and say why.
                            </span>
                        </div>
                    )}
                </div>
            )}
        </article>
    );
}
