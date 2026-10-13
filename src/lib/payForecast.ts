/*
 * The pay forecast: DTG_Forecast_Jul2026-Dec2027.xlsx, computed here.
 *
 * Nurhuda, October 2026: "change the pay forecast in DTG People with the
 * Excel file ... ensure the formula and number not change". So the inputs
 * (every typed number in the workbook) are stored as they are, and every
 * formula cell is worked out below exactly as Excel works it out -- the same
 * ROUNDUP to IDR 10,000, the same IDR 12,700 to the AUD, the same COUNT and
 * SUM rules on blank cells, and the same errors where the sheet would show
 * one. scripts/check-pay-forecast.mjs compares every cell against values
 * computed from the workbook itself by an independent formula engine.
 *
 * The cell addresses in comments are the workbook's: GM Summary (GM),
 * Budget vs Actual (BvA), Salary and Revenue.
 */

/** A cell: a number, Excel's empty string from IF(...,"",...), or an error. */
export type Val = number | "" | ExcelError;
export interface ExcelError {
    error: "#VALUE!" | "#DIV/0!";
}

export interface Line {
    name: string;
    note: string | null;
    /** 18 months, July 2026 to December 2027; null where the sheet has a formula. */
    values: (number | null)[];
}

export interface ForecastInputs {
    version: number;
    title: string;
    subtitle: string;
    months: string[];
    fy_label: string;
    /** Index of January 2027: FY2027 is the sum from here to December 2027. */
    fy_from: number;
    first_2027: number;
    rates: {
        idr_per_aud: number;
        labour_pl_markup: number;
        labour_pl_round_to: number;
        overhead_monthly_idr: number;
    };
    revenue: { pl: Line[]; pt: Line[]; subtitle: string; pl_title: string; pt_title: string };
    salary: {
        subtitle: string;
        groups: { key: GroupKey; title: string; rows: Line[] }[];
        thr_title: string;
        thr: Record<GroupKey, Line>;
        thr_total_note: string | null;
        bonus_title: string;
        bonus: Record<GroupKey, Line>;
        bonus_total_note: string | null;
    };
    gm: {
        labour_pl: { note: string | null; values: (number | null)[] };
        labour_pt: { note: string | null; values: (number | null)[] };
        overhead: { note: string | null; values: (number | null)[] };
        other_costs: { note: string | null; values: (number | null)[] };
        notes: { title: string; items: string[] }[];
    };
    bva: {
        subtitle: string;
        /** What finance enters each month from the P&L; null is a blank cell. */
        actuals: Record<ActualKey, (number | null)[]>;
        /** Months whose Actual cell reads =Budget in the workbook (July-September 2026). */
        actual_follows_budget: Record<ActualKey, boolean[]>;
    };
}

export type GroupKey = "pl" | "pt" | "support" | "focus";
export type ActualKey = "revenue_pl" | "revenue_pt" | "labour_pl" | "labour_pt" | "overhead" | "other_costs";
export const ACTUAL_KEYS: ActualKey[] = ["revenue_pl", "revenue_pt", "labour_pl", "labour_pt", "overhead", "other_costs"];

export const MONTHS = 18;

// --- Excel's rules ------------------------------------------------------------

export const isErr = (v: Val): v is ExcelError => typeof v === "object" && v !== null;
const VALUE: ExcelError = { error: "#VALUE!" };
const DIV0: ExcelError = { error: "#DIV/0!" };

/** COUNT: numbers only. */
const count = (...vs: Val[]) => vs.filter((v) => typeof v === "number").length;

/** SUM over cells: text and blanks ignored, the first error wins. */
function sum(vs: Val[]): Val {
    let t = 0;
    for (const v of vs) {
        if (isErr(v)) return v;
        if (typeof v === "number") t += v;
    }
    return t;
}

/** Arithmetic on a cell: text is #VALUE!, an error passes through. */
function arith(a: Val, b: Val, f: (x: number, y: number) => number): Val {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (a === "" || b === "") return VALUE;
    return f(a, b);
}
const sub = (a: Val, b: Val) => arith(a, b, (x, y) => x - y);
function div(a: Val, b: Val): Val {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (a === "" || b === "") return VALUE;
    return b === 0 ? DIV0 : a / b;
}
/** x = 0 inside OR(): an error makes the whole IF an error. */
function isZero(v: Val): boolean | ExcelError {
    if (isErr(v)) return v;
    return v === 0; // "" = 0 is FALSE in Excel
}
function or(...xs: (boolean | ExcelError)[]): boolean | ExcelError {
    for (const x of xs) if (typeof x === "object") return x;
    return xs.some(Boolean);
}

/** ROUNDUP(x, -k): away from zero, to a multiple of `step`. */
export function roundUp(x: number, step: number): number {
    const q = Math.abs(x) / step;
    // Guard against 1234.0000000002-style float noise before the ceiling.
    const r = Math.abs(q - Math.round(q)) < 1e-9 ? Math.round(q) : Math.ceil(q);
    return Math.sign(x) * r * step;
}

const range = (n = MONTHS) => Array.from({ length: n }, (_, i) => i);
const col = (rows: Val[][], i: number) => rows.map((r) => at(r, i));
/** Cell i of a row of months: always present, by construction. */
const at = (r: Val[], i: number): Val => r[i] as Val;

/** A row of 18 months plus its FY total. */
export interface Row {
    values: Val[];
    fy: Val;
}

function withFy(values: Val[], fyFrom: number): Row {
    return { values, fy: sum(values.slice(fyFrom)) };
}

// --- The computation ---------------------------------------------------------

export interface Forecast {
    revenue: {
        pl: Row[];
        plTotal: Row; // Revenue!10
        pt: Row[];
        ptTotal: Row; // Revenue!18
        total: Row; // Revenue!19
    };
    salary: {
        groups: { key: GroupKey; rows: Row[]; subtotal: Row }[];
        thr: Record<GroupKey, Row>;
        thrTotal: Row;
        bonus: Record<GroupKey, Row>;
        bonusTotal: Row;
    };
    gm: {
        revenuePl: Row; revenuePt: Row; revenue: Row;
        labourPl: Row; labourPt: Row; overhead: Row; otherCosts: Row;
        cogs: Row; gm: Row; gmPct: Row;
    };
    bva: {
        revenuePl: [Row, Row]; revenuePt: [Row, Row]; revenue: [Row, Row]; revenueVar: Row;
        labourPl: [Row, Row]; labourPt: [Row, Row]; overhead: [Row, Row]; otherCosts: [Row, Row];
        cogs: [Row, Row]; costVar: Row;
        gm: [Row, Row]; gmPct: [Row, Row]; gmVar: Row;
    };
}

export function computeForecast(m: ForecastInputs): Forecast {
    const F = m.fy_from;
    const R = m.rates.idr_per_aud;
    const row = (vs: Val[]) => withFy(vs, F);
    const typed = (vs: (number | null)[]) => vs.map((v) => (v === null ? "" : v)) as Val[];

    // Revenue: contracts, subtotals and total.
    const revPl = m.revenue.pl.map((l) => typed(l.values));
    const revPt = m.revenue.pt.map((l) => typed(l.values));
    const revPlTotal = range().map((i) => sum(col(revPl, i)));
    const revPtTotal = range().map((i) => sum(col(revPt, i)));
    const revTotal = range().map((i) => sum([at(revPlTotal, i), at(revPtTotal, i)]));

    // Salary: people by group, THR and bonus.
    const groups = m.salary.groups.map((g) => {
        const rows = g.rows.map((l) => typed(l.values));
        return { key: g.key, rows, subtotal: range().map((i) => sum(col(rows, i))) };
    });
    const sub_ = (k: GroupKey): Val[] => groups.find((g) => g.key === k)!.subtotal;
    const thr = Object.fromEntries(
        (Object.keys(m.salary.thr) as GroupKey[]).map((k) => [k, typed(m.salary.thr[k].values)]),
    ) as Record<GroupKey, Val[]>;
    const bonus = Object.fromEntries(
        (Object.keys(m.salary.bonus) as GroupKey[]).map((k) => [k, typed(m.salary.bonus[k].values)]),
    ) as Record<GroupKey, Val[]>;
    const KEYS: GroupKey[] = ["pl", "pt", "support", "focus"];
    const thrTotal = range().map((i) => sum(KEYS.map((k) => at(thr[k], i))));
    const bonusTotal = range().map((i) => sum(KEYS.map((k) => at(bonus[k], i))));

    // GM Summary. Typed months (the July-October actuals) are kept; the rest
    // are the workbook's formulas.
    const labourPl = range().map((i): Val => {
        const t = m.gm.labour_pl.values[i];
        if (t !== null && t !== undefined) return t;
        // =ROUNDUP((Salary!11+Salary!35+Salary!43)*(1+0.075),-4)/12700
        const base = sum([at(sub_("pl"), i), at(thr.pl, i), at(bonus.pl, i)]);
        if (isErr(base)) return base;
        return roundUp((base as number) * (1 + m.rates.labour_pl_markup), m.rates.labour_pl_round_to) / R;
    });
    const labourPt = range().map((i): Val => {
        const t = m.gm.labour_pt.values[i];
        if (t !== null && t !== undefined) return t;
        // =(Salary!17+36+44 + 25+37+45 + 31+38+46)/12700
        const s = sum([
            at(sub_("pt"), i), at(thr.pt, i), at(bonus.pt, i),
            at(sub_("support"), i), at(thr.support, i), at(bonus.support, i),
            at(sub_("focus"), i), at(thr.focus, i), at(bonus.focus, i),
        ]);
        return div(s, R);
    });
    const overhead = range().map((i): Val => {
        const t = m.gm.overhead.values[i];
        if (t !== null && t !== undefined) return t;
        return m.rates.overhead_monthly_idr / R; // =27968193.0/12700.0
    });
    const otherCosts = typed(m.gm.other_costs.values);
    const cogs = range().map((i) => sum([at(labourPl, i), at(labourPt, i), at(overhead, i), at(otherCosts, i)]));
    const gm = range().map((i) => sub(at(revTotal, i), at(cogs, i)));
    const gmPctAt = (rev: Val, g: Val): Val => {
        const z = isZero(rev);
        if (typeof z === "object") return z;
        return z ? 0 : div(g, rev);
    };
    const gmPct = range().map((i) => gmPctAt(at(revTotal, i), at(gm, i)));

    const gmRows = {
        revenuePl: row(revPlTotal), revenuePt: row(revPtTotal), revenue: row(revTotal),
        labourPl: row(labourPl), labourPt: row(labourPt), overhead: row(overhead), otherCosts: row(otherCosts),
        cogs: row(cogs), gm: row(gm), gmPct: { values: gmPct, fy: gmPctAt(row(revTotal).fy, row(gm).fy) },
    };

    // Budget vs Actual. Budget is the GM Summary; Actual is what is entered,
    // or =Budget in the months the workbook fills that way.
    const actual = (k: ActualKey, budget: Val[]): Val[] =>
        range().map((i) => {
            const v = m.bva.actuals[k]?.[i];
            if (v !== null && v !== undefined) return v;
            return m.bva.actual_follows_budget[k]?.[i] ? at(budget, i) : "";
        });
    const aRevPl = actual("revenue_pl", revPlTotal);
    const aRevPt = actual("revenue_pt", revPtTotal);
    const aLabPl = actual("labour_pl", labourPl);
    const aLabPt = actual("labour_pt", labourPt);
    const aOver = actual("overhead", overhead);
    const aOther = actual("other_costs", otherCosts);

    const ifAny = (vs: Val[], then: () => Val): Val => (count(...vs) === 0 ? "" : then());
    const aRev = range().map((i) => ifAny([at(aRevPl, i), at(aRevPt, i)], () => sum([at(aRevPl, i), at(aRevPt, i)])));
    const aCogs = range().map((i) =>
        ifAny([at(aLabPl, i), at(aLabPt, i), at(aOver, i), at(aOther, i)], () => sum([at(aLabPl, i), at(aLabPt, i), at(aOver, i), at(aOther, i)])),
    );
    // =IF(OR(budget=0,COUNT(actual)=0),"",(actual-budget)/budget)
    const variance = (b: Val, a: Val): Val => {
        const c = or(isZero(b), count(a) === 0);
        if (typeof c === "object") return c;
        return c ? "" : div(sub(a, b), b);
    };
    // The FY column: =IF(OR(U9=0,U10=0),"",(U10-U9)/U9)
    const fyVariance = (b: Val, a: Val): Val => {
        const c = or(isZero(b), isZero(a));
        if (typeof c === "object") return c;
        return c ? "" : div(sub(a, b), b);
    };
    const revVar = range().map((i) => variance(at(revTotal, i), at(aRev, i)));
    const costVar = range().map((i) => variance(at(cogs, i), at(aCogs, i)));
    const aGm = range().map((i) => ifAny([at(aRev, i), at(aCogs, i)], () => sub(at(aRev, i), at(aCogs, i))));
    const aGmPct = range().map((i) => ifAny([at(aRev, i)], () => div(at(aGm, i), at(aRev, i))));
    const gmVar = range().map((i) => variance(at(gm, i), at(aGm, i)));

    const pair = (b: Val[], a: Val[]): [Row, Row] => [row(b), row(a)];
    const bRev = pair(revTotal, aRev);
    const bCogs = pair(cogs, aCogs);
    const bGm = pair(gm, aGm);
    return {
        revenue: {
            pl: revPl.map(row), plTotal: row(revPlTotal),
            pt: revPt.map(row), ptTotal: row(revPtTotal),
            total: row(revTotal),
        },
        salary: {
            groups: groups.map((g) => ({ key: g.key, rows: g.rows.map(row), subtotal: row(g.subtotal) })),
            thr: Object.fromEntries(KEYS.map((k) => [k, row(thr[k])])) as Record<GroupKey, Row>,
            thrTotal: row(thrTotal),
            bonus: Object.fromEntries(KEYS.map((k) => [k, row(bonus[k])])) as Record<GroupKey, Row>,
            bonusTotal: row(bonusTotal),
        },
        gm: gmRows,
        bva: {
            revenuePl: pair(revPlTotal, aRevPl),
            revenuePt: pair(revPtTotal, aRevPt),
            revenue: bRev,
            revenueVar: { values: revVar, fy: fyVariance(bRev[0].fy, bRev[1].fy) },
            labourPl: pair(labourPl, aLabPl),
            labourPt: pair(labourPt, aLabPt),
            overhead: pair(overhead, aOver),
            otherCosts: pair(otherCosts, aOther),
            cogs: bCogs,
            costVar: { values: costVar, fy: fyVariance(bCogs[0].fy, bCogs[1].fy) },
            gm: bGm,
            // The workbook's FY cell for both GM % rows is =SUM(I:T) of the
            // monthly percentages, not total GM over total revenue. Kept as it is.
            gmPct: [row(gmPct), row(aGmPct)],
            gmVar: { values: gmVar, fy: fyVariance(bGm[0].fy, bGm[1].fy) },
        },
    };
}

/**
 * Every computed cell under its workbook address, columns C..U -- for the
 * check against the workbook, and for anyone reading the two side by side.
 */
export function forecastCells(f: Forecast): Record<string, Val> {
    const out: Record<string, Val> = {};
    const COLS = "CDEFGHIJKLMNOPQRST".split("");
    const put = (sheet: string, r: number, row: Row) => {
        row.values.forEach((v, i) => (out[`${sheet}!${COLS[i]}${r}`] = v));
        out[`${sheet}!U${r}`] = row.fy;
    };
    const G = "GM SUMMARY", B = "BUDGET VS ACTUAL", S = "SALARY", V = "REVENUE";
    f.revenue.pl.forEach((r, i) => put(V, 6 + i, r));
    put(V, 10, f.revenue.plTotal);
    f.revenue.pt.forEach((r, i) => put(V, 14 + i, r));
    put(V, 18, f.revenue.ptTotal);
    put(V, 19, f.revenue.total);
    const starts: Record<GroupKey, [number, number]> = { pl: [6, 11], pt: [15, 17], support: [21, 25], focus: [29, 31] };
    for (const g of f.salary.groups) {
        g.rows.forEach((r, i) => put(S, starts[g.key][0] + i, r));
        put(S, starts[g.key][1], g.subtotal);
    }
    (["pl", "pt", "support", "focus"] as GroupKey[]).forEach((k, i) => {
        put(S, 35 + i, f.salary.thr[k]);
        put(S, 43 + i, f.salary.bonus[k]);
    });
    put(S, 39, f.salary.thrTotal);
    put(S, 47, f.salary.bonusTotal);
    const g = f.gm;
    [g.revenuePl, g.revenuePt, g.revenue, g.labourPl, g.labourPt, g.overhead, g.otherCosts, g.cogs, g.gm, g.gmPct]
        .forEach((r, i) => put(G, 5 + i, r));
    const b = f.bva;
    const pairs: [number, [Row, Row]][] = [
        [5, b.revenuePl], [7, b.revenuePt], [9, b.revenue], [13, b.labourPl], [15, b.labourPt],
        [17, b.overhead], [19, b.otherCosts], [21, b.cogs], [25, b.gm], [27, b.gmPct],
    ];
    for (const [r, [bud, act]] of pairs) {
        put(B, r, bud);
        put(B, r + 1, act);
    }
    // The workbook's FY GM % cells (U27, U28) sum the monthly percentages.
    out[`${B}!U27`] = sum(b.gmPct[0].values.slice(6));
    out[`${B}!U28`] = sum(b.gmPct[1].values.slice(6));
    put(B, 11, b.revenueVar);
    put(B, 23, b.costVar);
    put(B, 29, b.gmVar);
    return out;
}
