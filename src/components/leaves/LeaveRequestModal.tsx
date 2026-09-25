import { useState, useEffect } from "react";
import { LeaveType } from "@/types/leave";
import type { LeaveBalance, LeaveTypeOption } from "@/types/leave";
import { leaveService, type LeaveRequestCreateData } from "@/services/leaveService";

interface Props {
    balances: LeaveBalance[];
    onClose: () => void;
    onSubmitted: () => void;
}

/*
 * The choices come from the API, not from a list here.
 *
 * Study leave is a grant rather than an entitlement — Nurhuda: "study leave
 * hanya muncul di saya ya. yg lain egag muncul" — and who has it is a setting
 * she changes. The handbook's family and special categories are also narrowed
 * per person. A list hard-coded in the page would be wrong for somebody the
 * day after it shipped.
 */
const GROUP_TITLES: Record<LeaveTypeOption["group"], string> = {
    core: "Leave",
    family: "Family and wellbeing",
    special: "Special leave",
};

function calcWorkingDays(start: string, end: string): number {
    if (!start || !end) return 0;
    const s = new Date(start);
    const e = new Date(end);
    if (e < s) return 0;
    let count = 0;
    const cur = new Date(s);
    while (cur <= e) {
        const day = cur.getDay();
        if (day !== 0 && day !== 6) count++;
        cur.setDate(cur.getDate() + 1);
    }
    return count;
}

export default function LeaveRequestModal({ balances, onClose, onSubmitted }: Props) {
    const [form, setForm] = useState({
        leave_type: LeaveType.ANNUAL,
        start_date: "",
        end_date: "",
        days_requested: 0,
        reason: "",
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [types, setTypes] = useState<LeaveTypeOption[]>([]);

    useEffect(() => {
        void leaveService
            .myTypes()
            .then((res) => setTypes(res.data))
            // A failure here leaves the picker empty rather than silently
            // offering leave somebody may not be entitled to.
            .catch(() => setError("Could not load the kinds of leave available to you."));
    }, []);

    useEffect(() => {
        const days = calcWorkingDays(form.start_date, form.end_date);
        setForm((prev) => ({ ...prev, days_requested: days }));
    }, [form.start_date, form.end_date]);

    const selectedBalance = balances.find((b) => b.leave_type === form.leave_type);
    const selectedType = types.find((t) => t.value === form.leave_type);
    const groups = (["core", "family", "special"] as const).filter((g) =>
        types.some((t) => t.group === g),
    );

    const handleChange = (
        e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
    ) => {
        const { name, value } = e.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (form.days_requested <= 0) {
            setError("Please select valid start and end dates.");
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const payload: LeaveRequestCreateData = {
                leave_type: form.leave_type,
                start_date: form.start_date,
                end_date: form.end_date,
                days_requested: form.days_requested,
                reason: form.reason || undefined,
            };
            await leaveService.submitRequest(payload);
            onSubmitted();
        } catch (err: unknown) {
            const msg =
                (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
                "Failed to submit leave request.";
            setError(typeof msg === "string" ? msg : JSON.stringify(msg));
        } finally {
            setLoading(false);
        }
    };

    const inputClass =
        "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-paper placeholder-muted focus:border-signal/60 focus:outline-none focus:ring-1 focus:ring-signal/40 transition";
    const labelClass = "block text-xs font-medium text-paper-soft mb-1";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-end">
            <div className="absolute inset-0 bg-deep/80 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 flex h-full w-full max-w-lg flex-col border-l border-white/10 bg-night shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
                    <h2 className="text-lg font-semibold text-paper">New Leave Request</h2>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-paper-soft hover:bg-white/10 hover:text-paper transition"
                    >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-y-auto">
                    <div className="space-y-4 px-6 py-5">
                        {error && (
                            <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                                {error}
                            </div>
                        )}

                        {/* Leave Type */}
                        <div>
                            <label className={labelClass}>Leave Type *</label>
                            <select
                                name="leave_type"
                                value={form.leave_type}
                                onChange={handleChange}
                                className={inputClass + " cursor-pointer"}
                                required
                            >
                                {groups.map((g) => (
                                    <optgroup key={g} label={GROUP_TITLES[g]} className="bg-surface">
                                        {types
                                            .filter((t) => t.group === g)
                                            .map((t) => (
                                                <option
                                                    key={t.value}
                                                    value={t.value}
                                                    className="bg-surface"
                                                >
                                                    {t.label}
                                                    {t.allowance_days
                                                        ? ` · ${t.allowance_days} day${
                                                              t.allowance_days === 1 ? "" : "s"
                                                          }`
                                                        : ""}
                                                </option>
                                            ))}
                                    </optgroup>
                                ))}
                            </select>
                        </div>

                        {/* The handbook's own wording, so nobody has to go and
                            find the handbook to know what they are entitled to. */}
                        {selectedType && (
                            <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs leading-relaxed text-paper-soft">
                                {selectedType.note}
                                {selectedType.needs_document && (
                                    <span className="mt-1 block text-gold">
                                        Please attach or bring the supporting certificate.
                                    </span>
                                )}
                            </p>
                        )}

                        {/* Balance info */}
                        {selectedBalance && (
                            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm">
                                <span className="text-paper-soft">Available balance</span>
                                <span className={`font-semibold ${selectedBalance.remaining_days <= 0 ? "text-danger" : "text-signal"}`}>
                                    {selectedBalance.remaining_days} / {selectedBalance.total_days} days
                                </span>
                            </div>
                        )}

                        {/* Dates */}
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelClass}>Start Date *</label>
                                <input
                                    className={inputClass}
                                    name="start_date"
                                    type="date"
                                    value={form.start_date}
                                    onChange={handleChange}
                                    required
                                />
                            </div>
                            <div>
                                <label className={labelClass}>End Date *</label>
                                <input
                                    className={inputClass}
                                    name="end_date"
                                    type="date"
                                    value={form.end_date}
                                    min={form.start_date}
                                    onChange={handleChange}
                                    required
                                />
                            </div>
                        </div>

                        {/* Working days */}
                        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm">
                            <span className="text-paper-soft">Working days</span>
                            <span className="font-semibold text-paper">{form.days_requested} days</span>
                        </div>

                        {/* Reason */}
                        <div>
                            <label className={labelClass}>Reason (optional)</label>
                            <textarea
                                name="reason"
                                value={form.reason}
                                onChange={handleChange}
                                rows={3}
                                placeholder="Briefly describe the reason for your leave…"
                                className={inputClass + " resize-none"}
                            />
                        </div>
                    </div>

                    <div className="mt-auto flex gap-3 border-t border-white/10 px-6 py-4">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm font-medium text-paper-soft hover:bg-white/10 transition"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={loading || form.days_requested <= 0}
                            className="flex-1 rounded-xl bg-signal py-2.5 text-sm font-semibold text-paper transition hover:bg-signal-hover disabled:opacity-60"
                        >
                            {loading ? "Submitting…" : "Submit Request"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
