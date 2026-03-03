import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import axios from "axios";

export default function RegisterPage() {
    const { register } = useAuth();
    const navigate = useNavigate();

    const [fullName, setFullName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [employeeId, setEmployeeId] = useState("");
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError("");

        if (password !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }

        if (password.length < 6) {
            setError("Password must be at least 6 characters.");
            return;
        }

        setIsSubmitting(true);

        try {
            await register(email, password, fullName, employeeId || undefined);
            navigate("/", { replace: true });
        } catch (err) {
            if (axios.isAxiosError(err)) {
                setError(
                    err.response?.data?.detail ?? "Registration failed. Please try again."
                );
            } else {
                setError("An unexpected error occurred.");
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-gray-950 px-4">
            {/* Decorative background */}
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
                        Create your account
                    </h1>
                    <p className="mt-1 text-sm text-gray-400">
                        Get started with HR Hub
                    </p>
                </div>

                {/* Card */}
                <div className="rounded-2xl border border-white/10 bg-gray-900/50 p-8 shadow-2xl backdrop-blur-xl">
                    <form onSubmit={handleSubmit} className="space-y-5">
                        {error && (
                            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                                {error}
                            </div>
                        )}

                        <div>
                            <label
                                htmlFor="fullName"
                                className="mb-1.5 block text-sm font-medium text-gray-300"
                            >
                                Full Name
                            </label>
                            <input
                                id="fullName"
                                type="text"
                                required
                                value={fullName}
                                onChange={(e) => setFullName(e.target.value)}
                                placeholder="John Doe"
                                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="email"
                                className="mb-1.5 block text-sm font-medium text-gray-300"
                            >
                                Email
                            </label>
                            <input
                                id="email"
                                type="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="you@company.com"
                                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="password"
                                className="mb-1.5 block text-sm font-medium text-gray-300"
                            >
                                Password
                            </label>
                            <input
                                id="password"
                                type="password"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••"
                                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="confirmPassword"
                                className="mb-1.5 block text-sm font-medium text-gray-300"
                            >
                                Confirm Password
                            </label>
                            <input
                                id="confirmPassword"
                                type="password"
                                required
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                placeholder="••••••••"
                                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                            />
                        </div>

                        {/* Employee ID (optional) */}
                        <div>
                            <label
                                htmlFor="employeeId"
                                className="mb-1.5 block text-sm font-medium text-gray-300"
                            >
                                Employee ID
                                <span className="ml-1.5 text-xs font-normal text-gray-500">(optional — links your account to your employee profile)</span>
                            </label>
                            <input
                                id="employeeId"
                                type="text"
                                value={employeeId}
                                onChange={(e) => setEmployeeId(e.target.value)}
                                placeholder="e.g. DTG-001"
                                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                            />
                        </div>

                        <button
                            id="register-button"
                            type="submit"
                            disabled={isSubmitting}
                            className="w-full rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:from-indigo-600 hover:to-purple-700 hover:shadow-indigo-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isSubmitting ? (
                                <span className="flex items-center justify-center gap-2">
                                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    Creating account...
                                </span>
                            ) : (
                                "Create account"
                            )}
                        </button>
                    </form>

                    <div className="mt-6 text-center">
                        <p className="text-sm text-gray-400">
                            Already have an account?{" "}
                            <Link
                                to="/login"
                                className="font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                            >
                                Sign in
                            </Link>
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
