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
/** How the request arrived. Staff raising their own is always the portal. */
export type TicketChannel = "portal" | "whatsapp" | "in_person" | "phone" | "email";

/**
 * The earlier ticket this one comes back to. To a viewer who neither works
 * the queue nor reported it, only the reference and status: the rest is null.
 */
export interface RelatedTicket {
    id: string | null;
    reference: string;
    subject: string | null;
    status: TicketStatus;
    resolution: string | null;
    resolved_at: string | null;
}

/** A later ticket that names this one as related. */
export interface Recurrence {
    id: string | null;
    reference: string;
    status: TicketStatus;
    created_at: string;
}

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
    channel: TicketChannel;
    reporter_id: string | null;
    reporter_name: string | null;
    assignee_id: string | null;
    assignee_name: string | null;
    resolution: string | null;
    resolved_at: string | null;
    /** Who wrote the fix, from the trail -- not necessarily the assignee. */
    resolved_by: string | null;
    closed_at: string | null;
    /** While waiting or resolved: when it closes on its own unless updated. */
    auto_close_at: string | null;
    created_at: string;
    updated_at: string;
    can_work: boolean;
    related: RelatedTicket | null;
    recurrences: Recurrence[];
    /** Who wrote the latest event that is not an internal note. */
    last_public_actor: "reporter" | "support" | "system" | null;
    last_public_kind: string | null;
    last_public_at: string | null;
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
    /** Fixed: has a resolution, whether still resolved or since closed. */
    resolved: number;
    /** Closed without a fix: duplicates, withdrawn, or no reply. */
    closed: number;
    /** Raised as the return of an earlier ticket. */
    recurrences: number;
    /** Hours, over the resolved ones; null when none is resolved yet. */
    average_hours: number | null;
    longest_hours: number | null;
}

/** One month's tickets by how they arrived. `month` is "2026-10". */
export interface ChannelMonth {
    month: string;
    total: number;
    portal: number;
    whatsapp: number;
    in_person: number;
    phone: number;
    email: number;
}

export interface TicketHistory {
    items: Ticket[];
    resolvers: ResolverSummary[];
    categories: CategorySummary[];
    /** The last six months, oldest first. */
    channels: ChannelMonth[];
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
        /** IT raising for someone else; needs a channel other than portal. */
        reporter_id?: string;
        channel?: TicketChannel;
        /** "Raise it again": the earlier ticket this comes back to. */
        related_ticket_id?: string;
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
    /** Still broken (resolved), or reopening a closed ticket. */
    reopen(id: string, reason: string) {
        return api.post<Ticket>(`/tickets/${id}/reopen`, { reason });
    },
    /** Move the auto-close later: after the current one, within 30 days. */
    extend(id: string, until: string, reason?: string) {
        return api.post<Ticket>(`/tickets/${id}/extend`, { until, reason });
    },
    triage(id: string, data: { priority?: TicketPriority; category?: TicketCategory }) {
        return api.post<Ticket>(`/tickets/${id}/triage`, data);
    },
    /** The earlier ticket this one comes back to; null unlinks. */
    link(id: string, relatedId: string | null) {
        return api.post<Ticket>(`/tickets/${id}/link`, { related_id: relatedId });
    },
};
