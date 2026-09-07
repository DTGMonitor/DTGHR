import { useMemo } from "react";
import type { Employee } from "@/types/employee";
import {
    SHIFT_STYLES,
    ShiftCode,
    type PublicHoliday,
    type ShiftChangeItem,
    type WorkingDaysSummary,
} from "@/types/schedule";

export interface DayColumn {
    /** ISO date, `YYYY-MM-DD`. */
    iso: string;
    dayNumber: number;
    dayName: string;
    isWeekend: boolean;
    holiday: PublicHoliday | null;
}

interface Props {
    employees: Employee[];
    days: DayColumn[];
    /** `employeeId|iso` → assigned code. */
    codes: Map<string, ShiftCode>;
    /** `employeeId|iso` → a day inside a submitted proposal, awaiting review. */
    pending: Map<string, ShiftChangeItem>;
    /** `employeeId|iso` → a local edit not yet submitted. */
    staged: Map<string, ShiftCode | null>;
    /** `employeeId` → working-day total (DS, NS, C and D only). */
    totals: Map<string, WorkingDaysSummary>;
    /** Which cells this user may open the editor on. */
    isCellEditable: (employeeId: string) => boolean;
    onCellClick: (employeeId: string, iso: string, rect: DOMRect) => void;
    /** Cell currently showing the editor, as `employeeId|iso`. */
    activeCell: string | null;
}

const CELL_W = "2.25rem";
const NAME_W = "13rem";

function employeeName(e: Employee) {
    return `${e.first_name} ${e.last_name}`;
}

/**
 * The month grid, laid out like the STAFF ROSTER worksheet: employees down the
 * left, one column per day, a working-days total on the right.
 *
 * A cell with an open proposal is split horizontally — the assigned code on
 * top, the proposed one underneath — and collapses back to a single block once
 * a superuser approves or rejects it.
 */
export default function RosterGrid({
    employees,
    days,
    codes,
    pending,
    staged,
    totals,
    isCellEditable,
    onCellClick,
    activeCell,
}: Props) {
    const monthLabel = useMemo(() => {
        const first = days[0];
        if (!first) return "";
        return new Date(`${first.iso}T00:00:00`).toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
        });
    }, [days]);

    return (
        <div className="overflow-x-auto">
            <table className="w-max border-separate border-spacing-0 text-[11px]">
                <thead>
                    {/* Day-of-week row */}
                    <tr>
                        <th
                            rowSpan={2}
                            style={{ width: NAME_W, minWidth: NAME_W }}
                            className="sticky left-0 z-20 border-b border-r border-white/10 bg-gray-900 px-3 py-2 text-left align-bottom font-semibold text-gray-300"
                        >
                            Employee name
                            <span className="block text-[10px] font-normal text-gray-500">
                                {monthLabel}
                            </span>
                        </th>
                        {days.map((d) => (
                            <th
                                key={`dow-${d.iso}`}
                                style={{ width: CELL_W, minWidth: CELL_W }}
                                className={`border-b border-r border-white/5 px-0 py-1 text-center text-[9px] font-medium ${d.holiday?.is_national
                                    ? "bg-emerald-500/20 text-emerald-300"
                                    : d.isWeekend
                                        ? "bg-white/[0.06] text-gray-400"
                                        : "text-gray-500"
                                    }`}
                                title={d.holiday ? d.holiday.name : undefined}
                            >
                                {d.dayName}
                            </th>
                        ))}
                        <th
                            rowSpan={2}
                            className="sticky right-[8.5rem] z-20 border-b border-l border-white/10 bg-gray-900 px-2 py-2 text-center align-bottom font-semibold text-gray-300"
                            title="Days worked. Counts DS, NS, C and D only."
                        >
                            Total
                            <span className="block text-[10px] font-normal text-gray-500">
                                days
                            </span>
                        </th>
                        <th
                            rowSpan={2}
                            style={{ width: "4.75rem", minWidth: "4.75rem" }}
                            className="sticky right-[3.75rem] z-20 border-b border-l border-white/10 bg-gray-900 px-2 py-2 text-center align-bottom font-semibold text-gray-300"
                            title="Annual leave remaining: accrued since joining, less every AL day booked"
                        >
                            Annual
                            <span className="block text-[10px] font-normal text-gray-500">
                                leave days
                            </span>
                        </th>
                        <th
                            rowSpan={2}
                            style={{ width: "3.75rem", minWidth: "3.75rem" }}
                            className="sticky right-0 z-20 border-b border-l border-white/10 bg-gray-900 px-2 py-2 text-center align-bottom font-semibold text-gray-300"
                            title="National public holidays this employee was rostered to work"
                        >
                            PH
                            <span className="block text-[10px] font-normal text-gray-500">
                                loading
                            </span>
                        </th>
                    </tr>
                    {/* Day-number row */}
                    <tr>
                        {days.map((d) => (
                            <th
                                key={`num-${d.iso}`}
                                style={{ width: CELL_W, minWidth: CELL_W }}
                                className={`border-b border-r border-white/10 px-0 py-1 text-center font-semibold ${d.holiday?.is_national
                                    ? "bg-emerald-500/20 text-emerald-300"
                                    : d.isWeekend
                                        ? "bg-white/[0.06] text-gray-300"
                                        : "text-gray-400"
                                    }`}
                                title={d.holiday ? d.holiday.name : undefined}
                            >
                                {d.dayNumber}
                            </th>
                        ))}
                    </tr>
                </thead>

                <tbody>
                    {employees.map((employee, rowIndex) => {
                        const editable = isCellEditable(employee.id);
                        return (
                            <tr
                                key={employee.id}
                                className={rowIndex % 2 ? "bg-white/[0.02]" : undefined}
                            >
                                <th
                                    scope="row"
                                    style={{ width: NAME_W, minWidth: NAME_W }}
                                    className={`sticky left-0 z-10 truncate border-b border-r border-white/10 px-3 py-1.5 text-left font-medium ${rowIndex % 2 ? "bg-gray-900" : "bg-gray-900"
                                        } text-gray-200`}
                                    title={`${employeeName(employee)} — ${employee.position}`}
                                >
                                    {employeeName(employee)}
                                </th>

                                {days.map((d) => {
                                    const key = `${employee.id}|${d.iso}`;
                                    return (
                                        <RosterCell
                                            key={key}
                                            cellKey={key}
                                            code={codes.get(key) ?? null}
                                            proposal={pending.get(key) ?? null}
                                            stagedCode={
                                                staged.has(key)
                                                    ? staged.get(key) ?? null
                                                    : undefined
                                            }
                                            isWeekend={d.isWeekend}
                                            isHoliday={!!d.holiday?.is_national}
                                            editable={editable}
                                            active={activeCell === key}
                                            onClick={(rect) =>
                                                onCellClick(employee.id, d.iso, rect)
                                            }
                                        />
                                    );
                                })}

                                <TotalCells summary={totals.get(employee.id)} />
                            </tr>
                        );
                    })}

                    {employees.length === 0 && (
                        <tr>
                            <td
                                colSpan={days.length + 4}
                                className="px-3 py-8 text-center text-gray-500"
                            >
                                No employees to show.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

/* ------------------------------------------------------------------ */

function RosterCell({
    cellKey,
    code,
    proposal,
    stagedCode,
    isWeekend,
    isHoliday,
    editable,
    active,
    onClick,
}: {
    cellKey: string;
    code: ShiftCode | null;
    proposal: ShiftChangeItem | null;
    stagedCode: ShiftCode | null | undefined;
    isWeekend: boolean;
    isHoliday: boolean;
    editable: boolean;
    active: boolean;
    onClick: (rect: DOMRect) => void;
}) {
    const style = code ? SHIFT_STYLES[code] : null;
    // The workbook draws a break day as a plain cyan block with no letter.
    const text = style?.blankInGrid ? "" : code ?? "";

    const emptyBg = isHoliday
        ? "rgba(16,185,129,0.12)"
        : isWeekend
            ? "rgba(255,255,255,0.05)"
            : "transparent";

    const handleClick = (e: React.MouseEvent<HTMLTableCellElement>) => {
        onClick(e.currentTarget.getBoundingClientRect());
    };

    // A cell is split whenever a second code is in play: a staged edit not yet
    // submitted (indigo), or a submitted day awaiting review (amber). Staging
    // wins the display, since it is the more recent of the two -- though in
    // practice the backend refuses to stage over a day already under review.
    const overlay: { code: ShiftCode | null; accent: string; hint: string } | null =
        stagedCode !== undefined
            ? {
                code: stagedCode,
                accent: "#818cf8",
                hint: `Staged: ${stagedCode ?? "cleared"} - not submitted yet`,
            }
            : proposal
                ? {
                    code: proposal.requested_code,
                    accent: "#fcd34d",
                    hint: `Proposed: ${proposal.requested_code ?? "cleared"} - awaiting approval`,
                }
                : null;

    const overlayStyle = overlay?.code ? SHIFT_STYLES[overlay.code] : null;

    return (
        <td
            data-cell={cellKey}
            onClick={handleClick}
            className={`h-7 border-b border-r border-white/10 p-0 text-center align-middle ${editable ? "cursor-pointer" : "cursor-default"
                } ${active ? "outline outline-2 -outline-offset-2 outline-indigo-400" : ""}`}
            style={{ background: style ? style.bg : emptyBg }}
        >
            {overlay ? (
                /* Split cell: the assigned code on top, the new one underneath. */
                <div className="flex h-7 w-full flex-col" title={overlay.hint}>
                    <span
                        className="flex flex-1 items-center justify-center text-[10px] font-bold leading-none"
                        style={{
                            background: style ? style.bg : emptyBg,
                            color: style ? style.fg : "#9ca3af",
                        }}
                    >
                        {text}
                    </span>
                    <span
                        className="flex flex-1 items-center justify-center border-t border-dashed text-[10px] font-bold leading-none"
                        style={{
                            borderColor: overlay.accent,
                            background: overlayStyle
                                ? overlayStyle.bg
                                : "rgba(255,255,255,0.08)",
                            color: overlayStyle ? overlayStyle.fg : overlay.accent,
                            opacity: 0.9,
                        }}
                    >
                        {overlayStyle?.blankInGrid ? "" : overlay.code ?? "-"}
                    </span>
                </div>
            ) : (
                <span
                    className="text-[10px] font-bold leading-none"
                    style={{ color: style?.fg }}
                >
                    {text}
                </span>
            )}
        </td>
    );
}

/**
 * The three right-hand totals, pinned beside the grid: days worked, annual
 * leave remaining and public-holiday loading.
 */
function TotalCells({ summary }: { summary: WorkingDaysSummary | undefined }) {
    const leave = summary?.annual_leave_days ?? 0;
    const taken = summary?.annual_leave_taken ?? 0;
    const loading = summary?.public_holiday_loading ?? 0;

    // A negative balance means leave was granted beyond the entitlement, which
    // only a superuser can do. It should read as an exception, not an error.
    const leaveColour =
        leave < 0 ? "text-amber-400" : leave < 1 ? "text-red-400" : "text-gray-200";

    return (
        <>
            <td className="sticky right-[8.5rem] z-10 border-b border-l border-white/10 bg-gray-900 px-2 py-1.5 text-center font-semibold text-gray-200">
                {summary?.working_days ?? 0}
            </td>
            <td
                className={`sticky right-[3.75rem] z-10 border-b border-l border-white/10 bg-gray-900 px-2 py-1.5 text-center font-semibold ${leaveColour}`}
                title={
                    `${leave.toFixed(2)} day(s) of annual leave remaining` +
                    (taken ? `, ${taken} taken this month` : "")
                }
            >
                {leave.toFixed(1)}
            </td>
            <td
                className="sticky right-0 z-10 border-b border-l border-white/10 bg-gray-900 px-2 py-1.5 text-center font-semibold text-gray-200"
                title={`${loading} public holiday(s) worked`}
            >
                {loading || ""}
            </td>
        </>
    );
}
