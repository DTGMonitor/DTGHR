import { useMemo, useState } from "react";
import {
    ShiftChangeStatus,
    type ShiftChangeItem,
    type ShiftChangeRequest,
} from "@/types/schedule";
import type { ShiftChangeReview } from "@/services/scheduleService";
import { ShiftChip } from "./ShiftLegend";

interface Props {
    requests: ShiftChangeRequest[];
    /** Superusers review; everyone else just watches their own queue. */
    canReview: boolean;
    busyId: string | null;
    onReview: (id: string, review: ShiftChangeReview) => void;
    onWithdraw: (id: string) => void;
    onClose: () => void;
}

function formatDate(iso: string) {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
    });
}

const STATUS_STYLES: Record<string, string> = {
    [ShiftChangeStatus.PENDING]: "border-gold/35 bg-gold/10 text-gold",
    [ShiftChangeStatus.APPROVED]: "border-signal/35 bg-signal/10 text-signal",
    [ShiftChangeStatus.REJECTED]: "border-danger/35 bg-danger/10 text-danger",
    [ShiftChangeStatus.PARTIALLY_APPROVED]: "border-teal-300/35 bg-teal-300/10 text-teal-300",
    [ShiftChangeStatus.CANCELLED]: "border-white/12 bg-white/[0.04] text-muted",
};

const STATUS_LABELS: Record<string, string> = {
    [ShiftChangeStatus.PENDING]: "Pending",
    [ShiftChangeStatus.APPROVED]: "Approved",
    [ShiftChangeStatus.REJECTED]: "Rejected",
    [ShiftChangeStatus.PARTIALLY_APPROVED]: "Partly approved",
    [ShiftChangeStatus.CANCELLED]: "Withdrawn",
};

export default function ApprovalsPanel({
    requests,
    canReview,
    busyId,
    onReview,
    onWithdraw,
    onClose,
}: Props) {
    return (
        <div className="rounded-2xl border border-white/10 bg-surface/50 backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                <h3 className="text-sm font-bold text-paper">
                    {canReview ? "Pending approvals" : "My proposals"}
                    <span className="ml-2 rounded-full bg-gold/20 px-2 py-0.5 text-[11px] font-medium text-gold">
                        {requests.length}
                    </span>
                </h3>
                <button
                    onClick={onClose}
                    className="rounded-lg p-1 text-muted transition hover:bg-white/5 hover:text-paper"
                    title="Hide"
                >
                    ✕
                </button>
            </div>

            {requests.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-muted">
                    Nothing waiting.
                </p>
            ) : (
                <ul className="divide-y divide-white/5">
                    {requests.map((request) => (
                        <ProposalRow
                            key={request.id}
                            request={request}
                            canReview={canReview}
                            busy={busyId === request.id}
                            onReview={onReview}
                            onWithdraw={onWithdraw}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */

function ProposalRow({
    request,
    canReview,
    busy,
    onReview,
    onWithdraw,
}: {
    request: ShiftChangeRequest;
    canReview: boolean;
    busy: boolean;
    onReview: (id: string, review: ShiftChangeReview) => void;
    onWithdraw: (id: string) => void;
}) {
    const pendingItems = useMemo(
        () => request.items.filter((i) => i.status === ShiftChangeStatus.PENDING),
        [request.items],
    );

    // Every pending day starts accepted; the reviewer unticks the ones they
    // will not allow, which is faster than ticking a long list one by one.
    const [accepted, setAccepted] = useState<Set<string>>(
        () => new Set(pendingItems.map((i) => i.id)),
    );
    const [note, setNote] = useState("");
    const [expanded, setExpanded] = useState(pendingItems.length <= 8);

    const toggle = (id: string) =>
        setAccepted((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const rejectedCount = pendingItems.length - accepted.size;
    const employees = [
        ...new Set(request.items.map((i) => i.employee_name ?? "Unknown")),
    ];

    const submit = () => {
        const review: ShiftChangeReview = { review_note: note || null };
        // Sending both lists explicitly keeps a partial review unambiguous;
        // an all-accepted review still sends every id, which the backend
        // treats the same as an unqualified approve-all.
        review.approved_item_ids = pendingItems
            .filter((i) => accepted.has(i.id))
            .map((i) => i.id);
        review.rejected_item_ids = pendingItems
            .filter((i) => !accepted.has(i.id))
            .map((i) => i.id);
        onReview(request.id, review);
    };

    return (
        <li className="px-5 py-3">
            {/* Summary line */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <button
                    onClick={() => setExpanded((v) => !v)}
                    className="text-muted transition hover:text-paper"
                    title={expanded ? "Collapse" : "Expand"}
                >
                    {expanded ? "▾" : "▸"}
                </button>

                <div className="min-w-[10rem] flex-1">
                    <p className="text-sm font-medium text-paper">
                        {employees.join(", ")}
                        <span className="ml-2 text-[11px] font-normal text-muted">
                            {request.items.length} day
                            {request.items.length === 1 ? "" : "s"}
                        </span>
                    </p>
                    <p className="text-[11px] text-muted">
                        {request.requested_by_name
                            ? `asked by ${request.requested_by_name}`
                            : " "}
                        {" · "}
                        {new Date(request.created_at).toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                        })}
                    </p>
                </div>

                <span
                    className={`dtg-chip ${STATUS_STYLES[request.status] ?? ""}`}
                >
                    {STATUS_LABELS[request.status] ?? request.status}
                </span>

                {canReview && pendingItems.length > 0 && (
                    <div className="flex items-center gap-2">
                        <input
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Note (optional)"
                            maxLength={500}
                            className="w-32 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-paper placeholder-muted focus:border-signal/60 focus:outline-none"
                        />
                        <button
                            onClick={submit}
                            disabled={busy}
                            className="rounded-lg bg-signal/20 px-3 py-1.5 text-[11px] font-semibold text-signal transition hover:bg-signal/30 disabled:opacity-50"
                        >
                            {rejectedCount === 0
                                ? `Approve all ${pendingItems.length}`
                                : `Approve ${accepted.size}, reject ${rejectedCount}`}
                        </button>
                        <button
                            onClick={() =>
                                onReview(request.id, {
                                    rejected_item_ids: pendingItems.map((i) => i.id),
                                    review_note: note || null,
                                })
                            }
                            disabled={busy}
                            className="rounded-lg bg-danger/20 px-3 py-1.5 text-[11px] font-semibold text-danger transition hover:bg-danger/30 disabled:opacity-50"
                        >
                            Reject all
                        </button>
                    </div>
                )}

                {!canReview && request.status === ShiftChangeStatus.PENDING && (
                    <button
                        onClick={() => onWithdraw(request.id)}
                        disabled={busy}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-medium text-paper-soft transition hover:bg-white/5 disabled:opacity-50"
                    >
                        Withdraw
                    </button>
                )}
            </div>

            {request.reason && (
                <p className="mt-1.5 pl-6 text-[11px] italic text-paper-soft">
                    “{request.reason}”
                </p>
            )}
            {request.review_note && (
                <p className="mt-1 pl-6 text-[11px] text-muted">
                    Reviewer: “{request.review_note}”
                </p>
            )}

            {/* Per-day breakdown */}
            {expanded && (
                <ul className="mt-2 space-y-1 pl-6">
                    {request.items.map((item) => (
                        <ItemRow
                            key={item.id}
                            item={item}
                            canReview={canReview}
                            accepted={accepted.has(item.id)}
                            onToggle={() => toggle(item.id)}
                            multiEmployee={employees.length > 1}
                        />
                    ))}
                </ul>
            )}
        </li>
    );
}

function ItemRow({
    item,
    canReview,
    accepted,
    onToggle,
    multiEmployee,
}: {
    item: ShiftChangeItem;
    canReview: boolean;
    accepted: boolean;
    onToggle: () => void;
    multiEmployee: boolean;
}) {
    const isPending = item.status === ShiftChangeStatus.PENDING;
    const reviewable = canReview && isPending;

    return (
        <li
            className={`flex items-center gap-2.5 rounded-lg px-2 py-1 text-[11px] ${reviewable ? "cursor-pointer hover:bg-white/5" : ""
                } ${reviewable && !accepted ? "opacity-45" : ""}`}
            onClick={reviewable ? onToggle : undefined}
        >
            {reviewable && (
                <input
                    type="checkbox"
                    checked={accepted}
                    onChange={onToggle}
                    onClick={(e) => e.stopPropagation()}
                    className="h-3.5 w-3.5 rounded border-white/20 bg-transparent"
                />
            )}

            <span className="w-24 shrink-0 text-paper-soft">{formatDate(item.date)}</span>

            {multiEmployee && (
                <span className="w-32 shrink-0 truncate text-muted">
                    {item.employee_name}
                </span>
            )}

            <ShiftChip code={item.current_code} />
            <span className="text-muted" aria-hidden>
                →
            </span>
            <ShiftChip code={item.requested_code} />

            {!isPending && (
                <span
                    className={`ml-auto rounded px-1.5 py-0.5 font-medium ${STATUS_STYLES[item.status] ?? ""
                        }`}
                >
                    {STATUS_LABELS[item.status] ?? item.status}
                </span>
            )}
            {reviewable && (
                <span className="ml-auto text-[10px] text-muted">
                    {accepted ? "will apply" : "will reject"}
                </span>
            )}
        </li>
    );
}
