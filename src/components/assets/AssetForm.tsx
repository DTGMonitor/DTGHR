import { useState } from "react";

import Alert from "@/components/ui/Alert";
import Drawer from "@/components/ui/Drawer";
import MoneyInput from "@/components/ui/MoneyInput";
import { assetService, type Asset, type AssetCategory, type AssetInput } from "@/services/assetService";
import type { ScheduleEmployee } from "@/types/schedule";
import { detail } from "./labels";

/*
 * Registering an item, or correcting one.
 *
 * Registering is the go-live stocktake: IT walks the office putting a new tag
 * on everything, so "Save & add another" keeps what the next item probably
 * shares -- category, brand, model, purchase date, location -- and clears
 * what is its own. An item can be handed to its holder in the same step.
 *
 * Editing never touches the tag, status or holder: those move only by the
 * moves in the drawer.
 */

const blank = (categoryId = ""): AssetInput => ({
    category_id: categoryId,
    name: "",
    brand: "",
    model: "",
    serial_number: "",
    location: "",
    purchase_date: "",
    purchase_value: "",
    currency: "IDR",
    warranty_until: "",
    calibration_due: "",
    notes: "",
});

const fromAsset = (a: Asset): AssetInput => ({
    category_id: a.category.id,
    name: a.name,
    brand: a.brand ?? "",
    model: a.model ?? "",
    serial_number: a.serial_number ?? "",
    location: a.location ?? "",
    purchase_date: a.purchase_date ?? "",
    purchase_value: a.purchase_value === null || a.purchase_value === undefined ? "" : String(a.purchase_value),
    currency: a.currency ?? "IDR",
    warranty_until: a.warranty_until ?? "",
    calibration_due: a.calibration_due ?? "",
    notes: a.notes ?? "",
});

export default function AssetForm({
    editing,
    categories,
    staff,
    onSaved,
    onClose,
}: {
    /** The asset being corrected, or null to register a new one. */
    editing: Asset | null;
    categories: AssetCategory[];
    staff: ScheduleEmployee[];
    onSaved: (a: Asset) => void;
    onClose: () => void;
}) {
    const active = categories.filter((c) => c.is_active !== false);
    const [form, setForm] = useState<AssetInput>(editing ? fromAsset(editing) : blank(active[0]?.id));
    const [assignTo, setAssignTo] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    const category = categories.find((c) => c.id === form.category_id);
    const set = (k: keyof AssetInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setForm({ ...form, [k]: e.target.value });

    const save = async (another: boolean) => {
        if (!form.name.trim()) {
            setError("Say what the item is.");
            return;
        }
        setBusy(true);
        try {
            if (editing) {
                const res = await assetService.update(editing.id, form);
                onSaved(res.data);
                onClose();
                return;
            }
            const res = await assetService.register({ ...form, assign_to: assignTo || undefined });
            onSaved(res.data);
            setError(null);
            if (another) {
                setSaved((s) => [`${res.data.tag} · ${res.data.name}`, ...s]);
                setForm({
                    ...blank(form.category_id),
                    brand: form.brand,
                    model: form.model,
                    purchase_date: form.purchase_date,
                    location: form.location,
                    currency: form.currency,
                });
                setAssignTo("");
            } else {
                onClose();
            }
        } catch (e) {
            setError(detail(e, "Could not save that."));
        } finally {
            setBusy(false);
        }
    };

    const field = "dtg-input";

    return (
        <Drawer
            title={editing ? `Edit ${editing.tag}` : "Register an item"}
            eyebrow="Asset register"
            onClose={onClose}
            footer={
                <>
                    {!editing && (
                        <button type="button" disabled={busy} onClick={() => void save(true)} className="dtg-btn-primary">
                            Save & add another
                        </button>
                    )}
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void save(false)}
                        className={editing ? "dtg-btn-primary" : "dtg-btn-secondary"}
                    >
                        {editing ? "Save changes" : "Save"}
                    </button>
                </>
            }
        >
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
                {error && <Alert tone="danger">{error}</Alert>}
                {saved.length > 0 && (
                    <Alert tone="success">
                        Registered {saved[0]}
                        {saved.length > 1 && ` (${saved.length} so far)`}. Put the tag on it.
                    </Alert>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                        <label className="dtg-label">Category</label>
                        <select value={form.category_id} onChange={set("category_id")} className={field}>
                            {categories
                                .filter((c) => c.is_active !== false || c.id === form.category_id)
                                .map((c) => (
                                    <option key={c.id} value={c.id} className="bg-surface">
                                        {c.name} ({c.code})
                                    </option>
                                ))}
                        </select>
                        {!editing && category?.next_tag && (
                            <p className="mt-1 text-micro text-muted">Next tag: {category.next_tag}</p>
                        )}
                        {editing && <p className="mt-1 text-micro text-muted">The tag stays {editing.tag}</p>}
                    </div>
                    <div>
                        <label className="dtg-label">Name</label>
                        <input value={form.name} onChange={set("name")} maxLength={200} placeholder="e.g. ThinkPad T14 Gen 4" className={field} />
                    </div>
                    <div>
                        <label className="dtg-label">Brand</label>
                        <input value={form.brand} onChange={set("brand")} maxLength={100} className={field} />
                    </div>
                    <div>
                        <label className="dtg-label">Model</label>
                        <input value={form.model} onChange={set("model")} maxLength={100} className={field} />
                    </div>
                    <div>
                        <label className="dtg-label">Serial number</label>
                        <input value={form.serial_number} onChange={set("serial_number")} maxLength={100} className={`${field} font-mono`} />
                    </div>
                    <div>
                        <label className="dtg-label">Location</label>
                        <input
                            value={form.location}
                            onChange={set("location")}
                            maxLength={160}
                            placeholder="e.g. Jakarta office, store room"
                            className={field}
                        />
                    </div>
                    <div>
                        <label className="dtg-label">Purchase date</label>
                        <input type="date" value={form.purchase_date} onChange={set("purchase_date")} className={field} />
                    </div>
                    <div>
                        <label className="dtg-label">Purchase value</label>
                        <div className="flex gap-2">
                            <select value={form.currency} onChange={set("currency")} className={`${field} w-24`}>
                                {["IDR", "AUD", "USD", "SGD"].map((c) => (
                                    <option key={c} value={c} className="bg-surface">{c}</option>
                                ))}
                            </select>
                            <div className="flex-1">
                                <MoneyInput
                                    value={form.purchase_value}
                                    onChange={(raw) => setForm({ ...form, purchase_value: raw })}
                                    prefix={null}
                                    allowDecimals={form.currency !== "IDR"}
                                    className={field}
                                />
                            </div>
                        </div>
                        <p className="mt-1 text-micro text-muted">Seen by IT, finance and management only</p>
                    </div>
                    <div>
                        <label className="dtg-label">Warranty until</label>
                        <input type="date" value={form.warranty_until} onChange={set("warranty_until")} className={field} />
                    </div>
                    {category?.tracks_calibration && (
                        <div>
                            <label className="dtg-label">Calibration due</label>
                            <input type="date" value={form.calibration_due} onChange={set("calibration_due")} className={field} />
                        </div>
                    )}
                </div>

                <div>
                    <label className="dtg-label">Notes</label>
                    <textarea value={form.notes} onChange={set("notes")} rows={2} className={field} />
                </div>

                {!editing && (
                    <div className="dtg-panel-inset px-4 py-3">
                        <label className="dtg-label">Assign to (optional)</label>
                        <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className={field}>
                            <option value="" className="bg-surface">Keep in store</option>
                            {staff.map((p) => (
                                <option key={p.id} value={p.id} className="bg-surface">
                                    {p.first_name} {p.last_name}
                                </option>
                            ))}
                        </select>
                        <p className="mt-1 text-micro text-muted">
                            For an item someone already has. They are asked to confirm it.
                        </p>
                    </div>
                )}
            </div>
        </Drawer>
    );
}
