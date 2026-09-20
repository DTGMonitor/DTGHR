import { useState } from "react";
import Modal from "@/components/ui/Modal";
import Alert from "@/components/ui/Alert";

interface Props {
    email: string;
    tempPassword: string;
    onClose: () => void;
}

export default function CreateAccountModal({ email, tempPassword, onClose }: Props) {
    const [copied, setCopied] = useState(false);
    const [copyFailed, setCopyFailed] = useState(false);

    const handleCopy = async () => {
        setCopyFailed(false);
        try {
            // Rejects when the page is not a secure context or permission is
            // denied. Silently doing nothing looked like a broken button, so
            // the failure now tells the user to copy it by hand.
            await navigator.clipboard.writeText(tempPassword);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopyFailed(true);
        }
    };

    return (
        <Modal
            tone="success"
            title="Account created"
            description={
                <>
                    Share the temporary password with{" "}
                    <span className="font-medium text-paper">{email}</span>. They will be asked to
                    change it the first time they sign in.
                </>
            }
            onClose={onClose}
            footer={
                <button onClick={onClose} className="dtg-btn-secondary sm:w-auto">
                    Done
                </button>
            }
        >
            <div className="dtg-panel-inset p-4">
                <p className="dtg-eyebrow">Temporary password</p>
                <div className="mt-2.5 flex items-center justify-between gap-3">
                    <code className="min-w-0 flex-1 select-all break-all font-mono text-sm text-paper">
                        {tempPassword}
                    </code>
                    <button
                        onClick={handleCopy}
                        className={`flex-shrink-0 rounded border px-2.5 py-1.5 text-micro font-semibold uppercase tracking-label transition-colors ${
                            copied
                                ? "border-signal/40 bg-signal/15 text-signal"
                                : "border-white/12 bg-white/[0.04] text-paper-soft hover:border-white/25 hover:text-paper"
                        }`}
                    >
                        {copied ? "Copied" : "Copy"}
                    </button>
                </div>
            </div>

            {copyFailed && (
                <Alert tone="warning" className="mt-3">
                    Could not reach the clipboard. Select the password above and copy it manually.
                </Alert>
            )}

            <Alert tone="warning" className="mt-3">
                This password is shown once and cannot be retrieved later.
            </Alert>
        </Modal>
    );
}
