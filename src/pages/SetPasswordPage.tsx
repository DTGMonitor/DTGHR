import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

export default function SetPasswordPage() {
    const { changePassword } = useAuth();
    const navigate = useNavigate();

    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError("");

        if (password.length < 6) {
            setError("Password must be at least 6 characters.");
            return;
        }
        if (password !== confirm) {
            setError("Passwords do not match.");
            return;
        }

        setIsSubmitting(true);
        try {
            await changePassword(password);
            navigate("/", { replace: true });
        } catch {
            setError("Failed to set password. Please try again.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const inputClass =
        "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";

    return (
        <div className="flex min-h-screen items-center justify-center bg-gray-950 px-4">
            {/* Decorative blobs */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute -left-40 -top-40 h-80 w-80 rounded-full bg-indigo-600/20 blur-3xl" />
                <div className="absolute -bottom-40 -right-40 h-80 w-80 rounded-full bg-purple-600/20 blur-3xl" />
            </div>

            <div className="relative w-full max-w-md">
                {/* Logo */}
                <div className="mb-8 text-center">
                    <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-xl font-bold text-white shadow-2xl shadow-indigo-500/30">
                        H
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">
                        Set your password
                    </h1>
                    <p className="mt-1 text-sm text-gray-400">
                        Welcome! Please create a secure password to continue.
                    </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-gray-900/50 p-8 shadow-2xl backdrop-blur-xl">
                    <form onSubmit={handleSubmit} className="space-y-5">
                        {error && (
                            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                                {error}
                            </div>
                        )}

                        <div>
                            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-gray-300">
                                New Password
                            </label>
                            <input
                                id="password"
                                type="password"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Minimum 6 characters"
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label htmlFor="confirm" className="mb-1.5 block text-sm font-medium text-gray-300">
                                Confirm Password
                            </label>
                            <input
                                id="confirm"
                                type="password"
                                required
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                                placeholder="Repeat your password"
                                className={inputClass}
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={isSubmitting}
                            className="w-full rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isSubmitting ? "Saving…" : "Set Password & Continue"}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
