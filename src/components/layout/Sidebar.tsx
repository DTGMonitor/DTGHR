import { NavLink } from "react-router-dom";
/*
 * A drawn icon set rather than SVG paths pasted in one at a time.
 *
 * The old ones were hand-copied `d` attributes, picked separately as each
 * feature was added, so the weights and the metaphors drifted — Nurhuda:
 * "seems like AI generated and not interesting". These are one family, with
 * one stroke weight, and each says what its page is: a signed document for
 * contracts, a banknote for salary, a newspaper for the bulletin, a clock on
 * a calendar for the roster.
 */
import {
    Award,
    Banknote,
    Calculator,
    BarChart3,
    CalendarClock,
    CalendarDays,
    FileSignature,
    History,
    LayoutDashboard,
    Newspaper,
    ReceiptText,
    Settings2,
    LifeBuoy,
    UserRound,
    Users,
    Wallet,
    type LucideIcon,
} from "lucide-react";
import { PixelMark } from "@/components/brand/Logo";
import { useAuth } from "@/contexts/AuthContext";

interface NavItem {
    label: string;
    to: string;
    Icon: LucideIcon;
    /** Management only — the staff directory and the activity log. */
    managementOnly?: boolean;
    /** The KPI review chain: director and executive. */
    reviewChainOnly?: boolean;
    /** HR administration. */
    adminOnly?: boolean;
    /** Anybody who is assessed, which is everybody but the founders. */
    assessedOnly?: boolean;
    /** Bulletin authors, whoever they happen to be. */
    authorOnly?: boolean;
    /** Finance, who prepares the payroll, and the two who approve it. */
    salaryChainOnly?: boolean;
    /** The two founders only — deciding whether a salary should change. */
    foundersOnly?: boolean;
    /** Management, plus anybody delegated the employee records. */
    directoryOnly?: boolean;
    /** Management, plus anybody delegated the contracts. */
    contractsOnly?: boolean;
}

const navItems: NavItem[] = [
    { label: "Dashboard", to: "/", Icon: LayoutDashboard },
    {
        // The staff directory carries statutory identifiers, bank details and
        // home addresses. Management and whoever maintains the records;
        // everyone else has "My profile" instead.
        label: "Employees",
        to: "/employees",
        directoryOnly: true,
        Icon: Users,
    },
    { label: "Leave", to: "/leaves", Icon: CalendarDays },
    {
        // Scorecards are limited to the review chain, so the link is hidden
        // rather than shown and then refused.
        label: "KPI Achievement",
        to: "/kpi",
        reviewChainOnly: true,
        Icon: BarChart3,
    },
    { label: "Roster", to: "/schedules", Icon: CalendarClock },
    {
        // Your own result, once it has been released to you. Distinct from
        // "KPI", which is the reviewer's workbench — Nurhuda has both,
        // because she assesses the team and is assessed by Peter.
        label: "My Achievement",
        to: "/my-scorecard",
        assessedOnly: true,
        Icon: Award,
    },
    {
        // The director proposes, the executive approves. Everybody else gets
        // 404 from the API, so the entry is absent rather than present and
        // refusing.
        //
        // The founders', not finance's. Whether somebody's salary should move
        // is their decision; finance meets the outcome on the payroll.
        label: "Salary",
        to: "/salary",
        foundersOnly: true,
        Icon: Banknote,
    },
    {
        // The month that is actually paid, as the salaries workbook has it.
        // Himawan prepares it; the two people who sign for money read it.
        // Distinct from "Pay forecast", which is next year and hypothetical.
        label: "Payroll",
        to: "/payroll",
        salaryChainOnly: true,
        Icon: ReceiptText,
    },
    {
        // Petty cash, tax, BPJS and the rest: what Himawan asks to pay out
        // each month, reviewed and approved like the payroll. The same three
        // people, so the same rule.
        label: "Finance requests",
        to: "/finance-requests",
        salaryChainOnly: true,
        Icon: Wallet,
    },
    {
        // What a pay decision costs, before anybody takes it. Management
        // and administrators: the question is what the company spends.
        label: "Pay forecast",
        to: "/compensation",
        managementOnly: true,
        Icon: Calculator,
    },
    {
        // Manpower, subscriptions and clients. Management reads them; the flag
        // adds and acknowledges.
        label: "Contracts",
        to: "/contracts",
        contractsOnly: true,
        Icon: FileSignature,
    },
    {
        // A record rather than news. It sat on the dashboard, where it was the
        // first thing everybody read every morning and where the staff
        // bulletin belongs.
        label: "Activity log",
        to: "/activity",
        managementOnly: true,
        Icon: History,
    },
    {
        // Writing the bulletin, not reading it. Readers meet it on the
        // dashboard; this is the desk it is written at, and it follows the
        // author flag rather than anybody's rank.
        label: "Bulletin",
        to: "/bulletin",
        authorOnly: true,
        Icon: Newspaper,
    },
    {
        // Everybody. Something being broken is not a rank, and a support queue
        // only half the company can reach is one half the company works around
        // by messaging somebody directly.
        label: "IT support",
        to: "/support",
        Icon: LifeBuoy,
    },
    {
        // The platform administrator only -- the director -- to match what
        // the page and the server allow. Peter and Mark are superusers as
        // management, but Nurhuda: "better to hide setting for peter and mark
        // ... so only admin can control it".
        label: "Settings",
        to: "/settings",
        adminOnly: true,
        Icon: Settings2,
    },
];

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { user } = useAuth();
    const inReviewChain = user?.role === "director" || user?.role === "executive";

    /*
     * The staff directory is management's. Everyone else never sees it.
     *
     * "My profile" is its own entry rather than a relabelled directory,
     * because management need both: the directory to administer other people,
     * and their own record like anybody else. It sits directly under
     * Employees so the pair reads as "everyone / me".
     */
    const isManagement = Boolean(user?.is_management) || inReviewChain;
    // The platform administrator: the director, not every superuser.
    const isAdmin = user?.role === "director";
    const canWrite = Boolean(user?.can_write_articles);
    /* Founders are not assessed, so they have no scorecard to read. */
    const isAssessed = Boolean(user?.employee_id) && !user?.is_founder;
    const inSalaryChain =
        user?.role === "finance" || user?.role === "director" || user?.role === "executive";

    const items = navItems
        .filter((item) => !item.reviewChainOnly || inReviewChain)
        .filter((item) => !item.managementOnly || isManagement)
        .filter((item) => !item.adminOnly || isAdmin)
        .filter((item) => !item.authorOnly || canWrite)
        .filter((item) => !item.assessedOnly || isAssessed)
        .filter((item) => !item.salaryChainOnly || inSalaryChain)
        .filter((item) => !item.foundersOnly || inReviewChain)
        .filter(
            (item) =>
                !item.contractsOnly ||
                isManagement ||
                Boolean(user?.can_manage_contracts),
        )
        .filter(
            (item) =>
                !item.directoryOnly ||
                isManagement ||
                Boolean(user?.can_manage_people),
        );

    const myProfile = user?.employee_id
        ? {
              label: "My profile",
              to: `/employees/${user.employee_id}`,
              Icon: UserRound,
          }
        : null;

    /* Straight after Employees, or first when there is no directory to sit
       under. Not appended at the end: "my own record" belongs with people,
       not below the roster. */
    const showsDirectory = items.some((i) => i.to === "/employees");
    const navList = myProfile
        ? [
              ...items.slice(0, showsDirectory ? 2 : 1),
              myProfile,
              ...items.slice(showsDirectory ? 2 : 1),
          ]
        : items;

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
                        {navList.map((item) => (
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
                                        <item.Icon
                                            className={`h-[1.125rem] w-[1.125rem] flex-shrink-0 transition-colors ${
                                                isActive
                                                    ? "text-signal"
                                                    : "text-teal-500 group-hover:text-teal-300"
                                            }`}
                                            strokeWidth={1.75}
                                        />
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
