import { useEffect, useState } from "react";

import Spinner from "@/components/ui/Spinner";
import { useAuth } from "@/contexts/AuthContext";
import { errorDetail, investigationService, type TeamSetting } from "@/services/investigationService";

type Flag = "can_investigate" | "is_monitoring_team";

const CARDS: { flag: Flag; eyebrow: string; title: string; help: string }[] = [
    {
        flag: "can_investigate",
        eyebrow: "Investigations",
        title: "Investigators",
        help: "Opens the Investigations page: every monitoring investigation, its findings and every decision. They record, issue, revise and close cases, and are emailed when a decision is disputed.",
    },
    {
        flag: "is_monitoring_team",
        eyebrow: "Investigations",
        title: "Monitoring team",
        help: "The engineers who can be named in an investigation — on duty, handing over, or given a decision. Grants no access to anything.",
    },
];

/*
 * Who investigates, and who can be investigated.
 *
 * Two separate lists on purpose: being management does not make somebody an
 * investigator (Mark is not one), and a new monitoring engineer joins the
 * team here rather than by a change to the database.
 */
export default function InvestigationSettingsCards({ onError }: { onError: (msg: string) => void }) {
    const { user, refreshUser } = useAuth();
    const [rows, setRows] = useState<TeamSetting[] | null>(null);
    const [saving, setSaving] = useState<string | null>(null);

    useEffect(() => {
        investigationService
            .teamSettings()
            .then((res) => setRows(res.data))
            .catch(() => onError("Could not load the investigation settings."));
    }, [onError]);

    const toggle = async (row: TeamSetting, flag: Flag) => {
        const next = !row[flag];
        setSaving(`${row.id}:${flag}`);
        setRows((list) => list?.map((r) => (r.id === row.id ? { ...r, [flag]: next } : r)) ?? null);
        try {
            const res = await investigationService.setFlag(row.id, flag, next);
            setRows((list) => list?.map((r) => (r.id === row.id ? res.data : r)) ?? null);
            // The sidebar reads the investigator flag off the session.
            if (flag === "can_investigate" && row.id === user?.employee_id) await refreshUser().catch(() => {});
        } catch (e) {
            setRows((list) => list?.map((r) => (r.id === row.id ? { ...r, [flag]: !next } : r)) ?? null);
            onError(errorDetail(e, "That change did not save."));
        } finally {
            setSaving(null);
        }
    };

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            {CARDS.map((c) => (
                <section key={c.flag} className="dtg-panel overflow-hidden">
                    <header className="border-b border-white/[0.08] px-5 py-3.5">
                        <p className="dtg-eyebrow">{c.eyebrow}</p>
                        <h2 className="mt-0.5 text-sm font-semibold text-paper">{c.title}</h2>
                        <p className="mt-1.5 text-xs leading-relaxed text-muted">{c.help}</p>
                    </header>
                    {!rows ? (
                        <div className="flex items-center gap-2.5 px-5 py-8 text-sm text-paper-soft">
                            <Spinner className="h-4 w-4 text-signal" />
                            Loading…
                        </div>
                    ) : (
                        <ul className="divide-y divide-white/[0.05]">
                            {rows.map((r) => {
                                const on = r[c.flag];
                                const busy = saving === `${r.id}:${c.flag}`;
                                return (
                                    <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm text-paper">{r.name}</span>
                                            <span className="block font-mono text-micro text-muted">
                                                {r.employee_id}
                                                {r.position ? ` · ${r.position}` : ""}
                                            </span>
                                        </span>
                                        <button
                                            role="switch"
                                            aria-checked={on}
                                            aria-label={`${c.title} for ${r.name}`}
                                            disabled={busy}
                                            onClick={() => void toggle(r, c.flag)}
                                            className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border transition-colors ${
                                                on ? "border-signal/50 bg-signal/30" : "border-white/15 bg-white/[0.06]"
                                            } ${busy ? "opacity-50" : ""}`}
                                        >
                                            <span
                                                aria-hidden
                                                className={`absolute top-[2px] h-3.5 w-3.5 rounded-full transition-all ${
                                                    on ? "left-[18px] bg-signal" : "left-[2px] bg-paper-soft"
                                                }`}
                                            />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            ))}
        </div>
    );
}
