import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import {
    listNotifications,
    markAllRead as markAllReadRpc,
    markRead as markReadRpc,
    unreadCount,
    type AppNotification,
} from "@/lib/notifications";

/*
 * The signed-in person's notifications, for the bell, the drawer entry and
 * the dashboard: the unread count and the ten most recent.
 *
 * Kept live by a Realtime subscription to their own rows (row-level security
 * applies to it, and the filter keeps the traffic to them). On any change it
 * refetches rather than patching in place, which stays right after a dropped
 * connection. A one-minute poll while the tab is visible covers Realtime
 * being unavailable; at worst the badge is a minute late.
 */

interface NotificationsValue {
    unread: number;
    recent: AppNotification[];
    loading: boolean;
    /** Bumped on every change, so pages holding their own lists know to reload. */
    version: number;
    refresh: () => Promise<void>;
    markRead: (ids: string[]) => Promise<void>;
    markAllRead: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsValue | undefined>(undefined);

const RECENT = 10;
const POLL_MS = 60_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const userId = user?.id ?? null;
    const [unread, setUnread] = useState(0);
    const [recent, setRecent] = useState<AppNotification[]>([]);
    const [loading, setLoading] = useState(true);
    const [version, setVersion] = useState(0);
    const inflight = useRef<Promise<void> | null>(null);

    const refresh = useCallback(async () => {
        if (!userId) return;
        // Bursts of events (one leave approval settles and writes several rows)
        // collapse into the request already under way.
        if (inflight.current) return inflight.current;
        const run = (async () => {
            try {
                const [count, rows] = await Promise.all([unreadCount(), listNotifications({ limit: RECENT })]);
                setUnread(count);
                setRecent(rows);
                setVersion((v) => v + 1);
            } catch {
                // A failed refresh keeps what is shown; the next event or poll retries.
            } finally {
                setLoading(false);
                inflight.current = null;
            }
        })();
        inflight.current = run;
        return run;
    }, [userId]);

    useEffect(() => {
        if (!userId) {
            setUnread(0);
            setRecent([]);
            setLoading(true);
            return;
        }
        void refresh();

        const channel = supabase
            .channel(`notifications:${userId}`)
            .on(
                "postgres_changes",
                { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
                () => void refresh(),
            )
            .subscribe();

        const poll = window.setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
        }, POLL_MS);
        const onVisible = () => {
            if (document.visibilityState === "visible") void refresh();
        };
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            window.clearInterval(poll);
            document.removeEventListener("visibilitychange", onVisible);
            void supabase.removeChannel(channel);
        };
    }, [userId, refresh]);

    const markRead = useCallback(
        async (ids: string[]) => {
            const unreadIds = ids.filter((id) => recent.find((n) => n.id === id)?.read_at == null);
            if (!unreadIds.length && ids.every((id) => recent.some((n) => n.id === id))) return;
            // Shown as read straight away; the refresh confirms it.
            const at = new Date().toISOString();
            setRecent((rows) => rows.map((n) => (ids.includes(n.id) && !n.read_at ? { ...n, read_at: at } : n)));
            setUnread((n) => Math.max(0, n - unreadIds.length));
            try {
                await markReadRpc(ids);
            } finally {
                void refresh();
            }
        },
        [recent, refresh],
    );

    const markAllRead = useCallback(async () => {
        const at = new Date().toISOString();
        setRecent((rows) => rows.map((n) => (n.read_at ? n : { ...n, read_at: at })));
        setUnread(0);
        try {
            await markAllReadRpc();
        } finally {
            void refresh();
        }
    }, [refresh]);

    const value = useMemo(
        () => ({ unread, recent, loading, version, refresh, markRead, markAllRead }),
        [unread, recent, loading, version, refresh, markRead, markAllRead],
    );
    return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
    const ctx = useContext(NotificationsContext);
    if (!ctx) throw new Error("useNotifications must be used within a NotificationsProvider");
    return ctx;
}
