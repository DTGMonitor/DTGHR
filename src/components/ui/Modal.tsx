import { useEffect, useRef, type ReactNode } from "react";
import Icon from "./icons";

/**
 * Shared dialog chrome.
 *
 * Every modal in the app previously hand-rolled its own backdrop and panel,
 * which drifted apart visually and shared the same accessibility gaps: no
 * `role="dialog"`, no Escape handler, no focus move, and the page behind stayed
 * scrollable. This centralises all of that.
 *
 * Focus is moved into the panel on open and returned to the trigger on close.
 * It is not a full focus trap — that needs a library — but it means keyboard
 * users start inside the dialog instead of at the top of the document.
 */
export default function Modal({
    title,
    description,
    onClose,
    children,
    footer,
    /** Visual tone for the title icon; omit for a plain dialog. */
    tone,
    size = "md",
}: {
    title: string;
    description?: ReactNode;
    onClose: () => void;
    children?: ReactNode;
    footer?: ReactNode;
    tone?: "danger" | "success" | "warning";
    size?: "sm" | "md" | "lg" | "xl";
}) {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown);

        // Stop the page behind the dialog from scrolling under it.
        const { overflow } = document.body.style;
        document.body.style.overflow = "hidden";

        panelRef.current?.focus();

        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.body.style.overflow = overflow;
            previouslyFocused?.focus?.();
        };
    }, [onClose]);

    const TONES = {
        danger: { wrap: "border-danger/30 bg-danger/10 text-danger", icon: "userMinus" },
        success: { wrap: "border-signal/30 bg-signal/10 text-signal", icon: "check" },
        warning: { wrap: "border-gold/30 bg-gold/10 text-gold", icon: "clipboard" },
    } as const;

    const SIZES = {
        sm: "max-w-sm",
        md: "max-w-md",
        lg: "max-w-2xl",
        xl: "max-w-4xl",
    } as const;

    const toneStyle = tone ? TONES[tone] : null;

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center sm:p-6">
            <div
                className="fixed inset-0 bg-deep/80 backdrop-blur-sm"
                onClick={onClose}
                aria-hidden="true"
            />

            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
                className={`dtg-fade-in relative z-10 my-auto w-full ${SIZES[size]} rounded-2xl border border-white/12 bg-surface shadow-raised outline-none`}
            >
                {/* ── Header ─────────────────────────────────────────────── */}
                <header className="flex items-start gap-3.5 border-b border-white/[0.08] px-5 py-4 sm:px-6">
                    {toneStyle && (
                        <span
                            className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border ${toneStyle.wrap}`}
                        >
                            <Icon name={toneStyle.icon} className="h-[1.125rem] w-[1.125rem]" />
                        </span>
                    )}

                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-paper">{title}</h2>
                        {description && (
                            <p className="mt-1 text-sm leading-relaxed text-paper-soft">{description}</p>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="-mr-1.5 -mt-1 flex-shrink-0 rounded p-2 text-teal-500 transition-colors hover:bg-white/[0.06] hover:text-paper"
                    >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.9} stroke="currentColor" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </header>

                {/* ── Body ───────────────────────────────────────────────── */}
                {children && <div className="px-5 py-5 sm:px-6">{children}</div>}

                {/* ── Footer ─────────────────────────────────────────────── */}
                {footer && (
                    <footer className="flex flex-col-reverse gap-2.5 border-t border-white/[0.08] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                        {footer}
                    </footer>
                )}
            </div>
        </div>
    );
}
