import { useState, type FormEvent } from "react";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import axios from "axios";
import AuthShell from "@/components/layout/AuthShell";
import Spinner from "@/components/ui/Spinner";
import Alert from "@/components/ui/Alert";

export default function LoginPage() {
    const { loginWithEmail, loginWithMicrosoft, isSsoAvailable, isAuthenticated, isLoading } = useAuth();
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
            <div className="flex min-h-screen items-center justify-center bg-night">
                <Spinner className="h-7 w-7 text-signal" />
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
        <AuthShell
            eyebrow="HR Hub"
            title="Sign in"
            subtitle="Use your DTG account to continue."
        >
            {/* Microsoft login — hidden when Entra SSO is not configured
                for this build, so the button never leads to a dead end. */}
            {isSsoAvailable && (
                <>
                    <button
                        id="microsoft-login-button"
                        onClick={() => loginWithMicrosoft()}
                        className="dtg-btn-secondary w-full py-3"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
                            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                        </svg>
                        Continue with Microsoft
                    </button>

                    <div className="my-6 flex items-center gap-3">
                        <div className="h-px flex-1 bg-white/10" />
                        <span className="text-micro font-semibold uppercase tracking-eyebrow text-muted">or</span>
                        <div className="h-px flex-1 bg-white/10" />
                    </div>
                </>
            )}

            <form onSubmit={handleEmailLogin} className="space-y-5">
                {error && <Alert tone="danger">{error}</Alert>}

                <div>
                    <label htmlFor="email" className="dtg-label">
                        Email
                    </label>
                    <input
                        id="email"
                        type="email"
                        required
                        autoComplete="username"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@dtgeotech.com"
                        className="dtg-input"
                    />
                </div>

                <div>
                    <label htmlFor="password" className="dtg-label">
                        Password
                    </label>
                    <input
                        id="password"
                        type="password"
                        required
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="dtg-input"
                    />
                </div>

                <button
                    id="login-button"
                    type="submit"
                    disabled={isSubmitting}
                    className="dtg-btn-primary w-full py-3"
                >
                    {isSubmitting ? (
                        <>
                            <Spinner />
                            Signing in…
                        </>
                    ) : (
                        "Sign in"
                    )}
                </button>
            </form>
        </AuthShell>
    );
}
