import { useCallback, useEffect, useState } from "react";

import api from "@/lib/api";
import { useDialog } from "@/components/ui/Dialog";
import Spinner from "@/components/ui/Spinner";

/*
 * Asking for a personal detail to be corrected.
 *
 * Staff cannot edit their own record — the directory is management's, and it
 * carries statutory identifiers and bank details. But the person whose PTKP
 * status it is knows it changed, and HR does not until they are told. So the
 * correction arrives as a request against one field: from this, to that, with
 * a reason, approved by whoever holds the People admin tick.
 *
 * Approving is what writes the value. That is the point rather than a detail:
 * a bank account its own owner can change with no second pair of eyes is how
 * payroll fraud works, and "changed on 3 October from K/0 to K/1, requested by
 * Lintang, approved by Nurhuda" is the answer to a question the tax office may
 * eventually ask.
 */

interface ProfileRequest {
    id: string;
    employee_id: string;
    employee_name: string;
    field: string;
    field_label: string;
    current_value: string | null;
    requested_value: string | null;
    reason: string | null;
    status: "pending" | "approved" | "declined" | "cancelled";
    review_note: string | null;
    reviewed_at: string | null;
    created_at: string;
}

const STATUS: Record<ProfileRequest["status"], { label: string; cls: string }> = {
    pending: { label: "Waiting", cls: "border-gold/30 bg-gold/10 text-gold" },
    approved: { label: "Applied", cls: "border-signal/30 bg-signal/10 text-signal" },
    declined: { label: "Declined", cls: "border-danger/30 bg-danger/10 text-danger" },
    cancelled: { label: "Withdrawn", cls: "border-white/15 bg-white/[0.04] text-muted" },
};

export default function ProfileRequests({
    /** Show only this person's requests and offer to raise one. Omit to review everybody's. */
    mine = false,
}: {
    mine?: boolean;
}) {
    const { confirm, prompt } = useDialog();
    const [rows, setRows] = useState<ProfileRequest[]>([]);
    const [fields, setFields] = useState<{ key: string; label: string }[]>([]);
    const [canReview, setCanReview] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [draft, setDraft] = useState<{ field: string; value: string; reason: string } | null>(
        null,
    );

    const load = useCallback(async () => {
        try {
            const [list, defs] = await Promise.all([
                api.get<{ items: ProfileRequest[]; can_review: boolean }>("/profile-requests"),
                api.get<{ key: string; label: string }[]>("/profile-requests/fields"),
            ]);
            setRows(list.data.items);
            setCanReview(list.data.can_review);
            setFields(defs.data);
        } catch {
            setError("Could not load requests.");
        } finally {
            setLoading(false);
        }
    }, []);

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
            setError(typeof detail === "string" ? detail : "That did not go through.");
        } finally {
            setBusy(null);
        }
    };

    const shown = mine ? rows : rows.filter((r) => r.status === "pending");

    if (loading)
        return (
            <section className="dtg-panel flex items-center gap-2.5 px-5 py-8 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading requests…
            </section>
        );

    // Nothing to review and nothing pending: a reviewer's empty queue is not
    // worth a panel on the page.
    if (!mine && shown.length === 0) return null;

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-3.5">
                <div>
                    <p className="dtg-eyebrow">{mine ? "Your details" : "Waiting on you"}</p>
                    <h2 className="mt-0.5 text-sm font-semibold text-paper">
                        {mine ? "Requested corrections" : "Profile change requests"}
                    </h2>
                    <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted">
                        {mine
                            ? "You cannot edit these yourself — ask, and whoever administers the records applies it."
                            : "Approving one is what writes the new value onto the record."}
                    </p>
                </div>
                {mine && !draft && (
                    <button
                        onClick={() => setDraft({ field: fields[0]?.key ?? "", value: "", reason: "" })}
                        className="dtg-btn-primary px-3 py-1.5 text-xs"
                    >
                        Request a correction
                    </button>
                )}
            </header>

            {error && (
                <p className="border-b border-danger/20 bg-danger/[0.06] px-5 py-2.5 text-xs text-danger">
                    {error}
                </p>
            )}

            {draft && (
                <div className="grid grid-cols-1 gap-3 border-b border-white/[0.08] bg-white/[0.02] px-5 py-4 sm:grid-cols-2">
                    <label className="block">
                        <span className="dtg-eyebrow">Detail</span>
                        <select
                            value={draft.field}
                            onChange={(e) => setDraft({ ...draft, field: e.target.value })}
                            className="dtg-input mt-1.5 w-full text-xs"
                        >
                            {fields.map((f) => (
                                <option key={f.key} value={f.key}>
                                    {f.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="block">
                        <span className="dtg-eyebrow">Should be</span>
                        <input
                            value={draft.value}
                            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                            className="dtg-input mt-1.5 w-full text-xs"
                            placeholder="K/1"
                        />
                    </label>
                    <label className="block sm:col-span-2">
                        <span className="dtg-eyebrow">Why</span>
                        <textarea
                            rows={2}
                            value={draft.reason}
                            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            className="dtg-input mt-1.5 w-full text-xs"
                            placeholder="Married in August, first child born September."
                        />
                    </label>
                    <div className="flex gap-2 sm:col-span-2">
                        <button
                            disabled={!draft.field || !draft.value || busy === "new"}
                            onClick={() =>
                                act("new", async () => {
                                    await api.post("/profile-requests", {
                                        field: draft.field,
                                        requested_value: draft.value,
                                        reason: draft.reason || null,
                                    });
                                    setDraft(null);
                                })
                            }
                            className="dtg-btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                        >
                            Send request
                        </button>
                        <button
                            onClick={() => setDraft(null)}
                            className="dtg-btn-ghost px-3 py-1.5 text-xs"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {shown.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-muted">
                    Nothing outstanding.
                </p>
            ) : (
                <ul className="divide-y divide-white/[0.06]">
                    {shown.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
                            <div className="min-w-0">
                                <p className="text-sm">
                                    {!mine && (
                                        <span className="mr-2 font-semibold text-paper">
                                            {r.employee_name}
                                        </span>
                                    )}
                                    <span className="dtg-eyebrow mr-2">{r.field_label}</span>
                                    <span className="text-muted line-through">
                                        {r.current_value || "not set"}
                                    </span>
                                    <span className="mx-2 text-teal-300">→</span>
                                    <span className="font-semibold text-paper">
                                        {r.requested_value || "not set"}
                                    </span>
                                </p>
                                {r.reason && (
                                    <p className="mt-1 text-xs italic leading-relaxed text-paper-soft">
                                        {r.reason}
                                    </p>
                                )}
                                {r.review_note && (
                                    <p className="mt-1 text-xs leading-relaxed text-muted">
                                        Reviewer: {r.review_note}
                                    </p>
                                )}
                            </div>

                            <div className="flex flex-shrink-0 items-center gap-2">
                                <span
                                    className={`rounded-full border px-2.5 py-1 text-micro font-semibold uppercase tracking-label ${STATUS[r.status].cls}`}
                                >
                                    {STATUS[r.status].label}
                                </span>

                                {canReview && r.status === "pending" && (
                                    <>
                                        <button
                                            disabled={busy === r.id}
                                            onClick={async () => {
                                                const ok = await confirm({
                                                    title: `Apply this change?`,
                                                    body: `${r.employee_name}'s ${r.field_label.toLowerCase()} becomes "${r.requested_value}". The record is written now and the before-and-after is kept.`,
                                                    confirmLabel: "Approve",
                                                });
                                                if (!ok) return;
                                                void act(r.id, () =>
                                                    api.post(`/profile-requests/${r.id}/approve`, {}),
                                                );
                                            }}
                                            className="dtg-btn-primary px-2.5 py-1 text-micro"
                                        >
                                            Approve
                                        </button>
                                        <button
                                            disabled={busy === r.id}
                                            onClick={async () => {
                                                const note = await prompt({
                                                    title: "Decline this request",
                                                    body: `${r.employee_name} will see your reason.`,
                                                    label: "Why",
                                                    multiline: true,
                                                    required: true,
                                                    confirmLabel: "Decline",
                                                    tone: "danger",
                                                });
                                                if (note === null) return;
                                                void act(r.id, () =>
                                                    api.post(`/profile-requests/${r.id}/decline`, {
                                                        note,
                                                    }),
                                                );
                                            }}
                                            className="dtg-btn-ghost px-2.5 py-1 text-micro text-danger"
                                        >
                                            Decline
                                        </button>
                                    </>
                                )}

                                {mine && !canReview && r.status === "pending" && (
                                    <button
                                        disabled={busy === r.id}
                                        onClick={() =>
                                            act(r.id, () =>
                                                api.post(`/profile-requests/${r.id}/cancel`, {}),
                                            )
                                        }
                                        className="dtg-btn-ghost px-2.5 py-1 text-micro"
                                    >
                                        Withdraw
                                    </button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
