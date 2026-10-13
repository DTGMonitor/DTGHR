import type { Ticket, TicketPriority } from "@/services/ticketService";

/*
 * The orders the ticket list can be read in. The list is small and already
 * fetched whole, so it is sorted here rather than on the server.
 *
 * "Needs me" is IT's: whatever is waiting on IT comes first, and whatever is
 * waiting on the reporter sinks.
 */

export type SortMode = "needs_me" | "priority" | "oldest" | "newest" | "updated";

export const SORT_MODES: { value: SortMode; label: string }[] = [
    { value: "needs_me", label: "Needs me" },
    { value: "priority", label: "Priority" },
    { value: "oldest", label: "Oldest first" },
    { value: "newest", label: "Newest first" },
    { value: "updated", label: "Recently updated" },
];

const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const time = (iso: string) => new Date(iso).getTime();

/*
 * 0  the reporter spoke last on a live ticket: replied, answered, reopened
 * 1  open, and nobody has answered since it was raised
 * 2  in progress
 * 3  waiting on the reporter
 * 4  resolved, waiting for the reporter to confirm
 * 5  closed
 */
function needsMeGroup(t: Ticket): number {
    const live = t.status === "open" || t.status === "in_progress";
    if (live && t.last_public_actor === "reporter" && t.last_public_kind !== "raised") return 0;
    if (t.status === "open") return 1;
    if (t.status === "in_progress") return 2;
    if (t.status === "waiting") return 3;
    if (t.status === "resolved") return 4;
    return 5;
}

const byPriorityThenAge = (a: Ticket, b: Ticket) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || time(a.created_at) - time(b.created_at);

const COMPARE: Record<SortMode, (a: Ticket, b: Ticket) => number> = {
    needs_me: (a, b) => needsMeGroup(a) - needsMeGroup(b) || byPriorityThenAge(a, b),
    priority: byPriorityThenAge,
    oldest: (a, b) => time(a.created_at) - time(b.created_at),
    newest: (a, b) => time(b.created_at) - time(a.created_at),
    updated: (a, b) => time(b.updated_at) - time(a.updated_at),
};

export function isSortMode(v: string | null): v is SortMode {
    return SORT_MODES.some((m) => m.value === v);
}

export function sortTickets(tickets: Ticket[], mode: SortMode): Ticket[] {
    return [...tickets].sort(COMPARE[mode]);
}
