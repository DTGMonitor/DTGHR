import { useState } from "react";
import { Plus } from "lucide-react";

import Alert from "@/components/ui/Alert";
import { assetService, type AssetCategory } from "@/services/assetService";
import { detail } from "./labels";

/*
 * The categories, for IT. A code goes into every tag in its category, so it
 * is fixed once an item carries it; the name can change and a category can
 * be retired from new registrations.
 */

type Draft = { id?: string; code: string; name: string; tracks_calibration: boolean; is_active: boolean };

export default function Categories({
    categories,
    onChange,
}: {
    categories: AssetCategory[];
    onChange: (c: AssetCategory[]) => void;
}) {
    const [draft, setDraft] = useState<Draft | null>(null);
    const [error, setError] = useState<string | null>(null);

    const save = async () => {
        if (!draft) return;
        try {
            onChange((await assetService.saveCategory(draft)).data);
            setDraft(null);
            setError(null);
        } catch (e) {
            setError(detail(e, "Could not save that category."));
        }
    };

    const used = (c: AssetCategory) => (c.assets ?? 0) > 0;

    return (
        <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={() => setDraft({ code: "", name: "", tracks_calibration: false, is_active: true })}
                    className="dtg-btn-secondary"
                >
                    <Plus className="h-4 w-4" />
                    New category
                </button>
            </div>

            {draft && (
                <div className="dtg-panel grid gap-4 px-5 py-4 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
                    <div>
                        <label className="dtg-label">Code</label>
                        <input
                            value={draft.code}
                            onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
                            maxLength={4}
                            disabled={Boolean(draft.id) && used(categories.find((c) => c.id === draft.id)!)}
                            placeholder="CAM"
                            className="dtg-input font-mono"
                        />
                    </div>
                    <div>
                        <label className="dtg-label">Name</label>
                        <input
                            value={draft.name}
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            maxLength={80}
                            className="dtg-input"
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-xs text-paper-soft">
                            <input
                                type="checkbox"
                                checked={draft.tracks_calibration}
                                onChange={(e) => setDraft({ ...draft, tracks_calibration: e.target.checked })}
                                className="h-3.5 w-3.5 rounded border-white/20 bg-white/5"
                            />
                            Tracks calibration
                        </label>
                        <label className="flex items-center gap-2 text-xs text-paper-soft">
                            <input
                                type="checkbox"
                                checked={draft.is_active}
                                onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
                                className="h-3.5 w-3.5 rounded border-white/20 bg-white/5"
                            />
                            In use
                        </label>
                        <button type="button" onClick={() => void save()} className="dtg-btn-primary px-3 py-1.5 text-xs">
                            Save
                        </button>
                        <button type="button" onClick={() => setDraft(null)} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            <div className="dtg-panel overflow-hidden">
                <ul className="divide-y divide-white/[0.06]">
                    {categories.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                            <div>
                                <p className="text-sm text-paper">
                                    <span className="font-mono text-micro text-muted">{c.code}</span> {c.name}
                                    {c.tracks_calibration && <span className="ml-2 text-micro text-teal-200">calibration</span>}
                                    {c.is_active === false && <span className="ml-2 text-micro text-muted">not in use</span>}
                                </p>
                                <p className="text-micro text-muted">
                                    {c.assets ?? 0} item{c.assets === 1 ? "" : "s"} · next tag {c.next_tag}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() =>
                                    setDraft({
                                        id: c.id,
                                        code: c.code,
                                        name: c.name,
                                        tracks_calibration: c.tracks_calibration,
                                        is_active: c.is_active !== false,
                                    })
                                }
                                className="text-xs text-paper-soft transition hover:text-paper"
                            >
                                Edit
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
