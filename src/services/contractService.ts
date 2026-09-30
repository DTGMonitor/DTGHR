import api from "@/lib/api";

export type ContractKind = "manpower" | "subscription" | "client";
export type ContractStatus = "active" | "renewed" | "ended" | "cancelled";

export interface ContractReminder {
    id: string;
    days_before: number;
    due_on: string;
    /** Arrived, and nobody has said they have seen it. */
    is_due: boolean;
    acknowledged_at: string | null;
    acknowledgement_note: string | null;
}

export interface ContractDocument {
    id: string;
    filename: string;
    content_type: string;
    byte_size: number;
    uploaded_at: string;
}

export interface Contract {
    id: string;
    kind: ContractKind;
    title: string;
    counterparty: string | null;
    employee_id: string | null;
    start_date: string | null;
    end_date: string;
    /** Negative once the end date has passed. */
    days_remaining: number;
    amount: number | null;
    currency: string;
    billing_period: string | null;
    notes: string | null;
    status: ContractStatus;
    documents: ContractDocument[];
    reminders: ContractReminder[];
    open_reminders: number;
    /** The POs issued under this contract, newest first. */
    purchase_orders: ContractPurchaseOrder[];
}

export interface ContractPurchaseOrder {
    id: string;
    po_number: string;
    po_date: string;
    end_date: string | null;
    value: number | null;
    currency: string;
    status: PurchaseOrderStatus;
}

export interface ContractList {
    items: Contract[];
    can_manage: boolean;
    due_count: number;
}

export interface ContractDraft {
    kind: ContractKind;
    title: string;
    counterparty?: string | null;
    employee_id?: string | null;
    start_date?: string | null;
    end_date: string;
    amount?: number | null;
    currency?: string;
    billing_period?: string | null;
    notes?: string | null;
    reminder_days?: number[];
}

export const contractService = {
    list: (kind?: ContractKind) =>
        api.get<ContractList>("/contracts", { params: kind ? { kind } : undefined }),
    create: (body: ContractDraft) => api.post<Contract>("/contracts", body),
    update: (id: string, body: Partial<ContractDraft> & { status?: ContractStatus }) =>
        api.patch<Contract>(`/contracts/${id}`, body),
    acknowledge: (id: string, reminderId: string, note?: string) =>
        api.post<Contract>(`/contracts/${id}/reminders/${reminderId}/acknowledge`, {
            note: note ?? null,
        }),
    remove: (id: string) => api.delete(`/contracts/${id}`),
    uploadDocument: (id: string, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return api.post<Contract>(`/contracts/${id}/documents`, form);
    },
    removeDocument: (id: string, documentId: string) =>
        api.delete<Contract>(`/contracts/${id}/documents/${documentId}`),
};

export type PurchaseOrderStatus = "active" | "completed" | "cancelled";

export interface PurchaseOrder {
    id: string;
    contract_id: string | null;
    contract_title: string | null;
    po_number: string;
    client_name: string;
    description: string | null;
    po_date: string;
    start_date: string | null;
    end_date: string | null;
    /** Null when there is no end date; negative once it has passed. */
    days_remaining: number | null;
    value: number | null;
    currency: string;
    status: PurchaseOrderStatus;
    notes: string | null;
    documents: ContractDocument[];
    created_at: string;
    updated_at: string;
}

export interface PurchaseOrderList {
    items: PurchaseOrder[];
    can_manage: boolean;
}

export interface PurchaseOrderDraft {
    contract_id?: string | null;
    po_number: string;
    /** Taken from the linked contract's client when left empty. */
    client_name?: string | null;
    description?: string | null;
    po_date: string;
    start_date?: string | null;
    end_date?: string | null;
    value?: number | null;
    currency?: string;
    status?: PurchaseOrderStatus;
    notes?: string | null;
}

export interface PurchaseOrderFilters {
    client?: string;
    contract_id?: string;
    status?: PurchaseOrderStatus;
    from?: string;
    to?: string;
    sort?: "po_date" | "end_date";
}

/** A contract renewal or a PO end, from GET /contracts/coming-up. */
export interface ComingUpItem {
    kind: "contract" | "purchase_order";
    id: string;
    contract_id: string | null;
    /** The contract's title, or the PO number. */
    label: string;
    client: string;
    contract_kind: ContractKind | null;
    end_date: string;
    days_remaining: number;
    overdue: boolean;
}

export const purchaseOrderService = {
    list: (filters: PurchaseOrderFilters = {}) =>
        api.get<PurchaseOrderList>("/purchase-orders", {
            params: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
        }),
    create: (body: PurchaseOrderDraft) => api.post<PurchaseOrder>("/purchase-orders", body),
    update: (id: string, body: Partial<PurchaseOrderDraft>) =>
        api.patch<PurchaseOrder>(`/purchase-orders/${id}`, body),
    remove: (id: string) => api.delete(`/purchase-orders/${id}`),
    uploadDocument: (id: string, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return api.post<PurchaseOrder>(`/purchase-orders/${id}/documents`, form);
    },
    removeDocument: (id: string, documentId: string) =>
        api.delete<PurchaseOrder>(`/purchase-orders/${id}/documents/${documentId}`),
    comingUp: () => api.get<{ items: ComingUpItem[] }>("/contracts/coming-up"),
};

/**
 * "2 months", "6 weeks", "30 days".
 *
 * Reminders are stored in days because months cannot be subtracted from a date
 * without ambiguity, but nobody asks to be told "42 days before" — they ask
 * for six weeks. So the storage is exact and the wording is human.
 */
export function describeLeadTime(days: number): string {
    if (days === 0) return "on the day";
    if (days % 30 === 0) {
        const m = days / 30;
        return `${m} month${m === 1 ? "" : "s"} before`;
    }
    if (days % 7 === 0) {
        const w = days / 7;
        return `${w} week${w === 1 ? "" : "s"} before`;
    }
    return `${days} days before`;
}

/**
 * The currencies DTG actually pays and bills in.
 *
 * Subscriptions are priced where the vendor lives — TeamViewer in euros,
 * Claude in dollars — and a figure stored without its currency is a figure
 * somebody will read as rupiah one day.
 */
export const CURRENCIES = ["IDR", "USD", "AUD", "SGD", "EUR", "GBP"] as const;

/**
 * Rupiah in whole numbers; every other currency to the cent -- a US$99.90
 * subscription shown as US$100 is a figure nobody can reconcile.
 */
export function money(amount: number, currency = "IDR"): string {
    const cents = currency === "IDR" ? 0 : 2;
    return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        minimumFractionDigits: cents,
        maximumFractionDigits: cents,
    }).format(amount);
}
