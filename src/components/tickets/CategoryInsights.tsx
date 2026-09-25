import type { CategorySummary, TicketCategory } from "@/services/ticketService";

/*
 * IT support by category: how many, and how long they took.
 *
 * Nurhuda, September 2026: "sbrp banyak per categorynya ... grafiknya dan ...
 * brp lama penyelesaiannya per category dan ticketnya. jd enak main KPI dan
 * tracking" -- for her, Peter, Mark, Bintang and his manager.
 *
 * Two bar charts, one measure each: a count and a duration do not share an
 * axis. Horizontal, because the category names are words. One colour, since
 * every bar is the same kind of thing and the label beside it says which --
 * colour is not carrying identity here, so nothing depends on telling hues
 * apart. The table underneath holds the same figures and more, for anyone
 * who would rather read numbers than bars.
 */

export const CATEGORY_NAMES: Record<TicketCategory, string> = {
    connection: "Connectivity",
    hardware: "Hardware",
    software: "Software",
    access: "Account & sign-in",
    access_request: "Access request",
    other: "Other",
};

/** "45 min", "3.5 h", "2.1 days". */
export function duration(hours: number): string {
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
    if (hours < 48) return `${hours.toFixed(1).replace(/\.0$/, "")} h`;
    return `${(hours / 24).toFixed(1).replace(/\.0$/, "")} days`;
}

function Bars({
    title,
    rows,
    format,
    empty,
}: {
    title: string;
    rows: { key: string; label: string; value: number | null; tip: string }[];
    format: (v: number) => string;
    empty: string;
}) {
    const max = Math.max(0, ...rows.map((r) => r.value ?? 0));
    return (
        <figure className="dtg-panel-inset px-4 py-3.5">
            <figcaption className="dtg-eyebrow">{title}</figcaption>
            {max === 0 ? (
                <p className="mt-3 text-micro text-muted">{empty}</p>
            ) : (
                <ul className="mt-3 space-y-2">
                    {rows.map((r) => (
                        <li
                            key={r.key}
                            // The whole row is the hover target, not the bar
                            // alone: a short bar is a small thing to aim at.
                            title={r.tip}
                            className="group grid grid-cols-[8.5rem_1fr_4.5rem] items-center gap-3 rounded px-1 py-0.5 hover:bg-white/[0.03]"
                        >
                            <span className="truncate text-xs text-paper-soft">{r.label}</span>
                            <span className="relative h-3">
                                {r.value !== null && r.value > 0 && (
                                    <span
                                        className="absolute inset-y-0 left-0 rounded-r bg-signal/80 transition-colors group-hover:bg-signal"
                                        style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}
                                    />
                                )}
                            </span>
                            <span className="text-right font-mono text-xs text-paper">
                                {r.value === null ? "—" : format(r.value)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </figure>
    );
}

export default function CategoryInsights({ categories }: { categories: CategorySummary[] }) {
    const total = categories.reduce((n, c) => n + c.raised, 0);
    const resolved = categories.reduce((n, c) => n + c.resolved, 0);

    return (
        <section className="dtg-panel overflow-hidden">
            <header className="border-b border-white/[0.08] px-5 py-3.5">
                <p className="dtg-eyebrow">By category</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">
                    {total} request{total === 1 ? "" : "s"} raised · {resolved} resolved
                </h2>
                <p className="mt-1 text-micro leading-relaxed text-muted">
                    Time to resolve runs from when a request is submitted to when it is marked
                    resolved, in calendar time.
                </p>
            </header>

            <div className="grid gap-3 p-5 lg:grid-cols-2">
                <Bars
                    title="Requests raised"
                    rows={categories.map((c) => ({
                        key: c.category,
                        label: CATEGORY_NAMES[c.category],
                        value: c.raised,
                        tip: `${CATEGORY_NAMES[c.category]}: ${c.raised} raised, ${c.open} open, ${c.resolved} resolved, ${c.closed} closed`,
                    }))}
                    format={(v) => String(v)}
                    empty="No requests raised yet."
                />
                <Bars
                    title="Average time to resolve"
                    rows={categories.map((c) => ({
                        key: c.category,
                        label: CATEGORY_NAMES[c.category],
                        value: c.average_hours,
                        tip:
                            c.average_hours === null
                                ? `${CATEGORY_NAMES[c.category]}: none resolved yet`
                                : `${CATEGORY_NAMES[c.category]}: ${duration(c.average_hours)} on average, longest ${duration(c.longest_hours ?? 0)}, over ${c.resolved} resolved`,
                    }))}
                    format={duration}
                    empty="Nothing resolved yet."
                />
            </div>

            {/* The same figures as a table, and the ones the charts leave out. */}
            <div className="overflow-x-auto border-t border-white/[0.08]">
                <table className="w-full min-w-[40rem] text-left text-xs">
                    <thead className="text-micro uppercase tracking-label text-muted">
                        <tr className="border-b border-white/[0.08]">
                            <th className="px-5 py-2 font-semibold">Category</th>
                            <th className="px-3 py-2 text-right font-semibold">Raised</th>
                            <th className="px-3 py-2 text-right font-semibold">Open</th>
                            <th className="px-3 py-2 text-right font-semibold">Resolved</th>
                            <th className="px-3 py-2 text-right font-semibold">Closed</th>
                            <th className="px-3 py-2 text-right font-semibold">Avg. to resolve</th>
                            <th className="px-5 py-2 text-right font-semibold">Longest</th>
                        </tr>
                    </thead>
                    <tbody className="text-paper-soft">
                        {categories.map((c) => (
                            <tr key={c.category} className="border-b border-white/[0.04] last:border-0">
                                <td className="px-5 py-1.5">
                                    <span className="mr-2 font-mono text-micro text-muted">{c.prefix}</span>
                                    {CATEGORY_NAMES[c.category]}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono">{c.raised}</td>
                                <td className="px-3 py-1.5 text-right font-mono">{c.open}</td>
                                <td className="px-3 py-1.5 text-right font-mono">{c.resolved}</td>
                                <td className="px-3 py-1.5 text-right font-mono">{c.closed}</td>
                                <td className="px-3 py-1.5 text-right font-mono">
                                    {c.average_hours === null ? "—" : duration(c.average_hours)}
                                </td>
                                <td className="px-5 py-1.5 text-right font-mono">
                                    {c.longest_hours === null ? "—" : duration(c.longest_hours)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
