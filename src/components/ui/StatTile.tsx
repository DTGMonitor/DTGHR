import Icon, { type IconName } from "./icons";

/**
 * A single headline figure.
 *
 * Deliberately flat: a hairline panel, a 2px accent rule down the left, the
 * number set large in the mono face. The marketing site marks its data blocks
 * the same way, and it keeps a row of tiles legible without the four competing
 * colour gradients the dashboard used to carry.
 *
 * `accent` names the meaning, not the colour, so a tile can be recoloured in
 * one place when the palette moves.
 */

export type StatAccent = "data" | "action" | "attention" | "neutral";

const ACCENTS: Record<StatAccent, { rule: string; icon: string }> = {
    /** Measured quantities — headcount, totals. */
    data: { rule: "border-l-teal-300", icon: "text-teal-300" },
    /** Something good / available — approved, remaining balance. */
    action: { rule: "border-l-signal", icon: "text-signal" },
    /** Something waiting on a human — pending approvals. */
    attention: { rule: "border-l-gold", icon: "text-gold" },
    neutral: { rule: "border-l-teal-700", icon: "text-teal-500" },
};

export interface StatTileProps {
    label: string;
    value: string | number;
    /** Secondary line under the figure, e.g. "of 12 days". */
    sub?: string;
    icon: IconName;
    accent?: StatAccent;
    /** Optional trailing detail, e.g. a delta or a link. */
    footer?: React.ReactNode;
}

export default function StatTile({
    label,
    value,
    sub,
    icon,
    accent = "neutral",
    footer,
}: StatTileProps) {
    const tone = ACCENTS[accent];

    return (
        <div
            className={`flex flex-col justify-between rounded-2xl border border-white/10 border-l-2 bg-surface p-5 transition-colors hover:bg-surface-raised ${tone.rule}`}
        >
            <div className="flex items-start justify-between gap-3">
                <p className="dtg-eyebrow text-paper-soft">{label}</p>
                <Icon name={icon} className={`h-[1.125rem] w-[1.125rem] flex-shrink-0 ${tone.icon}`} />
            </div>

            <div className="mt-4">
                <p className="font-mono text-3xl font-semibold leading-none tracking-tight text-paper">
                    {value}
                </p>
                {sub && <p className="mt-1.5 text-xs text-muted">{sub}</p>}
            </div>

            {footer && <div className="mt-3 border-t border-white/[0.08] pt-3">{footer}</div>}
        </div>
    );
}

/** Matching placeholder, so the grid does not reflow when data lands. */
export function StatTileSkeleton() {
    return (
        <div className="h-[8.5rem] animate-pulse rounded-2xl border border-white/10 border-l-2 border-l-teal-700/40 bg-surface/60" />
    );
}
