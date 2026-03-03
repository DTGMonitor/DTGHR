import { useState, useEffect } from "react";
import { LeaveType } from "@/types/leave";
import type { LeaveBalance } from "@/types/leave";
import { leaveService, type LeaveRequestCreateData } from "@/services/leaveService";

interface Props {
    balances: LeaveBalance[];
    onClose: () => void;
    onSubmitted: () => void;
}

const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
    [LeaveType.ANNUAL]: "Annual Leave",
    [LeaveType.SICK]: "Sick Leave",
    [LeaveType.PERSONAL]: "Personal Leave",
    [LeaveType.UNPAID]: "Unpaid Leave",
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

    useEffect(() => {
        const days = calcWorkingDays(form.start_date, form.end_date);
        setForm((prev) => ({ ...prev, days_requested: days }));
    }, [form.start_date, form.end_date]);

    const selectedBalance = balances.find((b) => b.leave_type === form.leave_type);

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
        "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition";
    const labelClass = "block text-xs font-medium text-gray-400 mb-1";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-end">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 flex h-full w-full max-w-lg flex-col border-l border-white/10 bg-gray-950 shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
                    <h2 className="text-lg font-semibold text-white">New Leave Request</h2>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition"
                    >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-y-auto">
                    <div className="space-y-4 px-6 py-5">
                        {error && (
                            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
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
                                {Object.values(LeaveType).map((t) => (
                                    <option key={t} value={t} className="bg-gray-900">
                                        {LEAVE_TYPE_LABELS[t]}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Balance info */}
                        {selectedBalance && (
                            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm">
                                <span className="text-gray-400">Available balance</span>
                                <span className={`font-semibold ${selectedBalance.remaining_days <= 0 ? "text-red-400" : "text-emerald-400"}`}>
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
                            <span className="text-gray-400">Working days</span>
                            <span className="font-semibold text-white">{form.days_requested} days</span>
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
                            className="flex-1 rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm font-medium text-gray-300 hover:bg-white/10 transition"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={loading || form.days_requested <= 0}
                            className="flex-1 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:from-indigo-600 hover:to-purple-700 disabled:opacity-60"
                        >
                            {loading ? "Submitting…" : "Submit Request"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
