import { useCallback, useEffect, useMemo, useState } from "react";
import { scheduleService } from "@/services/scheduleService";
import type { ShiftCode, ShiftCodeRow, ShiftStyle } from "@/types/schedule";

/*
 * The roster's codes, from public.shift_codes -- the one list of them.
 *
 * Fetched once per page load and shared by every screen that draws a code:
 * codes change only by migration, and a reload picks the change up. Until the
 * list arrives, or for a code it does not hold, styleOf() draws the letters on
 * a neutral fill, so a cell is never blank or broken.
 */

let rows: ShiftCodeRow[] | null = null;
let loading: Promise<ShiftCodeRow[]> | null = null;

function load(): Promise<ShiftCodeRow[]> {
    loading ??= scheduleService
        .shiftCodes()
        .then(({ data }) => (rows = data))
        .catch((err) => {
            loading = null; // the next screen to mount tries again
            throw err;
        });
    return loading;
}

const NEUTRAL = { bg: "#4B5563", fg: "#FFFFFF" };

export function useShiftCodes() {
    const [codes, setCodes] = useState<ShiftCodeRow[]>(rows ?? []);

    useEffect(() => {
        if (rows) return;
        let live = true;
        load()
            .then((r) => live && setCodes(r))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, []);

    const byCode = useMemo(() => new Map(codes.map((c) => [c.code, c])), [codes]);
    const activeCodes = useMemo(() => codes.filter((c) => c.active), [codes]);

    const styleOf = useCallback(
        (code: ShiftCode): ShiftStyle => {
            const row = byCode.get(code);
            return row
                ? { bg: row.bg, fg: row.fg, label: row.label, blankInGrid: row.blank_in_grid }
                : { ...NEUTRAL, label: code };
        },
        [byCode],
    );

    return { codes, activeCodes, styleOf };
}
