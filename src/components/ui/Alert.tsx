import type { ReactNode } from "react";

type Tone = "danger" | "success" | "warning" | "info";

const TONES: Record<Tone, { wrap: string; icon: string }> = {
    danger: { wrap: "border-danger/30 bg-danger/10 text-danger", icon: "M12 9v3.75m0 3.75h.007M12 3.75 3 20.25h18L12 3.75Z" },
    success: { wrap: "border-signal/30 bg-signal/10 text-signal", icon: "m4.5 12.75 6 6 9-13.5" },
    warning: { wrap: "border-gold/30 bg-gold/10 text-gold", icon: "M12 9v3.75m0 3.75h.007M12 3.75 3 20.25h18L12 3.75Z" },
    info: { wrap: "border-teal-300/25 bg-teal-300/[0.07] text-teal-100", icon: "M11.25 11.25h1.5v5.25m-.75-8.25h.007M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
};

/** Inline message block. Carries an icon so tone is not conveyed by colour alone. */
export default function Alert({
    tone = "info",
    children,
    className = "",
}: {
    tone?: Tone;
    children: ReactNode;
    className?: string;
}) {
    const { wrap, icon } = TONES[tone];
    return (
        <div
            role={tone === "danger" ? "alert" : "status"}
            className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm ${wrap} ${className}`}
        >
            <svg className="mt-0.5 h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.9} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
            </svg>
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}
