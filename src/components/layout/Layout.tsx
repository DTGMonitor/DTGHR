import { Outlet } from "react-router-dom";
import Header from "./Header";
import Sidebar from "./Sidebar";

export default function Layout() {
    return (
        <div className="min-h-screen bg-gray-950 text-gray-100">
            <Header />
            <Sidebar />
            <main className="ml-64 min-h-[calc(100vh-4rem)] p-6">
                <Outlet />
            </main>
        </div>
    );
}
