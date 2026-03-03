import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Layout from "@/components/layout/Layout";
import LoginPage from "@/pages/LoginPage";
import SetPasswordPage from "@/pages/SetPasswordPage";
import DashboardPage from "@/pages/DashboardPage";
import EmployeesPage from "@/pages/EmployeesPage";
import LeavesPage from "@/pages/LeavesPage";

export default function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <Routes>
                    {/* Public routes */}
                    <Route path="/login" element={<LoginPage />} />

                    {/* Set-password: accessible to authenticated users only */}
                    <Route
                        path="/set-password"
                        element={
                            <ProtectedRoute>
                                <SetPasswordPage />
                            </ProtectedRoute>
                        }
                    />

                    {/* Protected routes with layout */}
                    <Route
                        element={
                            <ProtectedRoute>
                                <Layout />
                            </ProtectedRoute>
                        }
                    >
                        <Route path="/" element={<DashboardPage />} />
                        <Route path="/employees" element={<EmployeesPage />} />
                        <Route path="/leaves" element={<LeavesPage />} />
                    </Route>

                    {/* Catch-all */}
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </AuthProvider>
        </BrowserRouter>
    );
}
