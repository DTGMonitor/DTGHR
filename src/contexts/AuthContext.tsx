import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    type ReactNode,
} from "react";
import api, { TOKEN_KEY } from "@/lib/api";
import type { UserResponse } from "@/types/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthContextValue {
    user: UserResponse | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (
        email: string,
        password: string,
        fullName: string
    ) => Promise<void>;
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
    const [user, setUser] = useState<UserResponse | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    // Hydrate user from stored token on mount
    useEffect(() => {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) {
            setIsLoading(false);
            return;
        }

        api
            .get<UserResponse>("/auth/me")
            .then((res) => setUser(res.data))
            .catch(() => localStorage.removeItem(TOKEN_KEY))
            .finally(() => setIsLoading(false));
    }, []);

    const login = useCallback(async (email: string, password: string) => {
        const { data } = await api.post<{ access_token: string }>("/auth/login", {
            email,
            password,
        });
        localStorage.setItem(TOKEN_KEY, data.access_token);
        const meRes = await api.get<UserResponse>("/auth/me");
        setUser(meRes.data);
    }, []);

    const register = useCallback(
        async (email: string, password: string, fullName: string) => {
            const { data } = await api.post<{ access_token: string }>(
                "/auth/register",
                {
                    email,
                    password,
                    full_name: fullName,
                }
            );
            localStorage.setItem(TOKEN_KEY, data.access_token);
            const meRes = await api.get<UserResponse>("/auth/me");
            setUser(meRes.data);
        },
        []
    );

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
                login,
                register,
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
