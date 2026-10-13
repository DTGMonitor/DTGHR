import type { ChannelMonth } from "@/services/ticketService";

/*
 * How requests reach IT, month by month: the share raised through the portal
 * against those Bintang logged from WhatsApp, in person, by phone or by
 * email. The point of logging those is to see this share grow as staff move
 * onto the platform.
 *
 * One bar per month, the portal part filled. A share, not a count, so a quiet
 * month and a busy one read on the same scale; the count is beside it.
 */

const OTHER: { key: keyof ChannelMonth; label: string }[] = [
    { key: "whatsapp", label: "WhatsApp" },
    { key: "in_person", label: "in person" },
    { key: "phone", label: "phone" },
    { key: "email", label: "email" },
];

const monthName = (m: string) =>
    new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" });

export default function ChannelShare({ months }: { months: ChannelMonth[] }) {
    if (!months.some((m) => m.total > 0)) return null;
    return (
        <section className="dtg-panel px-5 py-4">
            <p className="dtg-eyebrow">How requests arrive</p>
            <h2 className="mt-0.5 text-sm font-semibold text-paper">Raised through the portal, by month</h2>
            <ul className="mt-3 space-y-2">
                {months.map((m) => {
                    const share = m.total ? Math.round((m.portal / m.total) * 100) : null;
                    const others = OTHER.filter((o) => (m[o.key] as number) > 0)
                        .map((o) => `${m[o.key]} ${o.label}`)
                        .join(", ");
                    return (
                        <li
                            key={m.month}
                            title={
                                m.total
                                    ? `${monthName(m.month)}: ${m.portal} of ${m.total} through the portal${others ? `; ${others}` : ""}`
                                    : `${monthName(m.month)}: none raised`
                            }
                            className="grid grid-cols-[5.5rem_1fr_7rem] items-center gap-3 text-xs"
                        >
                            <span className="text-paper-soft">{monthName(m.month)}</span>
                            <span className="relative h-3 rounded-r bg-white/[0.06]">
                                {share !== null && share > 0 && (
                                    <span
                                        className="absolute inset-y-0 left-0 rounded-r bg-signal/80"
                                        style={{ width: `${share}%` }}
                                    />
                                )}
                            </span>
                            <span className="text-right font-mono text-paper">
                                {share === null ? "—" : `${share}%`}
                                <span className="ml-1.5 text-muted">of {m.total}</span>
                            </span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
