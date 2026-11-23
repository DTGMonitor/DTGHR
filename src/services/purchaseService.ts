import api from "@/lib/api";

/*
 * Purchasing (Route 2: above the petty-cash limit).
 *
 * Anyone raises a request in general terms; finance registers it, turns the
 * requested items into priced lines, gathers the evidence its tier needs and
 * sends it for approval; the approver approves the vendor and price; finance
 * issues the order and names a checker, who records what arrived; finance
 * matches the invoice and the payment goes through a finance request.
 *
 * The server shapes each purchase for the caller -- `shape` is "full",
 * "requester" or "checker". The requester's copy is a tracking view (their
 * items, the milestone, their own attachments); a checker's copy has no
 * prices. `can` says what the caller may do next; the page only offers that.
 */

export type PurchaseStatus =
    | "draft"
    | "submitted"
    | "sourcing"
    | "awaiting_approval"
    | "approved"
    | "ordered"
    | "received"
    | "amount_review"
    | "matched"
    | "paid"
    | "cancelled"
    | "petty_cash";

export type LineType = "asset" | "inventory" | "expense";
export type Tier = "simple" | "quotation" | "contract";
export type DocumentKind =
    | "request"
    | "quote"
    | "comparison"
    | "contract"
    | "approval_evidence"
    | "budget_exception"
    | "delivery_photo"
    | "delivery_note"
    | "invoice"
    | "tax_invoice"
    | "other";

export type PurchaseAction =
    | "edit"
    | "delete"
    | "submit"
    | "cancel"
    | "add_document"
    | "register"
    | "return"
    | "close_petty_cash"
    | "source"
    | "send_for_approval"
    | "issue_order"
    | "change_checker"
    | "ask_amount"
    | "match"
    | "approve"
    | "send_back"
    | "reject"
    | "confirm_urgent"
    | "decide_amount"
    | "receive";

export type Milestone = "submitted" | "approved" | "ordered" | "delivered" | "done";
export type Outcome = "returned" | "not_approved" | "cancelled" | "petty_cash";

/** Where a purchase stands, in the requester's terms. */
export interface PurchaseMilestone {
    current: Milestone | null;
    outcome: Outcome | null;
    /** The note meant for the requester: why it was returned, not approved or cancelled. */
    note: string | null;
    dates: Partial<Record<Milestone, string | null>>;
    outcome_at: string | null;
}

/** What the requester asked for, in their own words. */
export interface RequestedItem {
    id: string;
    description: string;
    quantity: number;
    note: string | null;
}

export interface PurchaseLine {
    id: string;
    line_type: LineType;
    description: string;
    specification: string | null;
    quantity: number;
    unit: string;
    asset_category: { id: string; code: string; name: string } | null;
    qty_received: number | null;
    condition_note: string | null;
    // Not in a checker's copy.
    unit_price?: number;
    line_total?: number;
    client_ref?: string | null;
    client_po?: { id: string; po_number: string; client_name: string } | null;
    assets_registered?: number;
}

export interface PurchaseDocument {
    id: string;
    kind: DocumentKind;
    filename: string;
    content_type: string;
    byte_size: number;
    uploaded_by_name: string | null;
    created_at: string;
    can_delete: boolean;
}

export interface PurchaseEvent {
    id?: string;
    kind: string;
    /** Absent from the requester's milestone history. */
    actor_name?: string;
    from_status?: PurchaseStatus | null;
    to_status?: PurchaseStatus | null;
    note: string | null;
    detail?: Record<string, unknown> | Record<string, unknown>[] | null;
    created_at: string;
}

export interface PurchaseVendor {
    id?: string;
    name: string;
    npwp?: string | null;
    is_pkp?: boolean;
    phone?: string | null;
    bank_name?: string | null;
    bank_account_number?: string | null;
    bank_account_holder?: string | null;
    is_active?: boolean;
}

export interface Purchase {
    id: string;
    reference: string | null;
    order_number: string | null;
    title: string;
    status: PurchaseStatus;
    needed_by: string | null;
    urgent: boolean;
    requester: { id: string; name: string | null };
    milestone: PurchaseMilestone;
    created_at: string;
    updated_at: string;
    shape: "full" | "requester" | "checker";
    can: PurchaseAction[];
    documents: PurchaseDocument[];
    /** The requester's copy: milestones and outcome only, without an actor. */
    events: PurchaseEvent[];
    // Finance and the checker: the purchase itself.
    checker?: { id: string; name: string | null } | null;
    vendor?: PurchaseVendor | null;
    ordered_at?: string | null;
    grn_at?: string | null;
    grn_note?: string | null;
    lines?: PurchaseLine[];
    // Finance and the requester: what was asked for.
    items?: RequestedItem[];
    purpose?: string | null;
    submitted_at?: string | null;
    urgent_detail?: {
        channel: "whatsapp" | "phone" | null;
        approved_at: string | null;
        note: string | null;
        // Finance's copy only.
        amount?: number | null;
        confirmed_at?: string | null;
        confirmed_by_name?: string | null;
    } | null;
    // Finance's copy only.
    cost_code?: string | null;
    budget_confirmed?: boolean;
    budget_exception_note?: string | null;
    estimated_total?: number;
    approval_amount?: number | null;
    approved_amount?: number | null;
    tier?: Tier | null;
    route_value?: number | null;
    related_party?: boolean | null;
    related_party_note?: string | null;
    sole_source?: boolean;
    sole_source_note?: string | null;
    shareholders_informed_on?: string | null;
    late_entry?: boolean;
    self_approved?: boolean;
    registered_at?: string | null;
    sent_for_approval_at?: string | null;
    approved_at?: string | null;
    approved_by_name?: string | null;
    invoice?: { number: string; date: string; total: number; ppn: number; pph: number; net_payable: number } | null;
    amount_review_amount?: number | null;
    matched_at?: string | null;
    finance_request?: { id: string; reference: string; status: string } | null;
    paid_on?: string | null;
    cancel_reason?: string | null;
    cancelled_at?: string | null;
    route?: { amount: number; vendor_month: number; route_value: number; tier: Tier };
    missing?: string[];
}

export interface PurchaseList {
    items: Purchase[];
    role?: string;
    is_full_viewer?: boolean;
}

export interface PurchaseSettings {
    petty_cash_limit: number;
    simple_limit: number;
    quotation_limit: number;
    updated_by_name: string | null;
    updated_at: string;
    can_edit: boolean;
}

/** One of finance's purchase lines, as the line editor sends it. */
export interface LineInput {
    line_type: LineType;
    description: string;
    specification?: string | null;
    quantity: number;
    unit: string;
    unit_price: number;
    asset_category_id?: string | null;
    client_po_id?: string | null;
}

/** What the requester sends: what is needed, in general terms. */
export interface RequestInput {
    title: string;
    purpose: string;
    needed_by: string | null;
    urgent: boolean;
    urgent_channel?: "whatsapp" | "phone" | null;
    urgent_approved_at?: string | null;
    urgent_note?: string | null;
    items: { description: string; quantity: number; note: string | null }[];
}

export interface CheckerCandidate {
    user_id: string;
    name: string | null;
    department: string | null;
    position: string | null;
}

export interface AwaitingLine {
    line_id: string;
    purchase_id: string;
    reference: string;
    order_number: string | null;
    description: string;
    category: { id: string; code: string; name: string };
    unit_price: number;
    qty_received: number;
    registered: number;
    grn_at: string;
    vendor_name: string | null;
}

const BASE = "/purchases";

export const purchaseService = {
    list: (filters: Record<string, string> = {}) => api.get<PurchaseList>(BASE, { params: filters }),
    mine: () => api.get<PurchaseList>(`${BASE}/mine`),
    toCheck: () => api.get<PurchaseList>(`${BASE}/to-check`),
    get: (id: string) => api.get<Purchase>(`${BASE}/${id}`),
    settings: () => api.get<PurchaseSettings>(`${BASE}/settings`),
    saveSettings: (s: { petty_cash_limit: number; simple_limit: number; quotation_limit: number }) =>
        api.put<PurchaseSettings>(`${BASE}/settings`, s),
    checkers: (id: string) => api.get<CheckerCandidate[]>(`${BASE}/${id}/checkers`),

    create: (body: RequestInput) => api.post<Purchase>(BASE, body),
    update: (id: string, body: RequestInput) => api.put<Purchase>(`${BASE}/${id}`, body),
    remove: (id: string) => api.delete(`${BASE}/${id}`),
    submit: (id: string) => api.post<Purchase>(`${BASE}/${id}/submit`),
    cancel: (id: string, reason: string | null) => api.post<Purchase>(`${BASE}/${id}/cancel`, { reason }),

    register: (
        id: string,
        body: {
            budget_confirmed: boolean;
            budget_exception_note?: string | null;
            cost_code?: string | null;
            lines?: LineInput[];
            vendor_id?: string | null;
            amount?: number | null;
        },
    ) => api.post<Purchase>(`${BASE}/${id}/register`, body),
    returnToRequester: (id: string, note: string) => api.post<Purchase>(`${BASE}/${id}/return`, { note }),
    closePettyCash: (id: string, estimate: number) => api.post<Purchase>(`${BASE}/${id}/petty-cash`, { estimate }),
    source: (id: string, body: Record<string, unknown>) => api.post<Purchase>(`${BASE}/${id}/source`, body),
    sendForApproval: (id: string) => api.post<Purchase>(`${BASE}/${id}/send`),
    issueOrder: (id: string, checkerId: string) => api.post<Purchase>(`${BASE}/${id}/order`, { checker_id: checkerId }),
    changeChecker: (id: string, checkerId: string) =>
        api.post<Purchase>(`${BASE}/${id}/checker`, { checker_id: checkerId }),
    askAmount: (id: string, amount: number, note: string) =>
        api.post<Purchase>(`${BASE}/${id}/ask-amount`, { amount, note }),
    match: (
        id: string,
        body: { invoice_number: string; invoice_date: string; invoice_total: number; ppn_amount: number; pph_amount: number },
    ) => api.post<Purchase>(`${BASE}/${id}/match`, body),

    approve: (id: string, note?: string) => api.post<Purchase>(`${BASE}/${id}/approve`, { note }),
    sendBack: (id: string, note: string) => api.post<Purchase>(`${BASE}/${id}/send-back`, { note }),
    reject: (id: string, reason: string) => api.post<Purchase>(`${BASE}/${id}/reject`, { reason }),
    confirmUrgent: (id: string, note?: string) => api.post<Purchase>(`${BASE}/${id}/confirm-urgent`, { note }),
    decideAmount: (id: string, approve: boolean, note?: string) =>
        api.post<Purchase>(`${BASE}/${id}/decide-amount`, { approve, note }),

    receive: (
        id: string,
        body: { lines: { line_id: string; qty_received: number; condition?: string }[]; matches: boolean; note?: string },
    ) => api.post<Purchase>(`${BASE}/${id}/receive`, body),

    upload: (id: string, kind: DocumentKind, file: File) => {
        const form = new FormData();
        form.append("file", file);
        form.append("kind", kind);
        return api.post<Purchase>(`${BASE}/${id}/documents`, form);
    },
    removeDocument: (id: string, documentId: string) => api.delete<Purchase>(`${BASE}/${id}/documents/${documentId}`),
    documentUrl: (id: string, documentId: string) => `${BASE}/${id}/documents/${documentId}`,

    awaitingAssets: () => api.get<AwaitingLine[]>("/assets/awaiting"),
};
