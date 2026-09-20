import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Header from "./Header";
import Sidebar from "./Sidebar";

export default function Layout() {
    // The sidebar is permanent from `lg` up and a drawer below it. Previously it
    // was fixed at every width while the content kept a 16rem left margin, so on
    // a phone the nav sat on top of the page and half the table was unreachable.
    const [navOpen, setNavOpen] = useState(false);
    const { pathname } = useLocation();

    // Navigating is the drawer's cue to get out of the way.
    useEffect(() => setNavOpen(false), [pathname]);

    return (
        <div className="min-h-screen bg-night text-paper">
            <Header onMenuClick={() => setNavOpen((open) => !open)} navOpen={navOpen} />
            <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

            {/* The header is `fixed`, so it is out of the document flow and the
                page must reserve its height explicitly — without this the first
                heading on every screen renders underneath it. */}
            <main className="min-h-[calc(100vh-var(--dtg-header-height))] px-4 pb-6 pt-[calc(var(--dtg-header-height)+1.5rem)] sm:px-6 lg:pl-[calc(var(--dtg-sidebar-width)+1.5rem)] lg:pr-6">
                {/* Caps line length on ultrawide monitors. Raised from 1440px:
                    at that width the roster's 31 day-columns were clipped on a
                    perfectly ordinary 1500px laptop, and the cap -- not the
                    table -- was what took the last days of the month away. */}
                <div className="mx-auto max-w-[1760px]">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}
