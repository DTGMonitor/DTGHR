import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import AuthImage from "@/components/articles/AuthImage";
import PhotoPreview from "@/components/employees/PhotoPreview";
import { employeeService } from "@/services/employeeService";
import { Link, useNavigate } from "react-router-dom";
import { ProductLockup } from "@/components/brand/Logo";
import NotificationBell from "@/components/notifications/NotificationBell";
import { useNotifications } from "@/contexts/NotificationsContext";

function initials(name?: string): string {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase() || "?";
}

export default function Header({
    onMenuClick,
    navOpen,
}: {
    onMenuClick: () => void;
    navOpen: boolean;
}) {
    const { user, logout } = useAuth();
    const { unread } = useNotifications();
    const navigate = useNavigate();
    const [previewing, setPreviewing] = useState(false);

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    return (
        <header className="fixed inset-x-0 top-0 z-40 flex h-[var(--dtg-header-height)] items-center justify-between gap-4 border-b border-white/10 bg-deep px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
                {/* Drawer toggle — the sidebar is permanent from lg up. */}
                <button
                    type="button"
                    onClick={onMenuClick}
                    aria-label={
                        (navOpen ? "Close navigation" : "Open navigation") +
                        (unread > 0 ? `, ${unread} unread notification${unread === 1 ? "" : "s"}` : "")
                    }
                    aria-expanded={navOpen}
                    className="relative -ml-1 rounded p-2 text-paper-soft transition-colors hover:bg-white/5 hover:text-paper lg:hidden"
                >
                    {/* Below lg the notifications live in the drawer; the dot
                        says there is something in there. No number: that is
                        on the entry inside. */}
                    {unread > 0 && (
                        <span
                            aria-hidden="true"
                            className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-deep"
                        />
                    )}
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                        {navOpen ? (
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
                        )}
                    </svg>
                </button>

                {/* The logo goes home, as it does on most sites -- Nurhuda
                    asked for it for every account. The Dashboard is "/"
                    for everybody; what it shows is decided there. */}
                <Link
                    to="/"
                    aria-label="Go to the dashboard"
                    className="min-w-0 rounded transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                >
                    <ProductLockup className="min-w-0" />
                </Link>
            </div>

            <div className="flex items-center gap-3">
                <NotificationBell />

                <div className="hidden min-w-0 text-right sm:block">
                    <p className="truncate text-sm font-medium text-paper">{user?.full_name}</p>
                    <p className="truncate font-mono text-micro text-muted">{user?.email}</p>
                </div>

                {/* Avatar. Square-ish and teal — DTG never uses round gradient
                    blobs. The person's photo, cropped to the face, where they
                    have one; initials otherwise. Click to see it full size. */}
                <button
                    type="button"
                    onClick={() => user?.employee_id && setPreviewing(true)}
                    disabled={!user?.employee_id}
                    aria-label="View your photo"
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded border border-teal-300/25 bg-teal-900 font-mono text-xs font-semibold tracking-wider text-teal-100 enabled:cursor-zoom-in"
                    title={user?.full_name ?? undefined}
                >
                    {user?.employee_id ? (
                        <AuthImage
                            src={employeeService.photoUrl(user.employee_id)}
                            alt=""
                            className="h-full w-full origin-[50%_18%] scale-[1.7] object-cover object-top"
                            fallback={initials(user?.full_name)}
                        />
                    ) : (
                        initials(user?.full_name)
                    )}
                </button>
                {previewing && user?.employee_id && (
                    <PhotoPreview
                        employeeId={user.employee_id}
                        name={user.full_name}
                        onClose={() => setPreviewing(false)}
                    />
                )}

                <button
                    id="logout-button"
                    onClick={handleLogout}
                    className="rounded border border-white/12 px-3 py-1.5 text-label font-semibold uppercase tracking-label text-paper-soft transition-colors hover:border-danger/50 hover:bg-danger/10 hover:text-danger"
                >
                    <span className="hidden sm:inline">Sign out</span>
                    <svg className="h-4 w-4 sm:hidden" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
                    </svg>
                </button>
            </div>
        </header>
    );
}
