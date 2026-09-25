/*
 * economic-readings -- fetch the monthly CPI y/y (BPS) and AUD->IDR (ECB)
 * readings the Salary page's twelve-month average needs, and store them.
 *
 * Deploy:
 *   supabase secrets set BPS_API_KEY=<key from webapi.bps.go.id>
 *   supabase functions deploy economic-readings
 * SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
 * by the platform. Without BPS_API_KEY the CPI months are simply not fetched
 * (the page names them as missing); AUD->IDR needs no key.
 *
 * Contract (called by src/lib/routes/salary.ts through
 * `supabase.functions.invoke("economic-readings", { body })`, which forwards
 * the caller's JWT):
 *   POST { cpi_yoy?: string[], aud_idr?: string[] }   -- months, "YYYY-MM-01"
 *   200  { stored: { cpi_yoy: number, aud_idr: number } }  -- rows added
 *   404  { detail: "Not found" }  -- the caller is not the director or an executive
 * The months to ask for come from the RPC `salary_guidance_missing`. Readings
 * are stored with the service role through `salary_store_readings`, which
 * never overwrites a stored month (hand-entered, or stored by a request that
 * got there first). Port of backend app/services/salary_guidance.py.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Reading = { month: string; value: number; source: string };

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, "Content-Type": "application/json" },
    });

/** Months "YYYY-MM-01" that have already started; anything else is dropped. */
function cleanMonths(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const months = value.filter(
        (m): m is string => typeof m === "string" && /^\d{4}-\d{2}-01$/.test(m) && m <= thisMonth,
    );
    return [...new Set(months)].sort().slice(0, 48);
}

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// ── BPS: year-on-year CPI inflation, national row, one call for all years ──

const BPS_DATA_URL = "https://webapi.bps.go.id/v1/api/list/";
/** "Inflasi Tahunan (Y-on-Y) 38 Provinsi (2022=100)"; starts January 2024. */
const BPS_CPI_YOY_VAR = 2263;
const BPS_NATIONAL = 9999;
/** BPS turns away requests without a browser-like user agent. */
const BPS_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; DTG-HR-Hub/1.0)" };

async function fetchCpiYoy(months: string[]): Promise<Reading[]> {
    const key = Deno.env.get("BPS_API_KEY");
    if (!months.length || !key) return [];
    // BPS numbers its years from 1900 (2025 is 125).
    const years = [...new Set(months.map((m) => Number(m.slice(0, 4)) - 1900))].sort();
    const url = new URL(BPS_DATA_URL);
    url.search = new URLSearchParams({
        model: "data",
        domain: "0000",
        var: String(BPS_CPI_YOY_VAR),
        th: years.join(";"),
        key,
    }).toString();
    try {
        const res = await fetch(url, { headers: BPS_HEADERS, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return [];
        const content = (await res.json())?.datacontent ?? {};
        const out: Reading[] = [];
        for (const m of months) {
            const year = Number(m.slice(0, 4));
            const month = Number(m.slice(5, 7));
            // Region, variable, sub-variable, year and month run together.
            const value = content[`${BPS_NATIONAL}${BPS_CPI_YOY_VAR}0${year - 1900}${month}`];
            if (value !== undefined && value !== null && !Number.isNaN(Number(value))) {
                out.push({
                    month: m,
                    value: Number(value),
                    source: `BPS year-on-year CPI, Indonesia, ${MONTH_NAMES[month - 1]} ${year} (automatic)`,
                });
            }
        }
        return out;
    } catch {
        return [];
    }
}

// ── ECB (frankfurter.app): AUD->IDR on or before the 1st of each month ──

async function fetchAudIdr(months: string[]): Promise<Reading[]> {
    if (!months.length) return [];
    // A week's margin before the earliest month covers a long weekend.
    const start = new Date(`${months[0]}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 7);
    const from = start.toISOString().slice(0, 10);
    const to = months[months.length - 1];
    try {
        const res = await fetch(`https://api.frankfurter.app/${from}..${to}?from=AUD&to=IDR`, {
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return [];
        const rates: Record<string, { IDR?: number }> = (await res.json())?.rates ?? {};
        const days = Object.keys(rates).sort();
        const out: Reading[] = [];
        for (const m of months) {
            const day = days.filter((d) => d <= m).pop();
            const value = day ? Number(rates[day]?.IDR) : NaN;
            if (day && Number.isFinite(value)) {
                out.push({ month: m, value, source: `ECB rate for ${day} (automatic)` });
            }
        }
        return out;
    } catch {
        return [];
    }
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ detail: "Method not allowed" }, 405);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Same audience as the page: ask the database, as the caller.
    const asCaller = createClient(url, anon, {
        global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: mayView, error } = await asCaller.rpc("salary_can_view");
    if (error || mayView !== true) return json({ detail: "Not found" }, 404);

    let body: Record<string, unknown> = {};
    try {
        body = await req.json();
    } catch {
        // An empty body asks for nothing.
    }
    const cpiMonths = cleanMonths(body.cpi_yoy);
    const audMonths = cleanMonths(body.aud_idr);

    const [cpi, aud] = await Promise.all([fetchCpiYoy(cpiMonths), fetchAudIdr(audMonths)]);

    const admin = createClient(url, service, { auth: { persistSession: false } });
    const stored = { cpi_yoy: 0, aud_idr: 0 };
    for (const [kind, readings] of [["cpi_yoy", cpi], ["aud_idr", aud]] as const) {
        if (!readings.length) continue;
        const { data, error: storeError } = await admin.rpc("salary_store_readings", {
            p_kind: kind,
            p_readings: readings,
        });
        if (!storeError) stored[kind] = Number(data) || 0;
    }
    return json({ stored });
});
