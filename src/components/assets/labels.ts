import type { AssetMove, AssetStatus, CheckinState } from "@/services/assetService";

export const STATUS_CHIP: Record<AssetStatus, { label: string; cls: string }> = {
    in_store: { label: "In store", cls: "border-white/15 bg-white/[0.04] text-paper-soft" },
    assigned: { label: "Assigned", cls: "border-signal/30 bg-signal/10 text-signal" },
    in_repair: { label: "In repair", cls: "border-gold/30 bg-gold/10 text-gold" },
    lost: { label: "Lost", cls: "border-danger/40 bg-danger/10 text-danger" },
    retired: { label: "Retired", cls: "border-white/10 bg-transparent text-muted" },
};

export const CHECKIN_CHIP: Record<CheckinState, { label: string; cls: string }> = {
    pending: { label: "Waiting", cls: "border-gold/30 bg-gold/10 text-gold" },
    confirmed: { label: "Confirmed", cls: "border-signal/30 bg-signal/10 text-signal" },
    missing: { label: "Not with them", cls: "border-danger/40 bg-danger/10 text-danger" },
    seen: { label: "Seen by IT", cls: "border-teal-300/30 bg-teal-300/10 text-teal-200" },
    no_reply: { label: "No reply", cls: "border-white/15 bg-white/[0.04] text-muted" },
};

export const FLAG_LABEL = {
    handover_declined: "Holder says they did not receive it",
    checkin_missing: "Holder says it is not with them",
} as const;

/** The moves IT may make, in the order the drawer offers them. */
export const MOVES: { move: AssetMove; label: string; tone: "primary" | "secondary" | "danger" }[] = [
    { move: "assign", label: "Assign", tone: "primary" },
    { move: "transfer", label: "Transfer", tone: "secondary" },
    { move: "return", label: "Record return", tone: "secondary" },
    { move: "repair_out", label: "Send for repair", tone: "secondary" },
    { move: "repair_back", label: "Back from repair", tone: "secondary" },
    { move: "found", label: "Found", tone: "secondary" },
    { move: "lost", label: "Mark lost", tone: "danger" },
    { move: "retire", label: "Retire", tone: "danger" },
];

export const day = (iso: string | null | undefined) =>
    iso
        ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
          })
        : "—";

export const when = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

/** Days since a moment, for "pending for 4 days". */
export const daysSince = (iso: string | null | undefined) =>
    iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)) : 0;

export const money = (value: number | null | undefined, currency = "IDR") =>
    value === null || value === undefined
        ? "—"
        : `${currency === "IDR" ? "Rp" : currency} ${Number(value).toLocaleString("id-ID")}`;

/** The error the server sent, or a fallback. */
export const detail = (e: unknown, fallback: string) => {
    const d = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
    return typeof d === "string" ? d : fallback;
};
