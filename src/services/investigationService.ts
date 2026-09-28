import api from "@/lib/api";

/*
 * Monitoring investigations and the disciplinary outcomes they record.
 *
 * Investigators (employees.can_investigate) manage the cases on the
 * Investigations page; each subject reads their own outcome on My Profile,
 * "Conduct", and responds there.
 */

export type InvestigationStatus = "draft" | "issued" | "closed";
export type Decision = "no_action" | "verbal_warning" | "written_warning" | "suspension" | "further_action";
export type ResponseStatus = "pending" | "acknowledged" | "accepted" | "disputed";

export interface MonitoringSite {
    id: string;
    name: string;
    client: string | null;
    is_active: boolean;
    sort_order: number;
}

export interface MonitoringPerson {
    id: string;
    employee_id: string;
    name: string;
    first_name: string;
    position: string | null;
}

export interface Outcome {
    id: string;
    investigation_id: string;
    employee_id: string;
    employee_name: string;
    employee_first_name: string;
    decision: Decision;
    decision_label: string;
    reason: string | null;
    effective_from: string | null;
    active_until: string | null;
    is_active_now: boolean;
    suspension_days: number | null;
    suspension_paid: boolean | null;
    further_action_note: string | null;
    response_status: ResponseStatus;
    response_text: string | null;
    responded_at: string | null;
    resolution_note: string | null;
    resolved_at: string | null;
    revised_at: string | null;
}

export interface Investigation {
    id: string;
    reference: string;
    event_at: string;
    site_id: string;
    site_name: string;
    site_client: string | null;
    radar: string | null;
    title: string;
    on_duty_employee_id: string | null;
    on_duty_name: string | null;
    handover_employee_id: string | null;
    handover_name: string | null;
    handover_note: string | null;
    findings: string | null;
    technical_summary: string | null;
    investigation_result: string | null;
    recommendation: string | null;
    status: InvestigationStatus;
    created_by_name: string | null;
    updated_by_name: string | null;
    created_at: string;
    updated_at: string;
    issued_at: string | null;
    closed_at: string | null;
    outcomes: Outcome[];
}

export interface InvestigationPayload {
    event_at: string;
    site_id: string;
    radar: string;
    title: string;
    on_duty_employee_id: string | null;
    handover_employee_id: string | null;
    handover_note: string;
    findings: string;
    technical_summary: string;
    investigation_result: string;
    recommendation: string;
}

export interface OutcomePayload {
    employee_id: string;
    decision: Decision;
    reason: string;
    effective_from: string | null;
    suspension_days: number | null;
    suspension_paid: boolean | null;
    further_action_note: string;
}

/** An outcome as its subject reads it. */
export interface MyOutcome {
    id: string;
    reference: string;
    event_at: string;
    site_name: string;
    site_client: string | null;
    radar: string | null;
    title: string;
    investigation_result: string | null;
    recommendation: string | null;
    case_status: InvestigationStatus;
    issued_at: string | null;
    decision: Decision;
    decision_label: string;
    reason: string | null;
    effective_from: string | null;
    active_until: string | null;
    is_active_now: boolean;
    suspension_days: number | null;
    suspension_paid: boolean | null;
    further_action_note: string | null;
    response_status: ResponseStatus;
    response_text: string | null;
    responded_at: string | null;
    resolution_note: string | null;
    resolved_at: string | null;
    revised_at: string | null;
    can_respond: boolean;
}

export interface TeamSetting {
    id: string;
    employee_id: string;
    name: string;
    position: string | null;
    can_investigate: boolean;
    is_monitoring_team: boolean;
}

export interface InvestigationsWaiting {
    respond: { reference: string; employee_id: string }[];
    disputes: { reference: string; investigation_id: string; name: string }[];
}

export const investigationService = {
    list: () => api.get<{ items: Investigation[]; sites: MonitoringSite[] }>("/investigations"),
    get: (id: string) => api.get<Investigation>(`/investigations/${id}`),
    people: () => api.get<MonitoringPerson[]>("/investigations/people"),
    create: (payload: InvestigationPayload) => api.post<Investigation>("/investigations", payload),
    update: (id: string, payload: InvestigationPayload) =>
        api.put<Investigation>(`/investigations/${id}`, payload),
    remove: (id: string) => api.delete<null>(`/investigations/${id}`),
    addOutcome: (id: string, payload: OutcomePayload) =>
        api.post<Investigation>(`/investigations/${id}/outcomes`, payload),
    updateOutcome: (id: string, outcomeId: string, payload: OutcomePayload) =>
        api.put<Investigation>(`/investigations/${id}/outcomes/${outcomeId}`, payload),
    removeOutcome: (outcomeId: string) => api.delete<Investigation>(`/investigations/outcomes/${outcomeId}`),
    resolve: (outcomeId: string, note: string) =>
        api.post<Investigation>(`/investigations/outcomes/${outcomeId}/resolve`, { note }),
    issue: (id: string) => api.post<Investigation>(`/investigations/${id}/issue`),
    close: (id: string) => api.post<Investigation>(`/investigations/${id}/close`),
    reopen: (id: string) => api.post<Investigation>(`/investigations/${id}/reopen`),

    sites: () => api.get<MonitoringSite[]>("/investigations/sites"),
    addSite: (site: { name: string; client: string }) => api.post<MonitoringSite[]>("/investigations/sites", site),
    updateSite: (id: string, site: Partial<Pick<MonitoringSite, "name" | "client" | "is_active" | "sort_order">>) =>
        api.put<MonitoringSite[]>(`/investigations/sites/${id}`, site),

    mine: () => api.get<MyOutcome[]>("/investigations/mine"),
    respond: (outcomeId: string, response: Exclude<ResponseStatus, "pending">, text?: string) =>
        api.post<MyOutcome>(`/investigations/outcomes/${outcomeId}/respond`, { response, text: text ?? null }),
    waiting: () => api.get<InvestigationsWaiting>("/investigations/waiting"),

    teamSettings: () => api.get<TeamSetting[]>("/investigations/settings"),
    setFlag: (employeeId: string, flag: "can_investigate" | "is_monitoring_team", value: boolean) =>
        api.put<TeamSetting>(`/investigations/settings/${employeeId}`, { flag, value }),
};

/** The Discipline Policy's wording, shown as help beside each decision. */
export const DECISIONS: { value: Decision; label: string; help: string }[] = [
    { value: "no_action", label: "No action", help: "The finding is recorded; no disciplinary action." },
    {
        value: "verbal_warning",
        label: "Verbal warning",
        help: "Minor or first-time infractions. Active 3 months (close monitoring); the mistake must not be repeated.",
    },
    {
        value: "written_warning",
        label: "Written warning",
        help: "Repeated issues or more serious misconduct. Active 6 months (close monitoring).",
    },
    {
        value: "suspension",
        label: "Suspension",
        help: "Temporary suspension, with or without pay, for a number of days.",
    },
    {
        value: "further_action",
        label: "Further action",
        help: "Including termination, where justified and in accordance with labour law.",
    },
];

export const RESPONSE_CHIP: Record<ResponseStatus, { label: string; cls: string }> = {
    pending: { label: "Awaiting response", cls: "border-gold/30 bg-gold/10 text-gold" },
    acknowledged: { label: "Acknowledged", cls: "border-teal-300/30 bg-teal-300/10 text-teal-200" },
    accepted: { label: "Accepted", cls: "border-signal/30 bg-signal/10 text-signal" },
    disputed: { label: "Disputed", cls: "border-danger/40 bg-danger/10 text-danger" },
};

export const STATUS_CHIP: Record<InvestigationStatus, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "border-white/15 bg-white/[0.04] text-paper-soft" },
    issued: { label: "Issued", cls: "border-gold/30 bg-gold/10 text-gold" },
    closed: { label: "Closed", cls: "border-signal/30 bg-signal/10 text-signal" },
};

const WIB = "Asia/Jakarta";

/** `20 Sep 2026, 02:15 WIB`. */
export function formatEventAt(iso: string): string {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat("en-GB", {
        timeZone: WIB,
        day: "numeric",
        month: "short",
        year: "numeric",
    }).format(d);
    const time = new Intl.DateTimeFormat("en-GB", {
        timeZone: WIB,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(d);
    return `${day}, ${time} WIB`;
}

/** `YYYY-MM-DD` of a moment, in WIB. */
export function wibDate(iso: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: WIB }).format(new Date(iso));
}

/** `YYYY-MM-DDTHH:mm` in WIB, for a datetime-local input. */
export function toWibInput(iso: string): string {
    const d = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
    return d.toISOString().slice(0, 16);
}

/** A datetime-local value read as WIB, as an ISO moment. */
export function fromWibInput(value: string): string {
    return value ? `${value}:00+07:00` : "";
}

/** `28 Dec 2026` for a calendar date. */
export function formatDay(date: string): string {
    const [y, m, d] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        day: "numeric",
        month: "short",
        year: "numeric",
    }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Today's date in WIB. */
export function todayWib(): string {
    return wibDate(new Date().toISOString());
}

/** The policy's active period, as the server computes it (investigations_active_until). */
export function activeUntil(decision: Decision, from: string | null, days: number | null): string | null {
    if (!from) return null;
    const [y, m, d] = from.split("-").map(Number) as [number, number, number];
    const addMonths = (n: number) => {
        const target = new Date(Date.UTC(y, m - 1 + n, 1));
        const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
        target.setUTCDate(Math.min(d, last));
        return target.toISOString().slice(0, 10);
    };
    if (decision === "verbal_warning") return addMonths(3);
    if (decision === "written_warning") return addMonths(6);
    if (decision === "suspension" && days && days > 0) {
        return new Date(Date.UTC(y, m - 1, d + days - 1)).toISOString().slice(0, 10);
    }
    return null;
}

/** "Active until 28 Dec 2026", "Ended 28 Dec 2026", or the terms without a period. */
export function periodText(o: Pick<Outcome, "decision" | "active_until" | "suspension_days" | "suspension_paid">): string {
    if (o.decision === "no_action") return "No disciplinary action";
    if (o.decision === "further_action") return "Further action";
    if (!o.active_until) return "Starts when issued";
    const ended = o.active_until < todayWib();
    return `${ended ? "Ended" : "Active until"} ${formatDay(o.active_until)}`;
}

export function suspensionText(o: Pick<Outcome, "suspension_days" | "suspension_paid">): string {
    if (!o.suspension_days) return "";
    return `${o.suspension_days} day${o.suspension_days === 1 ? "" : "s"}, ${o.suspension_paid ? "with pay" : "without pay"}`;
}

export function errorDetail(e: unknown, fallback: string): string {
    const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
    return typeof detail === "string" ? detail : fallback;
}
