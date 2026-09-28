import { useId } from "react";

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

/**
 * The DTG People mark: a D whose stem dissolves into pixels, as the D of the
 * DTG wordmark does, and a green P whose edge drifts off in pixels -- DTG and
 * its people. Carries its own teal tile; the favicon (public/favicon.svg) is
 * the same drawing.
 */
export function PeopleMark({ className = "h-5 w-5" }: { className?: string }) {
    const id = useId().replace(/:/g, "");
    return (
        <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
            <defs>
                <linearGradient id={`pm-bg-${id}`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#0d5163" />
                    <stop offset="1" stopColor="#062f3a" />
                </linearGradient>
                <linearGradient id={`pm-gr-${id}`} gradientUnits="userSpaceOnUse" x1="0" y1="7" x2="0" y2="25">
                    <stop offset="0" stopColor="#8fd98a" />
                    <stop offset="1" stopColor="#63B75D" />
                </linearGradient>
            </defs>
            <rect width="32" height="32" rx="8" fill={`url(#pm-bg-${id})`} />
            <path d="M6.6 9.3h3.6a6.7 6.7 0 0 1 0 13.4H6.6" fill="none" stroke="#F4F0E7" strokeWidth="3" />
            <g fill="#F4F0E7">
                <rect x="5" y="7.8" width="2.9" height="2.9" />
                <rect x="5" y="10.9" width="2.9" height="2.9" opacity=".92" />
                <rect x="5" y="14" width="2.9" height="2.9" />
                <rect x="5" y="17.1" width="2.9" height="2.9" opacity=".88" />
                <rect x="5" y="20.2" width="2.9" height="2.9" />
                <rect x="5" y="21.3" width="2.9" height="2.9" />
                <rect x="2.4" y="9.6" width="2" height="2" opacity=".6" />
                <rect x="2.4" y="15" width="2" height="2" opacity=".5" />
                <rect x="2.4" y="19.4" width="2" height="2" opacity=".55" />
                <rect x=".6" y="12.6" width="1.3" height="1.3" opacity=".3" />
                <rect x=".6" y="17.6" width="1.3" height="1.3" opacity=".25" />
            </g>
            <path d="M21 8v16" stroke={`url(#pm-gr-${id})`} strokeWidth="3" strokeLinecap="square" />
            <path d="M21 9.5h2.9a3.8 3.8 0 0 1 0 7.6H21" fill="none" stroke={`url(#pm-gr-${id})`} strokeWidth="3" />
            <g fill="#63B75D">
                <rect x="28.4" y="9.6" width="2" height="2" opacity=".6" />
                <rect x="28.4" y="12.3" width="2" height="2" opacity=".5" />
                <rect x="28.4" y="15" width="2" height="2" opacity=".55" />
                <rect x="30.6" y="11" width="1.2" height="1.2" opacity=".3" />
                <rect x="30.6" y="13.9" width="1.2" height="1.2" opacity=".25" />
            </g>
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
 * "People" clearly subordinate to DTG itself -- it reads "DTG People", as the
 * address does (people.digitaltwingeotechnical.com).
 */
export function ProductLockup({ className = "" }: { className?: string }) {
    return (
        <span className={`flex items-center gap-3 ${className}`}>
            <Wordmark className="h-[1.375rem]" />
            <span aria-hidden="true" className="h-5 w-px bg-white/20" />
            {/* The product's name, in the signal green and a size up from a
                caption: it names the app, it does not annotate the logo. */}
            <span className="text-[0.9375rem] font-bold uppercase tracking-[0.14em] text-signal">
                People
            </span>
        </span>
    );
}
