import { useState, type ReactNode } from "react";
import type { EmployeeDetail } from "@/types/employee";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";
import Alert from "@/components/ui/Alert";

export type FieldType =
    | "text"
    | "email"
    | "tel"
    | "date"
    | "number"
    | "textarea"
    | "select"
    | "toggle";

export interface FieldDef {
    key: keyof EmployeeDetail;
    label: string;
    type?: FieldType;
    options?: { value: string; label: string }[];
    /** Identifiers and account numbers read better in the mono face. */
    mono?: boolean;
    help?: string;
    placeholder?: string;
    /** Span both columns, for addresses and the like. */
    wide?: boolean;
}

function displayValue(employee: EmployeeDetail, field: FieldDef): ReactNode {
    const raw = employee[field.key];

    if (raw === null || raw === undefined || raw === "") {
        return <span className="text-muted">Not set</span>;
    }
    if (field.type === "toggle") {
        return raw ? "Yes" : "No";
    }
    if (field.type === "select") {
        const match = field.options?.find((o) => o.value === String(raw));
        return match?.label ?? String(raw);
    }
    if (field.type === "date") {
        return new Date(String(raw)).toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
        });
    }
    return String(raw);
}

/**
 * One block of the profile, read-only until an administrator edits it.
 *
 * Editing is per-section rather than per-page: the record has forty-odd fields,
 * and a single page-wide form makes every save a chance to clobber something
 * somebody else changed in a different part of the record.
 */
export default function ProfileSection({
    title,
    eyebrow,
    fields,
    employee,
    canEdit,
    onSave,
    children,
}: {
    title: string;
    eyebrow?: string;
    fields: FieldDef[];
    employee: EmployeeDetail;
    canEdit: boolean;
    onSave: (patch: Record<string, unknown>) => Promise<void>;
    children?: ReactNode;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<Record<string, unknown>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const startEdit = () => {
        const seed: Record<string, unknown> = {};
        for (const f of fields) {
            const v = employee[f.key];
            seed[f.key as string] = v ?? (f.type === "toggle" ? false : "");
        }
        setDraft(seed);
        setError(null);
        setEditing(true);
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);

        // Send only what actually changed, and turn cleared text fields back
        // into null so the server stores an absent value rather than "".
        const patch: Record<string, unknown> = {};
        for (const f of fields) {
            const next = draft[f.key as string];
            const current = employee[f.key] ?? (f.type === "toggle" ? false : "");
            if (next === current) continue;
            patch[f.key as string] =
                next === "" && f.type !== "toggle" ? null : next;
        }

        if (Object.keys(patch).length === 0) {
            setEditing(false);
            setSaving(false);
            return;
        }

        try {
            await onSave(patch);
            setEditing(false);
        } catch (err) {
            const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data
                ?.detail;
            setError(detail ?? "Could not save. Please try again.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="flex items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
                <div>
                    {eyebrow && <p className="dtg-eyebrow">{eyebrow}</p>}
                    <h2 className="mt-0.5 text-sm font-semibold text-paper">{title}</h2>
                </div>

                {canEdit && !editing && (
                    <button onClick={startEdit} className="dtg-btn-secondary px-2.5 py-1.5 text-micro">
                        <Icon name="pencil" className="h-3.5 w-3.5" />
                        Edit
                    </button>
                )}
                {editing && (
                    <div className="flex gap-2">
                        <button
                            onClick={() => setEditing(false)}
                            disabled={saving}
                            className="dtg-btn-secondary px-2.5 py-1.5 text-micro"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className="dtg-btn-primary px-2.5 py-1.5 text-micro"
                        >
                            {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
                            Save
                        </button>
                    </div>
                )}
            </header>

            <div className="p-5">
                {error && <Alert tone="danger" className="mb-4">{error}</Alert>}

                <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                    {fields.map((field) => (
                        <div key={String(field.key)} className={field.wide ? "sm:col-span-2" : ""}>
                            <dt className="dtg-label mb-1">{field.label}</dt>
                            <dd>
                                {editing ? (
                                    <FieldInput
                                        field={field}
                                        value={draft[field.key as string]}
                                        onChange={(v) =>
                                            setDraft((d) => ({ ...d, [field.key as string]: v }))
                                        }
                                    />
                                ) : (
                                    <p
                                        className={`text-sm text-paper ${
                                            field.mono ? "font-mono text-xs" : ""
                                        }`}
                                    >
                                        {displayValue(employee, field)}
                                    </p>
                                )}
                                {field.help && editing && (
                                    <p className="mt-1 text-micro leading-relaxed text-muted">
                                        {field.help}
                                    </p>
                                )}
                            </dd>
                        </div>
                    ))}
                </dl>

                {children}
            </div>
        </section>
    );
}

function FieldInput({
    field,
    value,
    onChange,
}: {
    field: FieldDef;
    value: unknown;
    onChange: (v: unknown) => void;
}) {
    if (field.type === "toggle") {
        return (
            <label className="relative inline-flex cursor-pointer items-center">
                <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={Boolean(value)}
                    onChange={(e) => onChange(e.target.checked)}
                />
                <span className="sr-only">{field.label}</span>
                <div className="peer h-6 w-11 rounded-full border border-white/15 bg-deep transition-colors after:absolute after:left-[3px] after:top-[3px] after:h-4 after:w-4 after:rounded-full after:bg-paper-soft after:transition-all after:content-[''] peer-checked:border-signal/50 peer-checked:bg-signal/25 peer-checked:after:translate-x-full peer-checked:after:bg-signal peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal" />
            </label>
        );
    }

    if (field.type === "select") {
        return (
            <select
                className="dtg-input"
                value={String(value ?? "")}
                onChange={(e) => onChange(e.target.value || null)}
            >
                <option value="">Not set</option>
                {field.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        );
    }

    if (field.type === "textarea") {
        return (
            <textarea
                className="dtg-input min-h-[4.5rem] resize-y"
                value={String(value ?? "")}
                placeholder={field.placeholder}
                onChange={(e) => onChange(e.target.value)}
            />
        );
    }

    return (
        <input
            className="dtg-input"
            type={field.type ?? "text"}
            value={String(value ?? "")}
            placeholder={field.placeholder}
            onChange={(e) =>
                onChange(field.type === "number" ? Number(e.target.value) : e.target.value)
            }
        />
    );
}
