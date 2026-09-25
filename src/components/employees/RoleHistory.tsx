import { useCallback, useEffect, useState } from "react";

import api from "@/lib/api";
import { useDialog } from "@/components/ui/Dialog";
import Spinner from "@/components/ui/Spinner";

/*
 * What this person's job has been.
 *
 * Changing Position on the profile above used to overwrite the old one, so
 * "when did Lintang become senior?" had no answer anywhere in the Hub — only
 * an "Updated employee" line in the activity log with no before and no after.
 * That question gets asked at review time, at salary time, and by anybody
 * writing a reference.
 *
 * The rows write themselves the moment somebody edits the profile, which means
 * the date is the day it was typed rather than the day the person started the
 * job. So the date is editable here, and there is somewhere to say what the
 * change actually was.
 */

interface RoleChange {
    id: string;
    effective_date: string;
    previous_position: string | null;
    new_position: string | null;
    previous_job_level: string | null;
    new_job_level: string | null;
    previous_department: string | null;
    new_department: string | null;
    note: string | null;
    created_at: string;
}

function longDate(iso: string): string {
    return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

/** "Engineer → Senior Engineer", or "— → Senior" when there was nothing before. */
function Change({ label, from, to }: { label: string; from: string | null; to: string | null }) {
    if (!from && !to) return null;
    return (
        <p className="text-sm">
            <span className="dtg-eyebrow mr-2">{label}</span>
            <span className="text-muted line-through">{from || "not set"}</span>
            <span className="mx-2 text-teal-300">→</span>
            <span className="font-semibold text-paper">{to || "not set"}</span>
        </p>
    );
}

export default function RoleHistory({
    employeeId,
    canEdit,
}: {
    employeeId: string;
    canEdit: boolean;
}) {
    const { prompt } = useDialog();
    const [rows, setRows] = useState<RoleChange[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await api.get<RoleChange[]>(`/employees/${employeeId}/history`);
            setRows(res.data);
        } catch {
            // Staff viewing their own profile get 403 here, which is the rule
            // rather than a fault, so the section simply does not appear.
            setFailed(true);
        } finally {
            setLoading(false);
        }
    }, [employeeId]);

    useEffect(() => {
        void load();
    }, [load]);

    if (failed) return null;
    if (loading)
        return (
            <section className="dtg-panel flex items-center gap-2.5 px-5 py-8 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading history…
            </section>
        );

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">Record</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">Role history</h2>
                <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted">
                    Written automatically whenever position, level or department changes. The
                    effective date starts as the day it was entered — correct it to the day the
                    person actually started.
                </p>
            </header>

            {rows.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-muted">
                    No changes recorded yet. The first promotion or transfer will appear here.
                </p>
            ) : (
                <ol className="divide-y divide-white/[0.06]">
                    {rows.map((r) => (
                        <li key={r.id} className="px-5 py-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 space-y-1">
                                    <Change
                                        label="Position"
                                        from={r.previous_position}
                                        to={r.new_position}
                                    />
                                    <Change
                                        label="Level"
                                        from={r.previous_job_level}
                                        to={r.new_job_level}
                                    />
                                    <Change
                                        label="Department"
                                        from={r.previous_department}
                                        to={r.new_department}
                                    />
                                    {r.note && (
                                        <p className="pt-1 text-xs italic leading-relaxed text-paper-soft">
                                            {r.note}
                                        </p>
                                    )}
                                </div>

                                <div className="flex flex-shrink-0 items-center gap-2">
                                    <span className="font-mono text-micro text-teal-200">
                                        {longDate(r.effective_date)}
                                    </span>
                                    {canEdit && (
                                        <button
                                            onClick={async () => {
                                                const date = await prompt({
                                                    title: "Effective from",
                                                    body: "The day the person actually started the new job, which is not always the day this was typed in.",
                                                    label: "Date (YYYY-MM-DD)",
                                                    defaultValue: r.effective_date,
                                                    required: true,
                                                    confirmLabel: "Save date",
                                                });
                                                if (date === null) return;
                                                await api.patch(
                                                    `/employees/${employeeId}/history/${r.id}`,
                                                    { effective_date: date },
                                                );
                                                await load();
                                            }}
                                            className="dtg-btn-ghost px-2 py-1 text-micro"
                                        >
                                            Date
                                        </button>
                                    )}
                                    {canEdit && (
                                        <button
                                            onClick={async () => {
                                                const note = await prompt({
                                                    title: "What was this change?",
                                                    body: "A promotion, a transfer, a correction to a typo — the three look identical in the data and completely different to a reader.",
                                                    label: "Note",
                                                    defaultValue: r.note ?? "",
                                                    multiline: true,
                                                    confirmLabel: "Save note",
                                                });
                                                if (note === null) return;
                                                await api.patch(
                                                    `/employees/${employeeId}/history/${r.id}`,
                                                    { note },
                                                );
                                                await load();
                                            }}
                                            className="dtg-btn-ghost px-2 py-1 text-micro"
                                        >
                                            Note
                                        </button>
                                    )}
                                </div>
                            </div>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}
