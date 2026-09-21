export interface LoginRequest {
    email: string;
    password: string;
}

/**
 * Authority is four roles, not a boolean.
 *
 * `admin` and `executive` differ by DOMAIN rather than degree: leave takes one
 * signature from either, and the executive may overturn the admin; pay takes
 * two in sequence, admin then executive. `finance` reads compensation and
 * nothing else — never the ratings or comments behind a bonus.
 */
export type UserRole = "admin" | "executive" | "finance" | "employee";

export interface UserResponse {
    id: string;
    email: string;
    full_name: string;
    is_active: boolean;
    role: UserRole;
    /**
     * True for admin and executive alike. Retained because the screens and the
     * RLS policies were written against it; `role` is the source of truth.
     */
    is_superuser: boolean;
    /** Either signature settles a leave request. */
    can_approve_leave: boolean;
    /** The executive alone may revisit a settled one. */
    can_overturn_leave: boolean;
    /** Admin, executive and finance. */
    can_read_compensation: boolean;
    password_change_required: boolean;
    created_at: string;
    /**
     * The roster row linked to this account, or null when HR has not paired
     * one up yet. Resolved by bootstrap_session() so the leave pages can scope
     * their queries without a second round trip.
     */
    employee_id: string | null;
}
