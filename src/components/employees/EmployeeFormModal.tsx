import { useState, useEffect } from "react";
import type { Employee } from "@/types/employee";
import {
    employeeService,
    type EmployeeCreateData,
    type EmployeeUpdateData,
} from "@/services/employeeService";

interface Props {
    employee?: Employee | null; // null = create mode
    onClose: () => void;
    onSaved: (employee: Employee) => void;
}

const EMPTY_FORM = {
    employee_id: "",
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    department: "",
    position: "",
    date_of_joining: "",
    is_active: true,
};

export default function EmployeeFormModal({ employee, onClose, onSaved }: Props) {
    const isEdit = !!employee;
    const [form, setForm] = useState(EMPTY_FORM);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (employee) {
            setForm({
                employee_id: employee.employee_id,
                first_name: employee.first_name,
                last_name: employee.last_name,
                email: employee.email,
                phone: employee.phone ?? "",
                department: employee.department,
                position: employee.position,
                date_of_joining: employee.date_of_joining,
                is_active: employee.is_active,
            });
        } else {
            setForm(EMPTY_FORM);
        }
        setError(null);
    }, [employee]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        setForm((prev) => ({
            ...prev,
            [name]: type === "checkbox" ? (e.target as HTMLInputElement).checked : value,
        }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            if (isEdit && employee) {
                const payload: EmployeeUpdateData = {
                    first_name: form.first_name,
                    last_name: form.last_name,
                    email: form.email,
                    phone: form.phone || undefined,
                    department: form.department,
                    position: form.position,
                    date_of_joining: form.date_of_joining,
                    is_active: form.is_active,
                };
                const res = await employeeService.update(employee.id, payload);
                onSaved(res.data);
            } else {
                const payload: EmployeeCreateData = {
                    employee_id: form.employee_id,
                    first_name: form.first_name,
                    last_name: form.last_name,
                    email: form.email,
                    phone: form.phone || undefined,
                    department: form.department,
                    position: form.position,
                    date_of_joining: form.date_of_joining,
                };
                const res = await employeeService.create(payload);
                onSaved(res.data);
            }
        } catch (err: unknown) {
            const msg =
                (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
                "An unexpected error occurred.";
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    const inputClass =
        "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition";
    const labelClass = "block text-xs font-medium text-gray-400 mb-1";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-end">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={onClose}
            />

            {/* Drawer */}
            <div className="relative z-10 flex h-full w-full max-w-lg flex-col border-l border-white/10 bg-gray-950 shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
                    <h2 className="text-lg font-semibold text-white">
                        {isEdit ? "Edit Employee" : "Add Employee"}
                    </h2>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition"
                    >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-y-auto">
                    <div className="space-y-4 px-6 py-5">
                        {error && (
                            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                                {error}
                            </div>
                        )}

                        {/* Employee ID (create only) */}
                        {!isEdit && (
                            <div>
                                <label className={labelClass}>Employee ID *</label>
                                <input
                                    className={inputClass}
                                    name="employee_id"
                                    value={form.employee_id}
                                    onChange={handleChange}
                                    placeholder="e.g. DTG-001"
                                    required
                                />
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelClass}>First Name *</label>
                                <input className={inputClass} name="first_name" value={form.first_name} onChange={handleChange} placeholder="John" required />
                            </div>
                            <div>
                                <label className={labelClass}>Last Name *</label>
                                <input className={inputClass} name="last_name" value={form.last_name} onChange={handleChange} placeholder="Doe" required />
                            </div>
                        </div>

                        <div>
                            <label className={labelClass}>Email *</label>
                            <input className={inputClass} name="email" type="email" value={form.email} onChange={handleChange} placeholder="john@dtgeotech.com" required />
                        </div>

                        <div>
                            <label className={labelClass}>Phone</label>
                            <input className={inputClass} name="phone" value={form.phone} onChange={handleChange} placeholder="+62 812 3456 7890" />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelClass}>Department *</label>
                                <input className={inputClass} name="department" value={form.department} onChange={handleChange} placeholder="Engineering" required />
                            </div>
                            <div>
                                <label className={labelClass}>Position *</label>
                                <input className={inputClass} name="position" value={form.position} onChange={handleChange} placeholder="Software Engineer" required />
                            </div>
                        </div>

                        <div>
                            <label className={labelClass}>Date of Joining *</label>
                            <input className={inputClass} name="date_of_joining" type="date" value={form.date_of_joining} onChange={handleChange} required />
                        </div>

                        {/* Active toggle (edit only) */}
                        {isEdit && (
                            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                                <div>
                                    <p className="text-sm font-medium text-white">Active Status</p>
                                    <p className="text-xs text-gray-500">Inactive employees are hidden from the directory</p>
                                </div>
                                <label className="relative inline-flex cursor-pointer items-center">
                                    <input
                                        type="checkbox"
                                        name="is_active"
                                        className="peer sr-only"
                                        checked={form.is_active}
                                        onChange={handleChange}
                                    />
                                    <div className="peer h-6 w-11 rounded-full bg-gray-700 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-indigo-600 peer-checked:after:translate-x-full" />
                                </label>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
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
                            disabled={loading}
                            className="flex-1 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:from-indigo-600 hover:to-purple-700 disabled:opacity-60"
                        >
                            {loading ? "Saving…" : isEdit ? "Save Changes" : "Add Employee"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
