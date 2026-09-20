/*
 * DTG brand lockups.
 *
 * The corporate wordmark ships as a "broken white" PNG (an off-white DTG block
 * with the pixel-dissolve edge), so it is used as-is on dark surfaces rather
 * than recoloured. `PixelMark` is the square reduction of that dissolve motif,
 * for slots the wide wordmark cannot fit — avatars, favicons, tight headers.
 */

/** Square pixel-dissolve mark. Inherits `currentColor`, so tint it with text-*. */
export function PixelMark({ className = "h-5 w-5" }: { className?: string }) {
    return (
        <svg viewBox="0 0 32 32" fill="currentColor" className={className} aria-hidden="true">
            <rect x="13" y="5" width="19" height="22" />
            <rect x="9" y="5" width="4" height="4" opacity="0.92" />
            <rect x="9" y="13" width="4" height="4" opacity="0.88" />
            <rect x="9" y="17" width="4" height="4" opacity="0.5" />
            <rect x="9" y="21" width="4" height="4" opacity="0.8" />
            <rect x="5" y="9" width="4" height="4" opacity="0.5" />
            <rect x="5" y="13" width="4" height="4" opacity="0.62" />
            <rect x="5" y="23" width="4" height="4" opacity="0.38" />
            <rect x="2" y="13" width="3" height="3" opacity="0.42" />
            <rect x="2" y="18" width="3" height="3" opacity="0.3" />
            <rect x="0" y="15" width="2" height="2" opacity="0.22" />
        </svg>
    );
}

/** The DTG wordmark. `withTagline` swaps in the version carrying the strapline. */
export function Wordmark({
    withTagline = false,
    className = "h-7",
}: {
    withTagline?: boolean;
    className?: string;
}) {
    return (
        <img
            src={
                withTagline
                    ? "/brand/dtg-logo-broken-white-full.png"
                    : "/brand/dtg-logo-broken-white-mark.png"
            }
            alt="Digital Twin Geotechnical"
            className={`${className} w-auto select-none`}
            /* Both files are fixed brand assets, never above the fold more than
               once — let the browser decode them off the main thread. */
            decoding="async"
        />
    );
}

/**
 * Product lockup: the corporate wordmark, a hairline, then the product name.
 * This is the pattern the marketing site uses for sub-brands, and it keeps
 * "HR Hub" clearly subordinate to DTG itself.
 */
export function ProductLockup({ className = "" }: { className?: string }) {
    return (
        <span className={`flex items-center gap-3 ${className}`}>
            <Wordmark className="h-[1.375rem]" />
            <span aria-hidden="true" className="h-5 w-px bg-white/20" />
            <span className="text-label font-bold uppercase tracking-label text-paper-soft">
                HR Hub
            </span>
        </span>
    );
}
