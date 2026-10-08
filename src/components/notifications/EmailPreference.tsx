import { useEffect, useState } from "react";
import { getEmailPreference, setEmailPreference } from "@/lib/notifications";

/*
 * Whether you are also emailed about your notifications. In-app ones carry
 * on either way -- turning email off no longer means hearing nothing. Saved
 * the moment it is switched.
 */
export default function EmailPreference() {
    const [on, setOn] = useState<boolean | null>(null);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

    useEffect(() => {
        getEmailPreference()
            .then(setOn)
            .catch(() => setMessage({ ok: false, text: "Could not load your email setting." }));
    }, []);

    const toggle = async () => {
        if (on === null || saving) return;
        const next = !on;
        setSaving(true);
        setMessage(null);
        try {
            setOn(await setEmailPreference(next));
            setMessage({ ok: true, text: next ? "Emails turned on." : "Emails turned off." });
        } catch (e) {
            setMessage({ ok: false, text: e instanceof Error ? e.message : "Could not save." });
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="dtg-panel p-5">
            <p className="dtg-eyebrow">Notifications</p>
            <div className="mt-2 flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h2 id="email-pref-label" className="text-base font-semibold text-paper">
                        Email me about notifications
                    </h2>
                    <p className="mt-1 text-sm text-paper-soft">
                        Approvals, tickets and decisions that concern you. You will still see them under
                        Notifications in the app either way.
                    </p>
                    {message && (
                        <p role="status" className={`mt-2 text-xs ${message.ok ? "text-signal" : "text-danger"}`}>
                            {message.text}
                        </p>
                    )}
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={on === true}
                    aria-labelledby="email-pref-label"
                    disabled={on === null || saving}
                    onClick={() => void toggle()}
                    className={`relative mt-1 h-6 w-11 flex-shrink-0 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50 ${
                        on ? "border-signal bg-signal" : "border-white/20 bg-deep"
                    }`}
                >
                    <span
                        aria-hidden="true"
                        className={`absolute top-0.5 h-[1.125rem] w-[1.125rem] rounded-full transition-all ${
                            on ? "left-[1.375rem] bg-signal-on" : "left-0.5 bg-paper-soft"
                        }`}
                    />
                </button>
            </div>
        </section>
    );
}
