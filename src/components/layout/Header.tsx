import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";

export default function Header() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    return (
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/10 bg-gray-900/80 px-6 backdrop-blur-xl">
            {/* Logo / App name */}
            <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-sm font-bold text-white shadow-lg shadow-indigo-500/25">
                    H
                </div>
                <h1 className="text-lg font-semibold tracking-tight text-white">
                    HR Hub
                </h1>
            </div>

            {/* User section */}
            <div className="flex items-center gap-4">
                <div className="hidden text-right sm:block">
                    <p className="text-sm font-medium text-gray-200">
                        {user?.full_name}
                    </p>
                    <p className="text-xs text-gray-400">{user?.email}</p>
                </div>

                {/* Avatar */}
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-sm font-semibold text-white ring-2 ring-indigo-500/30">
                    {user?.full_name?.charAt(0)?.toUpperCase() ?? "U"}
                </div>

                {/* Logout */}
                <button
                    id="logout-button"
                    onClick={handleLogout}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-gray-300 transition-all hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-400"
                >
                    Logout
                </button>
            </div>
        </header>
    );
}
