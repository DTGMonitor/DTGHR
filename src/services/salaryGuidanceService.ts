import api from "@/lib/api";

/*
 * What a salary increase is set by -- a percentage per KPI band, kept by
 * hand -- and what it is compared against: Indonesia's CPI (BPS's own
 * year-on-year figure) and the rupiah's move against the AUD, each averaged
 * over the last twelve months so the answer does not depend on which month
 * is picked. A second point of view that never enters the figure; both are
 * fetched automatically (CPI from BPS, AUD->IDR from the ECB).
 */

/** KPI band codes as the documents write them. */
export const BAND_CODES = ["1", "2L", "2M", "2H", "3"] as const;

export const BAND_NAMES: Record<string, string> = {
    "1": "Below Expectations",
    "2L": "Developing",
    "2M": "Meets Expectations",
    "2H": "Exceeds Expectations",
    "3": "Outstanding / Key Talent",
};

export type IndicatorKind = "cpi_yoy" | "aud_idr";

export interface Indicator {
    id: string;
    kind: IndicatorKind;
    month: string;
    value: number;
    source: string | null;
    /** Null for a reading fetched automatically. */
    entered_by: string | null;
}

export interface GuidanceData {
    /** Percent per KPI band code. */
    band_increases: Record<string, number>;
    indicators: Indicator[];
}

/** One month of the year: BPS's CPI y/y, and AUD->IDR against a year before. */
export interface MonthChange {
    month: string;
    cpi_yoy: number | null;
    aud_idr: number | null;
    aud_idr_year_before: number | null;
    aud_idr_yoy: number | null;
}

/** The last twelve year-on-year changes, and their averages. */
export interface AnnualAverage {
    start: string;
    end: string;
    months: MonthChange[];
    cpi_average: number | null;
    aud_idr_average: number | null;
    /** Readings that could not be found, in plain words. */
    missing: string[];
}

const BASE = "/salary-guidance";

export const salaryGuidanceService = {
    data: () => api.get<GuidanceData>(BASE),
    /** Twelve months ending at ``end`` (any day in it); default the latest BPS has published. */
    annualAverage: (end?: string) =>
        api.get<AnnualAverage>(`${BASE}/annual-average`, { params: end ? { end } : {} }),
    saveBands: (band_increases: Record<string, number>) =>
        api.put<{ band_increases: Record<string, number> }>(`${BASE}/bands`, { band_increases }),
};
