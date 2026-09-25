import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";

/*
 * The Hub's own confirm and prompt.
 *
 * Eighteen places called window.confirm() or window.prompt(), which drops a
 * piece of 1998 browser chrome into the middle of a dark navy application:
 * grey, system-font, the page title in the corner, buttons in the operating
 * system's order. Nurhuda, on deleting a contract: "this looks old and bad".
 *
 * They are also genuinely worse than a dialog we control. A native confirm
 * blocks the whole thread, cannot say which of two destructive things you are
 * about to do, cannot mark a note as required, and cannot be styled to warn
 * harder for a delete than for a save.
 *
 * Promise-based, so replacing a call site is a one-line change:
 *
 *     if (!(await confirm({ title: "Delete?" }))) return;
 *     const note = await prompt({ title: "Why?" });
 */

interface ConfirmOptions {
    title: string;
    /** The consequence, in a sentence. Skipped when the title says it all. */
    body?: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    /** `danger` for anything that destroys something. */
    tone?: "default" | "danger";
}

interface PromptOptions extends Omit<ConfirmOptions, "tone"> {
    label?: string;
    placeholder?: string;
    defaultValue?: string;
    /** Refuse an empty answer, with the reason shown in place. */
    required?: boolean;
    multiline?: boolean;
    tone?: "default" | "danger";
}

interface DialogApi {
    confirm: (options: ConfirmOptions) => Promise<boolean>;
    prompt: (options: PromptOptions) => Promise<string | null>;
    alert: (options: Omit<ConfirmOptions, "tone" | "cancelLabel">) => Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);

type Pending =
    | { kind: "confirm"; options: ConfirmOptions; resolve: (v: boolean) => void }
    | { kind: "prompt"; options: PromptOptions; resolve: (v: string | null) => void }
    | { kind: "alert"; options: ConfirmOptions; resolve: (v: void) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
    const [pending, setPending] = useState<Pending | null>(null);
    const [value, setValue] = useState("");
    const [touched, setTouched] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

    const api: DialogApi = {
        confirm: useCallback(
            (options) =>
                new Promise<boolean>((resolve) => {
                    setPending({ kind: "confirm", options, resolve });
                }),
            [],
        ),
        prompt: useCallback(
            (options) =>
                new Promise<string | null>((resolve) => {
                    setValue(options.defaultValue ?? "");
                    setTouched(false);
                    setPending({ kind: "prompt", options, resolve });
                }),
            [],
        ),
        alert: useCallback(
            (options) =>
                new Promise<void>((resolve) => {
                    setPending({ kind: "alert", options, resolve });
                }),
            [],
        ),
    };

    const close = useCallback(
        (answer: boolean | string | null) => {
            if (!pending) return;
            if (pending.kind === "confirm") pending.resolve(Boolean(answer));
            else if (pending.kind === "prompt")
                pending.resolve(typeof answer === "string" ? answer : null);
            else pending.resolve(undefined);
            setPending(null);
        },
        [pending],
    );

    // The focus lands in the field for a prompt and on the confirm button
    // otherwise, so the keyboard alone gets through the dialog.
    useEffect(() => {
        if (pending?.kind === "prompt") inputRef.current?.focus();
    }, [pending]);

    useEffect(() => {
        if (!pending) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                close(pending.kind === "prompt" ? null : false);
            }
            // Enter confirms, except in a textarea where it is a newline.
            if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
                e.preventDefault();
                submit();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    const options = pending?.options;
    const isPrompt = pending?.kind === "prompt";
    const required = isPrompt && (pending.options as PromptOptions).required;
    const emptyButRequired = Boolean(required) && !value.trim();

    function submit() {
        if (!pending) return;
        if (isPrompt) {
            if (emptyButRequired) {
                setTouched(true);
                inputRef.current?.focus();
                return;
            }
            close(value);
        } else {
            close(true);
        }
    }

    const danger = options?.tone === "danger";

    return (
        <DialogContext.Provider value={api}>
            {children}

            {pending && options && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-deep/80 p-4 backdrop-blur-sm"
                    role="dialog"
                    aria-modal="true"
                    aria-label={options.title}
                    onMouseDown={(e) => {
                        // Clicking the backdrop cancels, the way every other
                        // dialog in the application does. Not for an alert,
                        // which has only one way out.
                        if (e.target === e.currentTarget && pending.kind !== "alert") {
                            close(isPrompt ? null : false);
                        }
                    }}
                >
                    <div className="dtg-fade-in w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl">
                        {/* A 2px rule in the tone of the action — the same
                            device the rest of the application uses to mark
                            what a panel is for. */}
                        <div className={`h-0.5 w-full ${danger ? "bg-danger" : "bg-signal"}`} />

                        <div className="px-6 pb-5 pt-5">
                            <h2 className="text-base font-bold tracking-tight text-paper">
                                {options.title}
                            </h2>
                            {options.body && (
                                <div className="mt-2 text-sm leading-relaxed text-paper-soft">
                                    {options.body}
                                </div>
                            )}

                            {isPrompt && (
                                <label className="mt-4 block">
                                    {(options as PromptOptions).label && (
                                        <span className="dtg-eyebrow">
                                            {(options as PromptOptions).label}
                                        </span>
                                    )}
                                    {(options as PromptOptions).multiline ? (
                                        <textarea
                                            ref={(el) => (inputRef.current = el)}
                                            rows={3}
                                            value={value}
                                            onChange={(e) => setValue(e.target.value)}
                                            placeholder={(options as PromptOptions).placeholder}
                                            className="dtg-input mt-1.5 w-full"
                                        />
                                    ) : (
                                        <input
                                            ref={(el) => (inputRef.current = el)}
                                            value={value}
                                            onChange={(e) => setValue(e.target.value)}
                                            placeholder={(options as PromptOptions).placeholder}
                                            className="dtg-input mt-1.5 w-full"
                                        />
                                    )}
                                    {touched && emptyButRequired && (
                                        <span className="mt-1.5 block text-xs text-danger">
                                            This one is required.
                                        </span>
                                    )}
                                </label>
                            )}
                        </div>

                        <div className="flex justify-end gap-2 border-t border-white/[0.08] px-6 py-3.5">
                            {pending.kind !== "alert" && (
                                <button
                                    onClick={() => close(isPrompt ? null : false)}
                                    className="rounded-xl border border-white/10 px-4 py-2 text-sm font-medium text-paper-soft transition hover:bg-white/5"
                                >
                                    {options.cancelLabel ?? "Cancel"}
                                </button>
                            )}
                            <button
                                onClick={submit}
                                className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                                    danger
                                        ? "bg-danger text-white hover:bg-danger/85"
                                        : "bg-signal text-deep hover:bg-signal/85"
                                }`}
                            >
                                {options.confirmLabel ?? (danger ? "Delete" : "Confirm")}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </DialogContext.Provider>
    );
}

export function useDialog(): DialogApi {
    const ctx = useContext(DialogContext);
    if (!ctx) throw new Error("useDialog must be used within a DialogProvider");
    return ctx;
}
