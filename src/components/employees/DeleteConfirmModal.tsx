import type { Employee } from "@/types/employee";
import { employeeService } from "@/services/employeeService";
import { useState } from "react";

interface Props {
    employee: Employee;
    onClose: () => void;
    onDeleted: (id: string) => void;
}

export default function DeleteConfirmModal({ employee, onClose, onDeleted }: Props) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleConfirm = async () => {
        setLoading(true);
        setError(null);
        try {
            await employeeService.delete(employee.id);
            onDeleted(employee.id);
        } catch {
            setError("Failed to deactivate employee. Please try again.");
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

            {/* Dialog */}
            <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-gray-950 p-6 shadow-2xl">
                {/* Icon */}
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15">
                    <svg className="h-6 w-6 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                    </svg>
                </div>

                <h3 className="text-center text-lg font-semibold text-white">Deactivate Employee</h3>
                <p className="mt-2 text-center text-sm text-gray-400">
                    Are you sure you want to deactivate{" "}
                    <span className="font-medium text-white">
                        {employee.first_name} {employee.last_name}
                    </span>
                    ? They will be removed from the active directory.
                </p>

                {error && (
                    <p className="mt-3 text-center text-sm text-red-400">{error}</p>
                )}

                <div className="mt-6 flex gap-3">
                    <button
                        onClick={onClose}
                        className="flex-1 rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm font-medium text-gray-300 hover:bg-white/10 transition"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={loading}
                        className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 transition disabled:opacity-60"
                    >
                        {loading ? "Deactivating…" : "Deactivate"}
                    </button>
                </div>
            </div>
        </div>
    );
}
