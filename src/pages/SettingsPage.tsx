import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { employeeService } from "@/services/employeeService";
import { useAuth } from "@/contexts/AuthContext";
import type { Employee } from "@/types/employee";
import Spinner from "@/components/ui/Spinner";
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
    key: "can_write_articles" | "is_management_role" | "is_backup_engineer";
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
        key: "is_management_role",
        label: "Management",
        help: "Reads the staff directory, and is eligible for an annual bonus.",
    },
    {
        key: "is_backup_engineer",
        label: "Back-up engineer",
        help: "Office-day staff covering the roster; adds the rotating crew's schedule to their view.",
    },
];

export default function SettingsPage() {
    const { user } = useAuth();
    const isAdmin = Boolean(user?.is_superuser);

    const [people, setPeople] = useState<Employee[]>([]);
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
            // flags come from each record. Eleven people, once per visit.
            const entries = await Promise.all(
                active.map(async (e) => {
                    const d = await employeeService.get(e.id);
                    return [
                        e.id,
                        {
                            can_write_articles: Boolean(d.data.can_write_articles),
                            is_management_role: Boolean(d.data.is_management_role),
                            is_backup_engineer: Boolean(d.data.is_backup_engineer),
                        },
                    ] as const;
                }),
            );
            setDetail(Object.fromEntries(entries));
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
