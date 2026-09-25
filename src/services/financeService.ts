import api from "@/lib/api";

/*
 * Finance requests: petty cash, tax, BPJS and the rest, itemised, reviewed
 * by the director, approved by the executive -- or by the director alone when
 * Peter has handed the final say over in Settings -- and then marked paid.
 * The server decides whose turn it is and says so as `awaiting`.
 */

export type FinanceCategory =
    | "petty_cash"
    | "tax"
    | "bpjs"
    | "vendor"
    | "reimbursement"
    | "other";

export type FinanceStatus =
    | "draft"
    | "submitted"
    | "endorsed"
    | "approved"
    | "changes_requested"
    | "paid";

export const CATEGORY_LABELS: Record<FinanceCategory, string> = {
    petty_cash: "Petty cash",
    tax: "Tax",
    bpjs: "BPJS",
    vendor: "Supplier / vendor",
    reimbursement: "Reimbursement",
    other: "Other",
};

export interface FinanceItem {
    id?: string;
    category: FinanceCategory;
    description: string;
    amount: number;
}

export interface FinanceDocument {
    id: string;
    filename: string;
    content_type: string;
    byte_size: number;
    created_at: string;
}

export interface FinanceRequest {
    id: string;
    reference: string;
    title: string;
    notes: string | null;
    due_date: string | null;
    status: FinanceStatus;
    total: number;
    items: FinanceItem[];
    documents: FinanceDocument[];
    requested_by_name: string | null;
    submitted_at: string | null;
    reviewed_by_name: string | null;
    reviewed_at: string | null;
    approved_by_name: string | null;
    approved_at: string | null;
    revision_note: string | null;
    revision_by_name: string | null;
    paid_on: string | null;
    paid_by_name: string | null;
    payment_note: string | null;
    /** Whose turn: "director", "executive", or null. */
    awaiting: "director" | "executive" | null;
    is_editable: boolean;
    created_at: string;
}

export interface FinanceRequestList {
    items: FinanceRequest[];
    can_create: boolean;
    director_final_approval: boolean;
}

export interface FinanceDraft {
    title: string;
    notes: string | null;
    due_date: string | null;
    items: { category: FinanceCategory; description: string; amount: number }[];
}

const BASE = "/finance-requests";

export const financeService = {
    list: () => api.get<FinanceRequestList>(BASE),
    create: (body: FinanceDraft) => api.post<FinanceRequest>(BASE, body),
    update: (id: string, body: FinanceDraft) => api.put<FinanceRequest>(`${BASE}/${id}`, body),
    remove: (id: string) => api.delete(`${BASE}/${id}`),
    submit: (id: string) => api.post<FinanceRequest>(`${BASE}/${id}/submit`),
    review: (id: string) => api.post<FinanceRequest>(`${BASE}/${id}/review`),
    approve: (id: string) => api.post<FinanceRequest>(`${BASE}/${id}/approve`),
    sendBack: (id: string, note: string, sendTo: "finance" | "director") =>
        api.post<FinanceRequest>(`${BASE}/${id}/send-back`, { note, send_to: sendTo }),
    markPaid: (id: string, paidOn: string, note: string | null) =>
        api.post<FinanceRequest>(`${BASE}/${id}/paid`, { paid_on: paidOn, note }),
    upload: (id: string, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return api.post<FinanceRequest>(`${BASE}/${id}/documents`, form);
    },
    removeDocument: (id: string, documentId: string) =>
        api.delete<FinanceRequest>(`${BASE}/${id}/documents/${documentId}`),
    documentUrl: (id: string, documentId: string) => `${BASE}/${id}/documents/${documentId}`,
    settings: () => api.get<{ director_final_approval: boolean }>(`${BASE}/settings`),
    saveSettings: (directorFinalApproval: boolean) =>
        api.put<{ director_final_approval: boolean }>(`${BASE}/settings`, {
            director_final_approval: directorFinalApproval,
        }),
};
