import { useEffect } from "react";
import { createPortal } from "react-dom";
import AuthImage from "@/components/articles/AuthImage";
import { employeeService } from "@/services/employeeService";

/**
 * A profile photo at full size, over the page.
 *
 * The avatar in the header and the portrait on the profile are both small
 * crops; this shows the whole picture. Click anywhere, or press Escape, to
 * close.
 */
export default function PhotoPreview({
    employeeId,
    name,
    version,
    onClose,
}: {
    employeeId: string;
    name: string;
    version?: string;
    onClose: () => void;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label={`Photo of ${name}`}
            onClick={onClose}
            className="fixed inset-0 z-[60] flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-deep/90 p-6 backdrop-blur-sm"
        >
            <AuthImage
                src={employeeService.photoUrl(employeeId, version)}
                alt={name}
                className="max-h-[80vh] max-w-[90vw] rounded-2xl border border-white/12 object-contain shadow-2xl"
                fallback={<p className="text-sm text-muted">No photo yet.</p>}
            />
            <p className="text-sm font-medium text-paper">{name}</p>
        </div>,
        document.body,
    );
}
