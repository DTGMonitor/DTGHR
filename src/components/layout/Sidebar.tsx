import { NavLink } from "react-router-dom";
import { PixelMark } from "@/components/brand/Logo";

const navItems = [
    {
        label: "Dashboard",
        to: "/",
        icon: (
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
        ),
    },
    {
        label: "Employees",
        to: "/employees",
        icon: (
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
        ),
    },
    {
        label: "Leave",
        to: "/leaves",
        icon: (
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
        ),
    },
    {
        label: "Roster",
        to: "/schedules",
        icon: (
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        ),
    },
];

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
    return (
        <>
            {/* Scrim for the mobile drawer. */}
            <div
                onClick={onClose}
                aria-hidden="true"
                className={`fixed inset-0 top-[var(--dtg-header-height)] z-20 bg-deep/70 transition-opacity lg:hidden ${
                    open ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
            />

            <aside
                className={`fixed left-0 top-[var(--dtg-header-height)] z-30 flex h-[calc(100vh-var(--dtg-header-height))] w-[var(--dtg-sidebar-width)] flex-col border-r border-white/10 bg-surface transition-transform duration-200 ease-out lg:translate-x-0 ${
                    open ? "translate-x-0" : "-translate-x-full"
                }`}
            >
                <nav className="flex-1 overflow-y-auto px-3 py-5">
                    <p className="dtg-eyebrow px-3 pb-3">Workspace</p>

                    <div className="space-y-0.5">
                        {navItems.map((item) => (
                            <NavLink
                                key={item.to}
                                to={item.to}
                                end={item.to === "/"}
                                className={({ isActive }) =>
                                    /* The active marker is a 2px left rule in the signal
                                       colour — the same device the marketing site uses to
                                       mark the live section. */
                                    `group relative flex items-center gap-3 rounded-r border-l-2 py-2.5 pl-4 pr-3 text-sm transition-colors ${
                                        isActive
                                            ? "border-signal bg-white/[0.06] font-semibold text-paper"
                                            : "border-transparent font-medium text-paper-soft hover:border-teal-500 hover:bg-white/[0.03] hover:text-paper"
                                    }`
                                }
                            >
                                {({ isActive }) => (
                                    <>
                                        <svg
                                            className={`h-[1.125rem] w-[1.125rem] flex-shrink-0 transition-colors ${
                                                isActive ? "text-signal" : "text-teal-500 group-hover:text-teal-300"
                                            }`}
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            strokeWidth={1.6}
                                            stroke="currentColor"
                                        >
                                            {item.icon}
                                        </svg>
                                        {item.label}
                                    </>
                                )}
                            </NavLink>
                        ))}
                    </div>
                </nav>

                {/* Footer: the mark plus the strapline, so the brand closes the frame. */}
                <div className="border-t border-white/[0.08] px-4 py-4">
                    <div className="flex items-center gap-2.5 text-paper-warm/70">
                        <PixelMark className="h-4 w-4 flex-shrink-0" />
                        <p className="text-micro font-semibold uppercase tracking-label">
                            Integrated Data.
                            <br />
                            Informed Decisions.
                        </p>
                    </div>
                    <p className="mt-2.5 font-mono text-micro text-muted">HR Hub v0.1.0</p>
                </div>
            </aside>
        </>
    );
}
