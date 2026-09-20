/** @type {import('tailwindcss').Config} */

/*
 * DTG HR Hub — Tailwind theme.
 *
 * Every colour, radius and type token here is lifted from the design system on
 * digitaltwingeotechnical.com (its `:root` custom properties), so the HR Hub
 * reads as the same product family as the corporate site rather than a generic
 * dashboard. Names mirror the source tokens to keep the two in sync: if the
 * marketing site changes `--signal-green`, this is the one place to follow it.
 */
export default {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
        extend: {
            colors: {
                /* Deep teal-navy surfaces — the site's dark canvas. */
                night: "#0B1A22", // --bg-dark   : app background
                deep: "#061216", // --deep-base : deepest wells, inputs
                surface: {
                    DEFAULT: "#122530", // --surface-dark : cards, panels
                    raised: "#16303D", //                  hover / elevated
                },
                band: "#073C4A", // --deep-teal : full-bleed accent bands

                /* Teal scale — structure, borders, data lines. */
                teal: {
                    900: "#0E3A45",
                    700: "#3C6470",
                    500: "#6892A0",
                    300: "#9DC1CC",
                    100: "#CFE0E6",
                    50: "#EAF2F4",
                },

                /* Signal green — the site's single action colour. */
                signal: {
                    DEFAULT: "#63B75D", // --signal-green
                    hover: "#4FA24A", // --signal-green-hover
                    on: "#06210A", // --on-accent : text on a green fill
                },

                /* Gold — eyebrows, "needs attention", governance. */
                gold: {
                    DEFAULT: "#D6A73A",
                    soft: "#D8CCB3",
                },

                /* Foreground. "paper" is the warm off-white of the logo. */
                paper: {
                    DEFAULT: "#F4F8F9", // --text-on-dark
                    soft: "#AEC0C7", // --text-on-dark-soft
                    warm: "#F4F0E7", // logo off-white
                },
                muted: "#7C8B92", // --muted : decorative / disabled only

                /* Light-surface text, for anything on paper backgrounds. */
                ink: {
                    DEFAULT: "#10202A",
                    soft: "#51626B",
                },

                /* Status. Green doubles as "approved", so it stays `signal`. */
                danger: {
                    DEFAULT: "#E08373",
                    strong: "#A63A2B",
                },
            },

            /* The site draws hairlines, not visible strokes. */
            borderColor: {
                DEFAULT: "rgba(255,255,255,0.14)", // --border-dark
                strong: "rgba(255,255,255,0.24)",
                subtle: "rgba(255,255,255,0.08)",
            },

            /*
             * DTG's geometry is tight: 4 / 8 / 12px, never pill-shaped panels.
             * The scale is remapped rather than extended so the existing
             * `rounded-xl` / `rounded-2xl` usage across the app lands on the
             * brand's radii instead of Tailwind's softer defaults.
             */
            borderRadius: {
                none: "0",
                sm: "2px",
                DEFAULT: "4px", // --radius-sm
                md: "4px",
                lg: "8px", // --radius-md
                xl: "8px",
                "2xl": "12px", // --radius-lg
                "3xl": "16px",
                full: "9999px",
            },

            fontFamily: {
                sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
                mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
            },

            fontSize: {
                /* --text-micro / --text-label, used for the tracked eyebrows. */
                micro: ["0.6875rem", { lineHeight: "1.4" }],
                label: ["0.75rem", { lineHeight: "1.4" }],
            },

            letterSpacing: {
                /* --tracking-label: the site's signature uppercase eyebrow. */
                label: "0.18em",
                eyebrow: "0.22em",
                tight: "-0.02em",
            },

            boxShadow: {
                /* Flat, engineered depth — a lift, not a glow. */
                panel: "0 1px 2px rgba(6,18,22,0.4), 0 8px 24px -12px rgba(6,18,22,0.6)",
                raised: "0 2px 4px rgba(6,18,22,0.5), 0 16px 40px -16px rgba(6,18,22,0.7)",
            },

            backgroundImage: {
                /* The pixel-dissolve motif from the logo's left edge. */
                "pixel-fade":
                    "linear-gradient(90deg, rgba(244,240,231,0.06) 0%, transparent 60%)",
            },
        },
    },
    plugins: [],
};
