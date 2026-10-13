// Checks the pay forecast arithmetic (src/lib/payForecast.ts) against the
// workbook it was built from, cell by cell.
//
//   node scripts/check-pay-forecast.mjs <inputs.json> <expected.json>
//
// inputs.json is the forecast as DTG People stores it; expected.json is every
// cell of the workbook evaluated by an independent engine (the Python
// `formulas` package), keyed "SHEET!A1". Neither file is in the repository:
// they hold salaries, and the repository is public.
import { readFileSync } from "node:fs";
import { computeForecast, forecastCells, isErr } from "../src/lib/payForecast.ts";

const [inputsPath, expectedPath] = process.argv.slice(2);
if (!inputsPath || !expectedPath) {
    console.error("usage: node scripts/check-pay-forecast.mjs <inputs.json> <expected.json>");
    process.exit(2);
}
const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));
const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
const cells = forecastCells(computeForecast(inputs));

const show = (v) => (isErr(v) ? v.error : JSON.stringify(v));
let checked = 0;
const bad = [];
for (const [addr, got] of Object.entries(cells)) {
    if (!(addr in expected)) {
        bad.push(`${addr}: not in the workbook`);
        continue;
    }
    const want = expected[addr];
    checked++;
    if (typeof want === "number") {
        const ok = typeof got === "number" && Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));
        if (!ok) bad.push(`${addr}: got ${show(got)}, workbook ${want}`);
    } else {
        // Empty string, or an Excel error such as "#VALUE!".
        const w = want === "" || want === "empty" ? "" : want;
        const g = isErr(got) ? got.error : got;
        if (g !== w) bad.push(`${addr}: got ${show(got)}, workbook ${JSON.stringify(want)}`);
    }
}
if (bad.length) {
    console.error(`${bad.length} of ${checked} cells differ:\n  ` + bad.slice(0, 40).join("\n  "));
    process.exit(1);
}
console.log(`all ${checked} computed cells match the workbook`);
