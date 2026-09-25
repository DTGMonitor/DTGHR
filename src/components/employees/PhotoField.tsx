import { useRef, useState } from "react";
import { employeeService } from "@/services/employeeService";
import type { EmployeeDetail } from "@/types/employee";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";
import AuthImage from "@/components/articles/AuthImage";

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/webp";

/** Longest edge after downscaling. Plenty for a profile portrait. */
const MAX_EDGE = 512;

/**
 * Downscale and re-encode in the browser before uploading.
 *
 * A photo straight off a phone is several megabytes of camera JPEG, which is
 * far more than a 512px portrait needs and would be stored and re-served on
 * every page load. Re-encoding also normalises HEIC-ish oddities into a plain
 * JPEG the server will accept.
 *
 * Falls back to the original file if anything about the canvas path fails --
 * the server enforces the real limit, so the worst case is a rejected upload
 * with a clear message rather than a broken one.
 */
async function downscale(file: File): Promise<File> {
    try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        if (scale === 1 && file.size <= MAX_BYTES) return file;

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", 0.85)
        );
        if (!blob) return file;
        return new File([blob], "photo.jpg", { type: "image/jpeg" });
    } catch {
        return file;
    }
}

export default function PhotoField({
    employee,
    canEdit,
    onChanged,
}: {
    employee: EmployeeDetail;
    canEdit: boolean;
    onChanged: () => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [broken, setBroken] = useState(false);

    const initials = `${employee.first_name[0] ?? ""}${employee.last_name[0] ?? ""}`.toUpperCase();
    const showImage = employee.has_photo && !broken;
    const initialsBadge = (
        <span className="font-mono text-2xl font-semibold tracking-wider text-teal-500">
            {initials || "?"}
        </span>
    );

    const handleFile = async (file: File | undefined) => {
        if (!file) return;
        setError(null);

        const prepared = await downscale(file);
        if (prepared.size > MAX_BYTES) {
            setError("That image is too large, even after resizing. Try a smaller one.");
            return;
        }

        setBusy(true);
        try {
            await employeeService.uploadPhoto(employee.id, prepared);
            setBroken(false);
            onChanged();
        } catch {
            setError("Upload failed. Please try again.");
        } finally {
            setBusy(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    const handleRemove = async () => {
        setBusy(true);
        setError(null);
        try {
            await employeeService.deletePhoto(employee.id);
            onChanged();
        } catch {
            setError("Could not remove the photo.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col items-center gap-3">
            <div className="relative">
                <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-2xl border border-white/12 bg-deep">
                    {showImage ? (
                        // The photo sits in a private Storage bucket, so it is
                        // fetched through the API client rather than by the
                        // browser from a bare URL.
                        <AuthImage
                            src={employeeService.photoUrl(employee.id, employee.updated_at)}
                            alt={`${employee.first_name} ${employee.last_name}`}
                            className="h-full w-full object-cover"
                            fallback={initialsBadge}
                        />
                    ) : (
                        initialsBadge
                    )}
                </div>

                {busy && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-deep/70">
                        <Spinner className="h-5 w-5 text-signal" />
                    </div>
                )}
            </div>

            {canEdit && (
                <>
                    <input
                        ref={inputRef}
                        type="file"
                        accept={ACCEPT}
                        className="sr-only"
                        onChange={(e) => handleFile(e.target.files?.[0])}
                    />
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => inputRef.current?.click()}
                            disabled={busy}
                            className="dtg-btn-secondary px-2.5 py-1.5 text-micro"
                        >
                            <Icon name="plus" className="h-3.5 w-3.5" />
                            {employee.has_photo ? "Replace" : "Add photo"}
                        </button>
                        {employee.has_photo && (
                            <button
                                type="button"
                                onClick={handleRemove}
                                disabled={busy}
                                className="rounded p-1.5 text-teal-500 transition-colors hover:bg-danger/10 hover:text-danger"
                                title="Remove photo"
                                aria-label="Remove photo"
                            >
                                <Icon name="x" className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                    <p className="max-w-[12rem] text-center text-micro leading-relaxed text-muted">
                        JPEG, PNG or WebP. Resized to {MAX_EDGE}px before upload.
                    </p>
                </>
            )}

            {error && <p className="max-w-[12rem] text-center text-micro text-danger">{error}</p>}
        </div>
    );
}
