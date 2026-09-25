import api from "@/lib/api";

/*
 * IT support tickets.
 *
 * Everybody can raise one; whoever holds the IT support flag, and their
 * manager, works the queue. Administrators read the finished history.
 * The server decides which of those the caller is and says so on every
 * response as `can_work`, so the page never re-derives the rule.
 */

export type TicketCategory =
    | "connection"
    | "hardware"
    | "software"
    | "access"
    | "access_request"
    | "other";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";

export interface TicketEvent {
    id: string;
    actor_name: string;
    kind: string;
    body: string;
    from_status: string | null;
    to_status: string | null;
    is_internal: boolean;
    created_at: string;
}

export interface Ticket {
    id: string;
    reference: string;
    subject: string;
    description: string;
    category: TicketCategory;
    priority: TicketPriority;
    status: TicketStatus;
    location: string | null;
    reporter_id: string | null;
    reporter_name: string | null;
    assignee_id: string | null;
    assignee_name: string | null;
    resolution: string | null;
    resolved_at: string | null;
    /** Who wrote the fix, from the trail -- not necessarily the assignee. */
    resolved_by: string | null;
    created_at: string;
    updated_at: string;
    can_work: boolean;
    events: TicketEvent[];
}

export interface TicketList {
    items: Ticket[];
    open_count: number;
    /** Works the queue: the IT support flag, or their manager. */
    is_support: boolean;
    /** May open the resolved history: IT support, and administrators. */
    can_view_history: boolean;
}

export interface ResolverSummary {
    name: string;
    resolved: number;
    average_hours: number;
}

/** One category's tally: how many, and how long from raised to resolved. */
export interface CategorySummary {
    category: TicketCategory;
    /** The reference prefix: NET, HW, SW, ACC, REQ, GEN. */
    prefix: string;
    raised: number;
    open: number;
    resolved: number;
    closed: number;
    /** Hours, over the resolved ones; null when none is resolved yet. */
    average_hours: number | null;
    longest_hours: number | null;
}

export interface TicketHistory {
    items: Ticket[];
    resolvers: ResolverSummary[];
    categories: CategorySummary[];
}

export const ticketService = {
    list(params: { mine_only?: boolean; include_closed?: boolean } = {}) {
        return api.get<TicketList>("/tickets", { params });
    },
    history() {
        return api.get<TicketHistory>("/tickets/history");
    },
    get(id: string) {
        return api.get<Ticket>(`/tickets/${id}`);
    },
    raise(data: {
        subject: string;
        description: string;
        category: TicketCategory;
        priority: TicketPriority;
        location?: string;
    }) {
        return api.post<Ticket>("/tickets", data);
    },
    comment(id: string, body: string, isInternal = false) {
        return api.post<Ticket>(`/tickets/${id}/comments`, {
            body,
            is_internal: isInternal,
        });
    },
    setStatus(id: string, status: TicketStatus, note?: string) {
        return api.post<Ticket>(`/tickets/${id}/status`, { status, note });
    },
};
