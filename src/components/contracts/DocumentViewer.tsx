import { useEffect, useState } from "react";

import api from "@/lib/api";
import Spinner from "@/components/ui/Spinner";

/*
 * The contract itself, in the page.
 *
 * It cannot be an <iframe src="/api/..."> — the browser issues that request
 * without the bearer token, so the server answers 401 and the frame renders an
 * error. The same trap the bulletin figures fell into. So the bytes are
 * fetched through axios, which carries the token, and handed to the viewer as
 * a blob URL.
 *
 * The URL is revoked on unmount, because a blob URL holds its bytes alive for
 * the lifetime of the document otherwise, and a contract is megabytes.
 */
export default function DocumentViewer({
    contractId,
    documentId,
    src,
    filename,
    contentType,
    onClose,
}: {
    contractId?: string;
    documentId?: string;
    /** Any document endpoint, for files kept elsewhere -- finance requests. */
    src?: string;
    filename: string;
    contentType: string;
    onClose: () => void;
}) {
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let revoked = false;
        let objectUrl: string | null = null;

        api.get(src ?? `/contracts/${contractId}/documents/${documentId}`, {
            responseType: "blob",
        })
            .then((res) => {
                if (revoked) return;
                objectUrl = URL.createObjectURL(res.data as Blob);
                setUrl(objectUrl);
            })
            .catch(() => setError(true));

        return () => {
            revoked = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [contractId, documentId, src]);

    const isPdf = contentType === "application/pdf";
    const isImage = contentType.startsWith("image/");

    return (
        <div
            className="fixed inset-0 z-50 flex flex-col bg-deep/90 p-4 sm:p-8"
            role="dialog"
            aria-label={filename}
        >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="font-mono text-sm text-paper">{filename}</p>
                <div className="flex gap-2">
                    {url && (
                        <a
                            href={url}
                            download={filename}
                            className="dtg-btn-ghost px-3 py-1.5 text-xs"
                        >
                            Download
                        </a>
                    )}
                    <button onClick={onClose} className="dtg-btn-primary px-3 py-1.5 text-xs">
                        Close
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto rounded-xl border border-white/10 bg-surface">
                {error ? (
                    <p className="px-5 py-16 text-center text-sm text-danger">
                        That file could not be opened.
                    </p>
                ) : !url ? (
                    <div className="flex items-center justify-center gap-2.5 py-20 text-sm text-paper-soft">
                        <Spinner className="h-4 w-4 text-signal" />
                        Opening…
                    </div>
                ) : isPdf ? (
                    <iframe src={url} title={filename} className="h-full w-full" />
                ) : isImage ? (
                    <img src={url} alt={filename} className="mx-auto max-h-full" />
                ) : (
                    /* Word documents have no in-browser viewer, so the honest
                       thing is to say so rather than render a blank frame. */
                    <div className="px-5 py-16 text-center">
                        <p className="text-sm text-paper-soft">
                            This file type cannot be previewed in the browser.
                        </p>
                        <a
                            href={url}
                            download={filename}
                            className="dtg-btn-primary mt-4 inline-flex px-3 py-1.5 text-xs"
                        >
                            Download it
                        </a>
                    </div>
                )}
            </div>
        </div>
    );
}
