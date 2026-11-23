import type { DocumentKind, LineType, Milestone, Outcome, PurchaseStatus, Tier } from "@/services/purchaseService";

export { day, detail, when } from "@/components/assets/labels";

export const STATUS_CHIP: Record<PurchaseStatus, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "border-white/15 bg-white/[0.04] text-muted" },
    submitted: { label: "Submitted", cls: "border-teal-500/40 bg-teal-500/10 text-teal-200" },
    sourcing: { label: "Sourcing", cls: "border-teal-500/40 bg-teal-500/10 text-teal-200" },
    awaiting_approval: { label: "Awaiting approval", cls: "border-gold/30 bg-gold/10 text-gold" },
    approved: { label: "Approved", cls: "border-signal/40 bg-signal/10 text-signal" },
    ordered: { label: "Ordered", cls: "border-signal/40 bg-signal/10 text-signal" },
    received: { label: "Received", cls: "border-signal/40 bg-signal/10 text-signal" },
    amount_review: { label: "Amount review", cls: "border-gold/30 bg-gold/10 text-gold" },
    matched: { label: "In payment", cls: "border-teal-500/40 bg-teal-500/10 text-teal-200" },
    paid: { label: "Paid", cls: "border-white/15 bg-white/[0.04] text-paper-soft" },
    cancelled: { label: "Cancelled", cls: "border-danger/40 bg-danger/10 text-danger" },
    petty_cash: { label: "Petty cash", cls: "border-white/15 bg-white/[0.04] text-paper-soft" },
};

export const LINE_TYPE: Record<LineType, { label: string; hint: string }> = {
    asset: { label: "Asset", hint: "Kept by the company; IT registers it" },
    inventory: { label: "Inventory", hint: "A product bought to sell" },
    expense: { label: "Expense", hint: "A service, or something used up" },
};

export const TIER_LABEL: Record<Tier, string> = {
    simple: "Simple (1 quote)",
    quotation: "Quotation (2–3 quotes + comparison)",
    contract: "Contract (3 quotes, contract, shareholders informed)",
};

export const DOC_KIND: Record<DocumentKind, string> = {
    request: "Request form",
    quote: "Quote",
    comparison: "Comparison sheet",
    contract: "Contract",
    approval_evidence: "Approval evidence",
    budget_exception: "Budget exception",
    delivery_photo: "Delivery photo",
    delivery_note: "Delivery note / GRN",
    invoice: "Invoice",
    tax_invoice: "Faktur pajak",
    other: "Other",
};

/** What each history event says, in plain words. */
export const EVENT_LABEL: Record<string, string> = {
    created: "Drafted",
    submitted: "Submitted",
    returned: "Returned to the requester",
    registered: "Registered",
    petty_cash: "Closed as petty cash",
    document_added: "Attached",
    document_removed: "Removed",
    vendor_chosen: "Vendor chosen",
    sent_for_approval: "Sent for approval",
    approved: "Approved",
    sent_back: "Sent back",
    rejected: "Rejected",
    urgent_confirmed: "Urgent approval confirmed",
    ordered: "Order issued",
    checker_changed: "Checker changed",
    grn_accepted: "Goods received",
    delivery_rejected: "Delivery rejected",
    amount_review_asked: "Higher amount asked",
    amount_approved: "Higher amount approved",
    amount_declined: "Higher amount declined",
    matched: "Matched; sent for payment",
    paid: "Paid",
    cancelled: "Cancelled",
};

/** The requester's progress bar, in order. */
export const MILESTONES: { key: Milestone; label: string }[] = [
    { key: "submitted", label: "Submitted" },
    { key: "approved", label: "Approved" },
    { key: "ordered", label: "Ordered" },
    { key: "delivered", label: "Delivered" },
    { key: "done", label: "Done" },
];

export const OUTCOME: Record<Outcome, { label: string; tone: "warning" | "danger" | "info" }> = {
    returned: { label: "Returned to you", tone: "warning" },
    not_approved: { label: "Not approved", tone: "danger" },
    cancelled: { label: "Cancelled", tone: "danger" },
    petty_cash: { label: "Petty cash", tone: "info" },
};

/** One line for a requester's list: where it stands. */
export const milestoneLabel = (m: { current: Milestone | null; outcome: Outcome | null }) =>
    m.outcome ? OUTCOME[m.outcome].label : m.current ? MILESTONES.find((x) => x.key === m.current)!.label : "Draft";

export const rp =(value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `Rp ${Number(value).toLocaleString("id-ID")}`;

/** Today in the browser's time zone, as YYYY-MM-DD. */
export const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
