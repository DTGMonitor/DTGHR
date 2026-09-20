import type { Employee } from "@/types/employee";
import { employeeService } from "@/services/employeeService";
import { useState } from "react";
import Modal from "@/components/ui/Modal";
import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";

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
        <Modal
            tone="danger"
            title="Deactivate employee"
            description={
                <>
                    <span className="font-medium text-paper">
                        {employee.first_name} {employee.last_name}
                    </span>{" "}
                    will be removed from the active directory. Their leave history and roster
                    records are kept.
                </>
            }
            onClose={onClose}
            footer={
                <>
                    <button onClick={onClose} disabled={loading} className="dtg-btn-secondary sm:w-auto">
                        Cancel
                    </button>
                    <button onClick={handleConfirm} disabled={loading} className="dtg-btn-danger sm:w-auto">
                        {loading ? (
                            <>
                                <Spinner />
                                Deactivating…
                            </>
                        ) : (
                            "Deactivate"
                        )}
                    </button>
                </>
            }
        >
            <dl className="dtg-panel-inset divide-y divide-white/[0.06] px-4 text-sm">
                {[
                    ["Employee ID", employee.employee_id],
                    ["Department", employee.department],
                    ["Position", employee.position],
                ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-4 py-2.5">
                        <dt className="text-micro font-semibold uppercase tracking-label text-paper-soft">
                            {label}
                        </dt>
                        <dd className="truncate font-mono text-xs text-paper">{value}</dd>
                    </div>
                ))}
            </dl>

            {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
        </Modal>
    );
}
