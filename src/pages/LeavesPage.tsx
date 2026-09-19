import { useState, useEffect, useCallback } from "react";
import { LeaveType, LeaveStatus } from "@/types/leave";
import type { LeaveOverview, LeaveRequest } from "@/types/leave";
import { leaveService } from "@/services/leaveService";
import { useAuth } from "@/contexts/AuthContext";
import LeaveRequestModal from "@/components/leaves/LeaveRequestModal";
import LeaveOverviewCards from "@/components/leaves/LeaveOverviewCards";
import LeaveActivityFeed from "@/components/leaves/LeaveActivityFeed";
import {
    LEAVE_TYPE_COLORS,
    LEAVE_TYPE_LABELS,
    STATUS_STYLES,
    formatDate,
} from "@/components/leaves/leaveLabels";

type Tab = "mine" | "requests";

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: LeaveStatus }) {
    return (
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}>
            {status}
        </span>
    );
}

function NoProfileNotice() {
    return (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 p-12 text-center">
            <span className="text-4xl">🔗</span>
            <h2 className="mt-4 text-lg font-semibold text-white">No Employee Profile Linked</h2>
            <p className="mt-2 max-w-md text-sm text-gray-400">
                Your user account isn't linked to an employee profile yet, so there is no personal
                leave balance to show. Ask an administrator to link your account to an employee record.
            </p>
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LeavesPage() {
    const { user } = useAuth();
    const isAdmin = !!user?.is_superuser;
    const hasProfile = !!user?.employee_id;

    // HR sees their own leave and the organisation's requests on separate
    // tabs. The HR admin account has no roster row, so it opens on requests.
    const [tab, setTab] = useState<Tab>(isAdmin && !hasProfile ? "requests" : "mine");

    const [overview, setOverview] = useState<LeaveOverview | null>(null);
    const [requests, setRequests] = useState<LeaveRequest[]>([]);
    const [pendingApprovals, setPendingApprovals] = useState<LeaveRequest[]>([]);
    const [summary, setSummary] = useState<Record<string, Record<string, number>>>({});

    const [loadingOverview, setLoadingOverview] = useState(true);
    const [loadingRequests, setLoadingRequests] = useState(true);
    const [loadingApprovals, setLoadingApprovals] = useState(true);
    const [loadingSummary, setLoadingSummary] = useState(true);

    const [showModal, setShowModal] = useState(false);
    const [statusFilter, setStatusFilter] = useState<LeaveStatus | "">("");
    const [typeFilter, setTypeFilter] = useState<LeaveType | "">("");
    /** Bumped after anything that writes an activity row, so the feeds reload. */
    const [activityKey, setActivityKey] = useState(0);

    const [actionState, setActionState] = useState<{
        id: string; action: "approve" | "reject"; note: string; loading: boolean; error?: string;
    } | null>(null);

    const fetchOverview = useCallback(async () => {
        if (!hasProfile) { setLoadingOverview(false); return; }
        try {
            const res = await leaveService.getMyOverview();
            setOverview(res.data);
        } catch {
            // leave the skeleton-free empty state
        } finally {
            setLoadingOverview(false);
        }
    }, [hasProfile]);

    const fetchRequests = useCallback(async () => {
        if (!hasProfile) { setLoadingRequests(false); return; }
        try {
            const res = await leaveService.listMyRequests({
                status: statusFilter || undefined,
                leave_type: typeFilter || undefined,
                page_size: 50,
            });
            setRequests(res.data.items);
        } catch {
            // ignore
        } finally {
            setLoadingRequests(false);
        }
    }, [hasProfile, statusFilter, typeFilter]);

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
        fetchOverview();
        fetchApprovals();
        fetchSummary();
    }, [fetchOverview, fetchApprovals, fetchSummary]);
    useEffect(() => { fetchRequests(); }, [fetchRequests]);

    const refreshMine = () => {
        fetchRequests();
        fetchOverview();
        setActivityKey((k) => k + 1);
    };

    const handleSubmitted = () => {
        setShowModal(false);
        refreshMine();
        if (isAdmin) { fetchApprovals(); fetchSummary(); }
    };

    const handleCancel = async (id: string) => {
        if (!confirm("Cancel this leave request?")) return;
        try {
            await leaveService.cancelRequest(id);
            refreshMine();
            if (isAdmin) { fetchApprovals(); fetchSummary(); }
        } catch (err) {
            const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
            alert(detail ?? "Could not cancel the request.");
        }
    };

    const handleAction = async () => {
        if (!actionState) return;
        setActionState((s) => s && ({ ...s, loading: true, error: undefined }));
        try {
            if (actionState.action === "approve") {
                await leaveService.approveRequest(actionState.id, { note: actionState.note || undefined });
            } else {
                await leaveService.rejectRequest(actionState.id, { note: actionState.note || undefined });
            }
            setActionState(null);
            fetchApprovals();
            fetchSummary();
            // The reviewer may have just decided one of their own requests.
            refreshMine();
        } catch (err) {
            const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
            setActionState((s) => s && ({ ...s, loading: false, error: detail ?? "Action failed" }));
        }
    };

    // ── Sections ────────────────────────────────────────────────────────────

    const approvalsTable = !loadingApprovals && pendingApprovals.length > 0 && (
        <section>
            <h2 className="mb-3 text-lg font-semibold text-white">
                Pending Approvals
                <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
                    {pendingApprovals.length}
                </span>
            </h2>
            <div className="overflow-x-auto rounded-2xl border border-white/10">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                            <th className="px-4 py-3">Employee</th>
                            <th className="px-4 py-3">Type</th>
                            <th className="px-4 py-3">Dates</th>
                            <th className="px-4 py-3">Days</th>
                            <th className="px-4 py-3">Reason</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                        {pendingApprovals.map((req) => (
                            <tr key={req.id} className="bg-gray-900/20">
                                <td className="px-4 py-3 text-sm font-medium text-gray-300">{req.employee_name ?? req.employee_id.slice(0, 8)}</td>
                                <td className="px-4 py-3 text-gray-300">{LEAVE_TYPE_LABELS[req.leave_type]} Leave</td>
                                <td className="whitespace-nowrap px-4 py-3 text-gray-400">
                                    {formatDate(req.start_date)} – {formatDate(req.end_date)}
                                </td>
                                <td className="px-4 py-3 text-gray-400">{req.days_requested}d</td>
                                <td className="max-w-[180px] truncate px-4 py-3 text-gray-500" title={req.reason ?? undefined}>
                                    {req.reason ?? <span className="text-gray-700">—</span>}
                                </td>
                                <td className="px-4 py-3 text-right">
                                    {actionState?.id === req.id ? (
                                        <div className="flex flex-col items-end gap-1">
                                            <div className="flex items-center justify-end gap-2">
                                                <input
                                                    type="text"
                                                    placeholder="Note (optional)"
                                                    value={actionState.note}
                                                    onChange={(e) => setActionState((s) => s && ({ ...s, note: e.target.value }))}
                                                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:border-indigo-500 focus:outline-none"
                                                />
                                                <button
                                                    onClick={handleAction}
                                                    disabled={actionState.loading}
                                                    className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-60 ${actionState.action === "approve"
                                                        ? "bg-emerald-600 hover:bg-emerald-700"
                                                        : "bg-red-600 hover:bg-red-700"
                                                        }`}
                                                >
                                                    {actionState.loading ? "…" : actionState.action === "approve" ? "Confirm approve" : "Confirm reject"}
                                                </button>
                                                <button onClick={() => setActionState(null)} className="text-xs text-gray-500 hover:text-gray-300">
                                                    ✕
                                                </button>
                                            </div>
                                            {actionState.error && <p className="text-xs text-red-400">{actionState.error}</p>}
                                        </div>
                                    ) : (
                                        <div className="inline-flex gap-2">
                                            <button
                                                onClick={() => setActionState({ id: req.id, action: "approve", note: "", loading: false })}
                                                className="rounded-lg bg-emerald-600/20 px-3 py-1.5 text-xs font-medium text-emerald-400 transition hover:bg-emerald-600/40"
                                            >
                                                Approve
                                            </button>
                                            <button
                                                onClick={() => setActionState({ id: req.id, action: "reject", note: "", loading: false })}
                                                className="rounded-lg bg-red-600/20 px-3 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-600/40"
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
    );

    const myRequestsTable = (
        <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-white">My Requests</h2>
                <div className="flex gap-2">
                    <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as LeaveStatus | "")}
                        className="cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-300 focus:border-indigo-500 focus:outline-none"
                    >
                        <option value="" className="bg-gray-900">All statuses</option>
                        {Object.values(LeaveStatus).map((s) => (
                            <option key={s} value={s} className="bg-gray-900 capitalize">{s}</option>
                        ))}
                    </select>
                    <select
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value as LeaveType | "")}
                        className="cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-300 focus:border-indigo-500 focus:outline-none"
                    >
                        <option value="" className="bg-gray-900">All types</option>
                        {Object.values(LeaveType).map((t) => (
                            <option key={t} value={t} className="bg-gray-900">{LEAVE_TYPE_LABELS[t]}</option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-white/10">
                {loadingRequests ? (
                    <div className="flex items-center justify-center py-16 text-sm text-gray-500">Loading requests…</div>
                ) : requests.length === 0 ? (
                    <div className="py-16 text-center">
                        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-800 text-3xl">🗓</div>
                        <p className="text-sm text-gray-400">No leave requests found</p>
                        <button onClick={() => setShowModal(true)} className="mt-2 text-xs text-indigo-400 hover:underline">
                            Submit a request
                        </button>
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                <th className="px-4 py-3">Type</th>
                                <th className="px-4 py-3">Dates</th>
                                <th className="px-4 py-3">Days</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {requests.map((req) => (
                                <tr key={req.id} className="bg-gray-900/20 transition hover:bg-white/5">
                                    <td className="px-4 py-3 text-gray-300" title={req.reason ?? undefined}>
                                        {LEAVE_TYPE_LABELS[req.leave_type]} Leave
                                    </td>
                                    <td className="whitespace-nowrap px-4 py-3 text-gray-400">
                                        {formatDate(req.start_date)} – {formatDate(req.end_date)}
                                    </td>
                                    <td className="px-4 py-3 text-gray-400">{req.days_requested}d</td>
                                    <td className="px-4 py-3">
                                        <StatusBadge status={req.status} />
                                        {req.reviewer_note && (
                                            <p className="mt-1 max-w-[160px] truncate text-[11px] italic text-gray-500" title={req.reviewer_note}>
                                                “{req.reviewer_note}”
                                            </p>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        {req.status === LeaveStatus.PENDING && (
                                            <button
                                                onClick={() => handleCancel(req.id)}
                                                className="rounded-lg px-3 py-1 text-xs font-medium text-gray-400 transition hover:bg-white/10 hover:text-red-400"
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
    );

    const orgSummaryCards = loadingSummary ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[...Array(4)].map((_, i) => (
                <div key={i} className="h-32 animate-pulse rounded-2xl border border-white/10 bg-white/5 p-5" />
            ))}
        </div>
    ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Object.values(LeaveType).map((lt) => {
                const stats = summary[lt] || {};
                const total = Object.values(stats).reduce((a: number, b: number) => a + b, 0);
                return (
                    <div key={lt} className={`rounded-2xl border bg-gradient-to-br p-5 ${LEAVE_TYPE_COLORS[lt]}`}>
                        <div className="flex items-center justify-between">
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                                {LEAVE_TYPE_LABELS[lt]} Leave
                            </h3>
                            <span className="text-xs text-gray-500">{total} total</span>
                        </div>
                        <p className="mt-2 text-3xl font-bold text-white">{stats["pending"] || 0}</p>
                        <p className="text-xs text-gray-400">pending</p>
                        <div className="mt-3 flex gap-4 text-xs">
                            <span className="text-emerald-400">{stats["approved"] || 0} approved</span>
                            <span className="text-red-400">{stats["rejected"] || 0} rejected</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    // ── Render ──────────────────────────────────────────────────────────────

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold text-white">Leave Management</h1>
                    <p className="mt-1 text-sm text-gray-400">
                        {tab === "requests"
                            ? "Every leave request across the organisation."
                            : "Your balance, your requests, and what has happened to them."}
                    </p>
                </div>
                {tab === "mine" && hasProfile && (
                    <button
                        onClick={() => setShowModal(true)}
                        className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:from-indigo-600 hover:to-purple-700"
                    >
                        + New Request
                    </button>
                )}
            </div>

            {isAdmin && (
                <div role="tablist" className="inline-flex rounded-xl border border-white/10 bg-white/5 p-1">
                    {([
                        ["mine", "My Leave"],
                        ["requests", "Requests"],
                    ] as const).map(([key, label]) => (
                        <button
                            key={key}
                            role="tab"
                            aria-selected={tab === key}
                            onClick={() => setTab(key)}
                            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${tab === key ? "bg-indigo-500/20 text-indigo-300" : "text-gray-400 hover:text-gray-200"}`}
                        >
                            {label}
                            {key === "requests" && pendingApprovals.length > 0 && (
                                <span className="ml-2 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-400">
                                    {pendingApprovals.length}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            )}

            {tab === "mine" ? (
                !hasProfile ? (
                    <NoProfileNotice />
                ) : (
                    <>
                        <LeaveOverviewCards overview={overview} loading={loadingOverview} />

                        {/* A manager's queue for their direct reports. HR works it from the Requests tab. */}
                        {!isAdmin && approvalsTable}

                        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                            <div className="xl:col-span-2">{myRequestsTable}</div>
                            <LeaveActivityFeed scope="mine" title="My recent activity" refreshKey={activityKey} />
                        </div>
                    </>
                )
            ) : (
                <>
                    {orgSummaryCards}
                    {approvalsTable || (
                        !loadingApprovals && (
                            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-sm text-gray-500">
                                No requests waiting for approval. 🎉
                            </div>
                        )
                    )}
                    <LeaveActivityFeed scope="all" title="Recent activity — all employees" refreshKey={activityKey} />
                </>
            )}

            {showModal && hasProfile && (
                <LeaveRequestModal
                    balances={overview?.balances ?? []}
                    onClose={() => setShowModal(false)}
                    onSubmitted={handleSubmitted}
                />
            )}
        </div>
    );
}
