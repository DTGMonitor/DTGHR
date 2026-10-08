import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/*
 * Which item a page has open, kept in the URL (`?open=<id>`, or another
 * parameter name). A notification links straight to it, a link can be
 * shared, and closing it takes the parameter away again.
 *
 * Opening and closing replace the history entry rather than adding one, so
 * the back button leaves the page -- back to the bell, the email, wherever
 * the person came from -- instead of stepping through every row they opened.
 */
export function useOpenParam(name = "open"): [string | null, (id: string | null) => void] {
    const [params, setParams] = useSearchParams();
    const value = params.get(name);
    const set = useCallback(
        (id: string | null) =>
            setParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    if (id) next.set(name, id);
                    else next.delete(name);
                    return next;
                },
                { replace: true },
            ),
        [name, setParams],
    );
    return [value, set];
}

/** Bring an element into view and flash it, once it has rendered. */
export function revealElement(id: string, highlight = false): void {
    window.requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        if (highlight) {
            el.classList.add("dtg-flash");
            window.setTimeout(() => el.classList.remove("dtg-flash"), 2200);
        }
    });
}
