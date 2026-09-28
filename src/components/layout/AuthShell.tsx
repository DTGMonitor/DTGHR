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
                {/* The company's name beside its mark, as on the office wall:
                    the wordmark, a hairline, then the name over two lines. */}
                <div className="relative flex items-center gap-4 lg:gap-5">
                    <Wordmark className="h-9 lg:h-14" />
                    <span aria-hidden="true" className="h-9 w-px bg-white/25 lg:h-12" />
                    <p className="text-[0.6875rem] font-semibold uppercase leading-snug tracking-eyebrow text-teal-100/80 lg:text-sm">
                        Digital Twin
                        <br />
                        Geotechnical
                    </p>
                </div>

                <PhotoCollage />

                {/* Pitch and footer travel together at the foot of the band, so
                    the panel reads as a hero rather than three stranded blocks. */}
                <div className="relative hidden lg:block">
                    <p className="max-w-sm text-2xl font-semibold leading-tight tracking-tight text-paper">
                        Your work life at DTG,
                        <br />
                        in one place.
                    </p>
                    {/* "People" means the staff and the families behind them. */}
                    <p className="mt-2 max-w-sm text-sm text-teal-100/80">
                        For our people — and the families behind them.
                    </p>
                    <p className="mt-4 max-w-sm font-mono text-xs uppercase tracking-label text-teal-100/70">
                        Work · Wellbeing · Rewards · Growth
                    </p>

                    <div className="mt-10 flex items-center gap-2.5 border-t border-white/10 pt-5 text-paper-warm/50">
                        <PixelMark className="h-3.5 w-3.5" />
                        <p className="text-micro font-semibold uppercase tracking-label">DTG People</p>
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


/*
 * The people behind DTG, as a small gallery: the team at the monitors across
 * the top, the monitoring room and the families side by side beneath --
 * "people" here is the staff and the families behind them. Nothing is
 * cropped: each photograph keeps its own shape, the lower two share a height
 * with widths in proportion to their shapes, and the gallery's width follows
 * the screen's height so a short laptop screen never runs it into the
 * wordmark or the pitch. Wide screens only; the band is a compact header on
 * a phone.
 */
const TOP = { src: "/brand/photos/team-desk.jpg", alt: "The DTG team at the monitoring wall", ratio: 403 / 300 };
const ROW = [
    { src: "/brand/photos/control-room.jpg", alt: "Engineers reviewing slope monitoring", ratio: 777 / 512 },
    { src: "/brand/photos/team-outlook-full.jpg", alt: "DTG colleagues and family looking out over the hills", ratio: 452 / 377 },
];

function Photo({ src, alt, ratio }: { src: string; alt: string; ratio: number }) {
    return (
        <figure className="relative overflow-hidden" style={{ aspectRatio: String(ratio) }}>
            <img src={src} alt={alt} decoding="async" className="h-full w-full" />
        </figure>
    );
}

// The gallery's outer edge fades into the band on every side, so the
// photographs sit in it rather than on it.
const FEATHER =
    "linear-gradient(to right, transparent 0%, #000 11%, #000 89%, transparent 100%), " +
    "linear-gradient(to bottom, transparent 0%, #000 9%, #000 91%, transparent 100%)";

// Where two photographs meet they overlap, and the one on top fades in over
// the other -- no hard seam anywhere, one montage rather than three prints.
const FADE_IN_FROM_TOP = "linear-gradient(to bottom, transparent 0%, #000 26%)";
const FADE_IN_FROM_LEFT = "linear-gradient(to right, transparent 0%, #000 24%)";

function PhotoCollage() {
    const rowRatio = ROW.reduce((sum, p) => sum + p.ratio, 0);
    return (
        <div
            className="relative my-4 hidden lg:block"
            style={{
                // Height is about 1.1 x width; leave room for the wordmark
                // above and the pitch below.
                width: "min(100%, 31rem, calc((100vh - 420px) / 1.1))",
                maskImage: FEATHER,
                WebkitMaskImage: FEATHER,
                maskComposite: "intersect",
                WebkitMaskComposite: "source-in",
            }}
        >
            <Photo {...TOP} />
            <div
                className="relative flex"
                style={{ marginTop: "-11%", maskImage: FADE_IN_FROM_TOP, WebkitMaskImage: FADE_IN_FROM_TOP }}
            >
                {ROW.map((p, i) => (
                    <div
                        key={p.src}
                        className="relative"
                        style={{
                            flex: `${p.ratio / rowRatio} 1 0`,
                            ...(i > 0
                                ? { marginLeft: "-9%", maskImage: FADE_IN_FROM_LEFT, WebkitMaskImage: FADE_IN_FROM_LEFT }
                                : {}),
                        }}
                    >
                        <Photo {...p} />
                    </div>
                ))}
            </div>
        </div>
    );
}
