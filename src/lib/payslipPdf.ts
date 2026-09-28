/*
 * A payslip, drawn onto the company's own template.
 *
 * The template is the August 2026 sample with every variable piece of text
 * taken out -- the rules, labels, logo, Peter's signature and the stamp stay.
 * It is held in the database (payslips_template()), not shipped with the
 * app, because the signature and stamp must not be downloadable by anybody
 * who has not signed in.
 *
 * Everything written here comes from the slip's `data` snapshot, which the
 * database computed from the approved payroll line when the slip was issued:
 * this module lays figures out, it never works any of them out.
 *
 * Positions are the sample's own, read off it with PyMuPDF (text baselines,
 * in points from the top of an A4 page) and turned over here for pdf-lib,
 * whose origin is the bottom-left corner. The sample is Times New Roman; the
 * standard Times fonts have the same metrics, so right-aligned columns land
 * on the same edge.
 *
 * Kept free of the app's path aliases so the database test suite can import
 * it straight into Node and check what it writes.
 */
import {
    PDFDocument,
    StandardFonts,
    rgb,
    setCharacterSpacing,
    type Color,
    type PDFFont,
    type PDFPage,
} from "pdf-lib";

export interface PayslipLine {
    rate: number;
    unit: string;
    amount: number;
}

export interface PayslipData {
    period_label: string;
    year: number;
    month: number;
    issue_date: string;
    person_name: string;
    first_name: string;
    position: string;
    tax_bearer: string;
    file_name: string;
    earnings: {
        base: PayslipLine;
        health: PayslipLine;
        responsibility: PayslipLine;
        shift: PayslipLine;
        overtime: PayslipLine;
        bpjs_employment: number;
        bpjs_health: number;
        income_tax: number;
        others: number;
    };
    deductions: {
        bpjs_employment: number;
        bpjs_health: number;
        income_tax: number;
    };
    total_earnings: number;
    total_deductions: number;
    net_pay: number;
    /**
     * True while the PPh 21 on the slip is the estimate the payroll was
     * approved with, not yet the actual. Absent on slips issued before
     * actuals existed, which carried the estimate.
     */
    tax_is_estimate?: boolean;
}

const PAGE_HEIGHT = 841.92;
const SIZE = 7.68;
const NET_SIZE = 8.4;
const SUP_SIZE = 5.16;
const SUP_RISE = 3.84;
/* The sample's bold figures are set a little looser than the font's own
   advance widths (the spreadsheet export spaces them out); measured off the
   sample, per piece of text, so the left edges land where the sample's do. */
const SPACING = { period: 0.18, totalEarnings: 0.15, totalDeductions: 0.135, netPay: 0.245 };
/* The sheet's accounting format sets a zero as a dash, indented from the
   column's right edge by the width it reserves for a closing bracket. */
const DASH_INSET = 7.5;

const X = {
    detail: 119.3,
    period: 350.6,
    rate: 207.84,
    unit: 229.68,
    amount: 293.05,
    deduction: 534.08,
    totalEarnings: 292.75,
    totalDeductions: 536.4,
    netPay: 533.33,
    date: 473.7,
};

/*
 * The two tax labels the template already prints, and the cells they sit in.
 * While the tax is an estimate " (estimate)" is set straight after each; the
 * earnings cell ends where the Rate column's rule is, so the suffix shrinks
 * there until it fits. The rules are at x 162.12 and 408.12 in the template.
 */
const TAX_LABELS = {
    earnings: { text: "Income Tax Art 21 Allowance", x: 52.32, cellEnd: 162.12, row: 7 },
    deductions: { text: "Income Tax Art 21", x: 298.33, cellEnd: 408.12, row: 2 },
};
const ESTIMATE_SUFFIX = " (estimate)";
const CELL_PADDING = 1;
const NOTE_SIZE = 6.5;
const NOTE_X = 52.3;
/* Under the Net Pay row, whose bottom rule is at 320.5. */
const NOTE_Y = 328.8;
export const ESTIMATE_NOTE = "PPh 21 shown is an estimate and will be revised to the actual amount.";

/* Baselines, measured from the top of the page. */
const Y = {
    period: 115.56,
    name: 137.16,
    position: 147.84,
    taxBearer: 158.04,
    rows: [210.84, 221.52, 232.2, 242.88, 253.56, 264.24, 274.92, 285.6, 296.28],
    totals: 306.48,
    netPay: 317.64,
    date: 361.08,
};

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

/** `22,000,000`: whole rupiah, rounded half-up, English separators. */
export function formatAmount(value: number): string {
    const n = Math.round(Math.abs(value));
    const s = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return value < 0 && n !== 0 ? `-${s}` : s;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 22nd, 23rd … 31st. */
export function ordinalSuffix(day: number): string {
    const teen = day % 100;
    if (teen >= 11 && teen <= 13) return "th";
    switch (day % 10) {
        case 1:
            return "st";
        case 2:
            return "nd";
        case 3:
            return "rd";
        default:
            return "th";
    }
}

/** The line above the signature, in parts: `August 31`, `st`, `, 2026`. */
export function issueDateParts(isoDate: string): [string, string, string] {
    const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number) as [number, number, number];
    return [`${MONTHS[m - 1]} ${d}`, ordinalSuffix(d), `, ${y}`];
}

interface Fonts {
    regular: PDFFont;
    bold: PDFFont;
}

function top(y: number): number {
    return PAGE_HEIGHT - y;
}

function left(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size = SIZE) {
    page.drawText(text, { x, y: top(y), font, size, color: rgb(0, 0, 0) });
}

function right(
    page: PDFPage,
    text: string,
    x: number,
    y: number,
    font: PDFFont,
    size = SIZE,
    color: Color = rgb(0, 0, 0),
    spacing = 0,
) {
    const width = font.widthOfTextAtSize(text, size) + spacing * text.length;
    draw(page, text, x - width, y, font, size, color, spacing);
}

/* Character spacing is not a drawText option, so it is set around the text. */
function draw(
    page: PDFPage,
    text: string,
    x: number,
    y: number,
    font: PDFFont,
    size: number,
    color: Color,
    spacing: number,
) {
    if (spacing) page.pushOperators(setCharacterSpacing(spacing));
    page.drawText(text, { x, y: top(y), font, size, color });
    if (spacing) page.pushOperators(setCharacterSpacing(0));
}

function centre(
    page: PDFPage,
    text: string,
    x: number,
    y: number,
    font: PDFFont,
    size = SIZE,
    spacing = 0,
) {
    const width = font.widthOfTextAtSize(text, size) + spacing * text.length;
    draw(page, text, x - width / 2, y, font, size, rgb(0, 0, 0), spacing);
}

/** An amount in a column, or the dash a zero shows as. */
function money(page: PDFPage, value: number, x: number, y: number, font: PDFFont) {
    if (Math.round(value) === 0) right(page, "-", x - DASH_INSET, y, font);
    else right(page, formatAmount(value), x, y, font);
}

/** Fill the template with one slip. Returns the finished PDF's bytes. */
export async function fillPayslip(
    template: Uint8Array | ArrayBuffer,
    data: PayslipData,
): Promise<Uint8Array> {
    const doc = await PDFDocument.load(template);
    const fonts: Fonts = {
        regular: await doc.embedFont(StandardFonts.TimesRoman),
        bold: await doc.embedFont(StandardFonts.TimesRomanBold),
    };
    const italic = data.tax_is_estimate ? await doc.embedFont(StandardFonts.TimesRomanItalic) : null;
    const page = doc.getPage(0);
    const { regular, bold } = fonts;

    doc.setTitle(`Payslip ${data.period_label} - ${data.first_name}`);
    doc.setAuthor("PT. Digital Twin Geotechnical Indonesia");

    centre(page, data.period_label, X.period, Y.period, bold, SIZE, SPACING.period);

    left(page, data.person_name, X.detail, Y.name, regular);
    left(page, data.position, X.detail, Y.position, regular);
    left(page, data.tax_bearer, X.detail, Y.taxBearer, regular);

    const e = data.earnings;
    const withRate = [e.base, e.health, e.responsibility, e.shift, e.overtime];
    withRate.forEach((line, i) => {
        const y = Y.rows[i]!;
        money(page, line.rate, X.rate, y, regular);
        centre(page, line.unit, X.unit, y, regular);
        money(page, line.amount, X.amount, y, regular);
    });
    // Amount-only rows stay blank at zero, as the sample leaves "Others".
    [e.bpjs_employment, e.bpjs_health, e.income_tax, e.others].forEach((amount, i) => {
        if (amount) money(page, amount, X.amount, Y.rows[5 + i]!, regular);
    });

    const d = data.deductions;
    [d.bpjs_employment, d.bpjs_health, d.income_tax].forEach((amount, i) => {
        money(page, amount, X.deduction, Y.rows[i]!, regular);
    });

    const black = rgb(0, 0, 0);
    const red = rgb(1, 0, 0);
    right(
        page,
        formatAmount(data.total_earnings),
        X.totalEarnings,
        Y.totals,
        bold,
        SIZE,
        black,
        SPACING.totalEarnings,
    );
    if (Math.round(data.total_deductions) === 0) {
        right(page, "-", X.deduction - DASH_INSET, Y.totals, bold, SIZE, red);
    } else {
        right(
            page,
            `(${formatAmount(data.total_deductions)})`,
            X.totalDeductions,
            Y.totals,
            bold,
            SIZE,
            red,
            SPACING.totalDeductions,
        );
    }
    right(page, formatAmount(data.net_pay), X.netPay, Y.netPay, bold, NET_SIZE, black, SPACING.netPay);

    // An estimated PPh 21 says so, on both labels and under the net pay.
    // Each label takes " (estimate)" if it fits its cell at full size, and an
    // asterisk otherwise (the earnings one: a shrunk suffix was unreadable).
    if (data.tax_is_estimate && italic) {
        let starred = false;
        for (const label of [TAX_LABELS.earnings, TAX_LABELS.deductions]) {
            const x = label.x + regular.widthOfTextAtSize(label.text, SIZE);
            const room = label.cellEnd - CELL_PADDING - x;
            const fits = regular.widthOfTextAtSize(ESTIMATE_SUFFIX, SIZE) <= room;
            if (!fits) starred = true;
            left(page, fits ? ESTIMATE_SUFFIX : "*", x, Y.rows[label.row]!, regular);
        }
        left(page, (starred ? "* " : "") + ESTIMATE_NOTE, NOTE_X, NOTE_Y, italic, NOTE_SIZE);
    }

    // "August 31st, 2026", the ordinal set as a superscript.
    const [head, sup, tail] = issueDateParts(data.issue_date);
    const width =
        regular.widthOfTextAtSize(head, SIZE) +
        regular.widthOfTextAtSize(sup, SUP_SIZE) +
        regular.widthOfTextAtSize(tail, SIZE);
    let x = X.date - width / 2;
    left(page, head, x, Y.date, regular);
    x += regular.widthOfTextAtSize(head, SIZE);
    left(page, sup, x, Y.date - SUP_RISE, regular, SUP_SIZE);
    x += regular.widthOfTextAtSize(sup, SUP_SIZE);
    left(page, tail, x, Y.date, regular);

    return doc.save();
}
