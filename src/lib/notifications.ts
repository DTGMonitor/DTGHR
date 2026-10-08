import { rpc, supabase, unwrap } from "@/lib/supabase";

/*
 * Notifications: one row per person per event, written by the database
 * (20261007000100_in_app_notifications.sql). The browser reads its own rows
 * straight from the table -- row-level security returns nobody else's -- and
 * changes only `read_at`, through the functions below. Email is the same
 * notification delivered by the send-notifications Edge Function.
 */

export type NotificationTone = "action" | "success" | "danger" | "reminder";

export interface NotificationPayload {
    tone: NotificationTone;
    eyebrow: string;
    headline: string;
    intro?: string;
    details?: [string, string][];
    note?: { by?: string; text: string };
    link: { label: string; path: string };
}

export interface AppNotification {
    id: string;
    kind: string;
    source_table: string | null;
    source_id: string | null;
    payload: NotificationPayload;
    /** Asks something of the recipient: waiting for them, or sent back to them. */
    needs_action: boolean;
    created_at: string;
    read_at: string | null;
    resolved_at: string | null;
    resolved_by_name: string | null;
    /** The source's status when it was settled: "approved", "declined", ... */
    resolved_status: string | null;
}

export type NotificationFilter = "all" | "unread" | "action";

const COLUMNS =
    "id, kind, source_table, source_id, payload, needs_action, created_at, read_at, resolved_at, resolved_by_name, resolved_status";

/** A page of the caller's notifications, newest first. */
export async function listNotifications(opts: {
    filter?: NotificationFilter;
    limit?: number;
    offset?: number;
}): Promise<AppNotification[]> {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    let q = supabase
        .from("notifications")
        .select(COLUMNS)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
    if (opts.filter === "unread") q = q.is("read_at", null);
    if (opts.filter === "action") q = q.is("resolved_at", null).eq("needs_action", true);
    return unwrap(await q) as AppNotification[];
}

export async function unreadCount(): Promise<number> {
    const { count, error } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .is("read_at", null);
    if (error) throw error;
    return count ?? 0;
}

export const markRead = (ids: string[]) => rpc<number>("notifications_mark_read", { p_ids: ids });

export const markAllRead = () => rpc<number>("notifications_mark_all_read");

/** Unresolved action items, read or not, leaving out the given kinds. */
export const openActions = (excludeKinds: string[] = [], limit = 50) =>
    rpc<AppNotification[]>("notifications_open_actions", { p_exclude_kinds: excludeKinds, p_limit: limit });

export const getEmailPreference = () => rpc<boolean>("notifications_get_email");

export const setEmailPreference = (enabled: boolean) =>
    rpc<boolean>("notifications_set_email", { p_enabled: enabled });

/** "just now", "5 min ago", "yesterday", "3 days ago", then the date. */
export function relativeTime(iso: string, now = Date.now()): string {
    const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
    const abs = Math.abs(seconds);
    if (abs < 45) return "just now";
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
    if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
    if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
    if (abs < 7 * 86_400) return rtf.format(Math.round(seconds / 86_400), "day");
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export const badgeText = (n: number) => (n > 9 ? "9+" : String(n));

/** How a settled item was settled, by the source's new status. */
const SETTLED: Record<string, [verb: string, byName: boolean]> = {
    approved: ["Approved", true],
    rejected: ["Rejected", true],
    declined: ["Declined", true],
    changes_requested: ["Sent back", true],
    endorsed: ["Endorsed", true],
    submitted: ["Resubmitted", true],
    in_review: ["Submitted", true],
    issued: ["Issued", true],
    partially_approved: ["Partly approved", true],
    paid: ["Paid", true],
    closed: ["Closed", true],
    resolved: ["Resolved", true],
    acknowledged: ["Acknowledged", true],
    accepted: ["Accepted", true],
    disputed: ["Disputed", true],
    cancelled: ["Cancelled", false],
};

/**
 * "Approved by Nurhuda Teguh Santoso", "Cancelled", or -- when the status
 * says nothing we know, or nobody did it -- "No action needed".
 */
export function settledLabel(n: Pick<AppNotification, "resolved_status" | "resolved_by_name">): string {
    const known = n.resolved_status ? SETTLED[n.resolved_status] : undefined;
    if (!known) return "No action needed";
    const [verb, byName] = known;
    if (!byName) return verb;
    return n.resolved_by_name ? `${verb} by ${n.resolved_by_name}` : "No action needed";
}
