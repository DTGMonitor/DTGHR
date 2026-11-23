import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, Store } from "lucide-react";

import Alert from "@/components/ui/Alert";
import Drawer from "@/components/ui/Drawer";
import { vendorService, type Vendor, type VendorInput } from "@/services/vendorService";
import { day, detail, when } from "./labels";

/*
 * The vendor list.
 *
 * Finance adds vendors with their bank account and keeps the other details.
 * After that only the approver changes a bank account, and only once they have called
 * the vendor back on the number already on file -- the procedure's main
 * guard against a fraudulent "please pay our new account" letter. A phone
 * number changed recently is called out, because calling back a number that
 * was just changed proves nothing.
 */

const blank: VendorInput = {
    name: "",
    npwp: "",
    is_pkp: false,
    contact_name: "",
    phone: "",
    email: "",
    notes: "",
    bank_name: "",
    bank_account_number: "",
    bank_account_holder: "",
};

export default function Vendors() {
    const [items, setItems] = useState<Vendor[]>([]);
    const [canManage, setCanManage] = useState(false);
    const [canChangeBank, setCanChangeBank] = useState(false);
    const [showInactive, setShowInactive] = useState(false);
    const [open, setOpen] = useState<Vendor | null>(null);
    const [form, setForm] = useState<{ editing: Vendor | null } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await vendorService.list(showInactive);
            setItems(res.data.items);
            setCanManage(res.data.can_manage);
            setCanChangeBank(res.data.can_change_bank);
        } catch (e) {
            setError(detail(e, "Could not load the vendors."));
        }
    }, [showInactive]);

    useEffect(() => {
        void load();
    }, [load]);

    const openVendor = async (id: string) => {
        try {
            setOpen((await vendorService.get(id)).data);
        } catch (e) {
            setError(detail(e, "Could not open that vendor."));
        }
    };

    const changed = (v: Vendor) => {
        setOpen(v);
        void load();
    };

    return (
        <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-paper-soft">
                    <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="h-3.5 w-3.5" />
                    Show inactive
                </label>
                {canManage && (
                    <button type="button" onClick={() => setForm({ editing: null })} className="dtg-btn-primary">
                        <Plus className="h-4 w-4" />
                        Add a vendor
                    </button>
                )}
            </div>

            {items.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center">
                    <Store className="mx-auto h-6 w-6 text-muted" />
                    <p className="mt-3 text-sm text-paper-soft">No vendors yet.</p>
                </div>
            ) : (
                <div className="dtg-panel overflow-x-auto">
                    <table className="w-full min-w-[40rem] text-left text-sm">
                        <thead className="border-b border-white/[0.08] text-micro uppercase tracking-label text-muted">
                            <tr>
                                <th className="px-5 py-3 font-semibold">Vendor</th>
                                <th className="px-3 py-3 font-semibold">NPWP</th>
                                <th className="px-3 py-3 font-semibold">Bank account</th>
                                <th className="px-5 py-3 text-right font-semibold">Purchases</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.06]">
                            {items.map((v) => (
                                <tr key={v.id} onClick={() => void openVendor(v.id)} className="cursor-pointer transition hover:bg-white/[0.03]">
                                    <td className="px-5 py-3">
                                        <p className="text-paper">{v.name}</p>
                                        <p className="text-micro text-muted">
                                            {v.is_pkp ? "PKP" : "Non-PKP"}
                                            {v.phone && ` · ${v.phone}`}
                                            {!v.is_active && " · inactive"}
                                        </p>
                                    </td>
                                    <td className="px-3 py-3 font-mono text-xs text-paper-soft">{v.npwp ?? "—"}</td>
                                    <td className="px-3 py-3 text-xs text-paper-soft">
                                        {v.bank_name ? `${v.bank_name} ${v.bank_account_number}` : "—"}
                                    </td>
                                    <td className="px-5 py-3 text-right font-mono text-xs text-paper-soft">{v.purchases}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {open && (
                <VendorDrawer
                    vendor={open}
                    canManage={canManage}
                    canChangeBank={canChangeBank}
                    onEdit={() => setForm({ editing: open })}
                    onChange={changed}
                    onClose={() => setOpen(null)}
                />
            )}
            {form && (
                <VendorForm
                    editing={form.editing}
                    onSaved={(v) => {
                        setForm(null);
                        changed(v);
                    }}
                    onClose={() => setForm(null)}
                />
            )}
        </div>
    );
}

function VendorForm({ editing, onSaved, onClose }: { editing: Vendor | null; onSaved: (v: Vendor) => void; onClose: () => void }) {
    const [f, setF] = useState<VendorInput>(
        editing
            ? {
                  name: editing.name,
                  npwp: editing.npwp ?? "",
                  is_pkp: editing.is_pkp,
                  contact_name: editing.contact_name ?? "",
                  phone: editing.phone ?? "",
                  email: editing.email ?? "",
                  notes: editing.notes ?? "",
              }
            : blank,
    );
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const set = (k: keyof VendorInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setF({ ...f, [k]: e.target.value });

    const save = async () => {
        setBusy(true);
        try {
            if (editing) {
                // Only what changed: the server refuses an edit that changes nothing.
                const changes: Partial<VendorInput> = {};
                (Object.keys(f) as (keyof VendorInput)[]).forEach((k) => {
                    const before = k === "is_pkp" ? editing.is_pkp : ((editing as unknown as Record<string, unknown>)[k] ?? "");
                    if (f[k] !== before) (changes as Record<string, unknown>)[k] = f[k];
                });
                onSaved((await vendorService.update(editing.id, changes)).data);
            } else {
                onSaved((await vendorService.create(f)).data);
            }
        } catch (e) {
            setError(detail(e, "Could not save the vendor."));
        } finally {
            setBusy(false);
        }
    };

    const field = "dtg-input";
    return (
        <Drawer
            title={editing ? `Edit ${editing.name}` : "Add a vendor"}
            eyebrow="Vendors"
            onClose={onClose}
            footer={
                <button type="button" disabled={busy} onClick={() => void save()} className="dtg-btn-primary">
                    Save
                </button>
            }
        >
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
                {error && <Alert tone="danger">{error}</Alert>}
                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                        <label className="dtg-label">Name</label>
                        <input value={f.name} onChange={set("name")} maxLength={200} className={field} />
                    </div>
                    <div>
                        <label className="dtg-label">NPWP</label>
                        <input value={f.npwp} onChange={set("npwp")} maxLength={30} className={`${field} font-mono`} />
                    </div>
                    <label className="flex items-center gap-2 self-end pb-2 text-sm text-paper-soft">
                        <input type="checkbox" checked={f.is_pkp} onChange={(e) => setF({ ...f, is_pkp: e.target.checked })} className="h-3.5 w-3.5" />
                        PKP (charges PPN)
                    </label>
                    <div>
                        <label className="dtg-label">Contact person</label>
                        <input value={f.contact_name} onChange={set("contact_name")} maxLength={160} className={field} />
                    </div>
                    <div>
                        <label className="dtg-label">Phone (used for bank callbacks)</label>
                        <input value={f.phone} onChange={set("phone")} maxLength={40} className={field} />
                    </div>
                    <div className="sm:col-span-2">
                        <label className="dtg-label">Email</label>
                        <input value={f.email} onChange={set("email")} maxLength={200} className={field} />
                    </div>
                </div>
                {editing ? (
                    <Alert tone="info">Only the approver changes the bank account, after calling the vendor back.</Alert>
                ) : (
                    <div className="dtg-panel-inset grid gap-4 px-4 py-3 sm:grid-cols-3">
                        <div>
                            <label className="dtg-label">Bank</label>
                            <input value={f.bank_name} onChange={set("bank_name")} maxLength={100} className={field} />
                        </div>
                        <div>
                            <label className="dtg-label">Account number</label>
                            <input value={f.bank_account_number} onChange={set("bank_account_number")} maxLength={40} className={`${field} font-mono`} />
                        </div>
                        <div>
                            <label className="dtg-label">Account holder</label>
                            <input value={f.bank_account_holder} onChange={set("bank_account_holder")} maxLength={160} className={field} />
                        </div>
                        <p className="text-micro text-muted sm:col-span-3">
                            Check it against the vendor's letterhead or invoice. After this, only the approver can change it.
                        </p>
                    </div>
                )}
                <div>
                    <label className="dtg-label">Notes</label>
                    <textarea value={f.notes} onChange={set("notes")} rows={2} className={field} />
                </div>
            </div>
        </Drawer>
    );
}

function VendorDrawer({
    vendor: v,
    canManage,
    canChangeBank,
    onEdit,
    onChange,
    onClose,
}: {
    vendor: Vendor;
    canManage: boolean;
    canChangeBank: boolean;
    onEdit: () => void;
    onChange: (v: Vendor) => void;
    onClose: () => void;
}) {
    const [bank, setBank] = useState<{ bank_name: string; bank_account_number: string; bank_account_holder: string; callback_note: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const run = async (fn: () => Promise<{ data: Vendor }>, fallback: string) => {
        setBusy(true);
        try {
            onChange((await fn()).data);
            setBank(null);
            setError(null);
        } catch (e) {
            setError(detail(e, fallback));
        } finally {
            setBusy(false);
        }
    };

    const rows: [string, string | null][] = [
        ["NPWP", v.npwp],
        ["Tax status", v.is_pkp ? "PKP (charges PPN)" : "Non-PKP"],
        ["Contact", v.contact_name],
        ["Phone", v.phone],
        ["Email", v.email],
        ["Bank", v.bank_name],
        ["Account number", v.bank_account_number],
        ["Account holder", v.bank_account_holder],
    ];

    return (
        <Drawer title={v.name} eyebrow={v.is_active ? "Vendor" : "Vendor · inactive"} onClose={onClose}>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
                {error && <Alert tone="danger">{error}</Alert>}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    {rows.map(([k, val]) => (
                        <div key={k}>
                            <dt className="text-micro uppercase tracking-label text-muted">{k}</dt>
                            <dd className="mt-0.5 break-words text-paper">{val || "—"}</dd>
                        </div>
                    ))}
                </dl>
                {v.notes && <p className="whitespace-pre-wrap text-sm text-paper-soft">{v.notes}</p>}

                <div className="flex flex-wrap gap-2">
                    {canManage && (
                        <button type="button" onClick={onEdit} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                            Edit details
                        </button>
                    )}
                    {canChangeBank && !bank && (
                        <button
                            type="button"
                            onClick={() => setBank({ bank_name: v.bank_name ?? "", bank_account_number: "", bank_account_holder: v.bank_account_holder ?? "", callback_note: "" })}
                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                        >
                            Change bank account
                        </button>
                    )}
                    {(canManage || canChangeBank) && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void run(() => vendorService.setActive(v.id, !v.is_active), "Could not change that.")}
                            className="dtg-btn-ghost px-3 py-1.5 text-xs"
                        >
                            {v.is_active ? "Deactivate" : "Reactivate"}
                        </button>
                    )}
                </div>

                {bank && (
                    <div className="dtg-panel-inset space-y-3 px-4 py-4">
                        <p className="text-sm font-semibold text-paper">Change the bank account</p>
                        {v.phone ? (
                            <p className="text-sm text-paper-soft">
                                First call the vendor on the number on file, <span className="font-mono text-paper">{v.phone}</span>,
                                and confirm the new account with them. Never use a number from the letter or email asking for
                                the change.
                            </p>
                        ) : (
                            <Alert tone="warning">There is no phone number on file to call back. Finance must add one first.</Alert>
                        )}
                        {v.phone_changed_recently && (
                            <Alert tone="warning">
                                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                                The phone number was changed in the last 30 days. Confirm the account another way as well.
                            </Alert>
                        )}
                        <div className="grid gap-3 sm:grid-cols-3">
                            <input value={bank.bank_name} onChange={(e) => setBank({ ...bank, bank_name: e.target.value })} placeholder="Bank" className="dtg-input" />
                            <input value={bank.bank_account_number} onChange={(e) => setBank({ ...bank, bank_account_number: e.target.value })} placeholder="Account number" className="dtg-input font-mono" />
                            <input value={bank.bank_account_holder} onChange={(e) => setBank({ ...bank, bank_account_holder: e.target.value })} placeholder="Account holder" className="dtg-input" />
                        </div>
                        <textarea
                            value={bank.callback_note}
                            onChange={(e) => setBank({ ...bank, callback_note: e.target.value })}
                            rows={2}
                            placeholder="Who you spoke to, and what they confirmed"
                            className="dtg-input"
                        />
                        <div className="flex gap-2">
                            <button
                                type="button"
                                disabled={busy || !v.phone || !bank.callback_note.trim()}
                                onClick={() => void run(() => vendorService.changeBank(v.id, bank), "Could not change the account.")}
                                className="dtg-btn-primary px-3 py-1.5 text-xs"
                            >
                                Save new account
                            </button>
                            <button type="button" onClick={() => setBank(null)} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                <div>
                    <p className="dtg-eyebrow">History</p>
                    <ol className="mt-3 space-y-2.5 border-l border-white/[0.08] pl-4">
                        {[...v.events].reverse().map((e) => (
                            <li key={e.id} className="relative">
                                <span className="absolute -left-[1.3rem] top-1.5 h-1.5 w-1.5 rounded-full bg-white/25" />
                                <p className="text-micro text-muted">
                                    <span className="font-semibold text-paper-soft">{e.actor_name}</span> · {when(e.created_at)}
                                </p>
                                <p className="text-xs leading-relaxed text-paper-soft">
                                    {e.kind === "bank_changed"
                                        ? `Bank account changed from ${String(e.before?.bank_account_number ?? "none")} to ${String(e.after?.bank_account_number ?? "")}; called ${String(e.detail?.phone_called ?? "")}`
                                        : e.kind === "edited"
                                          ? `Edited: ${Object.keys(e.after ?? {}).join(", ")}`
                                          : e.kind.charAt(0).toUpperCase() + e.kind.slice(1)}
                                    {e.note && <span className="text-muted">: {e.note}</span>}
                                    {e.kind === "bank_changed" && e.detail?.phone_changed_recently === true && (
                                        <span className="text-gold"> (phone had changed recently)</span>
                                    )}
                                </p>
                            </li>
                        ))}
                    </ol>
                </div>
                <p className="text-micro text-muted">Added {day(v.created_at)}</p>
            </div>
        </Drawer>
    );
}
