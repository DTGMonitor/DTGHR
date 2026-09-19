import { LeaveStatus, LeaveType } from "@/types/leave";

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
    [LeaveType.ANNUAL]: "Annual",
    [LeaveType.SICK]: "Sick",
    [LeaveType.PERSONAL]: "Personal",
    [LeaveType.UNPAID]: "Unpaid",
};

export const LEAVE_TYPE_COLORS: Record<LeaveType, string> = {
    [LeaveType.ANNUAL]: "from-blue-500/20 to-cyan-500/20 border-blue-500/20",
    [LeaveType.SICK]: "from-red-500/20 to-rose-500/20 border-red-500/20",
    [LeaveType.PERSONAL]: "from-purple-500/20 to-violet-500/20 border-purple-500/20",
    [LeaveType.UNPAID]: "from-gray-500/20 to-slate-500/20 border-gray-500/20",
};

export const STATUS_STYLES: Record<LeaveStatus, string> = {
    [LeaveStatus.PENDING]: "bg-amber-500/15 text-amber-400",
    [LeaveStatus.APPROVED]: "bg-emerald-500/15 text-emerald-400",
    [LeaveStatus.REJECTED]: "bg-red-500/15 text-red-400",
    [LeaveStatus.CANCELLED]: "bg-gray-500/15 text-gray-400",
};

export function formatDate(d: string): string {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/** "12–14 Oct 2026", or a single date when the leave is one day. */
export function formatRange(start: string, end: string): string {
    if (start === end) return formatDate(start);
    const s = new Date(start);
    const e = new Date(end);
    const sameYear = s.getFullYear() === e.getFullYear();
    const sameMonth = sameYear && s.getMonth() === e.getMonth();
    const left = s.toLocaleDateString("en-GB", {
        day: "numeric",
        month: sameMonth ? undefined : "short",
        year: sameYear ? undefined : "numeric",
    });
    return `${left} – ${formatDate(end)}`;
}

export function formatDays(n: number): string {
    const v = Number.isInteger(n) ? String(n) : n.toFixed(1);
    return `${v} day${n === 1 ? "" : "s"}`;
}

export function timeAgo(dateStr: string): string {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return formatDate(dateStr);
}
