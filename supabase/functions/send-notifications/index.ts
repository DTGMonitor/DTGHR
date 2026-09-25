/*
 * send-notifications -- deliver the queued emails in public.email_outbox
 * through Microsoft Graph, from noreply@dtgeotech.com.
 *
 * The rows are written by the triggers in
 * supabase/migrations/20260926001300_notifications.sql; pg_cron calls this
 * function once a minute (the same migration schedules it). Each run takes up
 * to 25 unsent rows, oldest first, with fewer than five attempts behind them
 * (`notifications_claim`), sends each one, and records the result
 * (`notifications_mark`). A failed row is retried on the next run, up to five
 * attempts in all; its last error stays on the row.
 *
 * ── Setup, once per project ────────────────────────────────────────────────
 *
 * 1. Microsoft Entra app registration with the *application* permission
 *    Mail.Send (admin consent granted). Ideally restrict it to the noreply
 *    mailbox with an Exchange application access policy.
 *
 * 2. Function secrets (never commit the values):
 *
 *      supabase secrets set \
 *        MS_TENANT_ID=<directory (tenant) id> \
 *        MS_CLIENT_ID=<application (client) id> \
 *        MS_CLIENT_SECRET=<client secret value> \
 *        CRON_SECRET=<a long random string, e.g. `openssl rand -hex 32`>
 *
 *    Optional: MAIL_SENDER (default noreply@dtgeotech.com).
 *    SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
 *
 * 3. Vault entries the cron job reads (SQL editor, as postgres):
 *
 *      select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
 *      select vault.create_secret('<the same CRON_SECRET as above>', 'cron_secret');
 *
 * 4. Deploy. The cron job authenticates with CRON_SECRET, which is not a JWT,
 *    so the gateway's JWT check is off and this function checks the bearer
 *    itself:
 *
 *      supabase functions deploy send-notifications --no-verify-jwt
 *
 * 5. Enable the pg_cron and pg_net extensions (Dashboard -> Database ->
 *    Extensions) if they are not already, then apply the migration (or re-run
 *    its final `do $$ ... $$` block) so the job `send-notifications` exists:
 *
 *      select * from cron.job where jobname = 'send-notifications';
 *
 * To stop all email for one person: update public.users set
 * email_notifications = false where email = '...';
 *
 * ── Contract ───────────────────────────────────────────────────────────────
 *   POST (any body), Authorization: Bearer <CRON_SECRET or service-role key>
 *   200 { claimed, sent, failed }
 *   401 { detail: "Unauthorized" }
 *   500 { detail } -- configuration missing, or the token request failed
 *        (the claimed rows are marked failed with that error)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type OutboxRow = {
    id: string;
    to_email: string;
    to_name: string | null;
    subject: string;
    body_html: string;
    body_text: string;
};

const BATCH = 25;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Compare two strings in time independent of where they differ. */
function sameSecret(a: string, b: string): boolean {
    const x = new TextEncoder().encode(a);
    const y = new TextEncoder().encode(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return diff === 0;
}

function authorised(req: Request): boolean {
    const header = req.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return false;
    const accepted = [Deno.env.get("CRON_SECRET"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")]
        .filter((s): s is string => !!s && s.length >= 16);
    return accepted.some((s) => sameSecret(token, s));
}

async function graphToken(tenant: string, clientId: string, secret: string): Promise<string> {
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: secret,
            scope: "https://graph.microsoft.com/.default",
            grant_type: "client_credentials",
        }),
        signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.access_token !== "string") {
        // Never echo the secret; Entra's error text does not contain it.
        throw new Error(`token request failed (${res.status}): ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
    }
    return body.access_token;
}

async function sendOne(token: string, sender: string, row: OutboxRow): Promise<void> {
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            message: {
                subject: row.subject,
                body: { contentType: "HTML", content: row.body_html },
                toRecipients: [{ emailAddress: { address: row.to_email, name: row.to_name ?? undefined } }],
            },
            saveToSentItems: false,
        }),
        signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 202 && !res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Graph sendMail ${res.status}: ${text.slice(0, 500)}`);
    }
}

Deno.serve(async (req) => {
    if (req.method !== "POST") return json({ detail: "Method not allowed" }, 405);
    if (!authorised(req)) return json({ detail: "Unauthorized" }, 401);

    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" }, 500);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data, error } = await admin.rpc("notifications_claim", { p_limit: BATCH });
    if (error) return json({ detail: `claim failed: ${error.message}` }, 500);
    const rows = (data ?? []) as OutboxRow[];
    if (!rows.length) return json({ claimed: 0, sent: 0, failed: 0 });

    const mark = (id: string, err: string | null) => admin.rpc("notifications_mark", { p_id: id, p_error: err });

    const tenant = Deno.env.get("MS_TENANT_ID");
    const clientId = Deno.env.get("MS_CLIENT_ID");
    const clientSecret = Deno.env.get("MS_CLIENT_SECRET");
    const sender = Deno.env.get("MAIL_SENDER") || "noreply@dtgeotech.com";

    let token: string;
    try {
        if (!tenant || !clientId || !clientSecret) throw new Error("MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET missing");
        token = await graphToken(tenant, clientId, clientSecret);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await Promise.all(rows.map((r) => mark(r.id, message)));
        return json({ detail: message, claimed: rows.length, sent: 0, failed: rows.length }, 500);
    }

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            await sendOne(token, sender, row);
            await mark(row.id, null);
            sent++;
        } catch (e) {
            await mark(row.id, e instanceof Error ? e.message : String(e));
            failed++;
        }
    }
    return json({ claimed: rows.length, sent, failed });
});
