import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
    scheduleService,
    type ShiftChangeReview,
} from "@/services/scheduleService";
import { employeeService } from "@/services/employeeService";
import type { Employee } from "@/types/employee";
import {
    ScheduleStatus,
    ShiftChangeStatus,
    ShiftCode,
    type ShiftChangeItem,
    type ShiftChangeRequest,
    type WorkingDaysSummary,
    type WorkSchedule,
    type WorkScheduleDetail,
} from "@/types/schedule";
import RosterGrid, { type DayColumn } from "@/components/schedules/RosterGrid";
import CellEditor from "@/components/schedules/CellEditor";
import ShiftLegend from "@/components/schedules/ShiftLegend";
import ApprovalsPanel from "@/components/schedules/ApprovalsPanel";
import RosterPatternModal from "@/components/schedules/RosterPatternModal";
import { isoDate } from "@/lib/dates";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function errorMessage(err: unknown, fallback: string): string {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response
        ?.data?.detail;
    return typeof detail === "string" ? detail : fallback;
}

interface OpenCell {
    employeeId: string;
    iso: string;
    rect: DOMRect;
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function SchedulesPage() {
    const { user } = useAuth();
    const isAdmin = user?.is_superuser ?? false;

    const [schedules, setSchedules] = useState<WorkSchedule[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [detail, setDetail] = useState<WorkScheduleDetail | null>(null);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [inbox, setInbox] = useState<ShiftChangeRequest[]>([]);

    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");

    /**
     * Edits made in this sitting but not yet sent. A roster edit is a session,
     * so they collect here and go up as one proposal rather than one request
     * per day. `null` in the map means "clear this day".
     */
    const [staged, setStaged] = useState<Map<string, ShiftCode | null>>(new Map());
    const [proposalReason, setProposalReason] = useState("");

    const [openCell, setOpenCell] = useState<OpenCell | null>(null);
    const [showApprovals, setShowApprovals] = useState(false);
    const [showPattern, setShowPattern] = useState(false);
    const [showCreate, setShowCreate] = useState(false);
    const [newSchedule, setNewSchedule] = useState({ name: "", start: "", end: "" });

    const didAutoSelect = useRef(false);

    /* -------------------------------------------------------------- */
    /*  Which employee row belongs to the signed-in user               */
    /* -------------------------------------------------------------- */

    const myEmployeeId = useMemo(() => {
        if (!user) return null;
        const mine = employees.find(
            (e) => e.email.toLowerCase() === user.email.toLowerCase(),
        );
        return mine?.id ?? null;
    }, [employees, user]);

    /* -------------------------------------------------------------- */
    /*  Loaders                                                        */
    /* -------------------------------------------------------------- */

    const loadSchedules = useCallback(async () => {
        const res = await scheduleService.list({ page: 1, page_size: 100 });
        setSchedules(res.data.items);
        return res.data.items;
    }, []);

    const loadInbox = useCallback(async () => {
        try {
            const res = await scheduleService.listChangeRequests({
                status: ShiftChangeStatus.PENDING,
            });
            setInbox(res.data);
        } catch {
            // A user with no employee profile has no queue — not worth an error.
            setInbox([]);
        }
    }, []);

    const loadDetail = useCallback(async (id: string) => {
        const res = await scheduleService.get(id);
        setDetail(res.data);
    }, []);

    // Initial load: schedules + employees, then open the most recent month.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const [items, empRes] = await Promise.all([
                    loadSchedules(),
                    employeeService.list({ page: 1, page_size: 100 }),
                ]);
                if (cancelled) return;
                setEmployees(empRes.data.items.filter((e: Employee) => e.is_active));

                const newest = items[0];
                if (!didAutoSelect.current && newest) {
                    didAutoSelect.current = true;
                    // Prefer the month containing today, else the newest.
                    const today = isoDate(new Date());
                    const current = items.find(
                        (s) => s.start_date <= today && today <= s.end_date,
                    );
                    setSelectedId((current ?? newest).id);
                }
            } catch (err) {
                if (!cancelled) setError(errorMessage(err, "Failed to load schedules."));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadSchedules]);

    useEffect(() => {
        loadInbox();
    }, [loadInbox]);

    useEffect(() => {
        if (!selectedId) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await scheduleService.get(selectedId);
                if (!cancelled) setDetail(res.data);
            } catch (err) {
                if (!cancelled)
                    setError(errorMessage(err, "Failed to load this month's roster."));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selectedId]);

    /* -------------------------------------------------------------- */
    /*  Derived grid data                                              */
    /* -------------------------------------------------------------- */

    const days = useMemo<DayColumn[]>(() => {
        if (!detail) return [];
        const holidaysByDate = new Map(detail.holidays.map((h) => [h.date, h]));
        const out: DayColumn[] = [];
        const cursor = new Date(`${detail.start_date}T00:00:00`);
        const last = new Date(`${detail.end_date}T00:00:00`);
        while (cursor <= last) {
            const iso = isoDate(cursor);
            const weekday = cursor.getDay();
            out.push({
                iso,
                dayNumber: cursor.getDate(),
                dayName: DAY_NAMES[weekday] ?? "",
                isWeekend: weekday === 0 || weekday === 6,
                holiday: holidaysByDate.get(iso) ?? null,
            });
            cursor.setDate(cursor.getDate() + 1);
        }
        return out;
    }, [detail]);

    const codes = useMemo(() => {
        const map = new Map<string, ShiftCode>();
        detail?.assignments.forEach((a) =>
            map.set(`${a.employee_id}|${a.date}`, a.shift_code),
        );
        return map;
    }, [detail]);

    /** Flattened from the open proposals: every day still awaiting review. */
    const pending = useMemo(() => {
        const map = new Map<string, ShiftChangeItem>();
        detail?.pending_changes.forEach((proposal) =>
            proposal.items.forEach((item) => {
                if (item.status === ShiftChangeStatus.PENDING) {
                    map.set(`${item.employee_id}|${item.date}`, item);
                }
            }),
        );
        return map;
    }, [detail]);

    const totals = useMemo(() => {
        const map = new Map<string, WorkingDaysSummary>();
        detail?.working_days.forEach((w) => map.set(w.employee_id, w));
        return map;
    }, [detail]);

    // Employees who actually appear in this month's roster come first; the rest
    // still get a row so a superuser can fill them in.
    const orderedEmployees = useMemo(() => {
        if (!detail) return employees;
        const rostered = new Set(detail.assignments.map((a) => a.employee_id));
        return [...employees].sort((a, b) => {
            const diff = Number(rostered.has(b.id)) - Number(rostered.has(a.id));
            if (diff !== 0) return diff;
            return `${a.first_name} ${a.last_name}`.localeCompare(
                `${b.first_name} ${b.last_name}`,
            );
        });
    }, [employees, detail]);

    const monthHolidays = detail?.holidays ?? [];

    /**
     * What the staged edits would cost in annual leave, netted against any AL
     * day the same edit gives back. The backend is the authority; this only
     * warns before the user submits and gets turned down.
     */
    const stagedLeave = useMemo(() => {
        if (!myEmployeeId || staged.size === 0) return null;
        let net = 0;
        for (const [key, code] of staged) {
            const [employeeId, iso] = key.split("|") as [string, string];
            if (employeeId !== myEmployeeId) continue;
            if (code === ShiftCode.AL) net += 1;
            if (codes.get(`${employeeId}|${iso}`) === ShiftCode.AL) net -= 1;
        }
        const balance = totals.get(myEmployeeId)?.annual_leave_days ?? 0;
        return { net, remaining: balance - net };
    }, [staged, codes, totals, myEmployeeId]);

    /* -------------------------------------------------------------- */
    /*  Cell editing                                                   */
    /* -------------------------------------------------------------- */

    const isCellEditable = useCallback(
        (employeeId: string) => isAdmin || employeeId === myEmployeeId,
        [isAdmin, myEmployeeId],
    );

    const refreshAfterWrite = useCallback(async () => {
        if (selectedId) await loadDetail(selectedId);
        await loadInbox();
    }, [selectedId, loadDetail, loadInbox]);

    const applyCell = async (code: ShiftCode | null) => {
        if (!openCell || !selectedId) return;
        setBusy(true);
        setError("");
        try {
            await scheduleService.setCell(selectedId, {
                employee_id: openCell.employeeId,
                date: openCell.iso,
                shift_code: code,
            });
            setOpenCell(null);
            await refreshAfterWrite();
        } catch (err) {
            setError(errorMessage(err, "Failed to update that day."));
        } finally {
            setBusy(false);
        }
    };

    /* ---- staging (regular users) ---- */

    const stageCell = (code: ShiftCode | null) => {
        if (!openCell) return;
        const key = `${openCell.employeeId}|${openCell.iso}`;
        setStaged((prev) => new Map(prev).set(key, code));
    };

    const unstageCell = () => {
        if (!openCell) return;
        const key = `${openCell.employeeId}|${openCell.iso}`;
        setStaged((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
        });
    };

    const discardStaged = () => {
        setStaged(new Map());
        setProposalReason("");
    };

    /** Send the whole sitting as one proposal. */
    const submitProposal = async () => {
        if (!selectedId || staged.size === 0) return;
        setBusy(true);
        setError("");
        try {
            const items = [...staged.entries()].map(([key, code]) => {
                const [employee_id, date] = key.split("|") as [string, string];
                return { employee_id, date, requested_code: code };
            });
            const { data } = await scheduleService.proposeChange(selectedId, {
                items,
                reason: proposalReason.trim() || null,
            });
            discardStaged();
            setNotice(
                `Proposal sent: ${data.items.length} day` +
                `${data.items.length === 1 ? "" : "s"} awaiting approval.`,
            );
            await refreshAfterWrite();
        } catch (err) {
            setError(errorMessage(err, "Failed to send that proposal."));
        } finally {
            setBusy(false);
        }
    };

    /* ---- review (superusers) ---- */

    const withdrawChange = async (requestId: string) => {
        setBusyRequestId(requestId);
        setError("");
        try {
            await scheduleService.cancelChange(requestId);
            setOpenCell(null);
            await refreshAfterWrite();
        } catch (err) {
            setError(errorMessage(err, "Failed to withdraw that proposal."));
        } finally {
            setBusyRequestId(null);
        }
    };

    const reviewChange = async (requestId: string, review: ShiftChangeReview) => {
        setBusyRequestId(requestId);
        setError("");
        try {
            const { data } = await scheduleService.reviewChange(requestId, review);
            const approved = data.items.filter(
                (i) => i.status === ShiftChangeStatus.APPROVED,
            ).length;
            const rejected = data.items.filter(
                (i) => i.status === ShiftChangeStatus.REJECTED,
            ).length;
            setNotice(`Reviewed: ${approved} day(s) applied, ${rejected} rejected.`);
            await refreshAfterWrite();
        } catch (err) {
            setError(errorMessage(err, "Failed to review that proposal."));
        } finally {
            setBusyRequestId(null);
        }
    };

    /* -------------------------------------------------------------- */
    /*  Schedule-level actions                                         */
    /* -------------------------------------------------------------- */

    const togglePublish = async () => {
        if (!detail) return;
        setBusy(true);
        setError("");
        try {
            if (detail.status === ScheduleStatus.DRAFT)
                await scheduleService.publish(detail.id);
            else await scheduleService.unpublish(detail.id);
            await loadSchedules();
            await loadDetail(detail.id);
        } catch (err) {
            setError(errorMessage(err, "Failed to change the publish status."));
        } finally {
            setBusy(false);
        }
    };

    const createSchedule = async () => {
        const { name, start, end } = newSchedule;
        if (!name || !start || !end) return;
        setBusy(true);
        setError("");
        try {
            const res = await scheduleService.create({
                name,
                start_date: start,
                end_date: end,
            });
            setShowCreate(false);
            setNewSchedule({ name: "", start: "", end: "" });
            await loadSchedules();
            setSelectedId(res.data.id);
        } catch (err) {
            setError(errorMessage(err, "Failed to create that period."));
        } finally {
            setBusy(false);
        }
    };

    const deleteSchedule = async () => {
        if (!detail) return;
        if (!confirm(`Delete "${detail.name}" and all of its shifts?`)) return;
        setBusy(true);
        try {
            await scheduleService.delete(detail.id);
            const items = await loadSchedules();
            setSelectedId(items[0]?.id ?? null);
            setDetail(null);
        } catch (err) {
            setError(errorMessage(err, "Failed to delete that period."));
        } finally {
            setBusy(false);
        }
    };

    /* -------------------------------------------------------------- */
    /*  Month navigation                                               */
    /* -------------------------------------------------------------- */

    // Schedules arrive newest-first; oldest-first reads better in a month picker.
    const chronological = useMemo(
        () => [...schedules].sort((a, b) => a.start_date.localeCompare(b.start_date)),
        [schedules],
    );
    const currentIndex = chronological.findIndex((s) => s.id === selectedId);

    const step = (delta: number) => {
        const next = chronological[currentIndex + delta];
        if (next) {
            setOpenCell(null);
            discardStaged();
            setSelectedId(next.id);
        }
    };

    /* -------------------------------------------------------------- */
    /*  Render                                                         */
    /* -------------------------------------------------------------- */

    if (loading) {
        return (
            <div className="flex h-64 items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
            </div>
        );
    }

    const openCellKey = openCell ? `${openCell.employeeId}|${openCell.iso}` : null;
    const openCellEmployee = openCell
        ? employees.find((e) => e.id === openCell.employeeId)
        : undefined;

    return (
        <div className="space-y-5">
            {/* ---- Header ---- */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">
                        Employee absence schedule
                    </h1>
                    <p className="mt-1 text-sm text-gray-400">
                        {isAdmin
                            ? "Edit any cell, generate a default rotation, and approve requested changes."
                            : "Edit any day on your own row, then submit the lot as one proposal."}
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <button
                        onClick={() => setShowApprovals((v) => !v)}
                        className="relative rounded-xl border border-white/10 px-3.5 py-2 text-sm font-medium text-gray-300 transition hover:bg-white/5"
                    >
                        {isAdmin ? "Approvals" : "My requests"}
                        {inbox.length > 0 && (
                            <span className="ml-2 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-amber-400">
                                {inbox.length}
                            </span>
                        )}
                    </button>
                    {isAdmin && (
                        <>
                            <button
                                onClick={() => setShowPattern(true)}
                                className="rounded-xl border border-white/10 px-3.5 py-2 text-sm font-medium text-gray-300 transition hover:bg-white/5"
                            >
                                Default roster
                            </button>
                            <button
                                onClick={() => setShowCreate(true)}
                                className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:shadow-indigo-500/40"
                            >
                                + New period
                            </button>
                        </>
                    )}
                </div>
            </div>

            {error && (
                <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                    <span>{error}</span>
                    <button onClick={() => setError("")} className="text-red-300">
                        ✕
                    </button>
                </div>
            )}
            {notice && (
                <div className="flex items-start justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">
                    <span>{notice}</span>
                    <button onClick={() => setNotice("")} className="text-emerald-300">
                        ✕
                    </button>
                </div>
            )}

            {showApprovals && (
                <ApprovalsPanel
                    requests={inbox}
                    canReview={isAdmin}
                    busyId={busyRequestId}
                    onReview={reviewChange}
                    onWithdraw={withdrawChange}
                    onClose={() => setShowApprovals(false)}
                />
            )}

            {/* ---- Calendar ---- */}
            {schedules.length === 0 ? (
                <p className="rounded-2xl border border-white/10 bg-gray-900/50 px-5 py-10 text-center text-sm text-gray-500">
                    {isAdmin
                        ? "No schedule periods yet. Create one, or generate a default roster."
                        : "No published schedules available."}
                </p>
            ) : (
                <div className="rounded-2xl border border-white/10 bg-gray-900/50 backdrop-blur-xl">
                    {/* Month bar */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => step(-1)}
                                disabled={currentIndex <= 0}
                                className="rounded-lg border border-white/10 px-2.5 py-1.5 text-sm text-gray-300 transition hover:bg-white/5 disabled:opacity-30"
                                title="Previous month"
                            >
                                ‹
                            </button>
                            <select
                                value={selectedId ?? ""}
                                onChange={(e) => {
                                    setOpenCell(null);
                                    discardStaged();
                                    setSelectedId(e.target.value);
                                }}
                                className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-semibold text-white focus:border-indigo-500 focus:outline-none"
                            >
                                {chronological.map((s) => (
                                    <option key={s.id} value={s.id} className="bg-gray-900">
                                        {s.name}
                                    </option>
                                ))}
                            </select>
                            <button
                                onClick={() => step(1)}
                                disabled={
                                    currentIndex < 0 || currentIndex >= chronological.length - 1
                                }
                                className="rounded-lg border border-white/10 px-2.5 py-1.5 text-sm text-gray-300 transition hover:bg-white/5 disabled:opacity-30"
                                title="Next month"
                            >
                                ›
                            </button>

                            {detail && (
                                <span
                                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${detail.status === ScheduleStatus.PUBLISHED
                                        ? "bg-emerald-500/20 text-emerald-400"
                                        : "bg-amber-500/20 text-amber-400"
                                        }`}
                                >
                                    {detail.status === ScheduleStatus.PUBLISHED
                                        ? "Published"
                                        : "Draft"}
                                </span>
                            )}
                        </div>

                        {isAdmin && detail && (
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={togglePublish}
                                    disabled={busy}
                                    className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-white/5 disabled:opacity-50"
                                >
                                    {detail.status === ScheduleStatus.PUBLISHED
                                        ? "Unpublish"
                                        : "Publish"}
                                </button>
                                <button
                                    onClick={deleteSchedule}
                                    disabled={busy}
                                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition hover:bg-red-500/20 hover:text-red-400 disabled:opacity-50"
                                >
                                    Delete
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Legend */}
                    <div className="border-b border-white/10 px-5 py-3">
                        <ShiftLegend />
                    </div>

                    {/* Grid */}
                    {detail ? (
                        <div className="p-3">
                            <RosterGrid
                                employees={orderedEmployees}
                                days={days}
                                codes={codes}
                                pending={pending}
                                staged={staged}
                                totals={totals}
                                isCellEditable={isCellEditable}
                                activeCell={openCellKey}
                                onCellClick={(employeeId, iso, rect) => {
                                    if (!isCellEditable(employeeId)) {
                                        setOpenCell(null);
                                        return;
                                    }
                                    setOpenCell({ employeeId, iso, rect });
                                }}
                            />
                        </div>
                    ) : (
                        <div className="flex h-40 items-center justify-center">
                            <div className="h-6 w-6 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
                        </div>
                    )}

                    {/* Public holidays in this month */}
                    {monthHolidays.length > 0 && (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/10 px-5 py-3">
                            <span className="text-xs font-semibold text-gray-400">
                                Public holidays
                            </span>
                            {monthHolidays.map((h) => (
                                <span key={h.id} className="text-[11px] text-gray-400">
                                    <span
                                        className={`mr-1 inline-block h-2 w-2 rounded-full ${h.is_national ? "bg-emerald-500" : "bg-emerald-500/40"
                                            }`}
                                    />
                                    {new Date(`${h.date}T00:00:00`).getDate()} — {h.name}
                                    {!h.is_national && (
                                        <span className="text-gray-600"> (cuti bersama)</span>
                                    )}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ---- Staged edits: submit the sitting as one proposal ---- */}
            {staged.size > 0 && (
                <div className="sticky bottom-4 z-30 flex flex-wrap items-center gap-3 rounded-2xl border border-indigo-400/40 bg-gray-900/95 px-5 py-3 shadow-2xl shadow-black/50 backdrop-blur-xl">
                    <span className="text-sm font-semibold text-white">
                        {staged.size} day{staged.size === 1 ? "" : "s"} edited
                    </span>
                    <span className="hidden text-[11px] text-gray-500 sm:inline">
                        Sent as a single proposal for approval
                    </span>
                    {stagedLeave !== null && (
                        <span
                            className={`text-[11px] font-medium ${stagedLeave.remaining < 0
                                ? "text-red-400"
                                : "text-gray-400"
                                }`}
                            title="Annual leave this proposal would use, against the balance"
                        >
                            {stagedLeave.net > 0
                                ? `${stagedLeave.net} leave day${stagedLeave.net === 1 ? "" : "s"}, `
                                : ""}
                            {stagedLeave.remaining < 0
                                ? `${Math.abs(stagedLeave.remaining).toFixed(1)} over your balance - ask a superuser`
                                : `${stagedLeave.remaining.toFixed(1)} left`}
                        </span>
                    )}

                    <input
                        value={proposalReason}
                        onChange={(e) => setProposalReason(e.target.value)}
                        placeholder="Reason (optional)"
                        maxLength={500}
                        className="min-w-[10rem] flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                    />

                    <button
                        onClick={discardStaged}
                        disabled={busy}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-white/5 disabled:opacity-50"
                    >
                        Discard
                    </button>
                    <button
                        onClick={submitProposal}
                        disabled={busy}
                        className="rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:shadow-indigo-500/40 disabled:opacity-50"
                    >
                        {busy ? "Sending..." : "Submit for approval"}
                    </button>
                </div>
            )}

            {/* ---- Cell editor ---- */}
            {openCell && openCellEmployee && (
                <CellEditor
                    anchor={openCell.rect}
                    employeeName={`${openCellEmployee.first_name} ${openCellEmployee.last_name}`}
                    date={openCell.iso}
                    currentCode={codes.get(openCellKey!) ?? null}
                    pending={pending.get(openCellKey!) ?? null}
                    staged={
                        staged.has(openCellKey!)
                            ? staged.get(openCellKey!) ?? null
                            : undefined
                    }
                    canApplyDirectly={isAdmin}
                    canEdit={isCellEditable(openCell.employeeId)}
                    busy={busy}
                    onApply={applyCell}
                    onStage={stageCell}
                    onUnstage={unstageCell}
                    onClose={() => setOpenCell(null)}
                />
            )}

            {/* ---- Default roster ---- */}
            {showPattern && (
                <RosterPatternModal
                    employees={employees}
                    defaultStart={detail?.start_date ?? isoDate(new Date())}
                    onClose={() => setShowPattern(false)}
                    onApplied={async (result) => {
                        setShowPattern(false);
                        setNotice(
                            `Rotation applied: ${result.cells_written} days written across ` +
                            `${result.schedules_touched} month(s)` +
                            (result.cells_skipped
                                ? `, ${result.cells_skipped} left as they were.`
                                : "."),
                        );
                        await loadSchedules();
                        if (selectedId) await loadDetail(selectedId);
                    }}
                />
            )}

            {/* ---- New period ---- */}
            {showCreate && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-gray-900 p-6 shadow-2xl">
                        <h2 className="mb-4 text-lg font-bold text-white">
                            New schedule period
                        </h2>
                        <div className="space-y-3">
                            <div>
                                <label className="mb-1 block text-xs font-medium text-gray-400">
                                    Name
                                </label>
                                <input
                                    value={newSchedule.name}
                                    onChange={(e) =>
                                        setNewSchedule((p) => ({ ...p, name: e.target.value }))
                                    }
                                    placeholder="January 2027"
                                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="mb-1 block text-xs font-medium text-gray-400">
                                        Starts
                                    </label>
                                    <input
                                        type="date"
                                        value={newSchedule.start}
                                        onChange={(e) =>
                                            setNewSchedule((p) => ({ ...p, start: e.target.value }))
                                        }
                                        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1 block text-xs font-medium text-gray-400">
                                        Ends
                                    </label>
                                    <input
                                        type="date"
                                        value={newSchedule.end}
                                        min={newSchedule.start}
                                        onChange={(e) =>
                                            setNewSchedule((p) => ({ ...p, end: e.target.value }))
                                        }
                                        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end gap-2">
                            <button
                                onClick={() => setShowCreate(false)}
                                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-gray-300 transition hover:bg-white/5"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={createSchedule}
                                disabled={busy}
                                className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50"
                            >
                                Create
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
