import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Bell } from "lucide-react";
import NotificationItem from "@/components/notifications/NotificationItem";
import { useNotifications } from "@/contexts/NotificationsContext";
import { listNotifications, type AppNotification, type NotificationFilter } from "@/lib/notifications";

/*
 * Every notification you have had, newest first. "Needs action" is the
 * approvals and tickets still waiting on you, read or not -- what the
 * dashboard's summary links to. On a phone this is where the drawer's
 * Notifications entry leads; on a desktop, the bell's "See all".
 */

const PAGE = 20;

const FILTERS: { value: NotificationFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread" },
    { value: "action", label: "Needs action" },
];

const EMPTY: Record<NotificationFilter, string> = {
    all: "You have no notifications yet.",
    unread: "You're all caught up.",
    action: "Nothing is waiting for you.",
};

export default function NotificationsPage() {
    const [params, setParams] = useSearchParams();
    const raw = params.get("filter");
    const filter: NotificationFilter = raw === "unread" || raw === "action" ? raw : "all";
    const { unread, version, markRead, markAllRead } = useNotifications();
    const navigate = useNavigate();

    const [rows, setRows] = useState<AppNotification[]>([]);
    const [loading, setLoading] = useState(true);
    const [more, setMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reload the pages already shown, so a live change lands in place.
    const load = useCallback(
        async (count: number) => {
            try {
                const got = await listNotifications({ filter, limit: count + 1 });
                setRows(got.slice(0, count));
                setMore(got.length > count);
                setError(null);
            } catch (e) {
                setError(e instanceof Error ? e.message : "Could not load notifications.");
            } finally {
                setLoading(false);
            }
        },
        [filter],
    );

    useEffect(() => {
        setLoading(true);
        void load(PAGE);
    }, [load]);

    // Something changed (Realtime or a poll): refresh what is on screen.
    useEffect(() => {
        if (version > 0) void load(Math.max(PAGE, rows.length));
    }, [version]);

    const loadMore = async () => {
        try {
            const got = await listNotifications({ filter, limit: PAGE + 1, offset: rows.length });
            setRows((r) => [...r, ...got.slice(0, PAGE)]);
            setMore(got.length > PAGE);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load notifications.");
        }
    };

    const openItem = (n: AppNotification) => {
        if (!n.read_at) void markRead([n.id]);
        navigate(n.payload.link.path || "/");
    };

    return (
        <div className="dtg-fade-in space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Inbox</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">Notifications</h1>
                    <p className="mt-1.5 text-sm text-paper-soft">
                        What has happened that concerns you, and what is waiting for you.
                    </p>
                </div>
                {unread > 0 && (
                    <button type="button" onClick={() => void markAllRead()} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                        Mark all read
                    </button>
                )}
            </div>

            <section className="dtg-panel overflow-hidden">
                <div role="tablist" aria-label="Show" className="flex gap-1 border-b border-white/[0.08] px-3 pt-2">
                    {FILTERS.map((f) => (
                        <button
                            key={f.value}
                            role="tab"
                            type="button"
                            aria-selected={filter === f.value}
                            onClick={() => setParams(f.value === "all" ? {} : { filter: f.value }, { replace: true })}
                            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                                filter === f.value
                                    ? "border-signal font-semibold text-paper"
                                    : "border-transparent text-paper-soft hover:text-paper"
                            }`}
                        >
                            {f.label}
                            {f.value === "unread" && unread > 0 && (
                                <span className="ml-1.5 font-mono text-micro text-muted">{unread}</span>
                            )}
                        </button>
                    ))}
                </div>

                {error && <p className="border-b border-white/[0.08] px-5 py-3 text-sm text-danger">{error}</p>}

                {loading ? (
                    <div className="space-y-2 p-5">
                        {[0, 1, 2, 3].map((i) => (
                            <div key={i} className="h-16 animate-pulse rounded bg-white/[0.04]" />
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    <div className="px-5 py-14 text-center">
                        <Bell className="mx-auto h-8 w-8 text-teal-700" strokeWidth={1.5} />
                        <p className="mt-3 text-sm text-paper-soft">{EMPTY[filter]}</p>
                    </div>
                ) : (
                    <div className="divide-y divide-white/[0.06]">
                        {rows.map((n) => (
                            <NotificationItem key={n.id} n={n} full onOpen={openItem} />
                        ))}
                    </div>
                )}

                {more && !loading && (
                    <div className="border-t border-white/[0.08] px-5 py-3 text-center">
                        <button type="button" onClick={() => void loadMore()} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                            Load more
                        </button>
                    </div>
                )}
            </section>
        </div>
    );
}
