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
    [ShiftChangeStatus.PENDING]: "bg-amber-500/20 text-amber-400",
    [ShiftChangeStatus.APPROVED]: "bg-emerald-500/20 text-emerald-400",
    [ShiftChangeStatus.REJECTED]: "bg-red-500/20 text-red-400",
    [ShiftChangeStatus.PARTIALLY_APPROVED]: "bg-sky-500/20 text-sky-400",
    [ShiftChangeStatus.CANCELLED]: "bg-gray-500/20 text-gray-400",
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
        <div className="rounded-2xl border border-white/10 bg-gray-900/50 backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                <h3 className="text-sm font-bold text-white">
                    {canReview ? "Pending approvals" : "My proposals"}
                    <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                        {requests.length}
                    </span>
                </h3>
                <button
                    onClick={onClose}
                    className="rounded-lg p-1 text-gray-500 transition hover:bg-white/5 hover:text-white"
                    title="Hide"
                >
                    ✕
                </button>
            </div>

            {requests.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-gray-500">
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
                    className="text-gray-500 transition hover:text-white"
                    title={expanded ? "Collapse" : "Expand"}
                >
                    {expanded ? "▾" : "▸"}
                </button>

                <div className="min-w-[10rem] flex-1">
                    <p className="text-sm font-medium text-white">
                        {employees.join(", ")}
                        <span className="ml-2 text-[11px] font-normal text-gray-500">
                            {request.items.length} day
                            {request.items.length === 1 ? "" : "s"}
                        </span>
                    </p>
                    <p className="text-[11px] text-gray-500">
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
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[request.status] ?? ""
                        }`}
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
                            className="w-32 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                        />
                        <button
                            onClick={submit}
                            disabled={busy}
                            className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[11px] font-semibold text-emerald-400 transition hover:bg-emerald-500/30 disabled:opacity-50"
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
                            className="rounded-lg bg-red-500/20 px-3 py-1.5 text-[11px] font-semibold text-red-400 transition hover:bg-red-500/30 disabled:opacity-50"
                        >
                            Reject all
                        </button>
                    </div>
                )}

                {!canReview && request.status === ShiftChangeStatus.PENDING && (
                    <button
                        onClick={() => onWithdraw(request.id)}
                        disabled={busy}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-medium text-gray-300 transition hover:bg-white/5 disabled:opacity-50"
                    >
                        Withdraw
                    </button>
                )}
            </div>

            {request.reason && (
                <p className="mt-1.5 pl-6 text-[11px] italic text-gray-400">
                    “{request.reason}”
                </p>
            )}
            {request.review_note && (
                <p className="mt-1 pl-6 text-[11px] text-gray-500">
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

            <span className="w-24 shrink-0 text-gray-300">{formatDate(item.date)}</span>

            {multiEmployee && (
                <span className="w-32 shrink-0 truncate text-gray-500">
                    {item.employee_name}
                </span>
            )}

            <ShiftChip code={item.current_code} />
            <span className="text-gray-600" aria-hidden>
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
                <span className="ml-auto text-[10px] text-gray-500">
                    {accepted ? "will apply" : "will reject"}
                </span>
            )}
        </li>
    );
}
