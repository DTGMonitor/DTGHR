import { useMemo, useState } from "react";
import type { Employee } from "@/types/employee";
import { SHIFT_CODE_ORDER, SHIFT_STYLES, ShiftCode } from "@/types/schedule";
import {
    scheduleService,
    type RosterPatternBlock,
    type RosterPatternResult,
} from "@/services/scheduleService";
import { isoDate } from "@/lib/dates";

interface Props {
    employees: Employee[];
    /** Pre-fills the start date with the month currently on screen. */
    defaultStart: string;
    onClose: () => void;
    onApplied: (result: RosterPatternResult) => void;
}

/** Presets covering the rotations the roster actually uses. */
const PRESETS: { label: string; blocks: RosterPatternBlock[] }[] = [
    {
        label: "4 day / 4 night / 4 off",
        blocks: [
            { shift_code: ShiftCode.DS, days: 4 },
            { shift_code: ShiftCode.NS, days: 4 },
            { shift_code: ShiftCode.B, days: 4 },
        ],
    },
    {
        label: "5 day only / 2 off",
        blocks: [
            { shift_code: ShiftCode.D, days: 5 },
            { shift_code: ShiftCode.B, days: 2 },
        ],
    },
    {
        label: "7 day / 7 night / 7 off",
        blocks: [
            { shift_code: ShiftCode.DS, days: 7 },
            { shift_code: ShiftCode.NS, days: 7 },
            { shift_code: ShiftCode.B, days: 7 },
        ],
    },
];

/** How far forward to run the rotation. */
const DURATIONS: { label: string; months: number }[] = [
    { label: "1 month", months: 1 },
    { label: "2 months", months: 2 },
    { label: "3 months", months: 3 },
    { label: "6 months", months: 6 },
    { label: "1 year", months: 12 },
];

function addMonths(iso: string, months: number): string {
    const target = new Date(`${iso}T00:00:00`);
    target.setMonth(target.getMonth() + months);
    // One day short of the anniversary, so "1 month" from the 1st ends on the
    // last day of that month rather than spilling into the next.
    target.setDate(target.getDate() - 1);
    return isoDate(target);
}

export default function RosterPatternModal({
    employees,
    defaultStart,
    onClose,
    onApplied,
}: Props) {
    const [blocks, setBlocks] = useState<RosterPatternBlock[]>(PRESETS[0]!.blocks);
    const [selected, setSelected] = useState<string[]>([]);
    const [startDate, setStartDate] = useState(defaultStart);
    const [durationMonths, setDurationMonths] = useState(1);
    const [customEnd, setCustomEnd] = useState("");
    const [offsetDays, setOffsetDays] = useState(0);
    const [overwrite, setOverwrite] = useState(true);
    const [applyHolidays, setApplyHolidays] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const endDate = customEnd || addMonths(startDate, durationMonths);
    const cycleLength = useMemo(
        () => blocks.reduce((sum, b) => sum + b.days, 0),
        [blocks],
    );

    const toggleEmployee = (id: string) =>
        setSelected((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );

    const updateBlock = (index: number, patch: Partial<RosterPatternBlock>) =>
        setBlocks((prev) =>
            prev.map((b, i) => (i === index ? { ...b, ...patch } : b)),
        );

    const submit = async () => {
        if (selected.length === 0) {
            setError("Select at least one employee.");
            return;
        }
        if (!startDate || !endDate || endDate < startDate) {
            setError("Pick a valid date range.");
            return;
        }
        setBusy(true);
        setError("");
        try {
            const { data } = await scheduleService.applyPattern({
                employee_ids: selected,
                pattern: blocks,
                start_date: startDate,
                end_date: endDate,
                offset_days: offsetDays,
                overwrite,
                apply_public_holidays: applyHolidays,
            });
            onApplied(data);
        } catch (err: unknown) {
            const detail = (err as { response?: { data?: { detail?: unknown } } })
                ?.response?.data?.detail;
            setError(
                typeof detail === "string" ? detail : "Failed to apply the rotation.",
            );
        } finally {
            setBusy(false);
        }
    };

    const inputClass =
        "rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none";
    const labelClass = "mb-1 block text-xs font-medium text-gray-400";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-white/10 bg-gray-900 p-6 shadow-2xl">
                <div className="mb-5">
                    <h2 className="text-lg font-bold text-white">Default roster</h2>
                    <p className="mt-1 text-xs text-gray-400">
                        Repeat a rotation across a date range. Months that don&apos;t exist
                        yet are created as drafts.
                    </p>
                </div>

                {error && (
                    <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-400">
                        {error}
                    </div>
                )}

                {/* ---- Pattern ---- */}
                <div className="mb-5">
                    <label className={labelClass}>Rotation</label>
                    <div className="mb-2 flex flex-wrap gap-1.5">
                        {PRESETS.map((preset) => (
                            <button
                                key={preset.label}
                                onClick={() => setBlocks(preset.blocks)}
                                className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-gray-300 transition hover:border-indigo-500/50 hover:text-white"
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>

                    <div className="space-y-2">
                        {blocks.map((block, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <input
                                    type="number"
                                    min={1}
                                    max={60}
                                    value={block.days}
                                    onChange={(e) =>
                                        updateBlock(index, {
                                            days: Math.max(1, Number(e.target.value) || 1),
                                        })
                                    }
                                    className={`${inputClass} w-20`}
                                />
                                <span className="text-xs text-gray-500">days of</span>
                                <select
                                    value={block.shift_code}
                                    onChange={(e) =>
                                        updateBlock(index, {
                                            shift_code: e.target.value as ShiftCode,
                                        })
                                    }
                                    className={`${inputClass} flex-1`}
                                >
                                    {SHIFT_CODE_ORDER.map((code) => (
                                        <option key={code} value={code}>
                                            {code} — {SHIFT_STYLES[code].label}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    onClick={() =>
                                        setBlocks((prev) => prev.filter((_, i) => i !== index))
                                    }
                                    disabled={blocks.length === 1}
                                    className="rounded-lg px-2 py-1 text-gray-500 transition hover:bg-red-500/20 hover:text-red-400 disabled:opacity-30"
                                    title="Remove leg"
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className="mt-2 flex items-center justify-between">
                        <button
                            onClick={() =>
                                setBlocks((prev) => [
                                    ...prev,
                                    { shift_code: ShiftCode.B, days: 4 },
                                ])
                            }
                            className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                        >
                            + Add leg
                        </button>
                        <span className="text-[11px] text-gray-500">
                            {cycleLength}-day cycle
                        </span>
                    </div>

                    {/* Cycle preview */}
                    <div className="mt-2 flex flex-wrap gap-0.5">
                        {blocks.flatMap((block, bi) =>
                            Array.from({ length: block.days }, (_, di) => (
                                <span
                                    key={`${bi}-${di}`}
                                    className="inline-flex h-5 w-6 items-center justify-center rounded-sm text-[9px] font-bold ring-1 ring-black/20"
                                    style={{
                                        background: SHIFT_STYLES[block.shift_code].bg,
                                        color: SHIFT_STYLES[block.shift_code].fg,
                                    }}
                                >
                                    {SHIFT_STYLES[block.shift_code].blankInGrid
                                        ? ""
                                        : block.shift_code}
                                </span>
                            )),
                        )}
                    </div>
                </div>

                {/* ---- Range ---- */}
                <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                        <label className={labelClass}>Starts</label>
                        <input
                            type="date"
                            value={startDate}
                            onChange={(e) => setStartDate(e.target.value)}
                            className={`${inputClass} w-full`}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Apply for</label>
                        <select
                            value={customEnd ? "custom" : String(durationMonths)}
                            onChange={(e) => {
                                if (e.target.value === "custom") {
                                    setCustomEnd(addMonths(startDate, durationMonths));
                                } else {
                                    setCustomEnd("");
                                    setDurationMonths(Number(e.target.value));
                                }
                            }}
                            className={`${inputClass} w-full`}
                        >
                            {DURATIONS.map((d) => (
                                <option key={d.months} value={d.months}>
                                    {d.label}
                                </option>
                            ))}
                            <option value="custom">Custom end date…</option>
                        </select>
                    </div>
                    <div>
                        <label className={labelClass}>Ends</label>
                        {customEnd ? (
                            <input
                                type="date"
                                value={customEnd}
                                min={startDate}
                                onChange={(e) => setCustomEnd(e.target.value)}
                                className={`${inputClass} w-full`}
                            />
                        ) : (
                            <p className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 text-sm text-gray-400">
                                {endDate}
                            </p>
                        )}
                    </div>
                </div>

                {/* ---- Employees ---- */}
                <div className="mb-5">
                    <div className="mb-1 flex items-center justify-between">
                        <label className={labelClass}>
                            Employees ({selected.length} selected)
                        </label>
                        <button
                            onClick={() =>
                                setSelected((prev) =>
                                    prev.length === employees.length
                                        ? []
                                        : employees.map((e) => e.id),
                                )
                            }
                            className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                        >
                            {selected.length === employees.length
                                ? "Clear all"
                                : "Select all"}
                        </button>
                    </div>
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02] p-2">
                        {employees.map((employee) => {
                            const position = selected.indexOf(employee.id);
                            return (
                                <label
                                    key={employee.id}
                                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm text-gray-300 hover:bg-white/5"
                                >
                                    <input
                                        type="checkbox"
                                        checked={position >= 0}
                                        onChange={() => toggleEmployee(employee.id)}
                                        className="h-3.5 w-3.5 rounded border-white/20 bg-transparent"
                                    />
                                    <span className="flex-1">
                                        {employee.first_name} {employee.last_name}
                                    </span>
                                    {position >= 0 && offsetDays > 0 && (
                                        <span className="text-[10px] text-gray-500">
                                            +{position * offsetDays}d
                                        </span>
                                    )}
                                </label>
                            );
                        })}
                    </div>
                    <p className="mt-1 text-[10px] text-gray-500">
                        Selection order sets the stagger — the first employee starts at day
                        one of the cycle.
                    </p>
                </div>

                {/* ---- Options ---- */}
                <div className="mb-6 space-y-2.5">
                    <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400">
                            Stagger each employee by
                        </label>
                        <input
                            type="number"
                            min={0}
                            max={60}
                            value={offsetDays}
                            onChange={(e) =>
                                setOffsetDays(Math.max(0, Number(e.target.value) || 0))
                            }
                            className={`${inputClass} w-20 py-1`}
                        />
                        <span className="text-xs text-gray-500">
                            days of the cycle (0 = everyone on the same rotation)
                        </span>
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-400">
                        <input
                            type="checkbox"
                            checked={overwrite}
                            onChange={(e) => setOverwrite(e.target.checked)}
                            className="h-3.5 w-3.5 rounded border-white/20 bg-transparent"
                        />
                        Overwrite days that already have a code
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-400">
                        <input
                            type="checkbox"
                            checked={applyHolidays}
                            onChange={(e) => setApplyHolidays(e.target.checked)}
                            className="h-3.5 w-3.5 rounded border-white/20 bg-transparent"
                        />
                        Mark Indonesian public holidays as PH
                    </label>
                </div>

                <div className="flex justify-end gap-2">
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-gray-300 transition hover:bg-white/5 disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={submit}
                        disabled={busy}
                        className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:shadow-indigo-500/40 disabled:opacity-50"
                    >
                        {busy ? "Applying…" : "Apply rotation"}
                    </button>
                </div>
            </div>
        </div>
    );
}
