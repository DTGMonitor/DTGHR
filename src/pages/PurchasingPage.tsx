import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, ShoppingCart } from "lucide-react";

import Alert from "@/components/ui/Alert";
import MoneyInput from "@/components/ui/MoneyInput";
import Spinner from "@/components/ui/Spinner";
import PurchaseDrawer from "@/components/purchasing/PurchaseDrawer";
import RequestForm from "@/components/purchasing/RequestForm";
import Vendors from "@/components/purchasing/Vendors";
import { STATUS_CHIP, TIER_LABEL, day, detail, milestoneLabel, rp } from "@/components/purchasing/labels";
import { useAuth } from "@/contexts/AuthContext";
import { useOpenParam } from "@/lib/useOpenParam";
import {
    purchaseService,
    type Purchase,
    type PurchaseSettings,
    type PurchaseStatus,
} from "@/services/purchaseService";

/*
 * Purchasing.
 *
 * The company's purchasing procedure keeps two pairs apart: the person who
 * approves and releases money (the approver) never keeps the books, and the
 * person who keeps the books (finance) never approves; and whoever asked for
 * something never checks it in. Above the petty-cash limit every purchase
 * runs request -> register -> quotes -> approval -> order -> goods received ->
 * invoice match -> payment, and each step lands with the person whose step
 * it is.
 *
 * The requester asks in general terms and tracks five milestones; the
 * detail -- lines, vendor, amounts, checker -- is finance's. Everybody has My
 * requests and, when named, To check. Finance, the director and the approver
 * also get the register, the vendors and the settings, and the approver has
 * the approvals.
 */

type Tab = "mine" | "check" | "register" | "approvals" | "vendors" | "settings";

const STATUSES: { value: PurchaseStatus | "" | "open"; label: string }[] = [
    { value: "open", label: "Open" },
    { value: "", label: "Any status" },
    ...(Object.keys(STATUS_CHIP) as PurchaseStatus[])
        .filter((s) => s !== "draft")
        .map((s) => ({ value: s, label: STATUS_CHIP[s].label })),
];
const CLOSED: PurchaseStatus[] = ["paid", "cancelled", "petty_cash"];

export default function PurchasingPage() {
    const { user } = useAuth();
    const role = user?.role;
    const fullViewer = role === "finance" || role === "director" || role === "executive";

    const [mine, setMine] = useState<Purchase[] | null>(null);
    const [toCheck, setToCheck] = useState<Purchase[]>([]);
    const [all, setAll] = useState<Purchase[]>([]);
    const [settings, setSettings] = useState<PurchaseSettings | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [params, setParams] = useSearchParams();
    const [openId, setOpenId] = useOpenParam("open");
    const [open, setOpen] = useState<Purchase | null>(null);
    const [form, setForm] = useState<{ editing: Purchase | null } | null>(null);

    const [search, setSearch] = useState("");
    const [status, setStatus] = useState<PurchaseStatus | "" | "open">("open");
    const [flag, setFlag] = useState<"" | "urgent" | "late_entry" | "self_approved" | "related_party">("");

    const tabs: [Tab, string][] = [
        ["mine", "My requests"],
        ["check", "To check"],
        ...(fullViewer ? ([["register", "Register"]] as [Tab, string][]) : []),
        ...(role === "executive" ? ([["approvals", "Approvals"]] as [Tab, string][]) : []),
        ...(fullViewer ? ([["vendors", "Vendors"], ["settings", "Settings"]] as [Tab, string][]) : []),
    ];
    const tabParam = params.get("tab") as Tab | null;
    const tab: Tab = tabParam && tabs.some(([k]) => k === tabParam) ? tabParam : fullViewer && role !== "executive" ? "register" : role === "executive" ? "approvals" : "mine";

    const load = useCallback(async () => {
        try {
            const [m, c, s] = await Promise.all([purchaseService.mine(), purchaseService.toCheck(), purchaseService.settings()]);
            setMine(m.data.items);
            setToCheck(c.data.items);
            setSettings(s.data);
            if (fullViewer) setAll((await purchaseService.list()).data.items);
        } catch (e) {
            setError(detail(e, "Could not load purchases."));
            setMine((x) => x ?? []);
        }
    }, [fullViewer]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (!openId) {
            setOpen(null);
            return;
        }
        if (open?.id === openId) return;
        let live = true;
        purchaseService
            .get(openId)
            .then((res) => live && setOpen(res.data))
            .catch(() => {
                if (!live) return;
                setError("That purchase could not be found.");
                setOpenId(null);
            });
        return () => {
            live = false;
        };
    }, [openId]);

    const changed = (p: Purchase) => {
        setOpen(p);
        void load();
    };

    const shown = useMemo(() => {
        const q = search.trim().toLowerCase();
        return all.filter(
            (p) =>
                (status === "" ? true : status === "open" ? !CLOSED.includes(p.status) : p.status === status) &&
                (!flag || (flag === "related_party" ? p.related_party === true : p[flag] === true)) &&
                (!q || [p.reference, p.order_number, p.title, p.vendor?.name, p.requester.name]
                    .filter(Boolean)
                    .some((s) => s!.toLowerCase().includes(q))),
        );
    }, [all, search, status, flag]);

    const approvals = all.filter(
        (p) => p.can.includes("approve") || p.can.includes("confirm_urgent") || p.can.includes("decide_amount"),
    );
    const checkOpen = toCheck.filter((p) => p.can.includes("receive")).length;

    const input =
        "rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-paper focus:border-signal/60 focus:outline-none";

    const setTab = (key: Tab) =>
        setParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.delete("open");
                next.set("tab", key);
                return next;
            },
            { replace: true },
        );

    return (
        <div className="dtg-fade-in space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Purchasing</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">Purchases</h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        Anything above {rp(settings?.petty_cash_limit ?? 500000)} starts as a request here. Finance finds the vendor
                        and price, it is approved before anything is ordered, and you can follow it here until it's done.
                    </p>
                </div>
                {tab === "mine" && (
                    <button type="button" onClick={() => setForm({ editing: null })} className="dtg-btn-primary">
                        <Plus className="h-4 w-4" />
                        New request
                    </button>
                )}
            </header>

            <div role="tablist" className="flex flex-wrap gap-1 border-b border-white/10">
                {tabs.map(([key, label]) => (
                    <button
                        key={key}
                        role="tab"
                        aria-selected={tab === key}
                        onClick={() => setTab(key)}
                        className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors ${
                            tab === key
                                ? "border-signal font-semibold text-paper"
                                : "border-transparent font-medium text-paper-soft hover:border-teal-500 hover:text-paper"
                        }`}
                    >
                        {label}
                        {key === "check" && checkOpen > 0 && <span className="ml-1.5 font-mono text-gold">{checkOpen}</span>}
                        {key === "approvals" && approvals.length > 0 && <span className="ml-1.5 font-mono text-gold">{approvals.length}</span>}
                    </button>
                ))}
            </div>

            {error && <Alert tone="danger">{error}</Alert>}

            {mine === null ? (
                <div className="dtg-panel flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : tab === "vendors" ? (
                <Vendors />
            ) : tab === "settings" ? (
                <Settings settings={settings} onSaved={setSettings} />
            ) : (
                <PurchaseTable
                    items={tab === "mine" ? mine : tab === "check" ? toCheck : tab === "approvals" ? approvals : shown}
                    full={tab === "register" || tab === "approvals"}
                    empty={
                        tab === "mine"
                            ? "You have not asked for anything yet. Start with New request."
                            : tab === "check"
                              ? "Nothing to check in. Finance names you when an order is on its way."
                              : tab === "approvals"
                                ? "Nothing is waiting for you."
                                : "Nothing matches."
                    }
                    filters={
                        tab === "register" ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search PR, PO, title, vendor" className={`${input} w-60`} />
                                <select value={status} onChange={(e) => setStatus(e.target.value as PurchaseStatus | "" | "open")} className={input}>
                                    {STATUSES.map((s) => (
                                        <option key={s.value} value={s.value} className="bg-surface">{s.label}</option>
                                    ))}
                                </select>
                                {(
                                    [
                                        ["urgent", "Urgent"],
                                        ["late_entry", "Late entry"],
                                        ["self_approved", "Self-approved"],
                                        ["related_party", "Related party"],
                                    ] as const
                                ).map(([k, label]) => (
                                    <button
                                        key={k}
                                        type="button"
                                        onClick={() => setFlag(flag === k ? "" : k)}
                                        className={`rounded-full border px-3 py-1 text-micro font-semibold transition-colors ${
                                            flag === k ? "border-gold/50 bg-gold/15 text-gold" : "border-white/15 text-paper-soft hover:text-paper"
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        ) : null
                    }
                    onOpen={setOpenId}
                />
            )}

            {open && (
                <PurchaseDrawer
                    purchase={open}
                    me={user?.id}
                    role={role}
                    settings={settings}
                    onChange={changed}
                    onEdit={(p) => setForm({ editing: p })}
                    onDeleted={() => {
                        setOpenId(null);
                        void load();
                    }}
                    onClose={() => setOpenId(null)}
                />
            )}
            {form && (
                <RequestForm
                    editing={form.editing}
                    settings={settings}
                    onSaved={(p) => {
                        void load();
                        setOpen(p);
                        setOpenId(p.id);
                    }}
                    onClose={() => setForm(null)}
                />
            )}
        </div>
    );
}

function PurchaseTable({
    items,
    full,
    empty,
    filters,
    onOpen,
}: {
    items: Purchase[];
    full: boolean;
    empty: string;
    filters: React.ReactNode;
    onOpen: (id: string) => void;
}) {
    return (
        <div className="space-y-4">
            {filters}
            {items.length === 0 ? (
                <div className="dtg-panel px-5 py-14 text-center">
                    <ShoppingCart className="mx-auto h-6 w-6 text-muted" />
                    <p className="mt-3 text-sm text-paper-soft">{empty}</p>
                </div>
            ) : (
                <div className="dtg-panel overflow-x-auto">
                    <table className="w-full min-w-[44rem] text-left text-sm">
                        <thead className="border-b border-white/[0.08] text-micro uppercase tracking-label text-muted">
                            <tr>
                                <th className="px-5 py-3 font-semibold">Ref</th>
                                <th className="px-3 py-3 font-semibold">Purchase</th>
                                <th className="px-3 py-3 font-semibold">Status</th>
                                <th className="px-3 py-3 font-semibold">Vendor</th>
                                <th className="px-5 py-3 text-right font-semibold">Amount</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.06]">
                            {items.map((p) => {
                                const chip = p.shape === "requester"
                                    ? { label: milestoneLabel(p.milestone), cls: STATUS_CHIP[p.status].cls }
                                    : STATUS_CHIP[p.status];
                                const amount = p.approved_amount ?? p.approval_amount ?? p.estimated_total;
                                const waiting = p.can.some((a) => !["cancel", "add_document", "edit", "delete"].includes(a));
                                return (
                                    <tr key={p.id} onClick={() => onOpen(p.id)} className={`cursor-pointer transition hover:bg-white/[0.03] ${waiting ? "bg-signal/[0.03]" : ""}`}>
                                        <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-paper-soft">
                                            {p.reference ?? "—"}
                                            {p.order_number && <span className="block text-micro text-muted">{p.order_number}</span>}
                                        </td>
                                        <td className="px-3 py-3">
                                            <p className="text-paper">{p.title}</p>
                                            <p className="text-micro text-muted">
                                                {full && `${p.requester.name ?? ""} · `}
                                                {day(p.created_at)}
                                                {p.tier && ` · ${TIER_LABEL[p.tier].split(" (")[0]}`}
                                                {p.urgent && " · urgent"}
                                            </p>
                                        </td>
                                        <td className="px-3 py-3">
                                            <span className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-label ${chip.cls}`}>
                                                {chip.label}
                                            </span>
                                            {waiting && <span className="ml-1.5 text-micro font-semibold text-signal">your step</span>}
                                        </td>
                                        <td className="px-3 py-3 text-paper-soft">{p.vendor?.name ?? "—"}</td>
                                        <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-xs text-paper-soft">
                                            {p.shape === "full" ? rp(amount) : "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function Settings({ settings, onSaved }: { settings: PurchaseSettings | null; onSaved: (s: PurchaseSettings) => void }) {
    const [petty, setPetty] = useState(String(settings?.petty_cash_limit ?? ""));
    const [simple, setSimple] = useState(String(settings?.simple_limit ?? ""));
    const [quote, setQuote] = useState(String(settings?.quotation_limit ?? ""));
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    if (!settings) return null;
    const edit = settings.can_edit;

    const save = async () => {
        try {
            onSaved(
                (await purchaseService.saveSettings({
                    petty_cash_limit: Number(petty),
                    simple_limit: Number(simple),
                    quotation_limit: Number(quote),
                })).data,
            );
            setError(null);
            setDone(true);
        } catch (e) {
            setError(detail(e, "Could not save the limits."));
        }
    };

    const rows: [string, string, string, (v: string) => void, string][] = [
        ["Petty cash", "Up to this, petty cash: no purchase request.", petty, setPetty, "Finance pays; the approver approves at the monthly count"],
        ["Simple", "Up to this: 1 written quote.", simple, setSimple, "The approver, before the order"],
        ["Quotation", "Up to this: 2–3 quotes and a comparison sheet. Above it: contract, 3 quotes, shareholders informed.", quote, setQuote, "The approver, before the order"],
    ];

    return (
        <div className="dtg-panel max-w-2xl space-y-4 px-5 py-5">
            {error && <Alert tone="danger">{error}</Alert>}
            {done && <Alert tone="success">Saved.</Alert>}
            <p className="text-sm text-paper-soft">
                Each limit counts the purchase plus the same vendor's other purchases approved this month, so splitting an
                order doesn't lower its tier. {edit ? "Only you can change these." : "Only the approver changes these."}
            </p>
            {rows.map(([label, hint, value, set, who]) => (
                <div key={label} className="grid items-end gap-2 sm:grid-cols-[1fr_12rem]">
                    <div>
                        <p className="text-sm font-semibold text-paper">{label}</p>
                        <p className="text-micro text-muted">
                            {hint} Approved by: {who}.
                        </p>
                    </div>
                    {edit ? <MoneyInput value={value} onChange={set} className="dtg-input" /> : <p className="font-mono text-paper">{rp(Number(value))}</p>}
                </div>
            ))}
            {edit && (
                <button type="button" onClick={() => void save()} className="dtg-btn-primary">
                    Save limits
                </button>
            )}
            {settings.updated_by_name && (
                <p className="text-micro text-muted">
                    Last changed by {settings.updated_by_name} on {day(settings.updated_at)}
                </p>
            )}
        </div>
    );
}
