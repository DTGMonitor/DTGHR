import { SHIFT_CODE_ORDER, SHIFT_STYLES, ShiftCode } from "@/types/schedule";

/** The workbook's "Absence type key" strip. */
export default function ShiftLegend({ compact = false }: { compact?: boolean }) {
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {!compact && (
                <span className="text-xs font-semibold text-gray-400">Absence type key</span>
            )}
            {SHIFT_CODE_ORDER.map((code) => {
                const style = SHIFT_STYLES[code];
                return (
                    <span key={code} className="flex items-center gap-1.5">
                        <span
                            className="inline-flex h-5 w-7 items-center justify-center rounded text-[10px] font-bold leading-none ring-1 ring-black/20"
                            style={{ background: style.bg, color: style.fg }}
                        >
                            {code}
                        </span>
                        {!compact && (
                            <span className="text-[11px] text-gray-400">{style.label}</span>
                        )}
                    </span>
                );
            })}
            <span className="flex items-center gap-1.5">
                <span className="inline-flex h-5 w-7 items-center justify-center rounded border border-dashed border-amber-400/70 bg-amber-400/10 text-[10px] font-bold leading-none text-amber-300">
                    ?
                </span>
                <span className="text-[11px] text-gray-400">Pending approval</span>
            </span>
        </div>
    );
}

/** A single code chip, used in the legend, approvals list and cell popover. */
export function ShiftChip({
    code,
    className = "",
}: {
    code: ShiftCode | null;
    className?: string;
}) {
    if (!code) {
        return (
            <span
                className={`inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded border border-white/15 px-1 text-[10px] font-bold leading-none text-gray-400 ${className}`}
            >
                —
            </span>
        );
    }
    const style = SHIFT_STYLES[code];
    return (
        <span
            className={`inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1 text-[10px] font-bold leading-none ring-1 ring-black/20 ${className}`}
            style={{ background: style.bg, color: style.fg }}
            title={style.label}
        >
            {code}
        </span>
    );
}
