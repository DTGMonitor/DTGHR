import { useMemo } from "react";

import {
    SHIFT_STYLES,
    ShiftCode,
    WORKING_DAY_CODES,
    type PublicHoliday,
    type ShiftChangeItem,
    type WorkingDaysSummary,
    type ScheduleEmployee,
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
    employees: ScheduleEmployee[];
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

/*
 * Column sizing.
 *
 * A 31-day month has to fit beside the name column and the three totals
 * columns without horizontal scroll on a normal laptop. At the previous
 * 2.25rem / 13rem the table came to roughly 1460px and was clipped at the
 * right on a 1500px window, hiding the last days of the month -- exactly the
 * ones somebody checking next week's cover needs.
 *
 *   11rem + 31 x 1.875rem + 8.5rem totals = ~1200px
 *
 * Narrow screens still scroll; the codes are two characters, so 1.875rem
 * leaves them legible rather than cramped.
 */
/** Narrowest a day column may get before the grid starts scrolling sideways. */
const CELL_MIN_W = "1.5rem";
/* Wide enough for the longest name on the team ("Maulana Safa'atul Nur
   Muhammad"). Under `table-fixed` this is enforced exactly, where the old auto
   layout would quietly let the column grow -- so it has to be generous. */
const NAME_W = "15rem";

/* The three sticky totals columns on the right. Their widths have to be
   explicit: under `table-fixed` a column with no width joins the day columns
   in sharing the leftover space, and "Total days" would stretch with them. */
const TOTAL_W = "3.5rem";
const ANNUAL_W = "4.75rem";
const PH_W = "5rem";  // "Holidays worked" needs more room than "PH" did.

function employeeName(e: ScheduleEmployee) {
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
            {/*
              `w-max` sized the table to its contents, so on a wide screen the
              grid sat in the top-left corner of a mostly empty panel. It now
              fills the panel and the day columns share whatever is left after
              the name and totals columns -- wider cells on a big monitor,
              rather than dead space.

              `minWidth` is the floor: below it the columns would be too narrow
              to read a two-letter code, so the panel scrolls sideways instead
              of squeezing. It is computed from the month's own length, because
              February needs three fewer columns than October.
            */}
            <table
                style={{
                    minWidth: `calc(${NAME_W} + ${days.length} * ${CELL_MIN_W} + ${TOTAL_W} + ${ANNUAL_W} + ${PH_W})`,
                }}
                className="w-full table-fixed border-separate border-spacing-0 text-xs"
            >
                <thead>
                    {/* Day-of-week row */}
                    <tr>
                        <th
                            rowSpan={2}
                            style={{ width: NAME_W, minWidth: NAME_W }}
                            className="sticky left-0 z-20 border-b border-r border-white/10 bg-surface px-3 py-2 text-left align-bottom font-semibold text-paper-soft"
                        >
                            Employee name
                            <span className="block text-[10px] font-normal text-muted">
                                {monthLabel}
                            </span>
                        </th>
                        {days.map((d) => (
                            <th
                                key={`dow-${d.iso}`}
                                
                                className={`border-b border-r border-white/5 px-0 py-1 text-center text-[9px] font-medium ${d.holiday?.is_national
                                    ? "bg-signal/20 text-signal"
                                    : d.isWeekend
                                        ? "bg-white/[0.06] text-paper-soft"
                                        : "text-muted"
                                    }`}
                                title={d.holiday ? d.holiday.name : undefined}
                            >
                                {d.dayName}
                            </th>
                        ))}
                        <th
                            rowSpan={2}
                            style={{ width: TOTAL_W }}
                            className="sticky right-[8.5rem] z-20 border-b border-l border-white/10 bg-surface px-2 py-2 text-center align-bottom font-semibold text-paper-soft"
                            title="Days worked. Counts DS, NS, C and D only."
                        >
                            Total
                            <span className="block text-[10px] font-normal text-muted">
                                days
                            </span>
                        </th>
                        <th
                            rowSpan={2}
                            style={{ width: ANNUAL_W }}
                            className="sticky right-[3.75rem] z-20 border-b border-l border-white/10 bg-surface px-2 py-2 text-center align-bottom font-semibold text-paper-soft"
                            title="Annual leave remaining: accrued since joining, less every AL day booked"
                        >
                            Annual
                            <span className="block text-[10px] font-normal text-muted">
                                leave days
                            </span>
                        </th>
                        <th
                            rowSpan={2}
                            style={{ width: PH_W }}
                            className="sticky right-0 z-20 border-b border-l border-white/10 bg-surface px-2 py-2 text-center align-bottom font-semibold text-paper-soft"
                            title="National public holidays this employee was rostered to work. Cuti bersama is excluded — it is a government day off, not a worked holiday."
                        >
                            {/* It read "PH loading", which is payroll's word for
                                the premium, not a word anybody else uses. The
                                column counts holidays worked, so it says so. */}
                            Holidays
                            <span className="block text-[10px] font-normal text-muted">
                                worked
                            </span>
                        </th>
                    </tr>
                    {/* Day-number row */}
                    <tr>
                        {days.map((d) => (
                            <th
                                key={`num-${d.iso}`}
                                
                                className={`border-b border-r border-white/10 px-0 py-1 text-center font-semibold ${d.holiday?.is_national
                                    ? "bg-signal/20 text-signal"
                                    : d.isWeekend
                                        ? "bg-white/[0.06] text-paper"
                                        : "text-paper-soft"
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
                                    className={`sticky left-0 z-10 truncate border-b border-r border-white/10 px-2.5 py-2 text-left font-medium ${rowIndex % 2 ? "bg-surface-raised" : "bg-surface"
                                        } text-paper`}
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
                                className="px-3 py-8 text-center text-muted"
                            >
                                No employees to show.
                            </td>
                        </tr>
                    )}
                </tbody>

                {/*
                  Daily cover, the way the workbook closes each month sheet.
                  Counts people actually on duty that day (DS, NS, C, D) --
                  break, leave and holidays are not cover. This is the number
                  you are looking for when somebody asks for a day off, and
                  without it the panel just ended in empty space.
                */}
                {employees.length > 0 && (
                    <tfoot>
                        <tr>
                            <th
                                scope="row"
                                style={{ width: NAME_W }}
                                className="sticky left-0 z-10 border-t border-r border-white/10 bg-surface-raised px-2.5 py-2 text-left text-micro font-semibold uppercase tracking-label text-paper-soft"
                            >
                                On duty
                            </th>

                            {days.map((d) => {
                                const onDuty = employees.reduce((count, employee) => {
                                    const key = `${employee.id}|${d.iso}`;
                                    // A staged edit is what the day would become
                                    // if submitted, so count that over the saved
                                    // code -- otherwise the tally contradicts the
                                    // grid the user is looking at.
                                    const code = staged.has(key)
                                        ? staged.get(key)
                                        : codes.get(key);
                                    return code && WORKING_DAY_CODES.includes(code)
                                        ? count + 1
                                        : count;
                                }, 0);

                                return (
                                    <td
                                        key={`duty-${d.iso}`}
                                        className={`border-t border-r border-white/10 px-0 py-2.5 text-center font-mono text-[11px] font-semibold ${
                                            onDuty === 0
                                                ? "bg-danger/10 text-danger"
                                                : d.isWeekend
                                                  ? "bg-white/[0.06] text-paper-soft"
                                                  : "text-paper-soft"
                                        }`}
                                        title={
                                            onDuty === 0
                                                ? `Nobody on duty on ${d.dayName} ${d.dayNumber}`
                                                : `${onDuty} on duty on ${d.dayName} ${d.dayNumber}`
                                        }
                                    >
                                        {onDuty}
                                    </td>
                                );
                            })}

                            <td
                                colSpan={3}
                                className="sticky right-0 z-10 border-t border-l border-white/10 bg-surface-raised px-2 py-2 text-center font-mono text-[10px] text-muted"
                            >
                                cover
                            </td>
                        </tr>
                    </tfoot>
                )}
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
            className={`h-11 border-b border-r border-white/10 p-0 text-center align-middle ${editable ? "cursor-pointer" : "cursor-default"
                } ${active ? "outline outline-2 -outline-offset-2 outline-signal" : ""}`}
            style={{ background: style ? style.bg : emptyBg }}
        >
            {overlay ? (
                /* Split cell: the assigned code on top, the new one underneath. */
                <div className="flex h-7 w-full flex-col" title={overlay.hint}>
                    <span
                        className="flex flex-1 items-center justify-center text-xs font-bold leading-none"
                        style={{
                            background: style ? style.bg : emptyBg,
                            color: style ? style.fg : "#9ca3af",
                        }}
                    >
                        {text}
                    </span>
                    <span
                        className="flex flex-1 items-center justify-center border-t border-dashed text-xs font-bold leading-none"
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
                    className="text-xs font-bold leading-none"
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
        leave < 0 ? "text-gold" : leave < 1 ? "text-danger" : "text-paper";

    return (
        <>
            <td className="sticky right-[8.5rem] z-10 border-b border-l border-white/10 bg-surface px-2 py-2 text-center font-semibold text-paper">
                {summary?.working_days ?? 0}
            </td>
            <td
                className={`sticky right-[3.75rem] z-10 border-b border-l border-white/10 bg-surface px-2 py-2 text-center font-semibold ${leaveColour}`}
                title={
                    `${leave.toFixed(2)} day(s) of annual leave remaining` +
                    (taken ? `, ${taken} taken this month` : "")
                }
            >
                {/* Two places, not one. The accrual is thirtieths and
                    thirty-firsts -- 11.67, 4.97, -3.45 -- and rounding to
                    11.7 or 12 throws away the part that shows there is a
                    calculation behind it. */}
                {leave.toFixed(2)}
            </td>
            <td
                className="sticky right-0 z-10 border-b border-l border-white/10 bg-surface px-2 py-2 text-center font-semibold text-paper"
                title={`${loading} public holiday(s) worked`}
            >
                {loading || ""}
            </td>
        </>
    );
}
