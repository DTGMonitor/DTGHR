import { useState, useEffect } from "react";
import type { Employee } from "@/types/employee";
import {
    employeeService,
    type EmployeeCreateData,
    type EmployeeUpdateData,
} from "@/services/employeeService";
import Drawer from "@/components/ui/Drawer";
import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";

interface Props {
    employee?: Employee | null; // null = create mode
    onClose: () => void;
    onSaved: (employee: Employee) => void;
}

const EMPTY_FORM = {
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    department: "",
    position: "",
    date_of_joining: "",
    annual_leave_opening_balance: 0,
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
                first_name: employee.first_name,
                last_name: employee.last_name,
                email: employee.email,
                phone: employee.phone ?? "",
                department: employee.department,
                position: employee.position,
                date_of_joining: employee.date_of_joining,
                annual_leave_opening_balance:
                    employee.annual_leave_opening_balance ?? 0,
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
                    annual_leave_opening_balance: Number(
                        form.annual_leave_opening_balance,
                    ),
                    is_active: form.is_active,
                };
                const res = await employeeService.update(employee.id, payload);
                onSaved(res.data);
            } else {
                const payload: EmployeeCreateData = {
                    first_name: form.first_name,
                    last_name: form.last_name,
                    email: form.email,
                    phone: form.phone || undefined,
                    department: form.department,
                    position: form.position,
                    date_of_joining: form.date_of_joining,
                    annual_leave_opening_balance: Number(
                        form.annual_leave_opening_balance,
                    ),
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

    return (
        <Drawer
            eyebrow={isEdit ? "People" : "New record"}
            title={isEdit ? "Edit employee" : "Add employee"}
            onClose={onClose}
            footer={
                <>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={loading}
                        className="dtg-btn-secondary flex-1"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        form="employee-form"
                        disabled={loading}
                        className="dtg-btn-primary flex-1"
                    >
                        {loading ? (
                            <>
                                <Spinner />
                                Saving…
                            </>
                        ) : isEdit ? (
                            "Save changes"
                        ) : (
                            "Add employee"
                        )}
                    </button>
                </>
            }
        >
            <form
                id="employee-form"
                onSubmit={handleSubmit}
                className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6"
            >
                {error && <Alert tone="danger">{error}</Alert>}

                <fieldset className="space-y-4">
                    <legend className="dtg-eyebrow mb-3">Identity</legend>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                            <label htmlFor="first_name" className="dtg-label">
                                First name <span className="text-signal">*</span>
                            </label>
                            <input
                                id="first_name"
                                className="dtg-input"
                                name="first_name"
                                value={form.first_name}
                                onChange={handleChange}
                                placeholder="Budi"
                                required
                            />
                        </div>
                        <div>
                            <label htmlFor="last_name" className="dtg-label">
                                Last name <span className="text-signal">*</span>
                            </label>
                            <input
                                id="last_name"
                                className="dtg-input"
                                name="last_name"
                                value={form.last_name}
                                onChange={handleChange}
                                placeholder="Santoso"
                                required
                            />
                        </div>
                    </div>

                    <div>
                        <label htmlFor="email" className="dtg-label">
                            Email <span className="text-signal">*</span>
                        </label>
                        <input
                            id="email"
                            className="dtg-input"
                            name="email"
                            type="email"
                            value={form.email}
                            onChange={handleChange}
                            placeholder="budi@dtgeotech.com"
                            required
                        />
                    </div>

                    <div>
                        <label htmlFor="phone" className="dtg-label">
                            Phone
                        </label>
                        <input
                            id="phone"
                            className="dtg-input"
                            name="phone"
                            type="tel"
                            value={form.phone}
                            onChange={handleChange}
                            placeholder="+62 812 3456 7890"
                        />
                    </div>
                </fieldset>

                <hr className="border-white/[0.08]" />

                <fieldset className="space-y-4">
                    <legend className="dtg-eyebrow mb-3">Role</legend>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                            <label htmlFor="department" className="dtg-label">
                                Department <span className="text-signal">*</span>
                            </label>
                            <input
                                id="department"
                                className="dtg-input"
                                name="department"
                                value={form.department}
                                onChange={handleChange}
                                placeholder="Monitoring"
                                required
                            />
                        </div>
                        <div>
                            <label htmlFor="position" className="dtg-label">
                                Position <span className="text-signal">*</span>
                            </label>
                            <input
                                id="position"
                                className="dtg-input"
                                name="position"
                                value={form.position}
                                onChange={handleChange}
                                placeholder="Geotechnical Engineer"
                                required
                            />
                        </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                            <label htmlFor="date_of_joining" className="dtg-label">
                                Date of joining <span className="text-signal">*</span>
                            </label>
                            <input
                                id="date_of_joining"
                                className="dtg-input"
                                name="date_of_joining"
                                type="date"
                                value={form.date_of_joining}
                                onChange={handleChange}
                                required
                            />
                        </div>
                        <div>
                            <label htmlFor="annual_leave_opening_balance" className="dtg-label">
                                Opening annual leave
                            </label>
                            <input
                                id="annual_leave_opening_balance"
                                className="dtg-input"
                                name="annual_leave_opening_balance"
                                type="number"
                                step="0.5"
                                min="0"
                                value={form.annual_leave_opening_balance}
                                onChange={handleChange}
                                aria-describedby="opening-balance-help"
                            />
                            <p id="opening-balance-help" className="mt-1.5 text-micro leading-relaxed text-muted">
                                Days carried in on the joining date. Leave accrues at 1/month on
                                top of this — set it to match the balance the roster workbook
                                shows.
                            </p>
                        </div>
                    </div>
                </fieldset>

                {/* Active toggle (edit only) */}
                {isEdit && (
                    <>
                        <hr className="border-white/[0.08]" />
                        <div className="dtg-panel-inset flex items-center justify-between gap-4 px-4 py-3.5">
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-paper">Active</p>
                                <p className="mt-0.5 text-xs text-muted">
                                    Inactive employees are hidden from the directory.
                                </p>
                            </div>
                            <label className="relative inline-flex flex-shrink-0 cursor-pointer items-center">
                                <input
                                    type="checkbox"
                                    name="is_active"
                                    className="peer sr-only"
                                    checked={form.is_active}
                                    onChange={handleChange}
                                />
                                <span className="sr-only">Active</span>
                                <div className="peer h-6 w-11 rounded-full border border-white/15 bg-deep transition-colors after:absolute after:left-[3px] after:top-[3px] after:h-4 after:w-4 after:rounded-full after:bg-paper-soft after:transition-all after:content-[''] peer-checked:border-signal/50 peer-checked:bg-signal/25 peer-checked:after:translate-x-full peer-checked:after:bg-signal peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal" />
                            </label>
                        </div>
                    </>
                )}
            </form>
        </Drawer>
    );
}
