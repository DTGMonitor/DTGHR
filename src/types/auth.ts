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
    /**
     * Whether this account's employee record is a management role.
     *
     * A third axis again: `is_superuser` gates HR administration, `role` gates
     * the review chain, and this gates the staff directory and the bonus.
     * Staff see their own record in place of the directory.
     */
    is_management: boolean;
    /** The linked employee record, for linking straight to "my profile". */
    employee_id: string | null;
    password_change_required: boolean;
    created_at: string;
}
