import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import MoneyInput from "@/components/ui/MoneyInput";
import { assetService, type AssetCategory } from "@/services/assetService";
import { purchaseOrderService, type PurchaseOrder } from "@/services/contractService";
import type { LineInput, LineType, Purchase } from "@/services/purchaseService";
import { LINE_TYPE, rp } from "./labels";

/*
 * Finance's purchase lines: what is actually bought. They start as the
 * requester's items (with the requester's note as the specification) and
 * finance rewrites, splits, adds and removes them, and gives each a type,
 * a category for an asset, a unit price and, for stock to sell, the client
 * PO it is for. The server replaces the lines wholesale on save.
 */

export interface LineRow {
    line_type: LineType;
    description: string;
    specification: string;
    quantity: string;
    unit: string;
    unit_price: string;
    asset_category_id: string;
    client_po_id: string;
}

export const rowsFrom = (p: Purchase): LineRow[] =>
    (p.lines ?? []).map((l) => ({
        line_type: l.line_type,
        description: l.description,
        specification: l.specification ?? "",
        quantity: String(l.quantity),
        unit: l.unit,
        unit_price: l.unit_price == null ? "" : String(l.unit_price),
        asset_category_id: l.asset_category?.id ?? "",
        client_po_id: l.client_po?.id ?? "",
    }));

export const toInput = (rows: LineRow[]): LineInput[] =>
    rows
        .filter((r) => r.description.trim())
        .map((r) => ({
            line_type: r.line_type,
            description: r.description.trim(),
            specification: r.specification.trim() || null,
            quantity: Number(r.quantity) || 0,
            unit: r.unit.trim() || "pcs",
            unit_price: Number(r.unit_price) || 0,
            asset_category_id: r.line_type === "asset" ? r.asset_category_id || null : null,
            client_po_id: r.line_type === "inventory" ? r.client_po_id || null : null,
        }));

const blank = (): LineRow => ({
    line_type: "expense",
    description: "",
    specification: "",
    quantity: "1",
    unit: "pcs",
    unit_price: "",
    asset_category_id: "",
    client_po_id: "",
});

export default function LineEditor({ rows, onChange }: { rows: LineRow[]; onChange: (rows: LineRow[]) => void }) {
    const [categories, setCategories] = useState<AssetCategory[]>([]);
    const [clientPos, setClientPos] = useState<PurchaseOrder[]>([]);

    useEffect(() => {
        assetService.categories().then((res) => setCategories(res.data.filter((c) => c.is_active !== false))).catch(() => undefined);
        purchaseOrderService.list({ status: "active" }).then((res) => setClientPos(res.data.items)).catch(() => undefined);
    }, []);

    const set = (i: number, patch: Partial<LineRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
    const total = rows.reduce((s, r) => s + (Number(r.quantity) || 0) * (Number(r.unit_price) || 0), 0);
    const small = "dtg-input py-1 text-xs";

    return (
        <div className="space-y-2">
            {rows.map((r, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-white/[0.08] px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                        {(Object.keys(LINE_TYPE) as LineType[]).map((t) => (
                            <button
                                key={t}
                                type="button"
                                title={LINE_TYPE[t].hint}
                                onClick={() => set(i, { line_type: t })}
                                className={`rounded-full border px-2.5 py-0.5 text-micro font-semibold transition-colors ${
                                    r.line_type === t ? "border-signal/50 bg-signal/15 text-signal" : "border-white/15 text-paper-soft hover:text-paper"
                                }`}
                            >
                                {LINE_TYPE[t].label}
                            </button>
                        ))}
                        <button type="button" aria-label="Remove line" onClick={() => onChange(rows.filter((_, k) => k !== i))}
                                className="ml-auto text-muted hover:text-danger">
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    </div>
                    <input value={r.description} onChange={(e) => set(i, { description: e.target.value })} maxLength={300}
                           placeholder="What is bought" className={small} />
                    <textarea value={r.specification} onChange={(e) => set(i, { specification: e.target.value })} rows={2}
                              placeholder="Specification" className={small} />
                    <div className="grid gap-2 sm:grid-cols-[5rem_5rem_1fr]">
                        <input type="number" min={0} step={r.line_type === "asset" ? 1 : "any"} value={r.quantity}
                               onChange={(e) => set(i, { quantity: e.target.value })} aria-label="Quantity" className={small} />
                        <input value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} maxLength={20} aria-label="Unit" className={small} />
                        <MoneyInput value={r.unit_price} onChange={(raw) => set(i, { unit_price: raw })} className={small} />
                    </div>
                    {r.line_type === "asset" && (
                        <select value={r.asset_category_id} onChange={(e) => set(i, { asset_category_id: e.target.value })} className={small}>
                            <option value="" className="bg-surface">Asset category…</option>
                            {categories.map((c) => (
                                <option key={c.id} value={c.id} className="bg-surface">{c.name} ({c.code})</option>
                            ))}
                        </select>
                    )}
                    {r.line_type === "inventory" && (
                        <select value={r.client_po_id} onChange={(e) => set(i, { client_po_id: e.target.value })} className={small}>
                            <option value="" className="bg-surface">Client PO it is for (optional)…</option>
                            {clientPos.map((po) => (
                                <option key={po.id} value={po.id} className="bg-surface">{po.client_name} · {po.po_number}</option>
                            ))}
                        </select>
                    )}
                </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => onChange([...rows, blank()])} className="dtg-btn-ghost px-3 py-1 text-xs">
                    <Plus className="h-3.5 w-3.5" />
                    Add a line
                </button>
                <p className="text-xs text-paper-soft">
                    Lines total <span className="font-mono text-paper">{rp(total)}</span>
                </p>
            </div>
        </div>
    );
}
