import { useShiftCodes } from "@/lib/useShiftCodes";
import type { ShiftCode } from "@/types/schedule";

/** The workbook's "Absence type key" strip. */
export default function ShiftLegend({ compact = false }: { compact?: boolean }) {
    const { codes } = useShiftCodes();
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {!compact && (
                <span className="text-xs font-semibold text-paper-soft">Absence type key</span>
            )}
            {codes.map(({ code, bg, fg, label }) => (
                <span key={code} className="flex items-center gap-1.5">
                    <span
                        className="inline-flex h-5 w-7 items-center justify-center rounded text-[10px] font-bold leading-none ring-1 ring-black/25"
                        style={{ background: bg, color: fg }}
                    >
                        {code}
                    </span>
                    {!compact && (
                        <span className="text-[11px] text-paper-soft">{label}</span>
                    )}
                </span>
            ))}
            <span className="flex items-center gap-1.5">
                <span className="inline-flex h-5 w-7 items-center justify-center rounded border border-dashed border-gold/70 bg-gold/10 text-[10px] font-bold leading-none text-gold">
                    ?
                </span>
                <span className="text-[11px] text-paper-soft">Pending approval</span>
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
    const { styleOf } = useShiftCodes();
    if (!code) {
        return (
            <span
                className={`inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded border border-white/15 px-1 text-[10px] font-bold leading-none text-paper-soft ${className}`}
            >
                —
            </span>
        );
    }
    const style = styleOf(code);
    return (
        <span
            className={`inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1 text-[10px] font-bold leading-none ring-1 ring-black/25 ${className}`}
            style={{ background: style.bg, color: style.fg }}
            title={style.label}
        >
            {code}
        </span>
    );
}
