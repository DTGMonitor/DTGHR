import api from "@/lib/api";

/*
 * The vendor list. Finance adds vendors and keeps their details; only the approver
 * changes a bank account once a vendor exists, and only after calling the
 * vendor back on the number already on file. Finance, the director and the approver
 * read the list; everybody else sees a vendor's name on a purchase only.
 */

export interface VendorEvent {
    id: string;
    kind: "created" | "edited" | "bank_changed" | "deactivated" | "reactivated";
    actor_name: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    note: string | null;
    detail: Record<string, unknown> | null;
    created_at: string;
}

export interface Vendor {
    id: string;
    name: string;
    npwp: string | null;
    is_pkp: boolean;
    contact_name: string | null;
    phone: string | null;
    email: string | null;
    bank_name: string | null;
    bank_account_number: string | null;
    bank_account_holder: string | null;
    is_active: boolean;
    notes: string | null;
    created_at: string;
    updated_at: string;
    /** The phone number was changed in the last 30 days: a callback to it proves little. */
    phone_changed_recently: boolean;
    purchases: number;
    events: VendorEvent[];
}

export interface VendorInput {
    name: string;
    npwp: string;
    is_pkp: boolean;
    contact_name: string;
    phone: string;
    email: string;
    notes: string;
    bank_name?: string;
    bank_account_number?: string;
    bank_account_holder?: string;
}

export const vendorService = {
    list: (includeInactive = false) =>
        api.get<{ items: Vendor[]; can_manage: boolean; can_change_bank: boolean }>("/vendors", {
            params: { include_inactive: includeInactive },
        }),
    get: (id: string) => api.get<Vendor>(`/vendors/${id}`),
    create: (body: VendorInput) => api.post<Vendor>("/vendors", body),
    update: (id: string, body: Partial<VendorInput>) => api.patch<Vendor>(`/vendors/${id}`, body),
    setActive: (id: string, active: boolean, note?: string) =>
        api.post<Vendor>(`/vendors/${id}/active`, { active, note }),
    changeBank: (
        id: string,
        body: { bank_name: string; bank_account_number: string; bank_account_holder: string; callback_note: string },
    ) => api.post<Vendor>(`/vendors/${id}/bank`, body),
};
