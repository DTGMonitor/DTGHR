import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { isApiError } from "@/lib/supabase";
import AuthShell from "@/components/layout/AuthShell";
import Alert from "@/components/ui/Alert";
import Spinner from "@/components/ui/Spinner";

export default function SetPasswordPage() {
    const { changePassword } = useAuth();
    const navigate = useNavigate();
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError("");

        if (newPassword.length < 8) {
            setError("Password must be at least 8 characters long.");
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
                setError(err.response.data.detail || "Failed to change password.");
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
            subtitle="You need a password of your own before continuing."
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
                        minLength={8}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="At least 8 characters"
                        className="dtg-input"
                    />
                </div>

                <div>
                    <label htmlFor="confirm-password" className="dtg-label">
                        Confirm password
                    </label>
                    <input
                        id="confirm-password"
                        type="password"
                        required
                        minLength={8}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Re-enter your password"
                        className="dtg-input"
                    />
                </div>

                <button
                    id="set-password-button"
                    type="submit"
                    disabled={isSubmitting}
                    className="dtg-btn-primary w-full"
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
