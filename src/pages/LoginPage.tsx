import { useState, type FormEvent } from "react";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import axios from "axios";

export default function LoginPage() {
    const { loginWithEmail, loginWithMicrosoft, isAuthenticated, isLoading } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? "/";

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // If already authenticated (e.g. after MSAL redirect), go to dashboard
    if (isAuthenticated) {
        return <Navigate to={from} replace />;
    }

    // Show a loading spinner while auth state is being resolved
    if (isLoading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-gray-950">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
            </div>
        );
    }

    const handleEmailLogin = async (e: FormEvent) => {
        e.preventDefault();
        setError("");
        setIsSubmitting(true);

        try {
            await loginWithEmail(email, password);
            navigate(from, { replace: true });
        } catch (err) {
            if (axios.isAxiosError(err)) {
                setError(err.response?.data?.detail ?? "Login failed. Please try again.");
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
                        Welcome to HR Hub
                    </h1>
                    <p className="mt-1 text-sm text-gray-400">
                        Sign in to your account
                    </p>
                </div>

                {/* Card */}
                <div className="rounded-2xl border border-white/10 bg-gray-900/50 p-8 shadow-2xl backdrop-blur-xl">
                    {/* Microsoft login button */}
                    <button
                        id="microsoft-login-button"
                        onClick={() => loginWithMicrosoft()}
                        className="flex w-full items-center justify-center gap-3 rounded-xl bg-[#2f2f2f] px-4 py-3 text-sm font-semibold text-white shadow-lg transition-all hover:bg-[#3f3f3f] active:scale-[0.98]"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 21 21">
                            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                        </svg>
                        Sign in with Microsoft
                    </button>

                    {/* Divider */}
                    <div className="my-6 flex items-center gap-3">
                        <div className="h-px flex-1 bg-white/10" />
                        <span className="text-xs font-medium uppercase tracking-wider text-gray-500">or</span>
                        <div className="h-px flex-1 bg-white/10" />
                    </div>

                    {/* Email / Password form */}
                    <form onSubmit={handleEmailLogin} className="space-y-5">
                        {error && (
                            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                                {error}
                            </div>
                        )}

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

                        <button
                            id="login-button"
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
                                    Signing in...
                                </span>
                            ) : (
                                "Sign in with Email"
                            )}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
