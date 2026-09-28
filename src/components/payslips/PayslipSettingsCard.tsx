import { useEffect, useState } from "react";

import {
    formatRelease,
    nextRelease,
    payslipService,
    type PayslipSettings,
} from "@/services/payslipService";

/*
 * When payslips are released.
 *
 * Salary is paid at the end of the month, so by default each approved month's
 * slips go out on its last day at 23:59 WIB. The director can move that to a
 * set day (a day the month does not have means its last day) and time, or
 * switch automatic release off and issue slips from the Payroll page instead.
 */
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

export default function PayslipSettingsCard({ onError }: { onError: (msg: string) => void }) {
    const [settings, setSettings] = useState<PayslipSettings | null>(null);
    const [time, setTime] = useState("23:59");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        payslipService
            .settings()
            .then((res) => {
                setSettings(res.data);
                setTime(res.data.release_time);
            })
            .catch(() => onError("Could not load the payslip settings."));
    }, [onError]);

    if (!settings) return null;

    const save = async (patch: Parameters<typeof payslipService.saveSettings>[0]) => {
        setSaving(true);
        try {
            const res = await payslipService.saveSettings(patch);
            setSettings(res.data);
            setTime(res.data.release_time);
        } catch (e) {
            const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
            onError(typeof detail === "string" ? detail : "That change did not save.");
            setTime(settings.release_time);
        } finally {
            setSaving(false);
        }
    };

    const on = settings.auto_enabled;
    const next = nextRelease(settings.release_day, settings.release_time);

    return (
        <section className="dtg-panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="max-w-xl">
                    <p className="dtg-eyebrow">Payslips</p>
                    <h2 className="mt-0.5 text-sm font-semibold text-paper">
                        Release payslips automatically
                    </h2>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">
                        {on
                            ? "On. Once a month's payroll is approved, everybody's payslip is issued at the release moment below and appears on their profile."
                            : "Off. No payslips are issued on their own; issue a month's payslips from the Payroll page."}
                    </p>
                </div>
                <button
                    role="switch"
                    aria-checked={on}
                    aria-label="Release payslips automatically"
                    disabled={saving}
                    onClick={() => void save({ auto_enabled: !on })}
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
            </div>

            <div className="mt-4 flex flex-wrap items-end gap-4 border-t border-white/[0.08] pt-4">
                <label className="block">
                    <span className="dtg-label">Release day</span>
                    <select
                        value={settings.release_day ?? ""}
                        disabled={saving}
                        onChange={(e) =>
                            void save({
                                release_day: e.target.value === "" ? null : Number(e.target.value),
                            })
                        }
                        className="dtg-input w-56 text-sm"
                    >
                        <option value="">Last day of the month</option>
                        {DAYS.map((d) => (
                            <option key={d} value={d}>
                                {d}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block">
                    <span className="dtg-label">Time (WIB)</span>
                    <input
                        type="time"
                        value={time}
                        disabled={saving}
                        onChange={(e) => setTime(e.target.value)}
                        onBlur={() => {
                            if (time && time !== settings.release_time) void save({ release_time: time });
                        }}
                        className="dtg-input w-36 text-sm"
                    />
                </label>
            </div>

            <p className="mt-3 text-xs leading-relaxed text-muted">
                {on ? (
                    <>
                        <span className="font-semibold text-paper-soft">{next.label}</span> payslips
                        release on {formatRelease(next.at.toISOString())}, once that month's payroll
                        is approved. A day the month does not have means its last day.
                    </>
                ) : (
                    <>Automatic release is off.</>
                )}
            </p>
        </section>
    );
}
