import { useState, useEffect, useCallback, useRef } from "react";
import type { Employee } from "@/types/employee";
import { employeeService, type CreateAccountResult } from "@/services/employeeService";
import { useAuth } from "@/contexts/AuthContext";
import EmployeeFormModal from "@/components/employees/EmployeeFormModal";
import DeleteConfirmModal from "@/components/employees/DeleteConfirmModal";
import CreateAccountModal from "@/components/employees/CreateAccountModal";

const PAGE_SIZE = 20;

function StatusBadge({ active }: { active: boolean }) {
    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${active
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-gray-500/15 text-gray-400"
                }`}
        >
            <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-400" : "bg-gray-400"}`} />
            {active ? "Active" : "Inactive"}
        </span>
    );
}

export default function EmployeesPage() {
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const [department, setDepartment] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const { user } = useAuth();
    const isHR = !!user?.is_superuser;

    const [formTarget, setFormTarget] = useState<Employee | null | undefined>(undefined);
    // undefined = modal closed, null = create mode, Employee = edit mode
    const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null);
    const [createAccountResult, setCreateAccountResult] = useState<CreateAccountResult | null>(null);

    const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

    const fetchEmployees = useCallback(async (p: number, s: string, d: string) => {
        setLoading(true);
        setError(null);
        try {
            const res = await employeeService.list({
                page: p,
                page_size: PAGE_SIZE,
                search: s || undefined,
                department: d || undefined,
            });
            setEmployees(res.data.items);
            setTotal(res.data.total);
        } catch {
            setError("Failed to load employees. Please try again.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchEmployees(page, search, department);
    }, [page, department, fetchEmployees]); // search handled by debounce below

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setSearch(val);
        setPage(1);
        if (searchDebounce.current) clearTimeout(searchDebounce.current);
        searchDebounce.current = setTimeout(() => {
            fetchEmployees(1, val, department);
        }, 400);
    };

    const handleDeptChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setDepartment(e.target.value);
        setPage(1);
    };

    const handleSaved = (saved: Employee) => {
        setFormTarget(undefined);
        // Update in list if edit, or prepend if new
        setEmployees((prev) => {
            const idx = prev.findIndex((e) => e.id === saved.id);
            if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = saved;
                return updated;
            }
            setTotal((t) => t + 1);
            return [saved, ...prev];
        });
    };

    const handleDeleted = (id: string) => {
        setDeleteTarget(null);
        setEmployees((prev) => prev.filter((e) => e.id !== id));
        setTotal((t) => t - 1);
    };

    const handleCreateAccount = async (emp: Employee) => {
        try {
            const res = await employeeService.createAccount(emp.id);
            setCreateAccountResult(res.data);
            // Mark employee as having an account in the local list
            setEmployees((prev) =>
                prev.map((e) => (e.id === emp.id ? { ...e, has_account: true } : e))
            );
        } catch {
            alert("Failed to create account. The employee may already have one.");
        }
    };

    const totalPages = Math.ceil(total / PAGE_SIZE);

    return (
        <div className="space-y-6">
            {/* Page header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-white">Employees</h1>
                    <p className="mt-1 text-sm text-gray-400">
                        {total} employee{total !== 1 ? "s" : ""} in your organisation
                    </p>
                </div>
                {isHR && (
                    <button
                        onClick={() => setFormTarget(null)}
                        className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:from-indigo-600 hover:to-purple-700"
                    >
                        + Add Employee
                    </button>
                )}
            </div>

            {/* Filters */}
            <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                    <svg
                        className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
                        fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search by name, email, or ID…"
                        value={search}
                        onChange={handleSearchChange}
                        className="w-full rounded-xl border border-white/10 bg-white/5 py-2.5 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition"
                    />
                </div>
                <input
                    type="text"
                    placeholder="Filter by department…"
                    value={department}
                    onChange={handleDeptChange}
                    className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition sm:w-52"
                />
            </div>

            {/* Table */}
            <div className="overflow-hidden rounded-2xl border border-white/10">
                {loading ? (
                    <div className="flex items-center justify-center py-20 text-gray-500 text-sm">
                        <svg className="mr-2 h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        Loading employees…
                    </div>
                ) : error ? (
                    <div className="flex items-center justify-center py-20 text-red-400 text-sm">{error}</div>
                ) : employees.length === 0 ? (
                    <div className="py-20 text-center">
                        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-800 text-3xl">👥</div>
                        <p className="text-sm text-gray-400">No employees found</p>
                        {(search || department) && (
                            <button
                                onClick={() => { setSearch(""); setDepartment(""); fetchEmployees(1, "", ""); }}
                                className="mt-2 text-xs text-indigo-400 hover:underline"
                            >
                                Clear filters
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-white/10 bg-white/5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                    <th className="px-4 py-3">Employee</th>
                                    <th className="px-4 py-3">ID</th>
                                    <th className="px-4 py-3">Department</th>
                                    <th className="px-4 py-3">Position</th>
                                    <th className="px-4 py-3">Joined</th>
                                    <th className="px-4 py-3">Status</th>
                                    <th className="px-4 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {employees.map((emp) => (
                                    <tr key={emp.id} className="bg-gray-900/20 transition hover:bg-white/5">
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-3">
                                                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-xs font-bold text-white">
                                                    {emp.first_name[0]}{emp.last_name[0]}
                                                </div>
                                                <div>
                                                    <p className="font-medium text-white">
                                                        {emp.first_name} {emp.last_name}
                                                    </p>
                                                    <p className="text-xs text-gray-500">{emp.email}</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 font-mono text-xs text-gray-400">
                                            {emp.employee_id}
                                        </td>
                                        <td className="px-4 py-3 text-gray-300">{emp.department}</td>
                                        <td className="px-4 py-3 text-gray-300">{emp.position}</td>
                                        <td className="px-4 py-3 text-gray-400">
                                            {new Date(emp.date_of_joining).toLocaleDateString("en-GB", {
                                                day: "2-digit", month: "short", year: "numeric",
                                            })}
                                        </td>
                                        <td className="px-4 py-3">
                                            <StatusBadge active={emp.is_active} />
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <div className="inline-flex gap-1">
                                                <button
                                                    onClick={() => setFormTarget(emp)}
                                                    className="rounded-lg p-1.5 text-gray-500 hover:bg-white/10 hover:text-indigo-400 transition"
                                                    title="Edit"
                                                >
                                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" />
                                                    </svg>
                                                </button>
                                                <button
                                                    onClick={() => setDeleteTarget(emp)}
                                                    className="rounded-lg p-1.5 text-gray-500 hover:bg-red-500/10 hover:text-red-400 transition"
                                                    title="Deactivate"
                                                >
                                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM4 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 10.374 21c-2.331 0-4.512-.645-6.374-1.766Z" />
                                                    </svg>
                                                </button>
                                                {isHR && !emp.has_account && (
                                                    <button
                                                        onClick={() => handleCreateAccount(emp)}
                                                        className="rounded-lg p-1.5 text-gray-500 hover:bg-emerald-500/10 hover:text-emerald-400 transition"
                                                        title="Create Login Account"
                                                    >
                                                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                                                        </svg>
                                                    </button>
                                                )}
                                                {emp.has_account && (
                                                    <span title="Account active" className="rounded-lg p-1.5 text-emerald-500">
                                                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                                                        </svg>
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-gray-400">
                    <p>
                        Page {page} of {totalPages} &middot; {total} total
                    </p>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page === 1}
                            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/10 disabled:opacity-40 transition"
                        >
                            ← Previous
                        </button>
                        <button
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={page === totalPages}
                            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/10 disabled:opacity-40 transition"
                        >
                            Next →
                        </button>
                    </div>
                </div>
            )}

            {/* Form modal */}
            {formTarget !== undefined && (
                <EmployeeFormModal
                    employee={formTarget}
                    onClose={() => setFormTarget(undefined)}
                    onSaved={handleSaved}
                />
            )}

            {/* Delete modal */}
            {deleteTarget && (
                <DeleteConfirmModal
                    employee={deleteTarget}
                    onClose={() => setDeleteTarget(null)}
                    onDeleted={handleDeleted}
                />
            )}

            {/* Create Account result modal */}
            {createAccountResult && (
                <CreateAccountModal
                    email={createAccountResult.email}
                    tempPassword={createAccountResult.temp_password}
                    onClose={() => setCreateAccountResult(null)}
                />
            )}
        </div>
    );
}
