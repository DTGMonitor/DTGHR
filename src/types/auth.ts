export interface LoginRequest {
    email: string;
    password: string;
}

export interface TokenResponse {
    access_token: string;
    token_type: string;
}

export interface UserResponse {
    id: string;
    email: string;
    full_name: string;
    is_active: boolean;
    is_superuser: boolean;
    /**
     * Place in the KPI review chain. Distinct from `is_superuser`, which gates
     * HR administration — the CEO approves scorecards without editing rosters.
     */
    role: "employee" | "director" | "executive";
    password_change_required: boolean;
    created_at: string;
}
