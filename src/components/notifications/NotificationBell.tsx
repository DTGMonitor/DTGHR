import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { useNotifications } from "@/contexts/NotificationsContext";
import { badgeText, type AppNotification } from "@/lib/notifications";
import NotificationItem from "./NotificationItem";

/*
 * The header bell, from `lg` up. Below that the drawer carries a
 * "Notifications" entry instead and the drawer button a dot (Header,
 * Sidebar), so there is one place to look at each width and never two
 * badges with the same number.
 */
export default function NotificationBell() {
    const { unread, recent, loading, markRead, markAllRead } = useNotifications();
    const [open, setOpen] = useState(false);
    const navigate = useNavigate();
    const wrapRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOpen(false);
                buttonRef.current?.focus();
            }
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const openItem = (n: AppNotification) => {
        setOpen(false);
        if (!n.read_at) void markRead([n.id]);
        navigate(n.payload.link.path || "/");
    };

    const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

    return (
        <div ref={wrapRef} className="relative hidden lg:block">
            <button
                ref={buttonRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-label={label}
                aria-expanded={open}
                aria-haspopup="true"
                className={`relative rounded p-2 transition-colors hover:bg-white/5 hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal ${
                    open ? "bg-white/5 text-paper" : "text-paper-soft"
                }`}
            >
                <Bell className="h-5 w-5" strokeWidth={1.75} />
                {unread > 0 && (
                    <span
                        aria-hidden="true"
                        className="absolute -right-0.5 -top-0.5 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-danger px-1 font-mono text-[0.625rem] font-bold leading-none text-deep ring-2 ring-deep"
                    >
                        {badgeText(unread)}
                    </span>
                )}
            </button>

            {open && (
                <div
                    role="dialog"
                    aria-label="Notifications"
                    className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[24rem] overflow-hidden rounded border border-white/12 bg-surface shadow-2xl shadow-black/40"
                >
                    <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-3">
                        <p className="text-sm font-semibold text-paper">Notifications</p>
                        {unread > 0 && (
                            <button
                                type="button"
                                onClick={() => void markAllRead()}
                                className="text-xs font-semibold text-signal hover:underline"
                            >
                                Mark all read
                            </button>
                        )}
                    </div>

                    <div className="max-h-[min(28rem,calc(100vh-10rem))] divide-y divide-white/[0.06] overflow-y-auto">
                        {loading && recent.length === 0 ? (
                            <div className="space-y-2 p-4">
                                {[0, 1, 2].map((i) => (
                                    <div key={i} className="h-12 animate-pulse rounded bg-white/[0.04]" />
                                ))}
                            </div>
                        ) : recent.length === 0 ? (
                            <p className="px-4 py-10 text-center text-sm text-paper-soft">You're all caught up</p>
                        ) : (
                            recent.map((n) => <NotificationItem key={n.id} n={n} onOpen={openItem} />)
                        )}
                    </div>

                    <Link
                        to="/notifications"
                        onClick={() => setOpen(false)}
                        className="block border-t border-white/[0.08] px-4 py-2.5 text-center text-xs font-semibold text-paper-soft transition-colors hover:bg-white/[0.03] hover:text-paper"
                    >
                        See all notifications
                    </Link>
                </div>
            )}
        </div>
    );
}
