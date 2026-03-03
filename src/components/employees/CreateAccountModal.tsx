import { useState } from "react";

interface Props {
    email: string;
    tempPassword: string;
    onClose: () => void;
}

export default function CreateAccountModal({ email, tempPassword, onClose }: Props) {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(tempPassword);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-gray-900 p-8 shadow-2xl">
                {/* Success icon */}
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/20">
                    <svg className="h-7 w-7 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                </div>

                <h2 className="text-center text-lg font-semibold text-white">Account Created!</h2>
                <p className="mt-1 text-center text-sm text-gray-400">
                    Share the temporary password below with <span className="text-white">{email}</span>.
                    They will be prompted to change it on first login.
                </p>

                {/* Temp password display */}
                <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4">
                    <p className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
                        Temporary Password
                    </p>
                    <div className="flex items-center justify-between gap-3">
                        <code className="flex-1 select-all break-all text-sm font-mono text-white">
                            {tempPassword}
                        </code>
                        <button
                            onClick={handleCopy}
                            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition ${copied
                                    ? "bg-emerald-500/20 text-emerald-400"
                                    : "bg-white/10 text-gray-300 hover:bg-white/20"
                                }`}
                        >
                            {copied ? "Copied!" : "Copy"}
                        </button>
                    </div>
                </div>

                <p className="mt-3 text-xs text-gray-600">
                    ⚠️ This password will not be shown again. Make sure to copy it now.
                </p>

                <button
                    onClick={onClose}
                    className="mt-6 w-full rounded-xl bg-white/10 py-2.5 text-sm font-medium text-gray-300 hover:bg-white/20 transition"
                >
                    Done
                </button>
            </div>
        </div>
    );
}
