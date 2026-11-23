import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import Alert from "@/components/ui/Alert";
import Drawer from "@/components/ui/Drawer";
import { purchaseService, type Purchase, type PurchaseSettings, type RequestInput } from "@/services/purchaseService";
import { detail, rp } from "./labels";

/*
 * A purchase request, in general terms: what is needed, how many, and why.
 * The requester doesn't price it, pick a vendor or write a specification --
 * finance does that when sourcing. A note on each item is where a preference
 * or a minimum need goes ("Logitech wireless", "at least 16 GB RAM").
 *
 * An urgent request records that the approver already said yes by WhatsApp or
 * phone, and when. The WhatsApp screenshot is attached on the saved draft,
 * before it is submitted.
 */

interface ItemRow {
    description: string;
    quantity: string;
    note: string;
}

const blankItem = (): ItemRow => ({ description: "", quantity: "1", note: "" });

/** "2026-11-20T08:00" for a datetime-local field, in the browser's zone. */
const localDateTime = (iso: string | null | undefined) => {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function RequestForm({
    editing,
    settings,
    onSaved,
    onClose,
}: {
    editing: Purchase | null;
    settings: PurchaseSettings | null;
    onSaved: (p: Purchase) => void;
    onClose: () => void;
}) {
    const [title, setTitle] = useState(editing?.title ?? "");
    const [purpose, setPurpose] = useState(editing?.purpose ?? "");
    const [neededBy, setNeededBy] = useState(editing?.needed_by ?? "");
    const [urgent, setUrgent] = useState(editing?.urgent ?? false);
    const u = editing?.urgent_detail;
    const [channel, setChannel] = useState<"whatsapp" | "phone">(u?.channel ?? "whatsapp");
    const [approvedAt, setApprovedAt] = useState(localDateTime(u?.approved_at));
    const [urgentNote, setUrgentNote] = useState(u?.note ?? "");
    const [items, setItems] = useState<ItemRow[]>(
        editing?.items?.length
            ? editing.items.map((i) => ({ description: i.description, quantity: String(i.quantity), note: i.note ?? "" }))
            : [blankItem()],
    );
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const setItem = (i: number, patch: Partial<ItemRow>) =>
        setItems(items.map((row, k) => (k === i ? { ...row, ...patch } : row)));

    const body = (): RequestInput => ({
        title: title.trim(),
        purpose: purpose.trim(),
        needed_by: neededBy || null,
        urgent,
        urgent_channel: urgent ? channel : null,
        urgent_approved_at: urgent && approvedAt ? new Date(approvedAt).toISOString() : null,
        urgent_note: urgent ? urgentNote.trim() : null,
        items: items
            .filter((row) => row.description.trim())
            .map((row) => ({
                description: row.description.trim(),
                quantity: Number(row.quantity) || 0,
                note: row.note.trim() || null,
            })),
    });

    const save = async () => {
        if (!title.trim()) {
            setError("Say what is needed.");
            return;
        }
        setBusy(true);
        try {
            const res = editing
                ? await purchaseService.update(editing.id, body())
                : await purchaseService.create(body());
            onSaved(res.data);
            onClose();
        } catch (e) {
            setError(detail(e, "Could not save the request."));
        } finally {
            setBusy(false);
        }
    };

    const field = "dtg-input";

    return (
        <Drawer
            title={editing ? `Edit request: ${editing.title}` : "New purchase request"}
            eyebrow="Purchasing"
            onClose={onClose}
            footer={
                <button type="button" disabled={busy} onClick={() => void save()} className="dtg-btn-primary">
                    Save draft
                </button>
            }
        >
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
                {error && <Alert tone="danger">{error}</Alert>}
                <p className="text-sm leading-relaxed text-paper-soft">
                    Say what you need in general terms. Finance finds the vendor and the price. Save the draft, then
                    submit it.
                    {settings && ` Small things (up to ${rp(settings.petty_cash_limit)}) may be handled as petty cash.`}
                </p>

                <div>
                    <label className="dtg-label">What is needed</label>
                    <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
                           placeholder="e.g. Site kit for the Morowali job" className={field} />
                </div>
                <div>
                    <label className="dtg-label">Why it is needed</label>
                    <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} className={field} />
                </div>
                <div className="sm:w-1/2">
                    <label className="dtg-label">Needed by</label>
                    <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} className={field} />
                </div>

                <div className="space-y-3">
                    <p className="dtg-eyebrow">Items</p>
                    {items.map((row, i) => (
                        <div key={i} className="dtg-panel-inset space-y-2 px-4 py-3">
                            <div className="grid items-end gap-2 sm:grid-cols-[1fr_6rem_auto]">
                                <div>
                                    <label className="dtg-label">Item</label>
                                    <input value={row.description} onChange={(e) => setItem(i, { description: e.target.value })}
                                           maxLength={200} placeholder="e.g. monitor, peripherals, safety boots" className={field} />
                                </div>
                                <div>
                                    <label className="dtg-label">Quantity</label>
                                    <input type="number" min={1} step="any" value={row.quantity}
                                           onChange={(e) => setItem(i, { quantity: e.target.value })} className={field} />
                                </div>
                                {items.length > 1 && (
                                    <button type="button" aria-label="Remove item" onClick={() => setItems(items.filter((_, k) => k !== i))}
                                            className="mb-2 text-muted hover:text-danger">
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                            <textarea value={row.note} onChange={(e) => setItem(i, { note: e.target.value })} rows={2} maxLength={1000}
                                      placeholder="Note (optional): a preference or a minimum need, e.g. Logitech wireless, or at least 16 GB RAM"
                                      className={field} />
                        </div>
                    ))}
                    <button type="button" onClick={() => setItems([...items, blankItem()])} className="dtg-btn-ghost px-3 py-1.5 text-xs">
                        <Plus className="h-3.5 w-3.5" />
                        Add an item
                    </button>
                </div>

                <div className="dtg-panel-inset space-y-3 px-4 py-3">
                    <label className="flex items-center gap-2 text-sm text-paper">
                        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} className="h-3.5 w-3.5" />
                        Urgent: the approver has already said yes by WhatsApp or phone
                    </label>
                    {urgent && (
                        <>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <div>
                                    <label className="dtg-label">How</label>
                                    <select value={channel} onChange={(e) => setChannel(e.target.value as "whatsapp" | "phone")} className={field}>
                                        <option value="whatsapp" className="bg-surface">WhatsApp</option>
                                        <option value="phone" className="bg-surface">Phone call</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="dtg-label">When it was approved</label>
                                    <input type="datetime-local" value={approvedAt} onChange={(e) => setApprovedAt(e.target.value)} className={field} />
                                </div>
                            </div>
                            <div>
                                <label className="dtg-label">{channel === "phone" ? "Note of the call" : "Note (optional)"}</label>
                                <textarea value={urgentNote} onChange={(e) => setUrgentNote(e.target.value)} rows={2} className={field} />
                            </div>
                            <p className="text-micro text-muted">
                                {channel === "whatsapp"
                                    ? "After saving, attach the WhatsApp screenshot as approval evidence, then submit."
                                    : "Write down what was agreed on the call."}{" "}
                                Submit within 24 hours of the approval, or it is marked as a late entry.
                            </p>
                        </>
                    )}
                </div>
            </div>
        </Drawer>
    );
}
