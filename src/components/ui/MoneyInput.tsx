import { useEffect, useState } from "react";

/*
 * A money field written the way money is written here: 8.000.000, with a
 * comma before any cents.
 *
 * Nurhuda, September 2026: "di urusan duit ... susah ga ada koma atau aturan
 * penulisan uangnya". A bare 8000000 in a salary field is one zero away from
 * a mistake nobody spots. The field shows the grouped figure while it is
 * typed in and hands the caller a plain number string ("8000000", or
 * "1250.5"), so nothing downstream has to know about the formatting.
 */

/** "8000000.5" -> "8.000.000,5". Empty stays empty. */
export function formatMoney(raw: string): string {
    if (raw === "") return "";
    const [whole, cents] = raw.split(".");
    const grouped = (whole ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return cents === undefined ? grouped : `${grouped},${cents}`;
}

/** What was typed -> a plain number string. Dots are grouping; a comma is the decimal mark. */
export function parseMoney(text: string, allowDecimals: boolean): string {
    const cleaned = text.replace(/[^\d,]/g, "");
    if (!allowDecimals) return cleaned.replace(/,/g, "").replace(/^0+(?=\d)/, "");
    const [whole, ...rest] = cleaned.split(",");
    const digits = (whole ?? "").replace(/^0+(?=\d)/, "");
    // Keep a trailing comma while it is being typed, so "1.250," can become "1.250,5".
    return rest.length ? `${digits}.${rest.join("").slice(0, 2)}` : digits;
}

const toRaw = (value: string | number | null | undefined) =>
    value === null || value === undefined ? "" : String(value);

/** Drop a decimal point with nothing after it yet. */
const settle = (raw: string) => (raw.endsWith(".") ? raw.slice(0, -1) : raw);

export default function MoneyInput({
    value,
    onChange,
    onCommit,
    prefix = "Rp",
    allowDecimals = false,
    className = "",
    placeholder = "0",
    id,
    disabled,
}: {
    /** A plain number, or its string. */
    value: string | number | null | undefined;
    /** Every keystroke, as a plain number string. */
    onChange?: (raw: string) => void;
    /** On leaving the field -- for forms that save as they go. */
    onCommit?: (raw: string) => void;
    /** Shown inside the field. Null for none, where a currency is chosen beside it. */
    prefix?: string | null;
    /** Rupiah salaries are whole; a contract in AUD may have cents. */
    allowDecimals?: boolean;
    className?: string;
    placeholder?: string;
    id?: string;
    disabled?: boolean;
}) {
    const [raw, setRaw] = useState(toRaw(value));

    // Follow the caller when the value changes from outside, e.g. a figure
    // filled in automatically -- but not when it is only this field's own
    // keystroke coming back, which would eat a half-typed decimal comma.
    useEffect(() => {
        const incoming = toRaw(value);
        setRaw((mine) => (settle(mine) === incoming ? mine : incoming));
    }, [value]);

    const display = raw.endsWith(".")
        ? `${formatMoney(raw.slice(0, -1))},`
        : formatMoney(raw);

    return (
        <div className="relative">
            {prefix && (
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted">
                    {prefix}
                </span>
            )}
            <input
                id={id}
                type="text"
                inputMode={allowDecimals ? "decimal" : "numeric"}
                value={display}
                disabled={disabled}
                placeholder={placeholder}
                onChange={(e) => {
                    const next = parseMoney(e.target.value, allowDecimals);
                    setRaw(next);
                    onChange?.(settle(next));
                }}
                onBlur={() => {
                    const settled = settle(raw);
                    if (settled !== raw) setRaw(settled);
                    onCommit?.(settled);
                }}
                className={`${className} font-mono ${prefix ? "pl-9" : ""}`}
            />
        </div>
    );
}
