import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { scheduleService } from "@/services/scheduleService";
import { employeeService } from "@/services/employeeService";
import type { Employee } from "@/types/employee";
import {
    ScheduleStatus,
    ShiftCode,
    SHIFT_COLORS,
    type WorkSchedule,
    type WorkScheduleDetail,
    type ShiftAssignment,
    type LeaveOverlay,
} from "@/types/schedule";
import type { ShiftAssignmentInput } from "@/services/scheduleService";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function datesInRange(start: string, end: string): string[] {
    const dates: string[] = [];
    const d = new Date(start);
    const last = new Date(end);
    while (d <= last) {
        dates.push(d.toISOString().slice(0, 10));
        d.setDate(d.getDate() + 1);
    }
    return dates;
}

function formatDay(iso: string) {
    const d = new Date(iso);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return { dayNum: d.getDate(), dayName: days[d.getDay()], isWeekend: d.getDay() === 0 || d.getDay() === 6 };
}

const SHIFT_CODES = Object.values(ShiftCode);

/** Build a set of "empId|date" keys from leave overlays for O(1) lookup. */
function buildLeaveMap(leaves: LeaveOverlay[], scheduleDates: string[]) {
    const map = new Map<string, string>(); // key → leave_type abbreviation
    for (const l of leaves) {
        const lStart = new Date(l.start_date);
        const lEnd = new Date(l.end_date);
        for (const d of scheduleDates) {
            const cur = new Date(d);
            if (cur >= lStart && cur <= lEnd) {
                // Map leave_type to short code
                let code = l.leave_type.toUpperCase();
                if (code === "ANNUAL") code = "AL";
                else if (code === "SICK") code = "SL";
                else if (code === "PERSONAL") code = "PL";
                else if (code === "UNPAID") code = "UL";
                map.set(`${l.employee_id}|${d}`, code);
            }
        }
    }
    return map;
}

const LEAVE_COLORS: Record<string, { bg: string; text: string }> = {
    AL: { bg: "bg-rose-500/30", text: "text-rose-300" },
    SL: { bg: "bg-orange-500/30", text: "text-orange-300" },
    PL: { bg: "bg-pink-500/30", text: "text-pink-300" },
    UL: { bg: "bg-gray-500/30", text: "text-gray-400" },
};

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function SchedulesPage() {
    const { user } = useAuth();
    const isAdmin = user?.is_superuser ?? false;

    /* ---- list state ---- */
    const [schedules, setSchedules] = useState<WorkSchedule[]>([]);
    const [loading, setLoading] = useState(true);

    /* ---- detail / grid state ---- */
    const [selected, setSelected] = useState<WorkScheduleDetail | null>(null);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [grid, setGrid] = useState<Record<string, ShiftCode | null>>({});
    const [saving, setSaving] = useState(false);

    /* ---- paint mode ---- */
    const [activeBrush, setActiveBrush] = useState<ShiftCode | "eraser" | null>(null);

    /* ---- create modal state ---- */
    const [showCreate, setShowCreate] = useState(false);
    const [newName, setNewName] = useState("");
    const [newStart, setNewStart] = useState("");
    const [newEnd, setNewEnd] = useState("");

    /* ---- error ---- */
    const [error, setError] = useState("");

    /* ============================================================== */
    /*  Fetch list                                                    */
    /* ============================================================== */

    const loadSchedules = useCallback(async () => {
        setLoading(true);
        try {
            const res = await scheduleService.list({ page: 1, page_size: 100 });
            setSchedules(res.data.items);
        } catch {
            setError("Failed to load schedules");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadSchedules(); }, [loadSchedules]);

    /* ============================================================== */
    /*  Select a schedule → load detail + employees                  */
    /* ============================================================== */

    const openSchedule = useCallback(async (id: string) => {
        setError("");
        try {
            const [schedRes, empRes] = await Promise.all([
                scheduleService.get(id),
                isAdmin
                    ? employeeService.list({ page: 1, page_size: 100 })
                    : Promise.resolve(null),
            ]);
            setSelected(schedRes.data);

            const emps: Employee[] = empRes
                ? empRes.data.items.filter((e: Employee) => e.is_active)
                : [];
            setEmployees(emps);

            // Build grid map: "empId|date" → ShiftCode
            const g: Record<string, ShiftCode | null> = {};
            schedRes.data.assignments.forEach((a: ShiftAssignment) => {
                g[`${a.employee_id}|${a.date}`] = a.shift_code;
            });
            setGrid(g);
        } catch {
            setError("Failed to load schedule details");
        }
    }, [isAdmin]);

    /* ============================================================== */
    /*  Dates for selected schedule                                  */
    /* ============================================================== */

    const dates = useMemo(() => {
        if (!selected) return [];
        return datesInRange(selected.start_date, selected.end_date);
    }, [selected]);

    /* ============================================================== */
    /*  Leave overlay map                                             */
    /* ============================================================== */

    const leaveMap = useMemo(() => {
        if (!selected) return new Map<string, string>();
        return buildLeaveMap(selected.leaves ?? [], dates);
    }, [selected, dates]);

    /* ============================================================== */
    /*  Grid cell click — paint mode                                 */
    /* ============================================================== */

    const paintCell = (empId: string, date: string) => {
        if (!isAdmin || selected?.status !== ScheduleStatus.DRAFT) return;

        const key = `${empId}|${date}`;

        // Don't allow painting over leave cells
        if (leaveMap.has(key)) return;

        if (activeBrush === null) return; // no brush selected — do nothing

        if (activeBrush === "eraser") {
            setGrid((prev) => ({ ...prev, [key]: null }));
        } else {
            setGrid((prev) => ({ ...prev, [key]: activeBrush }));
        }
    };

    /* ============================================================== */
    /*  Save assignments                                             */
    /* ============================================================== */

    const saveAssignments = async () => {
        if (!selected) return;
        setSaving(true);
        setError("");
        try {
            const assignments: ShiftAssignmentInput[] = [];
            for (const [key, code] of Object.entries(grid)) {
                if (!code) continue;
                const [empId, date] = key.split("|") as [string, string];
                assignments.push({ employee_id: empId, date, shift_code: code });
            }
            const res = await scheduleService.saveAssignments(selected.id, assignments);
            setSelected(res.data);
        } catch {
            setError("Failed to save assignments");
        } finally {
            setSaving(false);
        }
    };

    /* ============================================================== */
    /*  Publish / unpublish (auto-save before publish)               */
    /* ============================================================== */

    const togglePublish = async () => {
        if (!selected) return;
        setSaving(true);
        setError("");
        try {
            if (selected.status === ScheduleStatus.DRAFT) {
                // AUTO-SAVE before publishing
                const assignments: ShiftAssignmentInput[] = [];
                for (const [key, code] of Object.entries(grid)) {
                    if (!code) continue;
                    const [empId, date] = key.split("|") as [string, string];
                    assignments.push({ employee_id: empId, date, shift_code: code });
                }
                await scheduleService.saveAssignments(selected.id, assignments);
                await scheduleService.publish(selected.id);
            } else {
                await scheduleService.unpublish(selected.id);
            }
            await loadSchedules();
            await openSchedule(selected.id);
        } catch {
            setError("Failed to update schedule status");
        } finally {
            setSaving(false);
        }
    };

    /* ============================================================== */
    /*  Create schedule                                              */
    /* ============================================================== */

    const createSchedule = async () => {
        if (!newName || !newStart || !newEnd) return;
        setError("");
        try {
            const res = await scheduleService.create({
                name: newName,
                start_date: newStart,
                end_date: newEnd,
            });
            setShowCreate(false);
            setNewName("");
            setNewStart("");
            setNewEnd("");
            await loadSchedules();
            await openSchedule(res.data.id);
        } catch {
            setError("Failed to create schedule");
        }
    };

    /* ============================================================== */
    /*  Delete schedule                                              */
    /* ============================================================== */

    const deleteSchedule = async (id: string) => {
        if (!confirm("Delete this schedule and all its assignments?")) return;
        try {
            await scheduleService.delete(id);
            if (selected?.id === id) setSelected(null);
            await loadSchedules();
        } catch {
            setError("Failed to delete schedule");
        }
    };

    /* ============================================================== */
    /*  Render                                                       */
    /* ============================================================== */

    if (loading) {
        return (
            <div className="flex h-64 items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">Work Schedules</h1>
                    <p className="mt-1 text-sm text-gray-400">
                        {isAdmin ? "Create, edit and publish monthly shift rosters" : "View your published shift schedule"}
                    </p>
                </div>
                {isAdmin && (
                    <button
                        id="create-schedule-btn"
                        onClick={() => setShowCreate(true)}
                        className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:shadow-indigo-500/40"
                    >
                        + New Schedule
                    </button>
                )}
            </div>

            {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                    {error}
                </div>
            )}

            {/* ---- Schedule List ---- */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {schedules.map((s) => (
                    <div
                        key={s.id}
                        onClick={() => openSchedule(s.id)}
                        className={`group relative cursor-pointer rounded-2xl border p-4 text-left transition-all duration-200 hover:shadow-lg ${selected?.id === s.id
                            ? "border-indigo-500/50 bg-indigo-500/10 shadow-lg shadow-indigo-500/10"
                            : "border-white/10 bg-gray-900/50 hover:border-white/20 hover:bg-gray-900/80"
                            }`}
                    >
                        <div className="flex items-start justify-between">
                            <h3 className="font-semibold text-white">{s.name}</h3>
                            <span
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.status === ScheduleStatus.PUBLISHED
                                    ? "bg-emerald-500/20 text-emerald-400"
                                    : "bg-amber-500/20 text-amber-400"
                                    }`}
                            >
                                {s.status === ScheduleStatus.PUBLISHED ? "Published" : "Draft"}
                            </span>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                            {s.start_date} → {s.end_date}
                        </p>
                        {isAdmin && (
                            <button
                                onClick={(e) => { e.stopPropagation(); deleteSchedule(s.id); }}
                                className="absolute right-2 top-2 hidden rounded-lg p-1 text-gray-500 hover:bg-red-500/20 hover:text-red-400 group-hover:block"
                                title="Delete"
                            >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                                </svg>
                            </button>
                        )}
                    </div>
                ))}
                {schedules.length === 0 && (
                    <p className="col-span-full text-center text-sm text-gray-500 py-8">
                        {isAdmin ? "No schedules yet. Create one to get started!" : "No published schedules available."}
                    </p>
                )}
            </div>

            {/* ---- Schedule Grid ---- */}
            {selected && (
                <div className="rounded-2xl border border-white/10 bg-gray-900/50 backdrop-blur-xl">
                    {/* Grid header */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
                        <div>
                            <h2 className="text-lg font-bold text-white">{selected.name}</h2>
                            <p className="text-xs text-gray-500">{selected.start_date} → {selected.end_date}</p>
                        </div>
                        <div className="flex items-center gap-2">
                            {/* Shift code legend */}
                            <div className="mr-2 flex flex-wrap gap-1.5">
                                {SHIFT_CODES.map((code) => (
                                    <span
                                        key={code}
                                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${SHIFT_COLORS[code].bg} ${SHIFT_COLORS[code].text}`}
                                        title={SHIFT_COLORS[code].label}
                                    >
                                        {code}
                                    </span>
                                ))}
                                {/* Leave legend */}
                                {Object.entries(LEAVE_COLORS).map(([code, c]) => (
                                    <span
                                        key={code}
                                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${c.bg} ${c.text}`}
                                        title={`${code} (Leave)`}
                                    >
                                        {code}
                                    </span>
                                ))}
                            </div>
                            {isAdmin && selected.status === ScheduleStatus.DRAFT && (
                                <button
                                    onClick={saveAssignments}
                                    disabled={saving}
                                    className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20 disabled:opacity-50"
                                >
                                    {saving ? "Saving…" : "Save Draft"}
                                </button>
                            )}
                            {isAdmin && (
                                <button
                                    onClick={togglePublish}
                                    disabled={saving}
                                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${selected.status === ScheduleStatus.DRAFT
                                        ? "bg-emerald-500 text-white hover:bg-emerald-600"
                                        : "bg-amber-500 text-white hover:bg-amber-600"
                                        }`}
                                >
                                    {saving
                                        ? "Processing…"
                                        : selected.status === ScheduleStatus.DRAFT
                                            ? "Save & Publish"
                                            : "Unpublish"}
                                </button>
                            )}
                        </div>
                    </div>

                    {/* ---- Paint Mode Toolbar (admin + draft only) ---- */}
                    {isAdmin && selected.status === ScheduleStatus.DRAFT && (
                        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-white/10 bg-gray-900/95 backdrop-blur px-5 py-3">
                            <span className="mr-1 text-xs font-medium text-gray-400">🎨 Paint:</span>
                            {SHIFT_CODES.map((code) => (
                                <button
                                    key={code}
                                    onClick={() => setActiveBrush(activeBrush === code ? null : code)}
                                    className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition-all ${activeBrush === code
                                        ? `${SHIFT_COLORS[code].bg} ${SHIFT_COLORS[code].text} ring-2 ring-white/50 shadow-lg scale-110`
                                        : `${SHIFT_COLORS[code].bg} ${SHIFT_COLORS[code].text} opacity-60 hover:opacity-100`
                                        }`}
                                    title={SHIFT_COLORS[code].label}
                                >
                                    {code}
                                </button>
                            ))}
                            <div className="mx-1 h-5 w-px bg-white/20" />
                            <button
                                onClick={() => setActiveBrush(activeBrush === "eraser" ? null : "eraser")}
                                className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition-all ${activeBrush === "eraser"
                                    ? "bg-red-500/80 text-white ring-2 ring-white/50 shadow-lg scale-110"
                                    : "bg-red-500/30 text-red-300 opacity-60 hover:opacity-100"
                                    }`}
                                title="Eraser — click cells to clear them"
                            >
                                ✕ Clear
                            </button>
                            {activeBrush && (
                                <span className="ml-2 text-[11px] text-gray-500">
                                    Click cells to apply • Click active brush again to deselect
                                </span>
                            )}
                        </div>
                    )}

                    {/* The grid table */}
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-xs">
                            <thead>
                                <tr>
                                    <th className="sticky left-0 z-10 min-w-[160px] border-b border-r border-white/10 bg-gray-900 px-3 py-2 text-left text-gray-400">
                                        Employee
                                    </th>
                                    {dates.map((d) => {
                                        const { dayNum, dayName, isWeekend } = formatDay(d);
                                        return (
                                            <th
                                                key={d}
                                                className={`min-w-[36px] border-b border-r border-white/10 px-1 py-1.5 text-center ${isWeekend ? "bg-white/5" : "bg-gray-900"
                                                    }`}
                                            >
                                                <span className="block text-[10px] text-gray-500">{dayName}</span>
                                                <span className={`block font-bold ${isWeekend ? "text-indigo-400" : "text-gray-300"}`}>
                                                    {dayNum}
                                                </span>
                                            </th>
                                        );
                                    })}
                                    <th className="min-w-[50px] border-b border-white/10 bg-gray-900 px-2 py-2 text-center text-gray-400">
                                        Total
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {(isAdmin ? employees : getEmployeesFromAssignments(selected.assignments)).map(
                                    (emp) => {
                                        const empId = isAdmin ? emp.id : (emp as Employee).id;
                                        const empName = isAdmin
                                            ? `${emp.first_name} ${emp.last_name}`
                                            : `${(emp as Employee).first_name} ${(emp as Employee).last_name}`;

                                        let total = 0;
                                        return (
                                            <tr key={empId} className="group hover:bg-white/[0.02]">
                                                <td className="sticky left-0 z-10 border-b border-r border-white/10 bg-gray-900 px-3 py-1.5 font-medium text-gray-200 group-hover:bg-gray-800/80">
                                                    {empName}
                                                </td>
                                                {dates.map((d) => {
                                                    const key = `${empId}|${d}`;
                                                    const code = grid[key] ?? null;
                                                    const leaveCode = leaveMap.get(key);
                                                    if (code && code !== ShiftCode.B && code !== ShiftCode.O) total++;
                                                    const { isWeekend } = formatDay(d);

                                                    // If employee is on leave this day
                                                    if (leaveCode) {
                                                        const lc = LEAVE_COLORS[leaveCode] ?? { bg: "bg-gray-500/30", text: "text-gray-400" };
                                                        return (
                                                            <td
                                                                key={d}
                                                                className={`border-b border-r border-white/10 px-0.5 py-0.5 text-center ${isWeekend ? "bg-white/[0.03]" : ""}`}
                                                                title={`On leave (${leaveCode})`}
                                                            >
                                                                <span
                                                                    className={`inline-block rounded px-1 py-0.5 text-[10px] font-bold leading-none ${lc.bg} ${lc.text}`}
                                                                    style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent, transparent 2px, rgba(255,255,255,0.08) 2px, rgba(255,255,255,0.08) 4px)" }}
                                                                >
                                                                    {leaveCode}
                                                                </span>
                                                            </td>
                                                        );
                                                    }

                                                    return (
                                                        <td
                                                            key={d}
                                                            onClick={() => paintCell(empId, d)}
                                                            className={`border-b border-r border-white/10 px-0.5 py-0.5 text-center ${isWeekend ? "bg-white/[0.03]" : ""
                                                                } ${isAdmin && selected.status === ScheduleStatus.DRAFT && activeBrush ? "cursor-pointer hover:bg-white/10" : ""}`}
                                                        >
                                                            {code && (
                                                                <span
                                                                    className={`inline-block rounded px-1 py-0.5 text-[10px] font-bold leading-none ${SHIFT_COLORS[code].bg} ${SHIFT_COLORS[code].text}`}
                                                                    title={SHIFT_COLORS[code].label}
                                                                >
                                                                    {code}
                                                                </span>
                                                            )}
                                                        </td>
                                                    );
                                                })}
                                                <td className="border-b border-white/10 px-2 py-1.5 text-center font-bold text-indigo-400">
                                                    {total}
                                                </td>
                                            </tr>
                                        );
                                    },
                                )}
                            </tbody>
                        </table>
                    </div>

                    {isAdmin && selected.status === ScheduleStatus.DRAFT && (
                        <div className="border-t border-white/10 px-5 py-3">
                            <p className="text-xs text-gray-500">
                                🎨 Select a shift code from the toolbar above, then click cells to paint. Use the eraser to clear cells.
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* ---- Create Modal ---- */}
            {showCreate && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-gray-900 p-6 shadow-2xl">
                        <h2 className="text-lg font-bold text-white">New Schedule</h2>
                        <div className="mt-4 space-y-4">
                            <div>
                                <label className="mb-1 block text-sm text-gray-400">Name</label>
                                <input
                                    id="schedule-name-input"
                                    value={newName}
                                    onChange={(e) => setNewName(e.target.value)}
                                    placeholder="e.g. March 2026"
                                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="mb-1 block text-sm text-gray-400">Start Date</label>
                                    <input
                                        id="schedule-start-input"
                                        type="date"
                                        value={newStart}
                                        onChange={(e) => setNewStart(e.target.value)}
                                        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1 block text-sm text-gray-400">End Date</label>
                                    <input
                                        id="schedule-end-input"
                                        type="date"
                                        value={newEnd}
                                        onChange={(e) => setNewEnd(e.target.value)}
                                        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                onClick={() => setShowCreate(false)}
                                className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200"
                            >
                                Cancel
                            </button>
                            <button
                                id="create-schedule-submit"
                                onClick={createSchedule}
                                disabled={!newName || !newStart || !newEnd}
                                className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-lg disabled:opacity-50"
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

/* ------------------------------------------------------------------ */
/*  Helper to derive employees from assignments (employee view)      */
/* ------------------------------------------------------------------ */

function getEmployeesFromAssignments(assignments: ShiftAssignment[]): Employee[] {
    const map = new Map<string, Employee>();
    for (const a of assignments) {
        if (!map.has(a.employee_id)) {
            const parts = (a.employee_name ?? "Unknown").split(" ");
            const first = parts[0] ?? "Unknown";
            const last = parts.slice(1).join(" ");
            map.set(a.employee_id, {
                id: a.employee_id,
                employee_id: "",
                first_name: first,
                last_name: last,
                email: "",
                phone: null,
                department: "",
                position: "",
                date_of_joining: "",
                is_active: true,
                has_account: false,
                on_leave_today: false,
                created_at: "",
                updated_at: "",
            });
        }
    }
    return Array.from(map.values());
}
