import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Laptop, Plus, ShieldCheck, UserMinus } from "lucide-react";

import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";
import AssetDrawer from "@/components/assets/AssetDrawer";
import AssetForm from "@/components/assets/AssetForm";
import Categories from "@/components/assets/Categories";
import CheckIns from "@/components/assets/CheckIns";
import { STATUS_CHIP, day, daysSince, detail, money } from "@/components/assets/labels";
import { useOpenParam } from "@/lib/useOpenParam";
import { scheduleService } from "@/services/scheduleService";
import {
    assetService,
    type Asset,
    type AssetCategory,
    type AssetStatus,
    type Leaver,
    type MyEquipment,
} from "@/services/assetService";
import type { ScheduleEmployee } from "@/types/schedule";

/*
 * Assets.
 *
 * The register used to be an Excel file IT kept, and it went stale because
 * every change relied on somebody remembering to open it. Here the record
 * moves with the item: IT records each handover, the holder confirms it, a
 * ticket about the item lands on its history, and a check-in every six
 * months has every holder confirm what they have.
 *
 * Everybody has My equipment. IT, finance and management also get the
 * register and the check-ins; IT alone registers and moves items, and keeps
 * the categories. Which of those somebody is comes from the server.
 */

type Tab = "register" | "checkins" | "mine" | "categories";

const STATUSES: { value: AssetStatus | ""; label: string }[] = [
    { value: "", label: "Any status" },
    { value: "in_store", label: "In store" },
    { value: "assigned", label: "Assigned" },
    { value: "in_repair", label: "In repair" },
    { value: "lost", label: "Lost" },
    { value: "retired", label: "Retired" },
];

export default function AssetsPage() {
    const [mine, setMine] = useState<MyEquipment | null>(null);
    const [assets, setAssets] = useState<Asset[]>([]);
    const [categories, setCategories] = useState<AssetCategory[]>([]);
    const [leavers, setLeavers] = useState<Leaver[]>([]);
    const [staff, setStaff] = useState<ScheduleEmployee[]>([]);
    const [error, setError] = useState<string | null>(null);

    const [params, setParams] = useSearchParams();
    const tabParam = params.get("tab");
    const [openId, setOpenId] = useOpenParam("open");
    const [roundId, setRoundId] = useOpenParam("round");
    const [holderParam, setHolderParam] = useOpenParam("holder");
    const [open, setOpen] = useState<Asset | null>(null);
    const [form, setForm] = useState<{ editing: Asset | null } | null>(null);

    const [search, setSearch] = useState("");
    const [status, setStatus] = useState<AssetStatus | "">("");
    const [categoryId, setCategoryId] = useState("");
    const [onlyFlagged, setOnlyFlagged] = useState(false);
    const [onlyPending, setOnlyPending] = useState(false);

    const canViewAll = mine?.can_view_all ?? false;
    const canManage = mine?.can_manage ?? false;

    // A check-in link lands a holder on My equipment, and a viewer on the
    // round itself.
    const tab: Tab = !canViewAll
        ? "mine"
        : tabParam === "checkins" || tabParam === "mine" || (tabParam === "categories" && canManage)
          ? (tabParam as Tab)
          : roundId
            ? "checkins"
            : "register";

    const loadMine = useCallback(async () => {
        try {
            setMine((await assetService.mine()).data);
        } catch (e) {
            setError(detail(e, "Could not load your equipment."));
        }
    }, []);

    const loadRegister = useCallback(async () => {
        try {
            const [list, cats, left] = await Promise.all([
                assetService.list(true),
                assetService.categories(),
                assetService.leavers(),
            ]);
            setAssets(list.data.items);
            setCategories(cats.data);
            setLeavers(left.data);
        } catch (e) {
            setError(detail(e, "Could not load the register."));
        }
    }, []);

    useEffect(() => {
        void loadMine();
    }, [loadMine]);

    useEffect(() => {
        if (canViewAll) void loadRegister();
    }, [canViewAll, loadRegister]);

    // The people IT hands items to: the roster's names, which every member
    // of staff may read.
    useEffect(() => {
        if (!canManage || staff.length) return;
        scheduleService
            .visibleEmployees()
            .then((res) =>
                setStaff(
                    [...res.data].sort((a, b) =>
                        `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`),
                    ),
                ),
            )
            .catch(() => setError("Could not load the staff list."));
    }, [canManage, staff.length]);

    useEffect(() => {
        if (!openId) {
            setOpen(null);
            return;
        }
        if (open?.id === openId) return;
        let live = true;
        assetService
            .get(openId)
            .then((res) => live && setOpen(res.data))
            .catch(() => {
                if (!live) return;
                setError("That item could not be found.");
                setOpenId(null);
            });
        return () => {
            live = false;
        };
    }, [openId]);

    const changed = async (a: Asset) => {
        setOpen(a);
        await Promise.all([loadMine(), canViewAll ? loadRegister() : Promise.resolve()]);
    };

    const holderName = holderParam
        ? assets.find((a) => a.holder?.employee_id === holderParam)?.holder?.name ??
          leavers.find((l) => l.employee_id === holderParam)?.name ??
          "this person"
        : null;

    const shown = useMemo(() => {
        const q = search.trim().toLowerCase();
        return assets.filter(
            (a) =>
                (status ? a.status === status : a.status !== "retired") &&
                (!categoryId || a.category.id === categoryId) &&
                (!onlyFlagged || a.flag) &&
                (!onlyPending || a.handover_pending) &&
                (!holderParam || a.holder?.employee_id === holderParam) &&
                (!q ||
                    [a.tag, a.name, a.serial_number, a.brand, a.model, a.holder?.name]
                        .filter(Boolean)
                        .some((s) => s!.toLowerCase().includes(q))),
        );
    }, [assets, search, status, categoryId, onlyFlagged, onlyPending, holderParam]);

    const pendingCount = assets.filter((a) => a.handover_pending).length;
    const flaggedCount = assets.filter((a) => a.flag).length;

    const tabs: [Tab, string][] = canViewAll
        ? [
              ["register", "Register"],
              ["checkins", "Check-ins"],
              ["mine", "My equipment"],
              ...(canManage ? ([["categories", "Categories"]] as [Tab, string][]) : []),
          ]
        : [];

    const input =
        "rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-paper focus:border-signal/60 focus:outline-none";

    return (
        <div className="dtg-fade-in space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Assets</p>
                    <h1 className="mt-1.5 flex items-center gap-2 text-2xl font-bold tracking-tight text-paper">
                        {canViewAll ? "Asset register" : "My equipment"}
                        {canManage && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-signal/30 bg-signal/10 px-2 py-0.5 text-micro font-semibold uppercase tracking-label text-signal">
                                <ShieldCheck className="h-3 w-3" />
                                IT
                            </span>
                        )}
                    </h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        {tab === "register"
                            ? "Every company item, who has it, and everything that has happened to it."
                            : tab === "checkins"
                              ? "Every holder confirms what they have; IT checks what is on the shelf. Closed rounds are kept as the record."
                              : tab === "categories"
                                ? "The kinds of item, and the code each puts in its tags."
                                : "The company equipment recorded against you. Confirm each item when IT hands it over."}
                    </p>
                </div>
                {canManage && tab === "register" && (
                    <button type="button" onClick={() => setForm({ editing: null })} className="dtg-btn-primary">
                        <Plus className="h-4 w-4" />
                        Register an item
                    </button>
                )}
            </header>

            {tabs.length > 0 && (
                <div role="tablist" className="flex flex-wrap gap-1 border-b border-white/10">
                    {tabs.map(([key, label]) => (
                        <button
                            key={key}
                            role="tab"
                            aria-selected={tab === key}
                            onClick={() =>
                                // One update: separate setters would each start
                                // from the same URL and undo one another.
                                setParams(
                                    (prev) => {
                                        const next = new URLSearchParams(prev);
                                        for (const k of ["round", "holder", "open"]) next.delete(k);
                                        if (key === "register") next.delete("tab");
                                        else next.set("tab", key);
                                        return next;
                                    },
                                    { replace: true },
                                )
                            }
                            className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors ${
                                tab === key
                                    ? "border-signal font-semibold text-paper"
                                    : "border-transparent font-medium text-paper-soft hover:border-teal-500 hover:text-paper"
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            )}

            {error && <Alert tone="danger">{error}</Alert>}

            {mine === null ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : tab === "mine" ? (
                <MyEquipmentList mine={mine} onOpen={setOpenId} />
            ) : tab === "checkins" ? (
                <CheckIns roundId={roundId} onOpenRound={setRoundId} onOpenAsset={setOpenId} />
            ) : tab === "categories" ? (
                <Categories categories={categories} onChange={setCategories} />
            ) : (
                <div className="space-y-4">
                    {/* Who is leaving with company equipment. */}
                    {leavers.length > 0 && !holderParam && (
                        <div className="dtg-panel px-5 py-4">
                            <p className="dtg-eyebrow flex items-center gap-1.5">
                                <UserMinus className="h-3.5 w-3.5" />
                                Leaving with items
                            </p>
                            <ul className="mt-2 space-y-1.5">
                                {leavers.map((l) => (
                                    <li key={l.employee_id} className="flex flex-wrap items-center gap-2 text-sm">
                                        <button
                                            type="button"
                                            onClick={() => setHolderParam(l.employee_id)}
                                            className="font-semibold text-paper hover:underline"
                                        >
                                            {l.name}
                                        </button>
                                        <span className="text-micro text-muted">
                                            {l.reason === "inactive" ? "No longer active" : `Contract ends ${day(l.end_date)}`}
                                            {" · "}
                                            {l.items.map((i) => i.tag).join(", ")}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {holderParam && (
                        <Alert tone="info">
                            Showing items held by {holderName}.{" "}
                            <button type="button" onClick={() => setHolderParam(null)} className="font-semibold underline-offset-2 hover:underline">
                                Show everything
                            </button>
                        </Alert>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search tag, serial, name or holder"
                            className={`${input} w-64`}
                        />
                        <select value={status} onChange={(e) => setStatus(e.target.value as AssetStatus | "")} className={input}>
                            {STATUSES.map((s) => (
                                <option key={s.value} value={s.value} className="bg-surface">
                                    {s.label}
                                </option>
                            ))}
                        </select>
                        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={input}>
                            <option value="" className="bg-surface">Any category</option>
                            {categories.map((c) => (
                                <option key={c.id} value={c.id} className="bg-surface">
                                    {c.name}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={() => setOnlyPending((v) => !v)}
                            className={`rounded-full border px-3 py-1 text-micro font-semibold transition-colors ${
                                onlyPending ? "border-gold/50 bg-gold/15 text-gold" : "border-white/15 text-paper-soft hover:text-paper"
                            }`}
                        >
                            Pending handover <span className="font-mono">{pendingCount}</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setOnlyFlagged((v) => !v)}
                            className={`rounded-full border px-3 py-1 text-micro font-semibold transition-colors ${
                                onlyFlagged ? "border-danger/50 bg-danger/15 text-danger" : "border-white/15 text-paper-soft hover:text-paper"
                            }`}
                        >
                            Flagged <span className="font-mono">{flaggedCount}</span>
                        </button>
                    </div>

                    {shown.length === 0 ? (
                        <div className="dtg-panel px-5 py-14 text-center">
                            <Laptop className="mx-auto h-6 w-6 text-muted" />
                            <p className="mt-3 text-sm text-paper-soft">
                                {assets.length === 0
                                    ? canManage
                                        ? "Nothing registered yet. Register the first item to start the register."
                                        : "Nothing registered yet."
                                    : "Nothing matches."}
                            </p>
                        </div>
                    ) : (
                        <div className="dtg-panel overflow-x-auto">
                            <table className="w-full min-w-[44rem] text-left text-sm">
                                <thead className="border-b border-white/[0.08] text-micro uppercase tracking-label text-muted">
                                    <tr>
                                        <th className="px-5 py-3 font-semibold">Tag</th>
                                        <th className="px-3 py-3 font-semibold">Item</th>
                                        <th className="px-3 py-3 font-semibold">Status</th>
                                        <th className="px-3 py-3 font-semibold">Holder / location</th>
                                        <th className="px-5 py-3 text-right font-semibold">Value</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/[0.06]">
                                    {shown.map((a) => (
                                        <tr
                                            key={a.id}
                                            onClick={() => setOpenId(a.id)}
                                            className="cursor-pointer transition hover:bg-white/[0.03]"
                                        >
                                            <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-paper-soft">{a.tag}</td>
                                            <td className="px-3 py-3">
                                                <p className="text-paper">{a.name}</p>
                                                <p className="text-micro text-muted">
                                                    {a.category.name}
                                                    {a.serial_number && ` · ${a.serial_number}`}
                                                </p>
                                            </td>
                                            <td className="px-3 py-3">
                                                <span className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${STATUS_CHIP[a.status].cls}`}>
                                                    {STATUS_CHIP[a.status].label}
                                                </span>
                                                {a.flag && <span className="ml-1.5 text-micro font-semibold text-danger">flagged</span>}
                                            </td>
                                            <td className="px-3 py-3 text-paper-soft">
                                                {a.holder ? (
                                                    <>
                                                        {a.holder.name}
                                                        {a.handover_pending && (
                                                            <span className="block text-micro text-gold">
                                                                pending {daysSince(a.holder.since)} days
                                                            </span>
                                                        )}
                                                    </>
                                                ) : (
                                                    <span className="text-muted">{a.location ?? "—"}</span>
                                                )}
                                            </td>
                                            <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-xs text-paper-soft">
                                                {money(a.purchase_value, a.currency)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {open && (
                <AssetDrawer
                    asset={open}
                    staff={staff}
                    onChange={(a) => void changed(a)}
                    onClose={() => setOpenId(null)}
                    onEdit={canManage ? (a) => setForm({ editing: a }) : undefined}
                />
            )}

            {form && (
                <AssetForm
                    editing={form.editing}
                    categories={categories}
                    staff={staff}
                    onSaved={(a) => {
                        if (form.editing) setOpen(a);
                        void loadRegister();
                        void loadMine();
                    }}
                    onClose={() => setForm(null)}
                />
            )}
        </div>
    );
}

/** What the caller holds, the handovers waiting on them, and the open check-in. */
function MyEquipmentList({ mine, onOpen }: { mine: MyEquipment; onOpen: (id: string) => void }) {
    const toConfirm = mine.items.filter((a) => a.can_respond).length;
    return (
        <div className="space-y-4">
            {mine.round && mine.round.pending > 0 && (
                <Alert tone="warning">
                    <span className="font-semibold">{mine.round.name}:</span> confirm{" "}
                    {mine.round.pending === 1 ? "the item" : `the ${mine.round.pending} items`} below by{" "}
                    {day(mine.round.due_date)}. Open each one and say whether you have it.
                </Alert>
            )}
            {toConfirm > 0 && (
                <Alert tone="info">
                    {toConfirm === 1 ? "One item is" : `${toConfirm} items are`} waiting for you to confirm the handover.
                </Alert>
            )}

            {mine.items.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center">
                    <Laptop className="mx-auto h-6 w-6 text-muted" />
                    <p className="mt-3 text-sm text-paper-soft">No company equipment is recorded against you.</p>
                </div>
            ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                    {mine.items.map((a) => (
                        <button
                            key={a.id}
                            type="button"
                            onClick={() => onOpen(a.id)}
                            className="dtg-panel px-5 py-4 text-left transition hover:border-white/20"
                        >
                            <p className="font-mono text-micro text-muted">{a.tag}</p>
                            <p className="mt-0.5 text-sm font-semibold text-paper">{a.name}</p>
                            <p className="text-micro text-muted">
                                {a.category.name}
                                {a.serial_number && ` · ${a.serial_number}`}
                                {a.holder?.since && ` · since ${day(a.holder.since)}`}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {a.status === "in_repair" && (
                                    <span className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${STATUS_CHIP.in_repair.cls}`}>
                                        In repair
                                    </span>
                                )}
                                {a.can_respond && (
                                    <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-micro font-semibold uppercase tracking-label text-gold">
                                        Confirm handover
                                    </span>
                                )}
                                {a.checkin?.can_answer && (
                                    <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-micro font-semibold uppercase tracking-label text-gold">
                                        Check-in
                                    </span>
                                )}
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
