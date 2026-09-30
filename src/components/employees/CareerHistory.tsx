import { useCallback, useEffect, useState } from "react";

import api from "@/lib/api";
import { useDialog } from "@/components/ui/Dialog";
import Alert from "@/components/ui/Alert";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";

/*
 * What this person's job has been, as periods.
 *
 * Replaces the role-change list ("LEVEL not set → Engineer"), which only
 * recorded edits from the day the Hub started watching and could not be
 * corrected beyond its date and note. Nurhuda: "Nessy changed to Business
 * Support in August; before that she was a Geotechnical Monitoring Engineer…
 * It should be more editable."
 *
 * Each entry is where a period starts; it runs until the next one. The latest
 * is the current role, and the profile's Position, Level and Department follow
 * it. Changing Position on the profile adds an entry dated today.
 */

export interface CareerEntry {
    id: string;
    employee_id: string;
    effective_date: string;
    end_date: string | null;
    is_current: boolean;
    position: string;
    job_level: string | null;
    department: string | null;
    note: string | null;
}

interface Draft {
    effective_date: string;
    position: string;
    job_level: string;
    department: string;
    note: string;
}

const EMPTY: Draft = { effective_date: "", position: "", job_level: "", department: "", note: "" };

function parse(iso: string): Date {
    return new Date(`${iso}T00:00:00`);
}

function monthYear(iso: string): string {
    return parse(iso).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

function todayIso(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "1 yr 4 mo", "3 mo", "less than a month". Counts whole months. */
function duration(fromIso: string, toIso: string): string {
    const a = parse(fromIso);
    const b = parse(toIso);
    let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) months -= 1;
    if (months < 1) return "less than a month";
    const years = Math.floor(months / 12);
    const rest = months % 12;
    const parts: string[] = [];
    if (years) parts.push(`${years} yr${years > 1 ? "s" : ""}`);
    if (rest) parts.push(`${rest} mo`);
    return parts.join(" ");
}

function errorDetail(err: unknown): string {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    return typeof detail === "string" ? detail : "Could not save. Please try again.";
}

function EntryForm({
    initial,
    saving,
    error,
    onCancel,
    onSubmit,
}: {
    initial: Draft;
    saving: boolean;
    error: string | null;
    onCancel: () => void;
    onSubmit: (d: Draft) => void;
}) {
    const [draft, setDraft] = useState<Draft>(initial);
    const set = (k: keyof Draft) => (e: { target: { value: string } }) =>
        setDraft((d) => ({ ...d, [k]: e.target.value }));

    return (
        <form
            className="space-y-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-4"
            onSubmit={(e) => {
                e.preventDefault();
                onSubmit(draft);
            }}
        >
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                    <span className="dtg-label mb-1 block">Start date</span>
                    <input
                        type="date"
                        required
                        className="dtg-input"
                        value={draft.effective_date}
                        onChange={set("effective_date")}
                    />
                </label>
                <label className="block">
                    <span className="dtg-label mb-1 block">Position</span>
                    <input
                        required
                        className="dtg-input"
                        value={draft.position}
                        onChange={set("position")}
                        placeholder="e.g. Senior Engineer"
                    />
                </label>
                <label className="block">
                    <span className="dtg-label mb-1 block">Level</span>
                    <input className="dtg-input" value={draft.job_level} onChange={set("job_level")} />
                </label>
                <label className="block">
                    <span className="dtg-label mb-1 block">Department</span>
                    <input className="dtg-input" value={draft.department} onChange={set("department")} />
                </label>
                <label className="block sm:col-span-2">
                    <span className="dtg-label mb-1 block">Note</span>
                    <input
                        className="dtg-input"
                        value={draft.note}
                        onChange={set("note")}
                        placeholder="e.g. Promoted, Moved to Business Support"
                    />
                </label>
            </div>
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={saving}
                    className="dtg-btn-secondary px-2.5 py-1.5 text-micro"
                >
                    Cancel
                </button>
                <button type="submit" disabled={saving} className="dtg-btn-primary px-2.5 py-1.5 text-micro">
                    {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
                    Save
                </button>
            </div>
        </form>
    );
}

export default function CareerHistory({
    employeeId,
    canEdit,
    onChanged,
}: {
    employeeId: string;
    canEdit: boolean;
    /** The profile's position, level and department follow the latest entry. */
    onChanged?: () => void | Promise<void>;
}) {
    const { confirm } = useDialog();
    const [rows, setRows] = useState<CareerEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    // "new" for the add form, an entry id for that entry's edit form.
    const [editing, setEditing] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await api.get<CareerEntry[]>(`/employees/${employeeId}/career`);
            setRows(res.data);
            setFailed(false);
        } catch {
            setFailed(true);
        } finally {
            setLoading(false);
        }
    }, [employeeId]);

    useEffect(() => {
        void load();
    }, [load]);

    const afterChange = async () => {
        setEditing(null);
        setError(null);
        await load();
        await onChanged?.();
    };

    const submit = async (d: Draft, id: string | null) => {
        setSaving(true);
        setError(null);
        const body = {
            effective_date: d.effective_date,
            position: d.position,
            job_level: d.job_level || null,
            department: d.department || null,
            note: d.note || null,
        };
        try {
            if (id) await api.patch(`/employees/${employeeId}/career/${id}`, body);
            else await api.post(`/employees/${employeeId}/career`, body);
            await afterChange();
        } catch (err) {
            setError(errorDetail(err));
        } finally {
            setSaving(false);
        }
    };

    const remove = async (r: CareerEntry) => {
        const ok = await confirm({
            title: "Delete this entry?",
            body: `${r.position}, from ${monthYear(r.effective_date)}. The period before it will run on to the next entry.`,
            confirmLabel: "Delete",
            tone: "danger",
        });
        if (!ok) return;
        try {
            await api.delete(`/employees/${employeeId}/career/${r.id}`);
            await afterChange();
        } catch (err) {
            setError(errorDetail(err));
        }
    };

    if (failed) return null;
    if (loading)
        return (
            <section className="dtg-panel flex items-center gap-2.5 px-5 py-8 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading career history…
            </section>
        );

    const today = todayIso();
    const latest = rows[0];

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
                <div>
                    <p className="dtg-eyebrow">Record</p>
                    <h2 className="mt-0.5 text-sm font-semibold text-paper">Career history</h2>
                    <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted">
                        Each entry runs until the next one starts; the latest is the current role
                        and sets Position, Level and Department above.
                    </p>
                </div>
                {canEdit && editing !== "new" && (
                    <button
                        onClick={() => {
                            setError(null);
                            setEditing("new");
                        }}
                        className="dtg-btn-secondary flex-shrink-0 px-2.5 py-1.5 text-micro"
                    >
                        <Icon name="plus" className="h-3.5 w-3.5" />
                        Add entry
                    </button>
                )}
            </header>

            <div className="px-5 py-4">
                {error && editing === null && (
                    <Alert tone="danger" className="mb-4">
                        {error}
                    </Alert>
                )}

                {editing === "new" && (
                    <div className="mb-4">
                        <EntryForm
                            initial={{
                                ...EMPTY,
                                job_level: latest?.job_level ?? "",
                                department: latest?.department ?? "",
                            }}
                            saving={saving}
                            error={error}
                            onCancel={() => {
                                setEditing(null);
                                setError(null);
                            }}
                            onSubmit={(d) => void submit(d, null)}
                        />
                    </div>
                )}

                {rows.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted">No career history recorded yet.</p>
                ) : (
                    <ol className="relative ml-1.5 border-l border-white/[0.1]">
                        {rows.map((r) => {
                            const upcoming = r.effective_date > today;
                            const end = r.end_date ?? today;
                            const range = r.end_date
                                ? `${monthYear(r.effective_date)} – ${monthYear(r.end_date)}`
                                : upcoming
                                  ? `From ${monthYear(r.effective_date)}`
                                  : `${monthYear(r.effective_date)} – present`;
                            return (
                                <li key={r.id} className="relative pb-5 pl-5 last:pb-0">
                                    <span
                                        aria-hidden="true"
                                        className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border ${
                                            r.is_current
                                                ? "border-signal bg-signal"
                                                : "border-white/30 bg-deep"
                                        }`}
                                    />
                                    {editing === r.id ? (
                                        <EntryForm
                                            initial={{
                                                effective_date: r.effective_date,
                                                position: r.position,
                                                job_level: r.job_level ?? "",
                                                department: r.department ?? "",
                                                note: r.note ?? "",
                                            }}
                                            saving={saving}
                                            error={error}
                                            onCancel={() => {
                                                setEditing(null);
                                                setError(null);
                                            }}
                                            onSubmit={(d) => void submit(d, r.id)}
                                        />
                                    ) : (
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="font-mono text-micro text-teal-200">
                                                    {range}
                                                    {!upcoming && (
                                                        <span className="ml-2 text-muted">
                                                            · {duration(r.effective_date, end)}
                                                        </span>
                                                    )}
                                                    {upcoming && <span className="ml-2 text-muted">· upcoming</span>}
                                                </p>
                                                <p className="mt-1 text-sm font-semibold text-paper">{r.position}</p>
                                                {(r.job_level || r.department) && (
                                                    <p className="text-xs text-paper-soft">
                                                        {[r.job_level, r.department].filter(Boolean).join(" · ")}
                                                    </p>
                                                )}
                                                {r.note && (
                                                    <p className="mt-1 text-xs italic leading-relaxed text-muted">
                                                        {r.note}
                                                    </p>
                                                )}
                                            </div>
                                            {canEdit && editing === null && (
                                                <div className="flex flex-shrink-0 gap-2">
                                                    <button
                                                        onClick={() => {
                                                            setError(null);
                                                            setEditing(r.id);
                                                        }}
                                                        className="dtg-btn-secondary px-2 py-1 text-micro"
                                                    >
                                                        Edit
                                                    </button>
                                                    {rows.length > 1 && (
                                                        <button
                                                            onClick={() => void remove(r)}
                                                            className="dtg-btn-secondary px-2 py-1 text-micro text-danger"
                                                        >
                                                            Delete
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                )}
            </div>
        </section>
    );
}
