import { useEffect, useRef } from "react";
import {
    SHIFT_CODE_ORDER,
    SHIFT_STYLES,
    ShiftCode,
    type ShiftChangeItem,
} from "@/types/schedule";
import { ShiftChip } from "./ShiftLegend";

interface Props {
    employeeName: string;
    date: string;
    currentCode: ShiftCode | null;
    /** A day inside an already-submitted proposal, if this cell is in one. */
    pending: ShiftChangeItem | null;
    /** A local edit not yet submitted. `undefined` means nothing staged. */
    staged: ShiftCode | null | undefined;
    /** Superusers write straight through; everyone else stages an edit. */
    canApplyDirectly: boolean;
    /** Whether this user may touch this cell at all. */
    canEdit: boolean;
    busy: boolean;
    onApply: (code: ShiftCode | null) => void;
    onStage: (code: ShiftCode | null) => void;
    onUnstage: () => void;
    onClose: () => void;
    /** Anchor rect of the clicked cell, in viewport coordinates. */
    anchor: DOMRect;
}

const PANEL_WIDTH = 260;

/**
 * The dropdown that opens on a grid cell.
 *
 * It is a fixed-position panel next to the cell rather than markup inside the
 * table, so the grid's horizontal scroll container can never clip it.
 */
export default function CellEditor({
    employeeName,
    date,
    currentCode,
    pending,
    staged,
    canApplyDirectly,
    canEdit,
    busy,
    onApply,
    onStage,
    onUnstage,
    onClose,
    anchor,
}: Props) {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        const onClickAway = (e: MouseEvent) => {
            if (!panelRef.current?.contains(e.target as Node)) onClose();
        };
        document.addEventListener("keydown", onKey);
        // Deferred so the click that opened the panel does not close it again.
        const id = window.setTimeout(
            () => document.addEventListener("mousedown", onClickAway),
            0,
        );
        return () => {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("mousedown", onClickAway);
            window.clearTimeout(id);
        };
    }, [onClose]);

    // Keep the panel on screen when the cell sits near the right or bottom edge.
    const left = Math.min(anchor.left, window.innerWidth - PANEL_WIDTH - 12);
    const openUpwards = anchor.bottom + 320 > window.innerHeight;
    const top = openUpwards ? undefined : anchor.bottom + 6;
    const bottom = openUpwards ? window.innerHeight - anchor.top + 6 : undefined;

    const choose = (code: ShiftCode | null) => {
        if (canApplyDirectly) {
            if (code === currentCode) {
                onClose();
                return;
            }
            onApply(code);
            return;
        }
        // Staging only. The edit joins the rest of this sitting's changes and
        // they are submitted together as a single proposal.
        if (code === currentCode) onUnstage();
        else onStage(code);
        onClose();
    };

    const readableDate = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
    });

    // The swatch to highlight: what the cell will read as once this edit lands.
    const highlighted = staged === undefined ? currentCode : staged;

    return (
        <div
            ref={panelRef}
            style={{ left, top, bottom, width: PANEL_WIDTH }}
            className="fixed z-50 rounded-xl border border-white/10 bg-gray-900 p-3 shadow-2xl shadow-black/50 backdrop-blur-xl"
        >
            <div className="mb-2 border-b border-white/10 pb-2">
                <p className="truncate text-sm font-semibold text-white">{employeeName}</p>
                <p className="text-[11px] text-gray-500">{readableDate}</p>
            </div>

            {pending && (
                <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
                    <p className="flex items-center gap-1.5 text-[11px] text-amber-300">
                        Awaiting approval:
                        <ShiftChip code={pending.current_code} />
                        <span aria-hidden>&rarr;</span>
                        <ShiftChip code={pending.requested_code} />
                    </p>
                    <p className="mt-1 text-[10px] leading-tight text-amber-200/70">
                        Withdraw the proposal from the requests panel to change this day
                        again.
                    </p>
                </div>
            )}

            {staged !== undefined && !pending && (
                <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-indigo-400/40 bg-indigo-500/10 p-2 text-[11px] text-indigo-300">
                    Staged:
                    <ShiftChip code={currentCode} />
                    <span aria-hidden>&rarr;</span>
                    <ShiftChip code={staged} />
                    <button
                        onClick={() => {
                            onUnstage();
                            onClose();
                        }}
                        className="ml-auto font-medium underline-offset-2 hover:underline"
                    >
                        Undo
                    </button>
                </div>
            )}

            {!canEdit ? (
                <p className="text-[11px] text-gray-500">
                    You can only change your own row.
                </p>
            ) : (
                <>
                    <div className="grid max-h-56 grid-cols-4 gap-1.5 overflow-y-auto pr-0.5">
                        {SHIFT_CODE_ORDER.map((code) => {
                            const style = SHIFT_STYLES[code];
                            const active = code === highlighted;
                            return (
                                <button
                                    key={code}
                                    onClick={() => choose(code)}
                                    disabled={busy || !!pending}
                                    title={style.label}
                                    className={`flex h-8 items-center justify-center rounded-lg text-[11px] font-bold ring-1 transition disabled:cursor-not-allowed disabled:opacity-40 ${active
                                        ? "ring-2 ring-white"
                                        : "ring-black/20 hover:ring-white/60"
                                        }`}
                                    style={{ background: style.bg, color: style.fg }}
                                >
                                    {code}
                                </button>
                            );
                        })}
                        <button
                            onClick={() => choose(null)}
                            disabled={busy || !!pending}
                            title="Clear this day"
                            className={`col-span-4 mt-0.5 flex h-8 items-center justify-center rounded-lg border border-dashed text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${highlighted === null
                                ? "border-white/60 text-white"
                                : "border-white/20 text-gray-400 hover:border-white/40 hover:text-white"
                                }`}
                        >
                            Clear day
                        </button>
                    </div>

                    <p className="mt-2 text-[10px] leading-tight text-gray-500">
                        {pending
                            ? "This day is already awaiting approval."
                            : canApplyDirectly
                                ? "Applied immediately."
                                : "Collected with your other edits, then submitted as one proposal."}
                    </p>
                </>
            )}
        </div>
    );
}
