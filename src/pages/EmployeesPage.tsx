import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import type { Employee } from "@/types/employee";
import { employeeService, type CreateAccountResult } from "@/services/employeeService";
import { useAuth } from "@/contexts/AuthContext";
import EmployeeFormModal from "@/components/employees/EmployeeFormModal";
import DeleteConfirmModal from "@/components/employees/DeleteConfirmModal";
import CreateAccountModal from "@/components/employees/CreateAccountModal";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";
import Alert from "@/components/ui/Alert";

const PAGE_SIZE = 20;

function StatusBadge({ active, onLeave }: { active: boolean; onLeave?: boolean }) {
    if (active && onLeave) {
        return (
            <span className="dtg-chip border-gold/35 bg-gold/10 text-gold">
                <span className="h-1.5 w-1.5 rounded-full bg-gold" />
                On leave
            </span>
        );
    }
    return (
        <span
            className={`dtg-chip ${
                active
                    ? "border-signal/35 bg-signal/10 text-signal"
                    : "border-white/12 bg-white/[0.04] text-muted"
            }`}
        >
            <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-signal" : "bg-muted"}`} />
            {active ? "Active" : "Inactive"}
        </span>
    );
}

/** Initials avatar. Square-ish and teal, matching the header's. */
function Avatar({ first, last }: { first: string; last: string }) {
    return (
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-teal-300/20 bg-teal-900 font-mono text-[0.6875rem] font-semibold tracking-wider text-teal-100">
            {(first[0] ?? "").toUpperCase()}
            {(last[0] ?? "").toUpperCase()}
        </div>
    );
}

export default function EmployeesPage() {
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const [department, setDepartment] = useState("");
    // Former staff are hidden by default; the server ignores this for anyone
    // who is not an administrator.
    const [includeInactive, setIncludeInactive] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [accountError, setAccountError] = useState<string | null>(null);

    const { user } = useAuth();
    /*
     * Two permissions, not one.
     *
     * This was a single `is_superuser` check, which showed Peter an "Add
     * employee" button the API then refused -- he is an administrator but
     * Nurhuda had not made him a people admin. A button that 403s is worse
     * than no button.
     *
     * Adding and editing a record needs the people-admin flag; deactivating
     * somebody and handing out a login stay with the administrator, because
     * neither is data entry.
     */
    const canManagePeople = !!user?.can_manage_people;
    const isAdmin = !!user?.is_superuser;

    const [formTarget, setFormTarget] = useState<Employee | null | undefined>(undefined);
    // undefined = modal closed, null = create mode, Employee = edit mode
    const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null);
    const [createAccountResult, setCreateAccountResult] = useState<CreateAccountResult | null>(null);

    const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

    const fetchEmployees = useCallback(async (p: number, s: string, d: string, inactive = false) => {
        setLoading(true);
        setError(null);
        try {
            const res = await employeeService.list({
                page: p,
                page_size: PAGE_SIZE,
                search: s || undefined,
                department: d || undefined,
                include_inactive: inactive || undefined,
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
        fetchEmployees(page, search, department, includeInactive);
    }, [page, department, includeInactive, fetchEmployees]); // search handled by debounce below

    // Clear any pending debounce if the page unmounts mid-keystroke.
    useEffect(() => {
        return () => {
            if (searchDebounce.current) clearTimeout(searchDebounce.current);
        };
    }, []);

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setSearch(val);
        setPage(1);
        if (searchDebounce.current) clearTimeout(searchDebounce.current);
        searchDebounce.current = setTimeout(() => {
            fetchEmployees(1, val, department, includeInactive);
        }, 400);
    };

    const handleDeptChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setDepartment(e.target.value);
        setPage(1);
    };

    const clearFilters = () => {
        if (searchDebounce.current) clearTimeout(searchDebounce.current);
        setSearch("");
        setDepartment("");
        setPage(1);
        fetchEmployees(1, "", "", includeInactive);
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
        setAccountError(null);
        try {
            const res = await employeeService.createAccount(emp.id);
            setCreateAccountResult(res.data);
            // Mark employee as having an account in the local list
            setEmployees((prev) =>
                prev.map((e) => (e.id === emp.id ? { ...e, has_account: true } : e))
            );
        } catch {
            // Was a blocking window.alert, which reads as a browser error rather
            // than part of the app.
            setAccountError(
                `Could not create an account for ${emp.first_name} ${emp.last_name}. They may already have one.`
            );
        }
    };

    const totalPages = Math.ceil(total / PAGE_SIZE);
    const hasFilters = !!(search || department);

    return (
        <div className="dtg-fade-in space-y-5">
            {/* ── Page header ───────────────────────────────────────────── */}
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">People</p>
                    <h1 className="mt-2 text-2xl font-bold tracking-tight text-paper">Employees</h1>
                    <p className="mt-1.5 text-sm text-paper-soft">
                        <span className="font-mono text-paper">{total}</span> active record
                        {total === 1 ? "" : "s"} at Digital Twin Geotechnical
                    </p>
                </div>
                {canManagePeople && (
                    <button onClick={() => setFormTarget(null)} className="dtg-btn-primary">
                        <Icon name="plus" className="h-4 w-4" />
                        Add employee
                    </button>
                )}
            </div>

            {accountError && (
                <Alert tone="danger">
                    <div className="flex items-start justify-between gap-3">
                        <span>{accountError}</span>
                        <button
                            onClick={() => setAccountError(null)}
                            className="flex-shrink-0 text-micro font-semibold uppercase tracking-label underline decoration-danger/40 hover:decoration-danger"
                        >
                            Dismiss
                        </button>
                    </div>
                </Alert>
            )}

            {/* ── Filters ───────────────────────────────────────────────── */}
            <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                    <Icon
                        name="search"
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-teal-500"
                    />
                    <input
                        type="search"
                        aria-label="Search employees"
                        placeholder="Search by name, email or employee ID…"
                        value={search}
                        onChange={handleSearchChange}
                        className="dtg-input pl-9"
                    />
                </div>
                <input
                    type="text"
                    aria-label="Filter by department"
                    placeholder="Department…"
                    value={department}
                    onChange={handleDeptChange}
                    className="dtg-input sm:w-56"
                />
                {isAdmin && (
                    <label className="flex flex-shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-deep/60 px-3.5 py-2.5 text-xs text-paper-soft">
                        <input
                            type="checkbox"
                            checked={includeInactive}
                            onChange={(e) => {
                                setIncludeInactive(e.target.checked);
                                setPage(1);
                            }}
                            className="h-3.5 w-3.5 accent-[#63B75D]"
                        />
                        Show former staff
                    </label>
                )}
                {hasFilters && (
                    <button onClick={clearFilters} className="dtg-btn-secondary sm:w-auto">
                        Clear
                    </button>
                )}
            </div>

            {/* ── Table ─────────────────────────────────────────────────── */}
            <div className="dtg-panel overflow-hidden">
                {loading ? (
                    <div className="flex items-center justify-center gap-2.5 py-20 text-sm text-paper-soft">
                        <Spinner className="h-4 w-4 text-signal" />
                        Loading employees…
                    </div>
                ) : error ? (
                    <div className="px-5 py-16 text-center">
                        <Icon name="x" className="mx-auto h-8 w-8 text-danger" />
                        <p className="mt-3 text-sm text-danger">{error}</p>
                        <button
                            onClick={() => fetchEmployees(page, search, department, includeInactive)}
                            className="dtg-btn-secondary mt-4"
                        >
                            <Icon name="refresh" className="h-4 w-4" />
                            Retry
                        </button>
                    </div>
                ) : employees.length === 0 ? (
                    <div className="px-5 py-16 text-center">
                        <Icon name="users" className="mx-auto h-8 w-8 text-teal-700" />
                        <p className="mt-3 text-sm text-paper-soft">No employees found</p>
                        {hasFilters ? (
                            <button onClick={clearFilters} className="dtg-btn-secondary mt-4">
                                Clear filters
                            </button>
                        ) : (
                            canManagePeople && (
                                <button onClick={() => setFormTarget(null)} className="dtg-btn-primary mt-4">
                                    <Icon name="plus" className="h-4 w-4" />
                                    Add the first employee
                                </button>
                            )
                        )}
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-white/10 bg-deep/40">
                                    <th className="dtg-th">Employee</th>
                                    <th className="dtg-th">ID</th>
                                    <th className="dtg-th">Department</th>
                                    <th className="dtg-th">Position</th>
                                    <th className="dtg-th">Hire date</th>
                                    <th className="dtg-th">Status</th>
                                    <th className="dtg-th text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/[0.06]">
                                {employees.map((emp) => (
                                    <tr key={emp.id} className="transition-colors hover:bg-white/[0.03]">
                                        <td className="dtg-td">
                                            <Link
                                                to={`/employees/${emp.id}`}
                                                className="group flex items-center gap-3 rounded outline-offset-2"
                                            >
                                                <Avatar first={emp.first_name} last={emp.last_name} />
                                                <div className="min-w-0">
                                                    <p className="truncate font-medium text-paper group-hover:text-signal">
                                                        {emp.first_name} {emp.last_name}
                                                    </p>
                                                    <p className="truncate text-xs text-muted">{emp.email}</p>
                                                </div>
                                            </Link>
                                        </td>
                                        <td className="dtg-td font-mono text-xs text-teal-300">
                                            {emp.employee_id}
                                        </td>
                                        <td className="dtg-td text-paper-soft">{emp.department}</td>
                                        <td className="dtg-td text-paper-soft">{emp.position}</td>
                                        <td className="dtg-td whitespace-nowrap font-mono text-xs text-muted">
                                            {new Date(emp.date_of_joining).toLocaleDateString("en-GB", {
                                                day: "2-digit",
                                                month: "short",
                                                year: "numeric",
                                            })}
                                        </td>
                                        <td className="dtg-td">
                                            <StatusBadge active={emp.is_active} onLeave={emp.on_leave_today} />
                                        </td>
                                        <td className="dtg-td text-right">
                                            <div className="inline-flex items-center gap-0.5">
                                                {canManagePeople && (
                                                    <button
                                                        onClick={() => setFormTarget(emp)}
                                                        className="rounded p-2 text-teal-500 transition-colors hover:bg-white/[0.06] hover:text-teal-100"
                                                        title="Edit employee"
                                                        aria-label={`Edit ${emp.first_name} ${emp.last_name}`}
                                                    >
                                                        <Icon name="pencil" className="h-4 w-4" />
                                                    </button>
                                                )}
                                                {isAdmin && (
                                                    <button
                                                        onClick={() => setDeleteTarget(emp)}
                                                        className="rounded p-2 text-teal-500 transition-colors hover:bg-danger/10 hover:text-danger"
                                                        title="Deactivate employee"
                                                        aria-label={`Deactivate ${emp.first_name} ${emp.last_name}`}
                                                    >
                                                        <Icon name="userMinus" className="h-4 w-4" />
                                                    </button>
                                                )}
                                                {isAdmin && !emp.has_account && (
                                                    <button
                                                        onClick={() => handleCreateAccount(emp)}
                                                        className="rounded p-2 text-teal-500 transition-colors hover:bg-signal/10 hover:text-signal"
                                                        title="Create login account"
                                                        aria-label={`Create a login account for ${emp.first_name} ${emp.last_name}`}
                                                    >
                                                        <Icon name="key" className="h-4 w-4" />
                                                    </button>
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

            {/* ── Pagination ────────────────────────────────────────────── */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between gap-3">
                    <p className="font-mono text-micro text-muted">
                        Page {page} / {totalPages} · {total} total
                    </p>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page === 1}
                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                        >
                            <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                            Previous
                        </button>
                        <button
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={page === totalPages}
                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                        >
                            Next
                            <Icon name="arrowRight" className="h-3.5 w-3.5" />
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
