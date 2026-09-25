import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import Spinner from "@/components/ui/Spinner";

interface ProtectedRouteProps {
    children: React.ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
    const { isAuthenticated, isLoading, user } = useAuth();
    const location = useLocation();

    if (isLoading) {
        return (
            <div className="flex h-screen items-center justify-center bg-night">
                <Spinner className="h-7 w-7 text-signal" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    // Redirect email/password users who must set their password on first login
    if (user?.password_change_required && location.pathname !== "/set-password") {
        return <Navigate to="/set-password" replace />;
    }

    return <>{children}</>;
}
