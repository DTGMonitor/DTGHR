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

export function money(amount: number, currency = "IDR"): string {
    return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
    }).format(amount);
}
