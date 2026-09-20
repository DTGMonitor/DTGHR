import type { ReactNode } from "react";
import { Wordmark, PixelMark } from "@/components/brand/Logo";

/**
 * Framing for the unauthenticated screens (sign in, first-run password).
 *
 * A split layout in the marketing site's idiom: a deep teal brand band carrying
 * the wordmark and strapline, and the form itself on the darker canvas. Below
 * `lg` the band collapses to a compact header so the form stays above the fold
 * on a phone.
 */
export default function AuthShell({
    eyebrow,
    title,
    subtitle,
    children,
}: {
    eyebrow: string;
    title: string;
    subtitle: string;
    children: ReactNode;
}) {
    return (
        <div className="min-h-screen bg-night lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            {/* ── Brand band ─────────────────────────────────────────────── */}
            <aside className="relative overflow-hidden border-b border-white/10 bg-band px-6 py-8 lg:flex lg:flex-col lg:justify-between lg:border-b-0 lg:border-r lg:px-12 lg:py-14">
                {/* Pixel-dissolve wash, echoing the logo's left edge. */}
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 opacity-[0.07]"
                    style={{
                        backgroundImage:
                            "radial-gradient(circle at 1px 1px, #F4F0E7 1px, transparent 0)",
                        backgroundSize: "14px 14px",
                        maskImage: "linear-gradient(115deg, #000 0%, transparent 62%)",
                        WebkitMaskImage: "linear-gradient(115deg, #000 0%, transparent 62%)",
                    }}
                />

                {/* The wordmark's own strapline is baked in at ~7px and is
                    unreadable at any size that fits here, so the plain "mark"
                    file is used and the strapline set as real text. */}
                <div className="relative">
                    <Wordmark className="h-8 lg:h-11" />
                    {/* Tracking is eased off on narrow screens: at 0.22em this
                        line is ~400px, which wraps awkwardly on a phone. */}
                    <p className="mt-3 text-[0.625rem] font-semibold uppercase tracking-label text-teal-100/60 sm:text-micro sm:tracking-eyebrow lg:mt-4">
                        Digital Twin Geotechnical Monitoring
                    </p>
                </div>

                {/* Pitch and footer travel together at the foot of the band, so
                    the panel reads as a hero rather than three stranded blocks. */}
                <div className="relative hidden lg:block">
                    <p className="dtg-eyebrow">Integrated Data</p>
                    <p className="mt-3 max-w-sm text-2xl font-semibold leading-tight tracking-tight text-paper">
                        Informed decisions,
                        <br />
                        from the field to the board.
                    </p>
                    <p className="mt-4 max-w-sm text-sm leading-relaxed text-teal-100/70">
                        Independent geotechnical monitoring, analytics, governance and
                        decision support.
                    </p>

                    <div className="mt-10 flex items-center gap-2.5 border-t border-white/10 pt-5 text-paper-warm/50">
                        <PixelMark className="h-3.5 w-3.5" />
                        <p className="text-micro font-semibold uppercase tracking-label">HR Hub</p>
                    </div>
                </div>
            </aside>

            {/* ── Form ───────────────────────────────────────────────────── */}
            <main className="flex items-center justify-center px-4 py-10 sm:px-8 lg:py-14">
                <div className="dtg-fade-in w-full max-w-md">
                    <p className="dtg-eyebrow">{eyebrow}</p>
                    <h1 className="mt-2.5 text-2xl font-bold tracking-tight text-paper">
                        {title}
                    </h1>
                    <p className="mt-1.5 text-sm text-paper-soft">{subtitle}</p>

                    <div className="dtg-panel mt-7 p-6 shadow-panel sm:p-8">{children}</div>
                </div>
            </main>
        </div>
    );
}
