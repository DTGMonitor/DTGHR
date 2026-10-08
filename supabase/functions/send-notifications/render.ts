/*
 * render.ts -- one email layout for every notification.
 *
 * The triggers write a structured payload into public.notifications (see the
 * migration 20261007000100_in_app_notifications.sql); this turns one into the
 * HTML and plain text that go out through Graph. Every notification kind uses
 * the same layout; the tone only picks the accent colour.
 *
 * Built for desktop Outlook, which renders with Word: nested tables, inline
 * styles, no images, no border-radius it depends on, and the button padded on
 * a <td> so it is still a block where Outlook ignores padding on <a>.
 */

export type Tone = "action" | "success" | "danger" | "reminder";

export type NotificationPayload = {
    tone: Tone;
    eyebrow: string;
    headline: string;
    intro?: string;
    details?: [string, string][];
    note?: { by?: string; text: string };
    link: { label: string; path: string };
};

// The DTG tokens (tailwind.config.js). The body is light even though the app
// is dark: mail clients invert or ignore dark backgrounds unpredictably.
const C = {
    band: "#0B1A22",
    bandText: "#F4F8F9",
    page: "#EAF2F4",
    card: "#FFFFFF",
    ink: "#10202A",
    inkSoft: "#51626B",
    rule: "#CFE0E6",
    noteBg: "#F4F8F9",
    signal: "#63B75D",
    onSignal: "#06210A",
};

const ACCENT: Record<Tone, string> = {
    action: "#63B75D",
    success: "#63B75D",
    danger: "#A63A2B",
    reminder: "#D6A73A",
};

const FONT = "'Segoe UI',Helvetica,Arial,sans-serif";

export function escapeHtml(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const multiline = (s: string) => escapeHtml(s).replace(/\r?\n/g, "<br>");

const text = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

/** The payload as stored, made safe to lay out: every optional part optional. */
function normalise(p: Partial<NotificationPayload> | null | undefined) {
    const tone: Tone = p?.tone && p.tone in ACCENT ? p.tone : "action";
    const details = Array.isArray(p?.details)
        ? p!.details
              .filter((d) => Array.isArray(d) && text(d[0]) && text(d[1]))
              .map((d) => [text(d[0]), text(d[1])] as [string, string])
        : [];
    const noteText = text(p?.note?.text);
    return {
        tone,
        eyebrow: text(p?.eyebrow),
        headline: text(p?.headline),
        intro: text(p?.intro),
        details,
        note: noteText ? { by: text(p?.note?.by), text: noteText } : null,
        linkLabel: text(p?.link?.label) || "Open DTG People",
        linkPath: text(p?.link?.path) || "/",
    };
}

export function linkUrl(siteUrl: string, path: string): string {
    const base = siteUrl.replace(/\/+$/, "");
    return base + (path.startsWith("/") ? path : "/" + path);
}

export function renderEmail(
    payload: Partial<NotificationPayload> | null | undefined,
    recipientName: string | null | undefined,
    siteUrl: string,
): { html: string; text: string } {
    const p = normalise(payload);
    if (!p.headline) throw new Error("notification payload has no headline");
    const accent = ACCENT[p.tone];
    const url = linkUrl(siteUrl, p.linkPath);
    const name = text(recipientName);

    const detailRows = p.details
        .map(
            ([k, v]) => `
                <tr>
                  <td valign="top" style="padding:8px 16px 8px 0;border-top:1px solid ${C.rule};font-family:${FONT};font-size:13px;line-height:1.5;color:${C.inkSoft};white-space:nowrap;width:1%">${escapeHtml(k)}</td>
                  <td valign="top" style="padding:8px 0;border-top:1px solid ${C.rule};font-family:${FONT};font-size:14px;line-height:1.5;color:${C.ink}">${multiline(v)}</td>
                </tr>`,
        )
        .join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(p.headline)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}">
  <tr>
    <td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
        <tr>
          <td style="background:${C.band};padding:18px 28px;font-family:${FONT};font-size:17px;font-weight:700;letter-spacing:0.2px;color:${C.bandText}">DTG People</td>
        </tr>
        <tr>
          <td style="background:${C.card};border-top:4px solid ${accent};padding:28px 28px 8px 28px">
            ${p.eyebrow ? `<p style="margin:0 0 6px 0;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${accent}">${escapeHtml(p.eyebrow)}</p>` : ""}
            <h1 style="margin:0 0 18px 0;font-family:${FONT};font-size:20px;line-height:1.35;font-weight:700;color:${C.ink}">${escapeHtml(p.headline)}</h1>
            ${name ? `<p style="margin:0 0 12px 0;font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink}">Dear ${escapeHtml(name)},</p>` : ""}
            ${p.intro ? `<p style="margin:0 0 18px 0;font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink}">${multiline(p.intro)}</p>` : ""}
            ${detailRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;border-bottom:1px solid ${C.rule}">${detailRows}
            </table>` : ""}
            ${p.note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0">
              <tr>
                <td style="background:${C.noteBg};border-left:3px solid ${accent};padding:12px 16px;font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink}">
                  ${p.note.by ? `<p style="margin:0 0 4px 0;font-size:12px;font-weight:700;color:${C.inkSoft}">${escapeHtml(p.note.by)} wrote</p>` : ""}
                  <p style="margin:0">${multiline(p.note.text)}</p>
                </td>
              </tr>
            </table>` : ""}
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 16px 0">
              <tr>
                <td bgcolor="${C.signal}" style="background:${C.signal};padding:11px 20px">
                  <a href="${escapeHtml(url)}" style="font-family:${FONT};font-size:14px;font-weight:700;color:${C.onSignal};text-decoration:none;display:inline-block">${escapeHtml(p.linkLabel)}</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 20px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.inkSoft}">If the button does not work, copy this address into your browser:<br><a href="${escapeHtml(url)}" style="color:${C.inkSoft};word-break:break-all">${escapeHtml(url)}</a></p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.inkSoft}">DTG People. This is an automatic notification; replies to this address are not read. You can turn these emails off on your profile.</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

    const lines: string[] = [];
    if (p.eyebrow) lines.push(p.eyebrow.toUpperCase());
    lines.push(p.headline, "");
    if (name) lines.push(`Dear ${name},`, "");
    if (p.intro) lines.push(p.intro, "");
    if (p.details.length) {
        for (const [k, v] of p.details) lines.push(`${k}: ${v}`);
        lines.push("");
    }
    if (p.note) {
        lines.push(p.note.by ? `${p.note.by} wrote:` : "Note:");
        lines.push(...p.note.text.split(/\r?\n/).map((l) => `> ${l}`), "");
    }
    lines.push(`${p.linkLabel}: ${url}`, "", "-- ",
        "DTG People. This is an automatic notification; replies to this address are not read.", "");

    return { html, text: lines.join("\n") };
}
