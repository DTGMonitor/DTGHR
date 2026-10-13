import api from "@/lib/api";

/*
 * The office asset register.
 *
 * IT (whoever works the IT queue) registers items and moves them; finance and
 * management read the whole register, values included; everybody else sees
 * what they hold, on My equipment. The server decides which of those the
 * caller is and shapes each asset for them: `can_manage` and `moves` say what
 * IT may do, and a holder's copy simply has no value, location or flag.
 */

export type AssetStatus = "in_store" | "assigned" | "in_repair" | "retired" | "lost";
export type AssetMove = "assign" | "transfer" | "return" | "repair_out" | "repair_back" | "lost" | "found" | "retire";
export type CheckinState = "pending" | "confirmed" | "missing" | "seen" | "no_reply";

export interface AssetCategory {
    id: string;
    code: string;
    name: string;
    tracks_calibration: boolean;
    is_active?: boolean;
    /** How many items carry it; its code is fixed once this is above 0. */
    assets?: number;
    /** The tag the next item registered in it will get. */
    next_tag?: string;
}

export interface AssetEvent {
    id: string;
    kind: string;
    actor_name: string;
    from_status: AssetStatus | null;
    to_status: AssetStatus | null;
    /** As the name was at the time. Null in a holder's copy unless it is them. */
    from_holder_name: string | null;
    to_holder_name: string | null;
    ticket_reference: string | null;
    body: string | null;
    created_at: string;
}

export interface AssetCheckin {
    item_id: string;
    round_id: string;
    round_name: string;
    due_date: string;
    state: CheckinState;
    can_answer: boolean;
}

export interface Asset {
    id: string;
    tag: string;
    category: AssetCategory;
    name: string;
    brand: string | null;
    model: string | null;
    serial_number: string | null;
    status: AssetStatus;
    holder: { employee_id: string; name: string | null; since: string | null; confirmed_at: string | null } | null;
    /** Assigned and not yet confirmed by the holder. */
    handover_pending: boolean;
    calibration_due: string | null;
    /** The caller holds it and has not answered the handover yet. */
    can_respond: boolean;
    /** Its item in the open check-in round, if any. */
    checkin: AssetCheckin | null;
    events: AssetEvent[];
    // The full copy only: IT, finance and management.
    location?: string | null;
    purchase_date?: string | null;
    purchase_value?: number | null;
    currency?: string;
    warranty_until?: string | null;
    flag?: { kind: "handover_declined" | "checkin_missing"; note: string | null; at: string } | null;
    notes?: string | null;
    retired_at?: string | null;
    created_at?: string;
    updated_at?: string;
    can_manage?: boolean;
    moves?: AssetMove[];
    tickets?: { id: string; reference: string; subject: string; status: string; created_at: string }[];
}

export interface AssetList {
    items: Asset[];
    can_manage: boolean;
}

export interface MyEquipment {
    items: Asset[];
    /** The open round, when it has items of the caller's. */
    round: { id: string; name: string; due_date: string; pending: number; total: number } | null;
    can_view_all: boolean;
    can_manage: boolean;
}

export interface Leaver {
    employee_id: string;
    name: string | null;
    reason: "inactive" | "contract_end";
    end_date: string | null;
    items: { id: string; tag: string; name: string; status: AssetStatus }[];
}

export interface RoundCounts {
    total: number;
    pending: number;
    confirmed: number;
    missing: number;
    seen: number;
    no_reply: number;
}

export interface RoundSummary {
    id: string;
    name: string;
    started_at: string;
    due_date: string;
    closed_at: string | null;
    is_open: boolean;
    counts: RoundCounts;
}

export interface RoundItem {
    id: string;
    asset_id: string;
    tag: string;
    name: string;
    category: string;
    asset_status: AssetStatus;
    holder_employee_id: string | null;
    holder_name: string | null;
    state: CheckinState;
    responded_at: string | null;
    responded_by_name: string | null;
    note: string | null;
}

export interface Round extends RoundSummary {
    started_by_name: string | null;
    reminded_at: string | null;
    closed_by_name: string | null;
    can_manage: boolean;
    summary: Omit<RoundCounts, "pending"> | null;
    items: RoundItem[];
}

/** What the register form sends. Empty strings are stored as nothing. */
export interface AssetInput {
    category_id: string;
    name: string;
    brand: string;
    model: string;
    serial_number: string;
    location: string;
    purchase_date: string;
    purchase_value: string;
    currency: string;
    warranty_until: string;
    calibration_due: string;
    notes: string;
}

export const assetService = {
    list(includeRetired = false) {
        return api.get<AssetList>("/assets", { params: { include_retired: includeRetired } });
    },
    get(id: string) {
        return api.get<Asset>(`/assets/${id}`);
    },
    mine() {
        return api.get<MyEquipment>("/assets/mine");
    },
    categories() {
        return api.get<AssetCategory[]>("/assets/categories");
    },
    saveCategory(data: { id?: string; code: string; name: string; tracks_calibration: boolean; is_active: boolean }) {
        return api.post<AssetCategory[]>("/assets/categories", data);
    },
    register(data: AssetInput & { assign_to?: string; note?: string }) {
        return api.post<Asset>("/assets", data);
    },
    update(id: string, data: Partial<AssetInput>) {
        return api.patch<Asset>(`/assets/${id}`, data);
    },
    /** From store, or a transfer from the current holder. */
    assign(id: string, employeeId: string, note?: string) {
        return api.post<Asset>(`/assets/${id}/assign`, { employee_id: employeeId, note });
    },
    move(id: string, move: Exclude<AssetMove, "assign" | "transfer">, data: { location?: string; note?: string } = {}) {
        return api.post<Asset>(`/assets/${id}/${move}`, data);
    },
    /** The holder: "I have it", or "I did not receive it" with a note. */
    respond(id: string, accept: boolean, note?: string) {
        return api.post<Asset>(`/assets/${id}/respond`, { accept, note });
    },
    clearFlag(id: string, note?: string) {
        return api.post<Asset>(`/assets/${id}/clear-flag`, { note });
    },
    leavers() {
        return api.get<Leaver[]>("/assets/leavers");
    },
    rounds() {
        return api.get<{ items: RoundSummary[]; can_manage: boolean; last_started_at: string | null }>(
            "/assets/rounds",
        );
    },
    round(id: string) {
        return api.get<Round>(`/assets/rounds/${id}`);
    },
    startRound(name?: string, dueDate?: string) {
        return api.post<Round>("/assets/rounds", { name, due_date: dueDate });
    },
    closeRound(id: string) {
        return api.post<Round>(`/assets/rounds/${id}/close`, {});
    },
    /** The holder answers for one item in the open round. */
    answer(itemId: string, haveIt: boolean, note?: string) {
        return api.post<MyEquipment>(`/assets/round-items/${itemId}/answer`, { have_it: haveIt, note });
    },
    markSeen(itemId: string, note?: string) {
        return api.post<Round>(`/assets/round-items/${itemId}/seen`, { note });
    },
};
