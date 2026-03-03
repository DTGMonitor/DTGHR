import { useState, useEffect, useCallback } from "react";
import { LeaveType, LeaveStatus } from "@/types/leave";
import type { LeaveRequest, LeaveBalance } from "@/types/leave";
import { leaveService } from "@/services/leaveService";
import LeaveRequestModal from "@/components/leaves/LeaveRequestModal";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
    [LeaveType.ANNUAL]: "Annual",
    [LeaveType.SICK]: "Sick",
    [LeaveType.PERSONAL]: "Personal",
    [LeaveType.UNPAID]: "Unpaid",
};

const LEAVE_TYPE_COLORS: Record<LeaveType, string> = {
    [LeaveType.ANNUAL]: "from-blue-500/20 to-cyan-500/20 border-blue-500/20",
    [LeaveType.SICK]: "from-red-500/20 to-rose-500/20 border-red-500/20",
    [LeaveType.PERSONAL]: "from-purple-500/20 to-violet-500/20 border-purple-500/20",
    [LeaveType.UNPAID]: "from-gray-500/20 to-slate-500/20 border-gray-500/20",
};

const STATUS_STYLES: Record<LeaveStatus, string> = {
    [LeaveStatus.PENDING]: "bg-amber-500/15 text-amber-400",
    [LeaveStatus.APPROVED]: "bg-emerald-500/15 text-emerald-400",
    [LeaveStatus.REJECTED]: "bg-red-500/15 text-red-400",
    [LeaveStatus.CANCELLED]: "bg-gray-500/15 text-gray-400",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: LeaveStatus }) {
    return (
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}>
            {status}
        </span>
    );
}

function BalanceCard({ balance }: { balance: LeaveBalance }) {
    const pct = balance.total_days > 0
        ? Math.min(100, (balance.used_days / balance.total_days) * 100)
        : 0;
    const colors = LEAVE_TYPE_COLORS[balance.leave_type];

    return (
        <div className={`rounded-2xl border bg-gradient-to-br p-5 ${colors}`}>
            <div className="flex items-start justify-between">
                <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
                        {LEAVE_TYPE_LABELS[balance.leave_type]} Leave
                    </p>
                    <p className="mt-1 text-3xl font-bold text-white">{balance.remaining_days}</p>
                    <p className="text-xs text-gray-500">days remaining</p>
                </div>
                <div className="text-right text-xs text-gray-500">
                    <p>{balance.used_days} used</p>
                    <p>{balance.total_days} total</p>
                </div>
            </div>
            {/* Usage bar */}
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                    className="h-full rounded-full bg-white/40 transition-all duration-500"
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LeavesPage() {
    const [balances, setBalances] = useState<LeaveBalance[]>([]);
    const [requests, setRequests] = useState<LeaveRequest[]>([]);
    const [pendingApprovals, setPendingApprovals] = useState<LeaveRequest[]>([]);

    const [loadingBalances, setLoadingBalances] = useState(true);
    const [loadingRequests, setLoadingRequests] = useState(true);
    const [loadingApprovals, setLoadingApprovals] = useState(true);

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

    useEffect(() => { fetchBalances(); fetchApprovals(); }, [fetchBalances, fetchApprovals]);
    useEffect(() => { fetchRequests(); }, [fetchRequests]);

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
        setActionState((s) => s && { ...s, loading: true });
        try {
            if (actionState.action === "approve") {
                await leaveService.approveRequest(actionState.id, { note: actionState.note || undefined });
            } else {
                await leaveService.rejectRequest(actionState.id, { note: actionState.note || undefined });
            }
            setActionState(null);
            fetchApprovals();
        } catch {
            setActionState((s) => s && { ...s, loading: false });
        }
    };

    const formatDate = (d: string) =>
        new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

    // ── No employee profile banner ──────────────────────────────────────────
    if (!loadingBalances && noEmployeeProfile) {
        return (
            <div className="space-y-6">
                <h1 className="text-2xl font-bold text-white">Leave Management</h1>
                <div className="flex flex-col items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 p-12 text-center">
                    <span className="text-4xl">🔗</span>
                    <h2 className="mt-4 text-lg font-semibold text-white">No Employee Profile Linked</h2>
                    <p className="mt-2 max-w-md text-sm text-gray-400">
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
                    <h1 className="text-2xl font-bold text-white">Leave Management</h1>
                    <p className="mt-1 text-sm text-gray-400">Submit, track, and manage leave requests.</p>
                </div>
                <button
                    onClick={() => setShowModal(true)}
                    className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:from-indigo-600 hover:to-purple-700"
                >
                    + New Request
                </button>
            </div>

            {/* Balance Cards */}
            {loadingBalances ? (
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
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-sm text-gray-500">
                    No leave balances configured for this year yet.
                </div>
            )}

            {/* Pending Approvals (manager only) */}
            {!loadingApprovals && pendingApprovals.length > 0 && (
                <section>
                    <h2 className="mb-3 text-lg font-semibold text-white">
                        Pending Approvals
                        <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
                            {pendingApprovals.length}
                        </span>
                    </h2>
                    <div className="overflow-hidden rounded-2xl border border-white/10">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                    <th className="px-4 py-3">Employee</th>
                                    <th className="px-4 py-3">Type</th>
                                    <th className="px-4 py-3">Dates</th>
                                    <th className="px-4 py-3">Days</th>
                                    <th className="px-4 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {pendingApprovals.map((req) => (
                                    <tr key={req.id} className="bg-gray-900/20">
                                        <td className="px-4 py-3 text-gray-300 font-mono text-xs">{req.employee_id}</td>
                                        <td className="px-4 py-3 text-gray-300">
                                            {LEAVE_TYPE_LABELS[req.leave_type]} Leave
                                        </td>
                                        <td className="px-4 py-3 text-gray-400">
                                            {formatDate(req.start_date)} – {formatDate(req.end_date)}
                                        </td>
                                        <td className="px-4 py-3 text-gray-400">{req.days_requested}d</td>
                                        <td className="px-4 py-3 text-right">
                                            {actionState?.id === req.id ? (
                                                <div className="flex items-center justify-end gap-2">
                                                    <input
                                                        type="text"
                                                        placeholder="Note (optional)"
                                                        value={actionState.note}
                                                        onChange={(e) =>
                                                            setActionState((s) => s && { ...s, note: e.target.value })
                                                        }
                                                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                                                    />
                                                    <button
                                                        onClick={handleAction}
                                                        disabled={actionState.loading}
                                                        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${actionState.action === "approve"
                                                                ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                                                                : "bg-red-600 hover:bg-red-700 text-white"
                                                            } disabled:opacity-60`}
                                                    >
                                                        {actionState.loading ? "…" : "Confirm"}
                                                    </button>
                                                    <button
                                                        onClick={() => setActionState(null)}
                                                        className="text-xs text-gray-500 hover:text-gray-300"
                                                    >
                                                        ✕
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="inline-flex gap-2">
                                                    <button
                                                        onClick={() => setActionState({ id: req.id, action: "approve", note: "", loading: false })}
                                                        className="rounded-lg bg-emerald-600/20 px-3 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-600/40 transition"
                                                    >
                                                        Approve
                                                    </button>
                                                    <button
                                                        onClick={() => setActionState({ id: req.id, action: "reject", note: "", loading: false })}
                                                        className="rounded-lg bg-red-600/20 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-600/40 transition"
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

            {/* My Leave History */}
            <section>
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-white">My Requests</h2>
                    <div className="flex gap-2">
                        <select
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value as LeaveStatus | "")}
                            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
                        >
                            <option value="" className="bg-gray-900">All statuses</option>
                            {Object.values(LeaveStatus).map((s) => (
                                <option key={s} value={s} className="bg-gray-900 capitalize">{s}</option>
                            ))}
                        </select>
                        <select
                            value={typeFilter}
                            onChange={(e) => setTypeFilter(e.target.value as LeaveType | "")}
                            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
                        >
                            <option value="" className="bg-gray-900">All types</option>
                            {Object.values(LeaveType).map((t) => (
                                <option key={t} value={t} className="bg-gray-900">{LEAVE_TYPE_LABELS[t]}</option>
                            ))}
                        </select>
                    </div>
                </div>

                <div className="overflow-hidden rounded-2xl border border-white/10">
                    {loadingRequests ? (
                        <div className="flex items-center justify-center py-16 text-gray-500 text-sm">
                            <svg className="mr-2 h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                            </svg>
                            Loading requests…
                        </div>
                    ) : requests.length === 0 ? (
                        <div className="py-16 text-center">
                            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-800 text-3xl">🗓</div>
                            <p className="text-sm text-gray-400">No leave requests found</p>
                            <button
                                onClick={() => setShowModal(true)}
                                className="mt-2 text-xs text-indigo-400 hover:underline"
                            >
                                Submit your first request
                            </button>
                        </div>
                    ) : (
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
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
                                    <tr key={req.id} className="bg-gray-900/20 hover:bg-white/5 transition">
                                        <td className="px-4 py-3 text-gray-300">
                                            {LEAVE_TYPE_LABELS[req.leave_type]} Leave
                                        </td>
                                        <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                                            {formatDate(req.start_date)} – {formatDate(req.end_date)}
                                        </td>
                                        <td className="px-4 py-3 text-gray-400">{req.days_requested}d</td>
                                        <td className="px-4 py-3 text-gray-500 max-w-[180px] truncate">
                                            {req.reason ?? <span className="text-gray-700">—</span>}
                                        </td>
                                        <td className="px-4 py-3">
                                            <StatusBadge status={req.status} />
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            {req.status === LeaveStatus.PENDING && (
                                                <button
                                                    onClick={() => handleCancel(req.id)}
                                                    className="rounded-lg px-3 py-1 text-xs font-medium text-gray-400 hover:bg-white/10 hover:text-red-400 transition"
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

            {/* Leave Request Modal */}
            {showModal && (
                <LeaveRequestModal
                    balances={balances}
                    onClose={() => setShowModal(false)}
                    onSubmitted={handleSubmitted}
                />
            )}
        </div>
    );
}
