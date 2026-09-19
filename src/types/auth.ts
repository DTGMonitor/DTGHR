export interface LoginRequest {
    email: string;
    password: string;
}

export interface UserResponse {
    id: string;
    email: string;
    full_name: string;
    is_active: boolean;
    is_superuser: boolean;
    password_change_required: boolean;
    created_at: string;
    /**
     * The roster row linked to this account, or null when HR has not paired
     * one up yet. Resolved by bootstrap_session() so the leave pages can scope
     * their queries without a second round trip.
     */
    employee_id: string | null;
}
