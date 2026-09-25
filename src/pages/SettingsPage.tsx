import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { employeeService } from "@/services/employeeService";
import { kpiService } from "@/services/kpiService";
import { financeService } from "@/services/financeService";
import type { KpiTemplateSummary } from "@/types/kpi";
import { useAuth } from "@/contexts/AuthContext";
import type { Employee } from "@/types/employee";
import Spinner from "@/components/ui/Spinner";
import HolidayCalendar from "@/components/settings/HolidayCalendar";
import ProfileRequests from "@/components/employees/ProfileRequests";
import Alert from "@/components/ui/Alert";

/*
 * Permissions in one place.
 *
 * These flags all live on the employee record and were editable there, but
 * answering "who can publish the bulletin?" meant opening eleven profiles in
 * turn. A permission you cannot survey is a permission you lose track of.
 *
 * Each column is a separate capability on purpose. Writing the bulletin is not
 * administering the platform, and being management is neither -- collapsing
 * any two of them is how somebody ends up able to edit salaries because they
 * were given the newsletter.
 */

interface Capability {
    key:
        | "can_write_articles"
        | "can_manage_people"
        | "can_manage_contracts"
        | "bonus_eligible"
        | "is_management_role"
        | "is_backup_engineer"
        | "study_leave_eligible"
        | "is_it_support";
    label: string;
    help: string;
}

const CAPABILITIES: Capability[] = [
    {
        key: "can_write_articles",
        label: "Bulletin author",
        help: "Write, schedule and publish staff articles. Grants nothing else — not employee records, not leave.",
    },
    {
        key: "can_manage_people",
        label: "People admin",
        help: "Adds and edits employee records, roster or office-day. Opens the staff directory, because you cannot maintain a record you cannot read — but grants no leave approval, no roster publishing, no salary and no settings.",
    },
    {
        key: "can_manage_contracts",
        label: "Contracts",
        help: "Adds and edits contracts — manpower, subscriptions and clients — and acknowledges their warnings. Nothing else.",
    },
    {
        key: "bonus_eligible",
        label: "Bonus",
        help: "An annual bonus exists for this person, and the scorecard shows the multiplier as money. Deliberately separate from Management — somebody can become eligible on promotion without taking on the directory, the approval chain or the salary queue.",
    },
    {
        key: "is_management_role",
        label: "Management",
        help: "Reads the staff directory, and is eligible for an annual bonus.",
    },
    {
        key: "is_backup_engineer",
        label: "Back-up engineer",
        help: "Office-day staff covering the roster; adds the rotating crew's schedule to their view. On the payroll, a month they cover shifts is invoiced to the client as service labour; a month they do not is the company's own overhead.",
    },
    {
        key: "study_leave_eligible",
        label: "Study leave",
        help: "May request study leave, which is granted in place of spending annual leave rather than accrued. Off for everybody by default — it appears in their leave options only once this is ticked.",
    },
    {
        key: "is_it_support",
        label: "IT support",
        help: "IT tickets land on this person: they see the whole queue, can reply, leave internal notes and resolve. Tick a second person and they share the queue — both see everything, because a support queue split in two is one where each half assumes the other has it.",
    },
];

export default function SettingsPage() {
    const { user, refreshUser } = useAuth();
    // The platform administrator: the director, as the server enforces. Peter
    // and Mark are superusers as management, and are sent to the dashboard.
    const isAdmin = user?.role === "director";

    const [people, setPeople] = useState<Employee[]>([]);
    const [templates, setTemplates] = useState<KpiTemplateSummary[]>([]);
    const [scorecards, setScorecards] = useState<Record<string, string>>({});
    const [detail, setDetail] = useState<Record<string, Record<string, boolean>>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await employeeService.list({ page: 1, page_size: 100 });
            const active = res.data.items.filter((e) => e.is_active);
            setPeople(active);

            // The list endpoint returns the directory columns only, so the
            // flags and the scorecard come from each record. One fetch per
            // person, not two -- both readings come off the same response.
            const [rows, tpl] = await Promise.all([
                Promise.all(
                    active.map(async (e) => {
                        const d = await employeeService.get(e.id);
                        return {
                            id: e.id,
                            flags: {
                                can_write_articles: Boolean(d.data.can_write_articles),
                                can_manage_people: Boolean(d.data.can_manage_people),
                                can_manage_contracts: Boolean(d.data.can_manage_contracts),
                                bonus_eligible: Boolean(d.data.bonus_eligible),
                                study_leave_eligible: Boolean(d.data.study_leave_eligible),
                                is_it_support: Boolean(d.data.is_it_support),
                                is_management_role: Boolean(d.data.is_management_role),
                                is_backup_engineer: Boolean(d.data.is_backup_engineer),
                            },
                            scorecard: d.data.kpi_template_id ?? "",
                        };
                    }),
                ),
                kpiService.listTemplates(),
            ]);
            setDetail(Object.fromEntries(rows.map((r) => [r.id, r.flags])));
            setScorecards(Object.fromEntries(rows.map((r) => [r.id, r.scorecard])));
            setTemplates(tpl.data);
        } catch {
            setError("Could not load permissions.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAdmin) void load();
        else setLoading(false);
    }, [isAdmin, load]);

    const toggle = async (employeeId: string, key: Capability["key"], next: boolean) => {
        setSaving(`${employeeId}:${key}`);
        // Optimistic: the switch moves under the finger, and reverts if the
        // save fails. A toggle that waits a round trip feels broken.
        setDetail((d) => ({ ...d, [employeeId]: { ...d[employeeId]!, [key]: next } }));
        try {
            await employeeService.update(employeeId, { [key]: next });
        } catch {
            setDetail((d) => ({ ...d, [employeeId]: { ...d[employeeId]!, [key]: !next } }));
            setError("That change did not save.");
        } finally {
            setSaving(null);
        }
    };

    /*
     * Turning the bulletin on for yourself.
     *
     * Peter is management and an admin and still arrived with a Bulletin entry
     * he had not asked for, leading to a page telling him he was not a
     * bulletin author. Nurhuda: hide it until he wants it, and let him be the
     * one who decides. So the desk is absent by default and this is where it
     * is switched on -- his own row in the matrix below would do the same job,
     * but nobody goes looking for their own name in a staff table.
     */
    const mine = user?.employee_id ? detail[user.employee_id] : undefined;
    const iWrite = Boolean(mine?.can_write_articles);

    const toggleMine = async (next: boolean) => {
        if (!user?.employee_id) return;
        await toggle(user.employee_id, "can_write_articles", next);
        // The sidebar reads this off the session, not off this page.
        await refreshUser().catch(() => {});
    };

    if (user && !isAdmin) return <Navigate to="/" replace />;

    return (
        <div className="dtg-fade-in space-y-6">
            <header>
                <p className="dtg-eyebrow">Configuration</p>
                <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">Settings</h1>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                    Who can do what. Each capability is separate — giving somebody the bulletin
                    does not give them the directory, and vice versa.
                </p>
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {user?.employee_id && !loading && (
                <section className="dtg-panel flex flex-wrap items-center justify-between gap-4 p-5">
                    <div className="max-w-xl">
                        <p className="dtg-eyebrow">Your workspace</p>
                        <h2 className="mt-0.5 text-sm font-semibold text-paper">
                            Show the bulletin desk in my sidebar
                        </h2>
                        <p className="mt-1.5 text-xs leading-relaxed text-muted">
                            {iWrite
                                ? "Bulletin is in your sidebar. Turn it off and it disappears — everything you have written stays published."
                                : "Off. You still read the bulletin on your dashboard; this only adds the desk it is written at."}
                        </p>
                    </div>
                    <button
                        role="switch"
                        aria-checked={iWrite}
                        aria-label="Bulletin author for me"
                        disabled={saving === `${user.employee_id}:can_write_articles`}
                        onClick={() => void toggleMine(!iWrite)}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border transition-colors ${
                            iWrite ? "border-signal/50 bg-signal/30" : "border-white/15 bg-white/[0.06]"
                        } ${saving === `${user.employee_id}:can_write_articles` ? "opacity-50" : ""}`}
                    >
                        <span
                            aria-hidden
                            className={`absolute top-[3px] h-4 w-4 rounded-full transition-all ${
                                iWrite ? "left-[23px] bg-signal" : "left-[3px] bg-paper-soft"
                            }`}
                        />
                    </button>
                </section>
            )}

            <FinanceApprovalSetting onError={setError} />

            <section className="dtg-panel overflow-hidden">
                <header className="border-b border-white/[0.08] px-5 py-3.5">
                    <p className="dtg-eyebrow">Permissions</p>
                    <h2 className="mt-0.5 text-sm font-semibold text-paper">People</h2>
                </header>

                {loading ? (
                    <div className="flex items-center gap-2.5 px-5 py-14 text-sm text-paper-soft">
                        <Spinner className="h-4 w-4 text-signal" />
                        Loading…
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[46rem]">
                            <thead>
                                <tr className="border-b border-white/[0.08]">
                                    <th className="dtg-th">Employee</th>
                                    {CAPABILITIES.map((c) => (
                                        <th key={c.key} className="dtg-th text-center" title={c.help}>
                                            {c.label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {people.map((e, i) => (
                                    <tr
                                        key={e.id}
                                        className={`border-b border-white/[0.05] ${
                                            i % 2 ? "bg-white/[0.015]" : ""
                                        }`}
                                    >
                                        <td className="dtg-td">
                                            <p className="font-medium text-paper">
                                                {e.first_name} {e.last_name}
                                            </p>
                                            <p className="font-mono text-micro text-muted">
                                                {e.employee_id} · {e.position}
                                            </p>
                                        </td>
                                        {CAPABILITIES.map((c) => {
                                            const on = detail[e.id]?.[c.key] ?? false;
                                            const busy = saving === `${e.id}:${c.key}`;
                                            return (
                                                <td key={c.key} className="dtg-td text-center">
                                                    <button
                                                        role="switch"
                                                        aria-checked={on}
                                                        aria-label={`${c.label} for ${e.first_name} ${e.last_name}`}
                                                        disabled={busy}
                                                        onClick={() => toggle(e.id, c.key, !on)}
                                                        className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border transition-colors ${
                                                            on
                                                                ? "border-signal/50 bg-signal/30"
                                                                : "border-white/15 bg-white/[0.06]"
                                                        } ${busy ? "opacity-50" : ""}`}
                                                    >
                                                        <span
                                                            aria-hidden
                                                            className={`absolute top-[2px] h-3.5 w-3.5 rounded-full transition-all ${
                                                                on
                                                                    ? "left-[18px] bg-signal"
                                                                    : "left-[2px] bg-paper-soft"
                                                            }`}
                                                        />
                                                    </button>
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <div className="space-y-2 border-t border-white/[0.08] px-5 py-4">
                    {CAPABILITIES.map((c) => (
                        <p key={c.key} className="text-xs leading-relaxed text-muted">
                            <span className="font-semibold text-paper-soft">{c.label}</span> — {c.help}
                        </p>
                    ))}
                </div>
            </section>

            {/*
                Role frameworks.

                This was a field on each employee's profile, where it printed
                the template's raw id -- a database key shown as though it
                were data -- and where answering "who is assessed against
                what?" meant opening eleven profiles. It is configuration, so
                it belongs beside the other configuration.
            */}
            {!loading && templates.length > 0 && (
                <section className="dtg-panel overflow-hidden">
                    <header className="border-b border-white/[0.08] px-5 py-3.5">
                        <p className="dtg-eyebrow">Performance</p>
                        <h2 className="mt-0.5 text-sm font-semibold text-paper">Role frameworks</h2>
                        <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted">
                            The framework each person is assessed against. Somebody with none
                            cannot have a KPI achievement opened for them.
                        </p>
                    </header>
                    <div className="grid grid-cols-1 gap-x-8 gap-y-3 p-5 sm:grid-cols-2">
                        {people.map((e) => (
                            <label key={e.id} className="flex items-center justify-between gap-4">
                                <span className="min-w-0">
                                    <span className="block truncate text-sm text-paper">
                                        {e.first_name} {e.last_name}
                                    </span>
                                    <span className="block font-mono text-micro text-muted">
                                        {e.position}
                                    </span>
                                </span>
                                <select
                                    value={scorecards[e.id] ?? ""}
                                    disabled={saving === `${e.id}:kpi`}
                                    onChange={async (ev) => {
                                        const next = ev.target.value;
                                        const previous = scorecards[e.id] ?? "";
                                        setScorecards((m) => ({ ...m, [e.id]: next }));
                                        setSaving(`${e.id}:kpi`);
                                        try {
                                            await employeeService.update(e.id, {
                                                kpi_template_id: next || null,
                                            });
                                        } catch {
                                            setScorecards((m) => ({ ...m, [e.id]: previous }));
                                            setError("That change did not save.");
                                        } finally {
                                            setSaving(null);
                                        }
                                    }}
                                    className="dtg-input w-52 flex-shrink-0 text-xs"
                                >
                                    <option value="">None</option>
                                    {templates.map((t) => (
                                        <option key={t.id} value={t.id}>
                                            {t.title}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        ))}
                    </div>
                </section>
            )}

            {/* Above the calendar: something waiting on a person beats
                something waiting on the government. */}
            <ProfileRequests />

            <HolidayCalendar />

            <section className="dtg-panel p-5">
                <p className="dtg-eyebrow">Bulletin</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">Publishing</h2>
                <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted">
                    Articles publish themselves on the date they carry — there is no scheduler to
                    start or stop. Write as far ahead as you like; each piece appears when its date
                    arrives, and nothing is ever removed. Older months fold away on the dashboard
                    rather than disappearing.
                </p>
            </section>
        </div>
    );
}

/*
 * Who gives the final approval on finance requests.
 *
 * Nurhuda, September 2026: approval is Peter's today, "tp gpp kasih opsi aja
 * ini kalau peter nyerahin ke saya dan saya bisa approved juga disetting".
 * Off: the Director reviews and the CEO approves. On: the Director's review
 * is the approval, and nothing waits on the CEO.
 */
function FinanceApprovalSetting({ onError }: { onError: (msg: string) => void }) {
    const [on, setOn] = useState<boolean | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        financeService
            .settings()
            .then((res) => setOn(res.data.director_final_approval))
            .catch(() => onError("Could not load the finance approval setting."));
    }, [onError]);

    if (on === null) return null;

    const toggle = async () => {
        setSaving(true);
        try {
            const res = await financeService.saveSettings(!on);
            setOn(res.data.director_final_approval);
        } catch {
            onError("That change did not save.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="dtg-panel flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="max-w-xl">
                <p className="dtg-eyebrow">Finance requests</p>
                <h2 className="mt-0.5 text-sm font-semibold text-paper">
                    The Director gives the final approval
                </h2>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                    {on
                        ? "On. The Director's review approves a finance request; it does not go on to the CEO. Turn it off to return approval to the CEO."
                        : "Off. The Director reviews each finance request and the CEO approves it. Turn it on when the CEO hands approval to the Director."}
                </p>
            </div>
            <button
                role="switch"
                aria-checked={on}
                aria-label="The Director gives the final approval on finance requests"
                disabled={saving}
                onClick={() => void toggle()}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border transition-colors ${
                    on ? "border-signal/50 bg-signal/30" : "border-white/15 bg-white/[0.06]"
                } ${saving ? "opacity-50" : ""}`}
            >
                <span
                    aria-hidden
                    className={`absolute top-[3px] h-4 w-4 rounded-full transition-all ${
                        on ? "left-[23px] bg-signal" : "left-[3px] bg-paper-soft"
                    }`}
                />
            </button>
        </section>
    );
}
