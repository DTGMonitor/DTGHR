/*
 * preview.ts -- render one sample email per tone to HTML files, to look at in
 * a browser (or paste into an Outlook test message). Not deployed: the
 * function's bundle follows index.ts's imports only.
 *
 *   node supabase/functions/send-notifications/preview.ts [out-dir]
 *   deno run -A supabase/functions/send-notifications/preview.ts [out-dir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type NotificationPayload, renderEmail } from "./render.ts";

const samples: Record<string, NotificationPayload> = {
    action: {
        tone: "action",
        eyebrow: "Leave request",
        headline: "Bintang Dwitama has requested sick leave",
        intro: "It is waiting for your approval.",
        details: [["Type", "Sick leave"], ["Dates", "29 September 2026"], ["Days", "1"]],
        note: { by: "Bintang Dwitama", text: "Fever since last night." },
        link: { label: "Review the request", path: "/leaves" },
    },
    success: {
        tone: "success",
        eyebrow: "Leave approved",
        headline: "Your annual leave has been approved",
        details: [["Type", "Annual leave"], ["Dates", "2 November 2026 to 3 November 2026"], ["Days", "2"]],
        note: { by: "Nurhuda Teguh Santoso", text: "Enjoy the break." },
        link: { label: "Open your leave", path: "/leaves" },
    },
    danger: {
        tone: "danger",
        eyebrow: "Payroll sent back",
        headline: "Payroll for October 2026 has been sent back to you",
        intro: "The executive has sent it back for another review.",
        note: { by: "Peter Saunders", text: "Check <Nessa's> night shifts\nagainst the roster." },
        link: { label: "Review the payroll", path: "/payroll" },
    },
    reminder: {
        tone: "reminder",
        eyebrow: "Contract ending",
        headline: "Contract with PT Example Mining ends in 30 days",
        intro: "If it is being renewed, record the new end date or mark it renewed on Contracts & POs.",
        details: [["Contract", "Monitoring services 2026"], ["Ends", "6 November 2026"]],
        link: { label: "Open Contracts & POs", path: "/contracts" },
    },
};

const out = (typeof Deno !== "undefined" ? Deno.args[0] : process.argv[2]) ?? "email-preview";
mkdirSync(out, { recursive: true });
for (const [name, payload] of Object.entries(samples)) {
    const { html, text } = renderEmail(payload, "Nurhuda Teguh Santoso", "https://people.digitaltwingeotechnical.com");
    writeFileSync(join(out, `${name}.html`), html);
    writeFileSync(join(out, `${name}.txt`), text);
    console.log(`wrote ${join(out, name)}.html`);
}

declare const Deno: { args: string[] } | undefined;
