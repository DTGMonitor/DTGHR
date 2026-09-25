import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { MsalProvider } from "@azure/msal-react";
import { msalInstance } from "@/lib/msalConfig";
import { AuthProvider } from "@/contexts/AuthContext";
import { DialogProvider } from "@/components/ui/Dialog";
import ProtectedRoute from "@/components/ProtectedRoute";
import Layout from "@/components/layout/Layout";
import LoginPage from "@/pages/LoginPage";
import SetPasswordPage from "@/pages/SetPasswordPage";
import DashboardPage from "@/pages/DashboardPage";
import EmployeesPage from "@/pages/EmployeesPage";
import EmployeeProfilePage from "@/pages/EmployeeProfilePage";
import KpiPage from "@/pages/KpiPage";
import LeavesPage from "@/pages/LeavesPage";
import SalaryPage from "@/pages/SalaryPage";
import PayrollPage from "@/pages/PayrollPage";
import FinanceRequestsPage from "@/pages/FinanceRequestsPage";
import TicketsPage from "@/pages/TicketsPage";
import ContractsPage from "@/pages/ContractsPage";
import MyScorecardPage from "@/pages/MyScorecardPage";
import CompensationPage from "@/pages/CompensationPage";
import SchedulesPage from "@/pages/SchedulesPage";
import ActivityLogPage from "@/pages/ActivityLogPage";
import SettingsPage from "@/pages/SettingsPage";
import BulletinAdminPage from "@/pages/BulletinAdminPage";

export default function App() {
    return (
        <MsalProvider instance={msalInstance}>
            <BrowserRouter>
                <AuthProvider>
                <DialogProvider>
                    <Routes>
                        {/* Public routes */}
                        <Route path="/login" element={<LoginPage />} />

                        {/* Password change (protected but outside layout) */}
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
                            <Route path="/employees/:employeeId" element={<EmployeeProfilePage />} />
                            <Route path="/kpi" element={<KpiPage />} />
                            <Route path="/leaves" element={<LeavesPage />} />
                            <Route path="/salary" element={<SalaryPage />} />
                            <Route path="/payroll" element={<PayrollPage />} />
                            <Route path="/finance-requests" element={<FinanceRequestsPage />} />
                            <Route path="/support" element={<TicketsPage />} />
                            <Route path="/contracts" element={<ContractsPage />} />
                            <Route path="/my-scorecard" element={<MyScorecardPage />} />
                            <Route path="/compensation" element={<CompensationPage />} />
                            <Route path="/schedules" element={<SchedulesPage />} />
                            <Route path="/activity" element={<ActivityLogPage />} />
                            <Route path="/bulletin" element={<BulletinAdminPage />} />
                            <Route path="/settings" element={<SettingsPage />} />
                        </Route>

                        {/* Catch-all */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </DialogProvider>
                </AuthProvider>
            </BrowserRouter>
        </MsalProvider>
    );
}
