// Routes for the salary area. See supabase/PORTING.md.
//
// Salary reviews, the KPI summary, the increase-by-band table and the year of
// CPI / AUD->IDR beside it. Every function answers 404 to anybody but the
// director and the executives.
import { route } from "@/lib/api";
import { ApiError, rpc, supabase } from "@/lib/supabase";

type Body = Record<string, unknown> | undefined;

// ── Salary reviews ──────────────────────────────────────────────────────

route("GET", "/salary-reviews", () => rpc("salary_list_reviews"));

route("GET", "/salary-reviews/kpi-summary", () => rpc("salary_kpi_summary"));

route("POST", "/salary-reviews", ({ body }) =>
    rpc("salary_create_review", { p_body: body ?? {} }),
);

route("PATCH", "/salary-reviews/:id", ({ path, body }) =>
    rpc("salary_update_review", { p_id: path.id, p_body: body ?? {} }),
);

route("POST", "/salary-reviews/:id/submit", ({ path }) =>
    rpc("salary_submit_review", { p_id: path.id }),
);

route("POST", "/salary-reviews/:id/approve", ({ path, body }) =>
    rpc("salary_approve_review", { p_id: path.id, p_note: (body as Body)?.note ?? null }),
);

route("POST", "/salary-reviews/:id/decline", ({ path, body }) =>
    rpc("salary_decline_review", { p_id: path.id, p_note: (body as Body)?.note ?? null }),
);

// The endorsement step was retired in the FastAPI line; the service still
// names it, and the backend answered it as an unknown path.
route("POST", "/salary-reviews/:id/endorse", async () => {
    throw new ApiError("Not Found", 404);
});

route("DELETE", "/salary-reviews/:id", async ({ path }) => {
    await rpc("salary_delete_review", { p_id: path.id });
    return null;
});

// ── Guidance ────────────────────────────────────────────────────────────

route("GET", "/salary-guidance", () => rpc("salary_guidance_data"));

route("PUT", "/salary-guidance/bands", ({ body }) =>
    rpc("salary_set_band_increases", {
        p_band_increases: (body as Body)?.band_increases ?? null,
    }),
);

route("PUT", "/salary-guidance/indicators", ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return rpc("salary_upsert_indicator", {
        p_kind: b.kind ?? null,
        p_month: b.month ?? null,
        p_value: b.value ?? null,
        p_source: b.source ?? null,
    });
});

route("DELETE", "/salary-guidance/indicators/:id", async ({ path }) => {
    await rpc("salary_delete_indicator", { p_id: path.id });
    return null;
});

interface Missing {
    end: string;
    candidates: string[];
    cpi_yoy: string[];
    aud_idr: string[];
}

/**
 * Have the `economic-readings` Edge Function fetch and store these months.
 * Any failure is swallowed: a month that could not be fetched is named as
 * missing by the average, which is better than a page that will not load.
 */
async function fetchReadings(cpi_yoy: string[], aud_idr: string[]): Promise<void> {
    if (!cpi_yoy.length && !aud_idr.length) return;
    try {
        await supabase.functions.invoke("economic-readings", { body: { cpi_yoy, aud_idr } });
    } catch {
        // Left out and named, as the backend did on any fetch failure.
    }
}

route("GET", "/salary-guidance/annual-average", async ({ query }) => {
    const end = query.end || null;
    let missing = await rpc<Missing>("salary_guidance_missing", { p_end: end });
    if (!end && missing.candidates.length) {
        // Which month ends the year depends on what BPS has published.
        await fetchReadings(missing.candidates, []);
        missing = await rpc<Missing>("salary_guidance_missing", { p_end: null });
    }
    await fetchReadings(missing.cpi_yoy, missing.aud_idr);
    return rpc("salary_annual_average", { p_end: missing.end });
});
