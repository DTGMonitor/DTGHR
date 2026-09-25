import { ApiError, toApiError } from "@/lib/supabase";

/*
 * The old REST API, answered by Supabase.
 *
 * The screens were written against a FastAPI backend: `api.get("/payroll/months")`,
 * `api.post("/tickets", body)` and the rest, 112 call sites across the pages and
 * services. That backend is retired -- the browser talks to Supabase directly,
 * PostgREST behind row-level security for reads and Postgres functions for
 * anything with rules behind it. Rather than rewrite every screen, this module
 * keeps the shape the screens already use and routes each request to the
 * function that now answers it.
 *
 *   api.get(path, { params, responseType })   -> { data }
 *   api.post(path, body)                      -> { data }
 *   api.put / api.patch / api.delete          -> { data }
 *
 * Routes are registered per area in `src/lib/routes/*`, as a method, a path
 * pattern with `:named` segments, and a handler. A request with no route fails
 * loudly with a 501 naming the path, so a gap in the port shows up as a clear
 * error on the one screen that needs it rather than as a blank page.
 *
 * Errors keep the axios shape the pages read -- `err.response.data.detail` --
 * because `ApiError` carries it.
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestContext {
    /** The `:named` segments of the path. */
    path: Record<string, string>;
    /** Query parameters, from `{ params }` and from any `?a=b` on the path itself. */
    query: Record<string, string>;
    /** The request body: JSON, or FormData for an upload. */
    body: unknown;
    /** "blob" when the caller wants a file back rather than JSON. */
    responseType?: string;
}

export type Handler = (ctx: RequestContext) => Promise<unknown>;

interface Route {
    method: Method;
    pattern: string;
    regex: RegExp;
    names: string[];
    handler: Handler;
}

const routes: Route[] = [];

/** Register a route. Called by the area modules in `src/lib/routes`. */
export function route(method: Method, pattern: string, handler: Handler): void {
    const names: string[] = [];
    const source = pattern
        .replace(/\/+$/, "")
        .split("/")
        .map((part) => {
            if (part.startsWith(":")) {
                names.push(part.slice(1));
                return "([^/]+)";
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/");
    routes.push({ method, pattern, regex: new RegExp(`^${source}/?$`), names, handler });
}

interface RequestConfig {
    params?: Record<string, unknown>;
    responseType?: string;
    // Accepted and ignored: there is no HTTP request underneath any more.
    headers?: Record<string, string | undefined>;
}

function toQuery(params: Record<string, unknown> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(params ?? {})) {
        if (v === undefined || v === null || v === "") continue;
        out[k] = String(v);
    }
    return out;
}

async function dispatch(
    method: Method,
    url: string,
    body: unknown,
    config?: RequestConfig,
): Promise<{ data: unknown }> {
    // Callers pass paths as the old API had them: "/payroll/months", sometimes
    // with a query string on the end.
    const [rawPath, rawQuery = ""] = url.replace(/^\/?api\/v1/, "").split("?");
    const path = `/${(rawPath ?? "").replace(/^\/+/, "")}`;
    const query = {
        ...Object.fromEntries(new URLSearchParams(rawQuery)),
        ...toQuery(config?.params),
    };

    for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.regex.exec(path);
        if (!m) continue;
        const named = Object.fromEntries(
            r.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? "")]),
        );
        try {
            const data = await r.handler({
                path: named,
                query,
                body,
                responseType: config?.responseType,
            });
            return { data };
        } catch (err) {
            if (err instanceof ApiError) throw err;
            throw toApiError(err as Error);
        }
    }
    throw new ApiError(`Not available yet: ${method} ${path}`, 501);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the callers name their types */
// `R` defaults to `{ data: T }` but, as with axios, can be inferred from the
// caller's own return type -- a service declared `Promise<void>` still compiles.
const api = {
    get: <T = any, R = { data: T }>(url: string, config?: RequestConfig) =>
        dispatch("GET", url, undefined, config) as Promise<R>,
    delete: <T = any, R = { data: T }>(url: string, config?: RequestConfig & { data?: unknown }) =>
        dispatch("DELETE", url, config?.data, config) as Promise<R>,
    post: <T = any, R = { data: T }>(url: string, body?: unknown, config?: RequestConfig) =>
        dispatch("POST", url, body, config) as Promise<R>,
    put: <T = any, R = { data: T }>(url: string, body?: unknown, config?: RequestConfig) =>
        dispatch("PUT", url, body, config) as Promise<R>,
    patch: <T = any, R = { data: T }>(url: string, body?: unknown, config?: RequestConfig) =>
        dispatch("PATCH", url, body, config) as Promise<R>,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Kept for the one caller that built a file URL from it (employee photos).
 * Photos now come from Storage, so nothing should fetch this directly.
 */
export const API_BASE_URL = "/api/v1";

export default api;
