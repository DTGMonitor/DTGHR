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
    [LeaveType.STUDY]: "Study",
    [LeaveType.MATERNITY]: "Maternity",
    [LeaveType.PATERNITY]: "Paternity",
    [LeaveType.MISCARRIAGE]: "Miscarriage",
    [LeaveType.MENSTRUAL]: "Menstrual",
    [LeaveType.MARRIAGE]: "Marriage",
    [LeaveType.CHILD_MARRIAGE]: "Child's marriage",
    [LeaveType.CHILD_CEREMONY]: "Child's ceremony",
    [LeaveType.BEREAVEMENT]: "Bereavement",
    [LeaveType.BEREAVEMENT_HOUSEHOLD]: "Bereavement (household)",
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
    [LeaveType.STUDY]: { rule: "border-l-gold", bar: "bg-gold" },
    // The handbook's categories share one accent each per group: they are
    // occasional and statutory, and giving each its own colour would put
    // eleven competing washes in a list that is usually three rows long.
    [LeaveType.MATERNITY]: { rule: "border-l-teal-200", bar: "bg-teal-200" },
    [LeaveType.PATERNITY]: { rule: "border-l-teal-200", bar: "bg-teal-200" },
    [LeaveType.MISCARRIAGE]: { rule: "border-l-teal-200", bar: "bg-teal-200" },
    [LeaveType.MENSTRUAL]: { rule: "border-l-teal-200", bar: "bg-teal-200" },
    [LeaveType.MARRIAGE]: { rule: "border-l-white/30", bar: "bg-white/40" },
    [LeaveType.CHILD_MARRIAGE]: { rule: "border-l-white/30", bar: "bg-white/40" },
    [LeaveType.CHILD_CEREMONY]: { rule: "border-l-white/30", bar: "bg-white/40" },
    [LeaveType.BEREAVEMENT]: { rule: "border-l-white/30", bar: "bg-white/40" },
    [LeaveType.BEREAVEMENT_HOUSEHOLD]: { rule: "border-l-white/30", bar: "bg-white/40" },
};

/*
 * Four cards, not one per kind of leave.
 *
 * Adding the handbook's family and special categories turned this row into
 * twelve cards of zeros — Nurhuda: "buset kebanyakan, bisa ga dipermudah
 * grouping gt". The three everyday kinds earn a card each because they are
 * what the queue is actually made of; the statutory ones are occasional and
 * rarely more than one at a time, so they share a card and name themselves
 * only when somebody has asked for one.
 */
const SUMMARY_CARDS: { title: string; types: LeaveType[]; rule: string }[] = [
    { title: "Annual", types: [LeaveType.ANNUAL], rule: "border-l-teal-300" },
    { title: "Sick", types: [LeaveType.SICK], rule: "border-l-danger" },
    { title: "Study", types: [LeaveType.STUDY], rule: "border-l-gold" },
    {
        title: "Family and special",
        types: [
            LeaveType.MATERNITY,
            LeaveType.PATERNITY,
            LeaveType.MISCARRIAGE,
            LeaveType.MENSTRUAL,
            LeaveType.MARRIAGE,
            LeaveType.CHILD_MARRIAGE,
            LeaveType.CHILD_CEREMONY,
            LeaveType.BEREAVEMENT,
            LeaveType.BEREAVEMENT_HOUSEHOLD,
        ],
        rule: "border-l-teal-200",
    },
];

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

/** "22 September 2026" */
function longDate(iso: string): string {
    return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

/*
 * One entitlement, read on two dates.
 *
 * The page showed four cards — annual, sick, personal and unpaid — of which
 * three were invented: a flat ten days of sick leave nobody had agreed and
 * five of personal leave that does not exist here. DTG grants an entitlement
 * for annual leave and nothing else. Sick and discretionary leave still
 * happen, and are recorded on the roster as they are taken, but there is no
 * balance to draw them down from and so nothing to put a bar under.
 *
 * The annual figure then needed a date against it. Nurhuda: "4.97 is December
 * — right now in September it is 11.97." Both matter, so both are here: what
 * you can book against today, and what the year closes on once the bookings
 * already in the system have happened.
 */
function BalanceCard({ balance }: { balance: LeaveBalance }) {
    const style = LEAVE_TYPE_STYLES[balance.leave_type];
    const hasNow = balance.remaining_now !== null && balance.remaining_now !== undefined;
    const headline = hasNow ? balance.remaining_now! : balance.remaining_days;
    const entitlement = hasNow ? balance.accrued_now! : balance.total_days;
    const used = hasNow ? balance.used_now! : balance.used_days;
    const pct = entitlement > 0 ? Math.min(100, (used / entitlement) * 100) : 0;

    return (
        <div
            className={`rounded-2xl border border-white/10 border-l-2 bg-surface p-5 transition-colors hover:bg-surface-raised ${style.rule}`}
        >
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="dtg-eyebrow text-paper-soft">
                        {LEAVE_TYPE_LABELS[balance.leave_type]} leave
                    </p>
                    <p className="mt-3 font-mono text-3xl font-semibold leading-none tracking-tight text-paper">
                        {headline.toFixed(2)}
                    </p>
                    <p className="mt-1.5 text-xs text-muted">
                        days remaining
                        {balance.as_at && (
                            <span className="text-paper-soft">
                                {" "}
                                · at {longDate(balance.as_at)}
                            </span>
                        )}
                    </p>
                </div>

                {/* How the figure is arrived at, rather than a bare total. The
                    opening balance is the part nobody can reconstruct from the
                    roster, so it is named. */}
                <div className="flex-shrink-0 text-right font-mono text-micro text-muted">
                    <p>
                        <span className="text-paper-soft">{entitlement.toFixed(2)}</span> accrued
                        since joining
                    </p>
                    <p className="mt-0.5">
                        <span className="text-paper-soft">{used}</span> taken
                    </p>
                </div>
            </div>

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

            {/* Where the year lands, if the two differ. In December they are
                the same figure and repeating it would be noise. */}
            {hasNow && balance.year_end && balance.remaining_days !== balance.remaining_now && (
                <p className="mt-3 border-t border-white/[0.06] pt-3 text-xs text-muted">
                    <span className="font-mono text-paper-soft">
                        {balance.remaining_days.toFixed(2)}
                    </span>{" "}
                    at {longDate(balance.year_end)}, with{" "}
                    <span className="font-mono">{balance.total_days.toFixed(2)}</span> accrued and{" "}
                    <span className="font-mono">{balance.used_days}</span> booked.
                </p>
            )}
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LeavesPage() {
    const { user } = useAuth();

    /*
     * Two questions, not one.
     *
     * The page split on is_superuser: you got the approver's view or the
     * employee's, never both. Wrong at both ends. Nurhuda approves everybody's
     * leave *and* books her own -- hers goes to Peter or Mark -- so she needs
     * the queue and a balance. Mark is management but not an administrator, so
     * he got the employee's view with no queue at all, while being one of the
     * two people expected to approve from it.
     *
     * Can this person approve? Does this person book leave? Independent, and
     * every combination occurs here.
     */
    const isAdmin = !!user?.is_superuser;
    const canApprove = isAdmin || !!user?.is_management;

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
        if (!canApprove) { setLoadingSummary(false); return; }
        try {
            const res = await leaveService.getSummary();
            setSummary(res.data);
        } catch {
            // ignore
        } finally {
            setLoadingSummary(false);
        }
    }, [canApprove]);

    /* Everybody loads all four: an approver who also books leave needs both
       halves, and the endpoints answer harmlessly for somebody who has only
       one. Deciding up front which half to fetch is what produced a page that
       could not show both. */
    useEffect(() => {
        fetchBalances();
        fetchRequests();
        fetchApprovals();
        if (canApprove) fetchSummary();
    }, [canApprove, fetchBalances, fetchRequests, fetchApprovals, fetchSummary]);

    /*
     * Whether this person books leave at all.
     *
     * Read off the balances the API returns rather than inferred from the
     * session: founders get an empty list, because they carry no entitlement,
     * and the server refuses their requests outright. Deriving it here from
     * is_management would catch Nurhuda too, and she very much does book
     * leave.
     */
    const hasOwnLeave = !loadingBalances && balances.length > 0;

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
    if (!canApprove && !loadingBalances && noEmployeeProfile) {
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
                        {canApprove && hasOwnLeave
                            ? "Approve the team's leave, and book your own."
                            : canApprove
                              ? "Approve and review the team's leave."
                              : "Submit, track, and manage leave requests."}
                    </p>
                </div>
                {hasOwnLeave && (
                    <button
                        onClick={() => setShowModal(true)}
                        className="rounded-xl bg-signal px-4 py-2 text-sm font-semibold text-paper transition-all hover:bg-signal-hover"
                    >
                        + New Request
                    </button>
                )}
            </div>

            {/* Summary, for whoever approves */}
            {canApprove && (
                loadingSummary ? (
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                        {[...Array(4)].map((_, i) => (
                            <div key={i} className="animate-pulse rounded-2xl border border-white/10 bg-white/5 p-5 h-32" />
                        ))}
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                        {SUMMARY_CARDS.map((card) => {
                            const tally = (status: string) =>
                                card.types.reduce(
                                    (n, lt) => n + ((summary[lt] || {})[status] || 0),
                                    0,
                                );
                            const total = card.types.reduce(
                                (n, lt) =>
                                    n +
                                    Object.values(summary[lt] || {}).reduce(
                                        (a: number, b: number) => a + b,
                                        0,
                                    ),
                                0,
                            );
                            const pending = tally("pending");
                            // Which of the grouped kinds actually happened. Named
                            // rather than left as a number, because "3 requests"
                            // under a heading covering nine categories says
                            // nothing about what anybody asked for.
                            const seen = card.types.filter(
                                (lt) => Object.values(summary[lt] || {}).some((n) => n > 0),
                            );
                            return (
                                <div
                                    key={card.title}
                                    className={`rounded-2xl border border-white/10 border-l-2 bg-surface p-5 transition-colors hover:bg-surface-raised ${card.rule}`}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <h3 className="dtg-eyebrow text-paper-soft">{card.title}</h3>
                                        <span className="flex-shrink-0 font-mono text-micro text-muted">
                                            {total} total
                                        </span>
                                    </div>
                                    <p className="mt-3 font-mono text-3xl font-semibold leading-none tracking-tight text-paper">
                                        {pending}
                                    </p>
                                    <p className="mt-1.5 text-xs text-muted">
                                        pending
                                        {card.types.length > 1 && seen.length > 0 && (
                                            <span className="text-muted">
                                                {" · "}
                                                {seen.map((lt) => LEAVE_TYPE_LABELS[lt]).join(", ")}
                                            </span>
                                        )}
                                    </p>
                                    <div className="mt-3 flex gap-4 border-t border-white/[0.08] pt-3 font-mono text-micro">
                                        <span className="text-signal">{tally("approved")} approved</span>
                                        <span className="text-danger">{tally("rejected")} rejected</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )
            )}

            {/* Employee Balance Cards */}
            {(hasOwnLeave || loadingBalances) && (loadingBalances ? (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    {[...Array(4)].map((_, i) => (
                        <div key={i} className="animate-pulse rounded-2xl border border-white/10 bg-white/5 p-5 h-32" />
                    ))}
                </div>
            ) : balances.length > 0 ? (
                <div className="grid grid-cols-1 gap-4 lg:max-w-2xl">
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
            {hasOwnLeave && (
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
            {hasOwnLeave && showModal && (
                <LeaveRequestModal
                    balances={balances}
                    onClose={() => setShowModal(false)}
                    onSubmitted={handleSubmitted}
                />
            )}
        </div>
    );
}
