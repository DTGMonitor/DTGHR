export default function LeavesPage() {
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-white">Leave Management</h1>
                    <p className="mt-1 text-sm text-gray-400">
                        Submit, track, and manage leave requests.
                    </p>
                </div>
                <button className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:from-indigo-600 hover:to-purple-700">
                    + New Leave Request
                </button>
            </div>

            <div className="rounded-2xl border border-white/10 bg-gray-900/30 p-12 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800 text-3xl">
                    🗓
                </div>
                <h2 className="text-lg font-semibold text-white">Coming Soon</h2>
                <p className="mt-2 text-sm text-gray-500">
                    Leave balance cards, request forms, approval workflows, and history
                    tables will be implemented here.
                </p>
            </div>
        </div>
    );
}
