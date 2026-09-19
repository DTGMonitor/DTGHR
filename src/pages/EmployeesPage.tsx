import { useState, useEffect, useCallback, useRef } from "react";
import type { Employee } from "@/types/employee";
import {
    employeeService,
    type CreateAccountResult,
    type EmployeeAccountFilter,
    type EmployeeSortKey,
    type EmployeeStatusFilter,
} from "@/services/employeeService";
import { useAuth } from "@/contexts/AuthContext";
import EmployeeFormModal from "@/components/employees/EmployeeFormModal";
import DeleteConfirmModal from "@/components/employees/DeleteConfirmModal";
import CreateAccountModal from "@/components/employees/CreateAccountModal";

const PAGE_SIZE = 20;

const SELECT_CLS =
    "rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none cursor-pointer";

interface Filters {
    department: string;
    status: EmployeeStatusFilter;
    account: EmployeeAccountFilter;
    onLeaveOnly: boolean;
    sort: EmployeeSortKey;
    ascending: boolean;
}

const DEFAULT_FILTERS: Filters = {
    department: "",
    status: "active",
    account: "all",
    onLeaveOnly: false,
    sort: "name",
    ascending: true,
};

function StatusBadge({ active, onLeave }: { active: boolean; onLeave?: boolean }) {
    if (active && onLeave) {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-amber-500/15 text-amber-400">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                On Leave
            </span>
        );
    }
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

function SortHeader({
    label,
    column,
    filters,
    onSort,
}: {
    label: string;
    column: EmployeeSortKey;
    filters: Filters;
    onSort: (column: EmployeeSortKey) => void;
}) {
    const active = filters.sort === column;
    return (
        <th
            className="px-4 py-3"
            aria-sort={active ? (filters.ascending ? "ascending" : "descending") : "none"}
        >
            <button
                onClick={() => onSort(column)}
                className={`inline-flex items-center gap-1 uppercase tracking-wider transition hover:text-gray-300 ${active ? "text-indigo-300" : ""}`}
            >
                {label}
                <span className="text-[10px]">{active ? (filters.ascending ? "▲" : "▼") : "↕"}</span>
            </button>
        </th>
    );
}

export default function EmployeesPage() {
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
    const [departments, setDepartments] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const { user } = useAuth();
    const isHR = !!user?.is_superuser;

    const [formTarget, setFormTarget] = useState<Employee | null | undefined>(undefined);
    // undefined = modal closed, null = create mode, Employee = edit mode
    const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null);
    const [createAccountResult, setCreateAccountResult] = useState<CreateAccountResult | null>(null);

    const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

    const fetchEmployees = useCallback(async (p: number, s: string, f: Filters) => {
        setLoading(true);
        setError(null);
        try {
            const res = await employeeService.list({
                page: p,
                page_size: PAGE_SIZE,
                search: s || undefined,
                department: f.department || undefined,
                status: f.status,
                account: f.account,
                on_leave_only: f.onLeaveOnly,
                sort: f.sort,
                ascending: f.ascending,
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
        fetchEmployees(page, search, filters);
        // search is handled by the debounce below
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, filters, fetchEmployees]);

    useEffect(() => {
        employeeService.departments().then(setDepartments).catch(() => {});
    }, []);

    const refresh = () => fetchEmployees(page, search, filters);

    const updateFilters = (patch: Partial<Filters>) => {
        setFilters((f) => ({ ...f, ...patch }));
        setPage(1);
    };

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setSearch(val);
        setPage(1);
        if (searchDebounce.current) clearTimeout(searchDebounce.current);
        searchDebounce.current = setTimeout(() => {
            fetchEmployees(1, val, filters);
        }, 400);
    };

    const handleSort = (column: EmployeeSortKey) => {
        updateFilters(
            filters.sort === column
                ? { ascending: !filters.ascending }
                : { sort: column, ascending: true }
        );
    };

    const isFiltered =
        !!search ||
        !!filters.department ||
        filters.status !== "active" ||
        filters.account !== "all" ||
        filters.onLeaveOnly;

    const clearFilters = () => {
        setSearch("");
        updateFilters({
            department: "",
            status: "active",
            account: "all",
            onLeaveOnly: false,
        });
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

    const handleDeactivated = () => {
        setDeleteTarget(null);
        refresh();
    };

    const handleReactivate = async (emp: Employee) => {
        if (!confirm(`Reactivate ${emp.first_name} ${emp.last_name}? Their sign-in will work again.`)) return;
        try {
            await employeeService.reactivate(emp.id);
            refresh();
        } catch (err) {
            const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
            alert(detail ?? "Failed to reactivate employee.");
        }
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
    const statusWord =
        filters.status === "inactive" ? "inactive " : filters.status === "active" ? "active " : "";

    return (
        <div className="space-y-6">
            {/* Page header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-white">Employees</h1>
                    <p className="mt-1 text-sm text-gray-400">
                        {total} {statusWord}employee{total !== 1 ? "s" : ""}
                        {isFiltered ? " matching your filters" : " in your organisation"}
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
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
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
                <div className="flex flex-wrap items-center gap-2">
                    <select
                        aria-label="Department"
                        value={filters.department}
                        onChange={(e) => updateFilters({ department: e.target.value })}
                        className={SELECT_CLS}
                    >
                        <option value="" className="bg-gray-900">All departments</option>
                        {departments.map((d) => (
                            <option key={d} value={d} className="bg-gray-900">{d}</option>
                        ))}
                    </select>
                    {isHR && (
                        <>
                            <select
                                aria-label="Status"
                                value={filters.status}
                                onChange={(e) => updateFilters({ status: e.target.value as EmployeeStatusFilter })}
                                className={SELECT_CLS}
                            >
                                <option value="active" className="bg-gray-900">Active</option>
                                <option value="inactive" className="bg-gray-900">Inactive</option>
                                <option value="all" className="bg-gray-900">All statuses</option>
                            </select>
                            <select
                                aria-label="Login account"
                                value={filters.account}
                                onChange={(e) => updateFilters({ account: e.target.value as EmployeeAccountFilter })}
                                className={SELECT_CLS}
                            >
                                <option value="all" className="bg-gray-900">Any login</option>
                                <option value="with" className="bg-gray-900">Has login</option>
                                <option value="without" className="bg-gray-900">No login</option>
                            </select>
                        </>
                    )}
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-gray-300">
                        <input
                            type="checkbox"
                            checked={filters.onLeaveOnly}
                            onChange={(e) => updateFilters({ onLeaveOnly: e.target.checked })}
                            className="accent-indigo-500"
                        />
                        On leave today
                    </label>
                    {isFiltered && (
                        <button onClick={clearFilters} className="px-2 text-xs text-indigo-400 hover:underline">
                            Clear filters
                        </button>
                    )}
                </div>
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
                        {isFiltered && (
                            <button
                                onClick={clearFilters}
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
                                    <SortHeader label="Employee" column="name" filters={filters} onSort={handleSort} />
                                    <SortHeader label="ID" column="employee_id" filters={filters} onSort={handleSort} />
                                    <SortHeader label="Department" column="department" filters={filters} onSort={handleSort} />
                                    <SortHeader label="Position" column="position" filters={filters} onSort={handleSort} />
                                    <SortHeader label="Joined" column="date_of_joining" filters={filters} onSort={handleSort} />
                                    <th className="px-4 py-3">Status</th>
                                    <th className="px-4 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {employees.map((emp) => (
                                    <tr
                                        key={emp.id}
                                        className={`bg-gray-900/20 transition hover:bg-white/5 ${emp.is_active ? "" : "opacity-60"}`}
                                    >
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
                                            <StatusBadge active={emp.is_active} onLeave={emp.on_leave_today} />
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <div className="inline-flex items-center gap-1">
                                                {isHR && (
                                                    <button
                                                        onClick={() => setFormTarget(emp)}
                                                        className="rounded-lg p-1.5 text-gray-500 hover:bg-white/10 hover:text-indigo-400 transition"
                                                        title="Edit"
                                                    >
                                                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" />
                                                        </svg>
                                                    </button>
                                                )}
                                                {isHR && emp.is_active && emp.user_id !== user?.id && (
                                                    <button
                                                        onClick={() => setDeleteTarget(emp)}
                                                        className="rounded-lg p-1.5 text-gray-500 hover:bg-red-500/10 hover:text-red-400 transition"
                                                        title="Deactivate (left the company)"
                                                    >
                                                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM4 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 10.374 21c-2.331 0-4.512-.645-6.374-1.766Z" />
                                                        </svg>
                                                    </button>
                                                )}
                                                {isHR && !emp.is_active && (
                                                    <button
                                                        onClick={() => handleReactivate(emp)}
                                                        className="rounded-lg px-2 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/10 transition"
                                                    >
                                                        Reactivate
                                                    </button>
                                                )}
                                                {isHR && emp.is_active && !emp.has_account && (
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
                                                {emp.has_account && emp.is_active && (
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

            {/* Deactivate modal */}
            {deleteTarget && (
                <DeleteConfirmModal
                    employee={deleteTarget}
                    onClose={() => setDeleteTarget(null)}
                    onDeleted={handleDeactivated}
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
