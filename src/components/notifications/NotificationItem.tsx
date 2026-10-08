import { relativeTime, type AppNotification, type NotificationTone } from "@/lib/notifications";

/*
 * One notification, as the bell's list and the notifications page show it.
 * The tone is a 2px left rule and the eyebrow colour -- the same device the
 * sidebar uses for the live page -- so a list of them reads at a glance:
 * green waiting on you or good news, red sent back or refused, gold a date
 * coming up. Unread carries a dot and full-strength text; an action item that
 * someone has since dealt with is muted and says so.
 */

const TONE: Record<NotificationTone, { rule: string; eyebrow: string }> = {
    action: { rule: "border-signal", eyebrow: "text-signal" },
    success: { rule: "border-signal", eyebrow: "text-signal" },
    danger: { rule: "border-danger", eyebrow: "text-danger" },
    reminder: { rule: "border-gold", eyebrow: "text-gold" },
};

export function isSettled(n: AppNotification): boolean {
    return n.resolved_at !== null && n.payload.tone === "action";
}

export default function NotificationItem({
    n,
    full = false,
    onOpen,
}: {
    n: AppNotification;
    /** The notifications page shows the intro, details and note too. */
    full?: boolean;
    onOpen: (n: AppNotification) => void;
}) {
    const tone = TONE[n.payload.tone] ?? TONE.action;
    const settled = isSettled(n);
    const unread = n.read_at === null;
    const p = n.payload;

    return (
        <button
            type="button"
            onClick={() => onOpen(n)}
            className={`group block w-full border-l-2 py-3 pl-4 pr-4 text-left transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.06] focus-visible:outline-none ${
                settled ? "border-white/15" : tone.rule
            }`}
        >
            <div className="flex items-start gap-3">
                <div className={`min-w-0 flex-1 ${settled ? "opacity-60" : ""}`}>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {p.eyebrow && (
                            <span
                                className={`text-micro font-semibold uppercase tracking-label ${
                                    settled ? "text-muted" : tone.eyebrow
                                }`}
                            >
                                {p.eyebrow}
                            </span>
                        )}
                        {settled && (
                            <span className="rounded-sm border border-white/12 px-1.5 text-micro font-medium text-paper-soft">
                                No action needed
                            </span>
                        )}
                    </p>
                    <p
                        className={`mt-0.5 text-sm ${full ? "" : "line-clamp-2"} ${
                            unread ? "font-semibold text-paper" : "text-paper-soft"
                        }`}
                    >
                        {p.headline}
                    </p>

                    {full && p.intro && <p className="mt-1.5 text-sm text-paper-soft">{p.intro}</p>}

                    {full && p.details && p.details.length > 0 && (
                        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                            {p.details.map(([k, v]) => (
                                <div key={k} className="contents">
                                    <dt className="text-muted">{k}</dt>
                                    <dd className="whitespace-pre-line text-paper">{v}</dd>
                                </div>
                            ))}
                        </dl>
                    )}

                    {full && p.note && (
                        <blockquote className="mt-2.5 border-l-2 border-white/15 bg-deep/40 px-3 py-2 text-sm text-paper">
                            {p.note.by && <p className="text-micro font-semibold text-paper-soft">{p.note.by} wrote</p>}
                            <p className="whitespace-pre-line">{p.note.text}</p>
                        </blockquote>
                    )}

                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 font-mono text-micro text-muted">
                        <time dateTime={n.created_at} title={new Date(n.created_at).toLocaleString("en-GB")}>
                            {relativeTime(n.created_at)}
                        </time>
                        {full && (
                            <span className="font-sans text-xs font-semibold text-signal group-hover:underline">
                                {p.link.label} →
                            </span>
                        )}
                    </p>
                </div>
                {unread && (
                    <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-signal" aria-label="Unread" />
                )}
            </div>
        </button>
    );
}
