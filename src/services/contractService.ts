import api from "@/lib/api";

export type ContractKind = "manpower" | "subscription" | "client";
export type ContractStatus = "active" | "renewed" | "ended" | "cancelled";
export type BillingCycle = "one_off" | "monthly" | "quarterly" | "annual";

export const BILLING_CYCLES: { key: BillingCycle; label: string }[] = [
    { key: "one_off", label: "One-off" },
    { key: "monthly", label: "Monthly" },
    { key: "quarterly", label: "Quarterly" },
    { key: "annual", label: "Annual" },
];

const CYCLE_MONTHS: Record<Exclude<BillingCycle, "one_off">, number> = {
    monthly: 1,
    quarterly: 3,
    annual: 12,
};

/** "month", "quarter", "year" -- for "/ month" and "every month". */
export function cycleUnit(cycle: BillingCycle | null): string | null {
    switch (cycle) {
        case "monthly":
            return "month";
        case "quarterly":
            return "quarter";
        case "annual":
            return "year";
        default:
            return null;
    }
}

export function isRecurring(cycle: BillingCycle | null | undefined): boolean {
    return cycle === "monthly" || cycle === "quarterly" || cycle === "annual";
}

/** Today in Jakarta, as YYYY-MM-DD -- the day the server counts from. */
export function jakartaToday(): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

function addMonths(iso: string, months: number): string {
    const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
    const total = (m - 1) + months;
    const year = y + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    // Clamp to the month's last day, as Postgres does: 31 Jan + 1 month = 28/29 Feb.
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(d, last);
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The first start + k cycles (k >= 1) after today -- the same rule the
 * database uses (_contracts_next_renewal), so the form shows what will be
 * stored.
 */
export function nextRenewal(start: string, cycle: BillingCycle, today = jakartaToday()): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || cycle === "one_off") return null;
    const step = CYCLE_MONTHS[cycle];
    let k = 1;
    let d = addMonths(start, step);
    while (d <= today) {
        k += 1;
        d = addMonths(start, k * step);
    }
    return d;
}

/** The default warnings for a new contract, as the database picks them. */
export function defaultReminders(kind: ContractKind, cycle: BillingCycle): string {
    if (kind === "client") return "60, 42, 30";
    if (cycle === "monthly") return "7";
    if (cycle === "quarterly") return "14";
    return "30";
}

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
    /** Null on contracts recorded before the cycle was a choice. */
    billing_cycle: BillingCycle | null;
    /** Renews itself: end_date is then the next renewal. */
    auto_renew: boolean;
    /** The next renewal date when auto_renew, else null. */
    next_renewal: string | null;
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
    /** Not needed (and ignored) when auto_renew: it is worked out from the start. */
    end_date?: string | null;
    amount?: number | null;
    currency?: string;
    billing_period?: string | null;
    billing_cycle?: BillingCycle | null;
    auto_renew?: boolean;
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
