import { useState, useEffect, useCallback } from "react";
import { LeaveType, LeaveStatus } from "@/types/leave";
import type { LeaveRequest, LeaveBalance } from "@/types/leave";
import { leaveService } from "@/services/leaveService";
import { useAuth } from "@/contexts/AuthContext";
import LeaveRequestModal from "@/components/leaves/LeaveRequestModal";
import Icon from "@/components/ui/icons";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
    [LeaveType.ANNUAL]: "Annual",
    [LeaveType.SICK]: "Sick",
    [LeaveType.PERSONAL]: "Personal",
    [LeaveType.UNPAID]: "Unpaid",
};

/*
 * Accent rule and usage-bar fill per leave type.
 *
 * These were four two-stop gradients, which put four competing washes in one
 * row. DTG marks its data blocks with a flat surface and a 2px rule instead, so
 * the type is legible without the card shouting.
 */
const LEAVE_TYPE_STYLES: Record<LeaveType, { rule: string; bar: string }> = {
    [LeaveType.ANNUAL]: { rule: "border-l-teal-300", bar: "bg-teal-300" },
    [LeaveType.SICK]: { rule: "border-l-danger", bar: "bg-danger" },
    [LeaveType.PERSONAL]: { rule: "border-l-signal", bar: "bg-signal" },
    [LeaveType.UNPAID]: { rule: "border-l-teal-700", bar: "bg-teal-500" },
};

const STATUS_STYLES: Record<LeaveStatus, string> = {
    [LeaveStatus.PENDING]: "border-gold/35 bg-gold/10 text-gold",
    [LeaveStatus.APPROVED]: "border-signal/35 bg-signal/10 text-signal",
    [LeaveStatus.REJECTED]: "border-danger/35 bg-danger/10 text-danger",
    [LeaveStatus.CANCELLED]: "border-white/12 bg-white/[0.04] text-muted",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: LeaveStatus }) {
    return (
        <span className={`dtg-chip ${STATUS_STYLES[status]}`}>
            {status}
        </span>
    );
}

function BalanceCard({ balance }: { balance: LeaveBalance }) {
    const pct = balance.total_days > 0
        ? Math.min(100, (balance.used_days / balance.total_days) * 100)
        : 0;
    const style = LEAVE_TYPE_STYLES[balance.leave_type];

    return (
        <div
            className={`rounded-2xl border border-white/10 border-l-2 bg-surface p-5 transition-colors hover:bg-surface-raised ${style.rule}`}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="dtg-eyebrow text-paper-soft">
                        {LEAVE_TYPE_LABELS[balance.leave_type]} leave
                    </p>
                    <p className="mt-3 font-mono text-3xl font-semibold leading-none tracking-tight text-paper">
                        {balance.remaining_days}
                    </p>
                    <p className="mt-1.5 text-xs text-muted">days remaining</p>
                </div>
                <div className="flex-shrink-0 text-right font-mono text-micro text-muted">
                    <p>{balance.used_days} used</p>
                    <p className="mt-0.5">{balance.total_days} total</p>
                </div>
            </div>

            {/* Usage bar */}
            <div
                className="mt-4 h-1 overflow-hidden rounded-sm bg-white/10"
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${LEAVE_TYPE_LABELS[balance.leave_type]} leave used`}
            >
                <div
                    className={`h-full rounded-sm transition-all duration-500 ${style.bar}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LeavesPage() {
    const { user } = useAuth();
    const isAdmin = !!user?.is_superuser;

    const [balances, setBalances] = useState<LeaveBalance[]>([]);
    const [requests, setRequests] = useState<LeaveRequest[]>([]);
    const [pendingApprovals, setPendingApprovals] = useState<LeaveRequest[]>([]);
    const [summary, setSummary] = useState<Record<string, Record<string, number>>>({});

    const [loadingBalances, setLoadingBalances] = useState(true);
    const [loadingRequests, setLoadingRequests] = useState(true);
    const [loadingApprovals, setLoadingApprovals] = useState(true);
    const [loadingSummary, setLoadingSummary] = useState(true);

    const [noEmployeeProfile, setNoEmployeeProfile] = useState(false);
    const [showModal, setShowModal] = useState(false);

    const [statusFilter, setStatusFilter] = useState<LeaveStatus | "">("");
    const [typeFilter, setTypeFilter] = useState<LeaveType | "">("");

    // Action state: { id, action: "approve"|"reject", note }
    const [actionState, setActionState] = useState<{
        id: string; action: "approve" | "reject"; note: string; loading: boolean;
    } | null>(null);

    const fetchBalances = useCallback(async () => {
        try {
            const res = await leaveService.getMyBalances();
            setBalances(res.data);
        } catch (err: unknown) {
            const status = (err as { response?: { status?: number } })?.response?.status;
            if (status === 403) setNoEmployeeProfile(true);
        } finally {
            setLoadingBalances(false);
        }
    }, []);

    const fetchRequests = useCallback(async () => {
        try {
            const res = await leaveService.listMyRequests({
                status: statusFilter || undefined,
                leave_type: typeFilter || undefined,
                page_size: 50,
            });
            setRequests(res.data.items);
        } catch {
            // silently ignore if no employee profile
        } finally {
            setLoadingRequests(false);
        }
    }, [statusFilter, typeFilter]);

    const fetchApprovals = useCallback(async () => {
        try {
            const res = await leaveService.listPendingApprovals({ page_size: 50 });
            setPendingApprovals(res.data.items);
        } catch {
            // not a manager or no employee profile — ignore
        } finally {
            setLoadingApprovals(false);
        }
    }, []);

    const fetchSummary = useCallback(async () => {
        if (!isAdmin) { setLoadingSummary(false); return; }
        try {
            const res = await leaveService.getSummary();
            setSummary(res.data);
        } catch {
            // ignore
        } finally {
            setLoadingSummary(false);
        }
    }, [isAdmin]);

    useEffect(() => {
        if (isAdmin) {
            fetchSummary();
            fetchApprovals();
        } else {
            fetchBalances();
            fetchApprovals();
        }
    }, [isAdmin, fetchBalances, fetchApprovals, fetchSummary]);
    useEffect(() => { if (!isAdmin) fetchRequests(); }, [isAdmin, fetchRequests]);

    const handleSubmitted = () => {
        setShowModal(false);
        fetchRequests();
        fetchBalances();
    };

    const handleCancel = async (id: string) => {
        try {
            await leaveService.cancelRequest(id);
            fetchRequests();
            fetchBalances();
        } catch {
            // TODO: toast error
        }
    };

    const handleAction = async () => {
        if (!actionState) return;
        setActionState((s) => s && ({ ...s, loading: true }));
        try {
            if (actionState.action === "approve") {
                await leaveService.approveRequest(actionState.id, { note: actionState.note || undefined });
            } else {
                await leaveService.rejectRequest(actionState.id, { note: actionState.note || undefined });
            }
            setActionState(null);
            fetchApprovals();
        } catch {
            setActionState((s) => s && ({ ...s, loading: false }));
        }
    };

    const formatDate = (d: string) =>
        new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

    // ── No employee profile banner (only for non-admin) ─────────────────────
    if (!isAdmin && !loadingBalances && noEmployeeProfile) {
        return (
            <div className="space-y-6">
                <h1 className="text-2xl font-bold text-paper">Leave Management</h1>
                <div className="flex flex-col items-center justify-center rounded-2xl border border-gold/30 bg-gold/10 p-12 text-center">
                    <Icon name="key" className="h-9 w-9 text-gold" />
                    <h2 className="mt-4 text-lg font-semibold text-paper">No Employee Profile Linked</h2>
                    <p className="mt-2 max-w-md text-sm text-paper-soft">
                        Your user account isn't linked to an employee profile yet.
                        Please ask your administrator to link your account to an employee record before using leave management.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-paper">Leave Management</h1>
                    <p className="mt-1 text-sm text-paper-soft">
                        {isAdmin ? "Overview of all leave requests across the organisation." : "Submit, track, and manage leave requests."}
                    </p>
                </div>
                {!isAdmin && (
                    <button
                        onClick={() => setShowModal(true)}
                        className="rounded-xl bg-signal px-4 py-2 text-sm font-semibold text-paper transition-all hover:bg-signal-hover"
                    >
                        + New Request
                    </button>
                )}
            </div>

            {/* Admin Summary Cards */}
            {isAdmin && (
                loadingSummary ? (
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                        {[...Array(4)].map((_, i) => (
                            <div key={i} className="animate-pulse rounded-2xl border border-white/10 bg-white/5 p-5 h-32" />
                        ))}
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                        {Object.values(LeaveType).map((lt) => {
                            const stats = summary[lt] || {};
                            const total = Object.values(stats).reduce((a: number, b: number) => a + b, 0);
                            const pending = stats["pending"] || 0;
                            const approved = stats["approved"] || 0;
                            const rejected = stats["rejected"] || 0;
                            return (
                                <div
                                    key={lt}
                                    className={`rounded-2xl border border-white/10 border-l-2 bg-surface p-5 transition-colors hover:bg-surface-raised ${LEAVE_TYPE_STYLES[lt].rule}`}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <h3 className="dtg-eyebrow text-paper-soft">
                                            {LEAVE_TYPE_LABELS[lt]} leave
                                        </h3>
                                        <span className="flex-shrink-0 font-mono text-micro text-muted">
                                            {total} total
                                        </span>
                                    </div>
                                    <p className="mt-3 font-mono text-3xl font-semibold leading-none tracking-tight text-paper">
                                        {pending}
                                    </p>
                                    <p className="mt-1.5 text-xs text-muted">pending</p>
                                    <div className="mt-3 flex gap-4 border-t border-white/[0.08] pt-3 font-mono text-micro">
                                        <span className="text-signal">{approved} approved</span>
                                        <span className="text-danger">{rejected} rejected</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )
            )}

            {/* Employee Balance Cards */}
            {!isAdmin && (loadingBalances ? (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    {[...Array(4)].map((_, i) => (
                        <div key={i} className="animate-pulse rounded-2xl border border-white/10 bg-white/5 p-5 h-32" />
                    ))}
                </div>
            ) : balances.length > 0 ? (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    {balances.map((b) => <BalanceCard key={b.id} balance={b} />)}
                </div>
            ) : (
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-sm text-muted">
                    No leave balances configured for this year yet.
                </div>
            ))}

            {/* Pending Approvals (manager/admin) */}
            {!loadingApprovals && pendingApprovals.length > 0 && (
                <section>
                    <h2 className="mb-3 text-lg font-semibold text-paper">
                        Pending Approvals
                        <span className="ml-2 rounded-full bg-gold/20 px-2 py-0.5 text-xs text-gold">
                            {pendingApprovals.length}
                        </span>
                    </h2>
                    <div className="overflow-hidden rounded-2xl border border-white/10">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium uppercase tracking-wider text-muted">
                                    <th className="px-4 py-3">Employee</th>
                                    <th className="px-4 py-3">Type</th>
                                    <th className="px-4 py-3">Dates</th>
                                    <th className="px-4 py-3">Days</th>
                                    <th className="px-4 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {pendingApprovals.map((req) => (
                                    <tr key={req.id} className="bg-surface/20">
                                        <td className="px-4 py-3 text-paper-soft text-sm font-medium">{req.employee_name ?? req.employee_id.slice(0, 8)}</td>
                                        <td className="px-4 py-3 text-paper-soft">
                                            {LEAVE_TYPE_LABELS[req.leave_type]} Leave
                                        </td>
                                        <td className="px-4 py-3 text-paper-soft">
                                            {formatDate(req.start_date)} – {formatDate(req.end_date)}
                                        </td>
                                        <td className="px-4 py-3 text-paper-soft">{req.days_requested}d</td>
                                        <td className="px-4 py-3 text-right">
                                            {actionState?.id === req.id ? (
                                                <div className="flex items-center justify-end gap-2">
                                                    <input
                                                        type="text"
                                                        placeholder="Note (optional)"
                                                        value={actionState.note}
                                                        onChange={(e) =>
                                                            setActionState((s) => s && ({ ...s, note: e.target.value }))
                                                        }
                                                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-paper placeholder-muted focus:outline-none focus:border-signal/60"
                                                    />
                                                    <button
                                                        onClick={handleAction}
                                                        disabled={actionState.loading}
                                                        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${actionState.action === "approve"
                                                            ? "bg-signal-hover hover:bg-signal-hover text-paper"
                                                            : "bg-danger hover:bg-danger text-paper"
                                                            } disabled:opacity-60`}
                                                    >
                                                        {actionState.loading ? "…" : "Confirm"}
                                                    </button>
                                                    <button
                                                        onClick={() => setActionState(null)}
                                                        className="text-xs text-muted hover:text-paper-soft"
                                                    >
                                                        ✕
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="inline-flex gap-2">
                                                    <button
                                                        onClick={() => setActionState({ id: req.id, action: "approve", note: "", loading: false })}
                                                        className="rounded-lg bg-signal-hover/20 px-3 py-1.5 text-xs font-medium text-signal hover:bg-signal-hover/40 transition"
                                                    >
                                                        Approve
                                                    </button>
                                                    <button
                                                        onClick={() => setActionState({ id: req.id, action: "reject", note: "", loading: false })}
                                                        className="rounded-lg bg-danger/20 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/40 transition"
                                                    >
                                                        Reject
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {/* My Leave History (employees only) */}
            {!isAdmin && (
                <section>
                    <div className="mb-3 flex items-center justify-between">
                        <h2 className="text-lg font-semibold text-paper">My Requests</h2>
                        <div className="flex gap-2">
                            <select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value as LeaveStatus | "")}
                                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-paper-soft focus:outline-none focus:border-signal/60 cursor-pointer"
                            >
                                <option value="" className="bg-surface">All statuses</option>
                                {Object.values(LeaveStatus).map((s) => (
                                    <option key={s} value={s} className="bg-surface capitalize">{s}</option>
                                ))}
                            </select>
                            <select
                                value={typeFilter}
                                onChange={(e) => setTypeFilter(e.target.value as LeaveType | "")}
                                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-paper-soft focus:outline-none focus:border-signal/60 cursor-pointer"
                            >
                                <option value="" className="bg-surface">All types</option>
                                {Object.values(LeaveType).map((t) => (
                                    <option key={t} value={t} className="bg-surface">{LEAVE_TYPE_LABELS[t]}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="overflow-hidden rounded-2xl border border-white/10">
                        {loadingRequests ? (
                            <div className="flex items-center justify-center py-16 text-muted text-sm">
                                <svg className="mr-2 h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                </svg>
                                Loading requests…
                            </div>
                        ) : requests.length === 0 ? (
                            <div className="py-16 text-center">
                                <Icon name="calendar" className="mx-auto h-8 w-8 text-teal-700" />
                                <p className="text-sm text-paper-soft">No leave requests found</p>
                                <button
                                    onClick={() => setShowModal(true)}
                                    className="mt-2 text-xs text-teal-300 hover:underline"
                                >
                                    Submit your first request
                                </button>
                            </div>
                        ) : (
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium uppercase tracking-wider text-muted">
                                        <th className="px-4 py-3">Type</th>
                                        <th className="px-4 py-3">Dates</th>
                                        <th className="px-4 py-3">Days</th>
                                        <th className="px-4 py-3">Reason</th>
                                        <th className="px-4 py-3">Status</th>
                                        <th className="px-4 py-3 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5">
                                    {requests.map((req) => (
                                        <tr key={req.id} className="bg-surface/20 hover:bg-white/5 transition">
                                            <td className="px-4 py-3 text-paper-soft">
                                                {LEAVE_TYPE_LABELS[req.leave_type]} Leave
                                            </td>
                                            <td className="px-4 py-3 text-paper-soft whitespace-nowrap">
                                                {formatDate(req.start_date)} – {formatDate(req.end_date)}
                                            </td>
                                            <td className="px-4 py-3 text-paper-soft">{req.days_requested}d</td>
                                            <td className="px-4 py-3 text-muted max-w-[180px] truncate">
                                                {req.reason ?? <span className="text-muted">—</span>}
                                            </td>
                                            <td className="px-4 py-3">
                                                <StatusBadge status={req.status} />
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                {req.status === LeaveStatus.PENDING && (
                                                    <button
                                                        onClick={() => handleCancel(req.id)}
                                                        className="rounded-lg px-3 py-1 text-xs font-medium text-paper-soft hover:bg-white/10 hover:text-danger transition"
                                                    >
                                                        Cancel
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </section>
            )}

            {/* Leave Request Modal */}
            {!isAdmin && showModal && (
                <LeaveRequestModal
                    balances={balances}
                    onClose={() => setShowModal(false)}
                    onSubmitted={handleSubmitted}
                />
            )}
        </div>
    );
}
