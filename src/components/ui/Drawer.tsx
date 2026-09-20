import { useEffect, useRef, type ReactNode } from "react";

/**
 * Right-edge drawer, for forms long enough that a centred dialog would scroll.
 *
 * Same contract as `Modal` — Escape closes, focus moves in and returns, the
 * page behind is locked — but it slides from the edge and goes full-width below
 * `sm` so a phone gets the whole screen for the form.
 */
export default function Drawer({
    title,
    eyebrow,
    onClose,
    children,
    footer,
}: {
    title: string;
    eyebrow?: string;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
}) {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown);

        const { overflow } = document.body.style;
        document.body.style.overflow = "hidden";

        panelRef.current?.focus();

        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.body.style.overflow = overflow;
            previouslyFocused?.focus?.();
        };
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
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
                className="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-white/12 bg-surface shadow-raised outline-none"
            >
                <header className="flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-4 sm:px-6">
                    <div className="min-w-0">
                        {eyebrow && <p className="dtg-eyebrow">{eyebrow}</p>}
                        <h2 className="mt-1 text-base font-semibold text-paper">{title}</h2>
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

                {children}

                {footer && (
                    <footer className="mt-auto flex gap-3 border-t border-white/[0.08] px-5 py-4 sm:px-6">
                        {footer}
                    </footer>
                )}
            </div>
        </div>
    );
}
