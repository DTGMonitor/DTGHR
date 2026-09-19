import { createClient, type PostgrestError } from "@supabase/supabase-js";

/**
 * The Supabase client is the whole backend now.
 *
 * Reads go straight to PostgREST and are scoped by row-level security; writes
 * and anything with business logic behind it go through a Postgres function.
 * There is no server of our own left in the path, which is the point: the old
 * FastAPI deployment put a Python cold start and a second network hop in front
 * of every single request.
 */

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? "";

if (!url || !anonKey) {
    // Vite reads these when the dev server starts and inlines them at build
    // time, so an empty value is always a configuration problem rather than a
    // runtime one -- and the two deployments configure it in different places.
    throw new Error(
        "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set.\n" +
            (import.meta.env.DEV
                ? "Copy .env.example to .env.local, fill in both values from " +
                  "Supabase -> Project Settings -> API, then restart `npm run dev`."
                : "Set them in Vercel -> Settings -> Environment Variables, then " +
                  "redeploy: Vite inlines them at build time, so an existing " +
                  "deployment will not pick them up on its own.")
    );
}

export const supabase = createClient(url, anonKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Needed for the Microsoft redirect to complete on the way back in.
        detectSessionInUrl: true,
        storageKey: "hr_hub_auth",
    },
});

/** Whether Microsoft Entra sign-in is offered in this build. */
export const isAzureSsoConfigured =
    (import.meta.env.VITE_AZURE_SSO_ENABLED ?? "").toString().toLowerCase() === "true";

// ---------------------------------------------------------------------------
// Errors
//
// The pages were written against axios and read `err.response.data.detail`.
// Rather than touch every catch block, errors are reshaped into that form on
// the way out of this module -- so a Postgres `raise exception` surfaces in
// the UI exactly where an HTTPException's detail used to.
// ---------------------------------------------------------------------------

export class ApiError extends Error {
    readonly response: { status: number; data: { detail: string } };

    constructor(detail: string, status = 400) {
        super(detail);
        this.name = "ApiError";
        this.response = { status, data: { detail } };
    }
}

export function isApiError(err: unknown): err is ApiError {
    return err instanceof ApiError;
}

/**
 * Map a Postgres error onto an HTTP status.
 *
 * The RPCs raise with a SQLSTATE of the form PTnnn, which PostgREST already
 * turns into HTTP nnn; this recovers the same number on the client so the
 * 401 handling below can tell "your session expired" from "that was invalid".
 */
function statusFor(error: PostgrestError | { code?: string; status?: number }): number {
    const withStatus = error as { status?: number };
    if (typeof withStatus.status === "number") return withStatus.status;

    const code = (error as { code?: string }).code ?? "";
    if (/^PT\d{3}$/.test(code)) return Number(code.slice(2));
    if (code === "42501") return 403;
    if (code === "PGRST116") return 404; // no rows where exactly one was expected
    return 400;
}

export function toApiError(error: PostgrestError | Error | { message: string }): ApiError {
    const status = statusFor(error as PostgrestError);
    const message = error.message || "Something went wrong.";
    return new ApiError(message, status);
}

/** Unwrap a `{ data, error }` result, throwing an ApiError on failure. */
export function unwrap<T>(result: { data: T | null; error: PostgrestError | null }): T {
    if (result.error) throw toApiError(result.error);
    return result.data as T;
}

/** Call a Postgres function and unwrap it. */
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args ?? {});
    if (error) throw toApiError(error);
    return data as T;
}

/**
 * PostgREST's `or=` filter is a comma-separated list, so a comma or bracket
 * typed into the search box would otherwise be read as syntax.
 */
export function sanitiseFilterValue(value: string): string {
    return value.replace(/[,()"\\]/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Session facts the services need
//
// Several lists are scoped to "me" rather than to what RLS allows -- the
// pending-approvals queue, for instance, deliberately leaves out your own
// requests. AuthContext publishes the answer here once per sign-in so those
// calls do not each have to go and ask.
// ---------------------------------------------------------------------------

export interface SessionFacts {
    userId: string;
    employeeId: string | null;
    isSuperuser: boolean;
}

let sessionFacts: SessionFacts | null = null;

export function setSessionFacts(facts: SessionFacts | null): void {
    sessionFacts = facts;
}

export function getSessionFacts(): SessionFacts {
    if (!sessionFacts) {
        throw new ApiError("Your session has expired. Please sign in again.", 401);
    }
    return sessionFacts;
}
