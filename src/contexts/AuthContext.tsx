import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useRef,
    type ReactNode,
} from "react";
import {
    ApiError,
    isAzureSsoConfigured,
    rpc,
    setSessionFacts,
    supabase,
    toApiError,
} from "@/lib/supabase";
import type { UserResponse } from "@/types/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthContextValue {
    user: UserResponse | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    /** Email/password login */
    loginWithEmail: (email: string, password: string) => Promise<void>;
    /** Microsoft Entra ID login, through Supabase's Azure provider */
    loginWithMicrosoft: () => Promise<void>;
    /** Whether Entra SSO is offered in this build */
    isSsoAvailable: boolean;
    /**
     * Re-read the session. Capabilities live on the employee record, so
     * switching one on for yourself in Settings has to reach the sidebar
     * without a fresh sign-in.
     */
    refreshUser: () => Promise<void>;
    /** Change password (first-time users on a temporary password) */
    changePassword: (newPassword: string) => Promise<void>;
    logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<UserResponse | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const mounted = useRef(true);

    /**
     * Resolve the profile behind the current Supabase session.
     *
     * bootstrap_session() is the replacement for GET /auth/me. It also does
     * what the backend used to do on every single request: link the roster row
     * whose email matches this account, so somebody imported from the workbook
     * can propose changes to their own row without HR pairing them up by hand.
     */
    const loadProfile = useCallback(async () => {
        try {
            const profile = await rpc<UserResponse & { employee_id: string | null }>(
                "bootstrap_session"
            );
            setSessionFacts({
                userId: profile.id,
                employeeId: profile.employee_id,
                isSuperuser: profile.is_superuser,
            });
            if (mounted.current) setUser(profile);
        } catch (err) {
            // An inactive account, or a session whose user no longer exists.
            // Either way there is nothing to show, so drop the session rather
            // than leave the app in a half-signed-in state.
            console.error("[AuthContext] could not load profile:", err);
            setSessionFacts(null);
            await supabase.auth.signOut();
            if (mounted.current) setUser(null);
            // Rethrow so a failure here during sign-in reaches the login form.
            // Swallowing it bounces the user back to /login with nothing shown,
            // which is indistinguishable from a rejected password.
            throw err;
        }
    }, []);

    // -----------------------------------------------------------------------
    // On mount: pick up an existing session, then follow it.
    //
    // onAuthStateChange also fires for token refreshes and for the redirect
    // back from Microsoft, which is what makes SSO work without any explicit
    // handling of the callback URL.
    // -----------------------------------------------------------------------
    useEffect(() => {
        mounted.current = true;

        (async () => {
            try {
                const { data } = await supabase.auth.getSession();
                if (data.session) await loadProfile();
            } catch {
                // loadProfile has already dropped the session; nothing to show.
            } finally {
                if (mounted.current) setIsLoading(false);
            }
        })();

        const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
            // Supabase warns against awaiting its own calls inside this
            // callback -- doing so can deadlock the client's internal lock.
            // Defer instead.
            queueMicrotask(async () => {
                if (!mounted.current) return;
                if (event === "SIGNED_OUT" || !session) {
                    setSessionFacts(null);
                    setUser(null);
                    return;
                }
                if (event === "SIGNED_IN" || event === "USER_UPDATED") {
                    try {
                        await loadProfile();
                    } catch {
                        // Already handled inside loadProfile. The login form
                        // reports it; this listener has nowhere to put it.
                    }
                }
            });
        });

        return () => {
            mounted.current = false;
            subscription.subscription.unsubscribe();
        };
    }, [loadProfile]);

    // -----------------------------------------------------------------------
    // Login: email + password
    // -----------------------------------------------------------------------
    const loginWithEmail = useCallback(
        async (email: string, password: string) => {
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) {
                // GoTrue says "Invalid login credentials"; the old API said
                // "Incorrect email or password". Keep the wording people know --
                // but only for that one case. GoTrue returns 400 for several
                // other things too (the email provider being switched off, an
                // unconfirmed address, rate limiting), and calling those a bad
                // password sends whoever is debugging it in the wrong direction.
                const isBadCredentials =
                    error.code === "invalid_credentials" ||
                    /invalid login credentials/i.test(error.message);

                throw toApiError({
                    message: isBadCredentials
                        ? "Incorrect email or password"
                        : error.message,
                    ...(error.status ? { status: error.status } : {}),
                } as { message: string; status?: number });
            }
            await loadProfile();
        },
        [loadProfile]
    );

    // -----------------------------------------------------------------------
    // Login: Microsoft Entra ID
    //
    // The provider is configured in the Supabase dashboard rather than in this
    // bundle, so there is no client id here any more. Supabase handles the
    // redirect and hands back its own session.
    // -----------------------------------------------------------------------
    const loginWithMicrosoft = useCallback(async () => {
        if (!isAzureSsoConfigured) {
            throw new Error(
                "Microsoft sign-in is not enabled. Configure the Azure provider in the " +
                    "Supabase dashboard, set VITE_AZURE_SSO_ENABLED=true and redeploy."
            );
        }
        const { error } = await supabase.auth.signInWithOAuth({
            provider: "azure",
            options: {
                scopes: "openid profile email",
                redirectTo: window.location.origin,
            },
        });
        if (error) throw toApiError(error);
    }, []);

    // -----------------------------------------------------------------------
    // Change password
    // -----------------------------------------------------------------------
    const changePassword = useCallback(async (newPassword: string) => {
        // The old endpoint's rule; GoTrue's own minimum is shorter.
        if (newPassword.length < 8) {
            throw new ApiError("Password must be at least 8 characters long", 400);
        }
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) throw toApiError(error);

        // The password itself is GoTrue's business now; this clears the
        // "must change it" flag the old endpoint reset alongside the hash.
        const profile = await rpc<UserResponse & { employee_id: string | null }>(
            "complete_password_change"
        );
        setSessionFacts({
            userId: profile.id,
            employeeId: profile.employee_id,
            isSuperuser: profile.is_superuser,
        });
        setUser(profile);
    }, []);

    // -----------------------------------------------------------------------
    // Logout — clears the HR Hub session only. As before, we do not sign the
    // user out of Microsoft: an SSO user going back to /login should be able
    // to come straight back in.
    // -----------------------------------------------------------------------
    const logout = useCallback(() => {
        setSessionFacts(null);
        setUser(null);
        void supabase.auth.signOut();
    }, []);

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                isLoading,
                loginWithEmail,
                loginWithMicrosoft,
                isSsoAvailable: isAzureSsoConfigured,
                refreshUser: loadProfile,
                changePassword,
                logout,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return ctx;
}
