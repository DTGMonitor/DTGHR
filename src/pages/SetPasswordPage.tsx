import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { isApiError } from "@/lib/supabase";
import AuthShell from "@/components/layout/AuthShell";
import Spinner from "@/components/ui/Spinner";
import Alert from "@/components/ui/Alert";

const MIN_LENGTH = 8;

export default function SetPasswordPage() {
    const { changePassword } = useAuth();
    const navigate = useNavigate();
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Surfaced as you type, rather than saved up for the submit.
    const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
    const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
    const shortfall = MIN_LENGTH - newPassword.length;

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError("");

        if (newPassword.length < MIN_LENGTH) {
            setError(`Password must be at least ${MIN_LENGTH} characters long.`);
            return;
        }

        if (newPassword !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }

        setIsSubmitting(true);
        try {
            await changePassword(newPassword);
            navigate("/", { replace: true });
        } catch (err) {
            if (isApiError(err)) {
                setError(err.response?.data?.detail ?? "Failed to change password.");
            } else {
                setError("An unexpected error occurred.");
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <AuthShell
            eyebrow="First sign-in"
            title="Set your password"
            subtitle="Choose a new password before continuing to HR Hub."
        >
            <form onSubmit={handleSubmit} className="space-y-5">
                {error && <Alert tone="danger">{error}</Alert>}

                <div>
                    <label htmlFor="new-password" className="dtg-label">
                        New password
                    </label>
                    <input
                        id="new-password"
                        type="password"
                        required
                        minLength={MIN_LENGTH}
                        autoComplete="new-password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder={`At least ${MIN_LENGTH} characters`}
                        aria-invalid={tooShort}
                        className={`dtg-input ${tooShort ? "border-danger/50" : ""}`}
                    />
                    {tooShort && (
                        <p className="mt-1.5 text-micro text-danger">
                            {shortfall} more character{shortfall === 1 ? "" : "s"} needed.
                        </p>
                    )}
                </div>

                <div>
                    <label htmlFor="confirm-password" className="dtg-label">
                        Confirm password
                    </label>
                    <input
                        id="confirm-password"
                        type="password"
                        required
                        minLength={MIN_LENGTH}
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Re-enter your password"
                        aria-invalid={mismatch}
                        className={`dtg-input ${mismatch ? "border-danger/50" : ""}`}
                    />
                    {mismatch && (
                        <p className="mt-1.5 text-micro text-danger">Passwords do not match.</p>
                    )}
                </div>

                <button
                    id="set-password-button"
                    type="submit"
                    disabled={isSubmitting || tooShort || mismatch}
                    className="dtg-btn-primary w-full py-3"
                >
                    {isSubmitting ? (
                        <>
                            <Spinner />
                            Saving…
                        </>
                    ) : (
                        "Set password and continue"
                    )}
                </button>
            </form>
        </AuthShell>
    );
}
