/*
 * Routes for payslips: each person's slips (My Profile), one slip as a PDF,
 * the release settings (Settings) and a month's slips (Payroll). Answered by
 * the payslips_* functions in supabase/migrations/20260928000300_payslips.sql.
 *
 * The PDF is drawn here, in the browser, from the slip's snapshot and the
 * company template (src/lib/payslipPdf.ts). The template carries Peter's
 * signature and the stamp, so it comes from the database for somebody allowed
 * a slip, never from the public bundle, and is kept in memory for the rest of
 * the session.
 */
import { route } from "@/lib/api";
import { ApiError, rpc, supabase } from "@/lib/supabase";
// pdf-lib is loaded only when somebody opens a slip, not with every page.
import type { PayslipData } from "@/lib/payslipPdf";

interface Slip {
    id: string;
    year: number;
    month: number;
    issue_date: string;
    data: PayslipData;
}

let template: Promise<Uint8Array> | null = null;

// A different person signing in must not inherit the last one's copy.
supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") template = null;
});

function loadTemplate(): Promise<Uint8Array> {
    if (!template) {
        template = rpc<string>("payslips_template")
            .then((b64) => {
                const bin = atob(b64.replace(/\s+/g, ""));
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return bytes;
            })
            .catch((err) => {
                template = null;
                throw err;
            });
    }
    return template;
}

async function render(data: PayslipData): Promise<{ blob: Blob; filename: string }> {
    const [bytes, { fillPayslip }] = await Promise.all([loadTemplate(), import("@/lib/payslipPdf")]);
    const pdf = await fillPayslip(bytes, data);
    return {
        blob: new Blob([pdf as BlobPart], { type: "application/pdf" }),
        filename: data.file_name,
    };
}

/** An issued slip as a PDF Blob, with the file name it downloads under. */
export async function payslipPdf(id: string): Promise<{ blob: Blob; filename: string }> {
    const slip = await rpc<Slip>("payslips_get", { p_id: id });
    return render(slip.data);
}

/**
 * Any person's slip for an approved month, built now from the current
 * figures: payroll viewers only, and before its release moment too.
 */
export async function previewPdf(
    monthId: string,
    lineId: string,
): Promise<{ blob: Blob; filename: string }> {
    const data = await rpc<PayslipData>("payslips_preview", { p_month_id: monthId, p_line_id: lineId });
    return render(data);
}

function object(body: unknown): Record<string, unknown> {
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

// Fixed paths before "/payslips/:id", which would otherwise answer them.
route("GET", "/payslips/mine", () => rpc("payslips_mine"));

route("GET", "/payslips/settings", () => rpc("payslips_settings_get"));

route("PUT", "/payslips/settings", ({ body }) =>
    rpc("payslips_settings_update", { p_changes: object(body) }),
);

route("GET", "/payslips/:id", ({ path }) => rpc("payslips_get", { p_id: path.id }));

// The viewer asks with responseType "blob"; a PDF is the only answer.
route("GET", "/payslips/:id/pdf", async ({ path, responseType }) => {
    if (responseType !== "blob") throw new ApiError("Ask for the payslip as a file.", 406);
    return (await payslipPdf(path.id ?? "")).blob;
});

route("GET", "/payroll/months/:id/payslips", ({ path }) =>
    rpc("payslips_for_month", { p_month_id: path.id }),
);

route("POST", "/payroll/months/:id/payslips/issue", ({ path, body }) =>
    rpc("payslips_issue_now", {
        p_month_id: path.id,
        p_employee_id: object(body).employee_id ?? null,
    }),
);

route("GET", "/payroll/months/:id/lines/:lineId/payslip.pdf", async ({ path, responseType }) => {
    if (responseType !== "blob") throw new ApiError("Ask for the payslip as a file.", 406);
    return (await previewPdf(path.id ?? "", path.lineId ?? "")).blob;
});

// ── The actual PPh 21 ────────────────────────────────────────────────────

route("GET", "/payroll-tax", ({ query }) => {
    const year = Number(query.year);
    if (!Number.isInteger(year)) throw new ApiError("year must be a whole number", 422);
    return rpc("payroll_tax_list", { p_year: year });
});

route("PUT", "/payroll-tax/lines/:id", ({ path, body }) => {
    const b = object(body);
    return rpc("payroll_tax_set", {
        p_line_id: path.id,
        p_actual: b.actual,
        p_note: typeof b.note === "string" ? b.note : null,
    });
});

route("DELETE", "/payroll-tax/lines/:id", ({ path }) =>
    rpc("payroll_tax_clear", { p_line_id: path.id }),
);
