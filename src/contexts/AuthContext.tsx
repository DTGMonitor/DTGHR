import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    type ReactNode,
} from "react";
import { useMsal } from "@azure/msal-react";
import { InteractionRequiredAuthError } from "@azure/msal-browser";
import api, { TOKEN_KEY } from "@/lib/api";
import { isAzureSsoConfigured, loginRequest } from "@/lib/msalConfig";
import type { UserResponse } from "@/types/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthContextValue {
    user: UserResponse | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    /** Email/password login (admin) */
    loginWithEmail: (email: string, password: string) => Promise<void>;
    /** Microsoft Entra ID login (employees) */
    loginWithMicrosoft: () => Promise<void>;
    /** Whether Entra SSO is configured in this build */
    isSsoAvailable: boolean;
    /** Change password (first-time email/password users) */
    changePassword: (newPassword: string) => Promise<void>;
    logout: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
    const { instance } = useMsal();
    const [user, setUser] = useState<UserResponse | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    // -----------------------------------------------------------------------
    // On mount: hydrate from stored local token OR from MSAL session
    // -----------------------------------------------------------------------
    useEffect(() => {
        const localToken = localStorage.getItem(TOKEN_KEY);
        // MSAL v3 throws if the instance was never initialised, which is the
        // case whenever Entra SSO is not configured for this build.
        const msalAccounts = isAzureSsoConfigured ? instance.getAllAccounts() : [];

        // Case 1: Local JWT exists (admin email/password login)
        if (localToken) {
            api
                .get<UserResponse>("/auth/me")
                .then((res) => setUser(res.data))
                .catch(() => localStorage.removeItem(TOKEN_KEY))
                .finally(() => setIsLoading(false));
            return;
        }

        // Case 2: MSAL session exists (Microsoft login)
        // Use instance.getAllAccounts() directly — it's synchronous and always
        // up-to-date after handleRedirectPromise() has resolved (which we
        // await in main.tsx before rendering). The useIsAuthenticated() hook
        // may lag behind by one render cycle after a redirect, causing a
        // race condition where ProtectedRoute redirects to /login.
        // msalAccounts already computed above
        if (msalAccounts.length > 0) {
            const fetchUser = async () => {
                try {
                    const tokenResponse = await instance.acquireTokenSilent({
                        ...loginRequest,
                        account: msalAccounts[0],
                    });

                    // Use the ID token (signed JWT with user claims)
                    const token = tokenResponse.idToken;
                    localStorage.setItem(TOKEN_KEY, token);

                    const res = await api.get<UserResponse>("/auth/me");
                    setUser(res.data);
                } catch (err) {
                    if (err instanceof InteractionRequiredAuthError) {
                        await instance.acquireTokenRedirect(loginRequest);
                    } else {
                        console.error("[AuthContext] MSAL token/me FAIL:", err);
                    }
                } finally {
                    setIsLoading(false);
                }
            };
            fetchUser();
            return;
        }

        // Neither — user is not logged in
        setIsLoading(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [instance]);

    // -----------------------------------------------------------------------
    // Login: email + password (admin)
    // -----------------------------------------------------------------------
    const loginWithEmail = useCallback(async (email: string, password: string) => {
        const { data } = await api.post<{ access_token: string }>("/auth/login", {
            email,
            password,
        });
        localStorage.setItem(TOKEN_KEY, data.access_token);
        const meRes = await api.get<UserResponse>("/auth/me");
        setUser(meRes.data);
    }, []);

    // -----------------------------------------------------------------------
    // Login: Microsoft Entra ID (employees)
    // -----------------------------------------------------------------------
    const loginWithMicrosoft = useCallback(async () => {
        if (!isAzureSsoConfigured) {
            throw new Error(
                "Microsoft sign-in is not configured. Set VITE_AZURE_CLIENT_ID and " +
                    "VITE_AZURE_TENANT_ID and redeploy the frontend."
            );
        }
        await instance.loginRedirect(loginRequest);
    }, [instance]);

    // -----------------------------------------------------------------------
    // Change password (first-time email/password users)
    // -----------------------------------------------------------------------
    const changePassword = useCallback(async (newPassword: string) => {
        await api.post("/auth/change-password", { new_password: newPassword });
        // Refresh user profile so password_change_required becomes false
        const meRes = await api.get<UserResponse>("/auth/me");
        setUser(meRes.data);
    }, []);

    // -----------------------------------------------------------------------
    // Logout — only clears the HR Hub session.
    // We intentionally do NOT call instance.logoutRedirect() so the user
    // stays signed in to their Microsoft / Entra account.  On re-login the
    // existing MSAL session token is reused if still valid.
    // -----------------------------------------------------------------------
    const logout = useCallback(() => {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
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
