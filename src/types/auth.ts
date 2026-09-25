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
    role: "employee" | "director" | "executive" | "finance";
    /**
     * Whether this account's employee record is a management role.
     *
     * A third axis again: `is_superuser` gates HR administration, `role` gates
     * the review chain, and this gates the staff directory and the bonus.
     * Staff see their own record in place of the directory.
     */
    is_management: boolean;
    /**
     * Whether this person may write the staff bulletin.
     *
     * A fourth axis, implied by none of the others. The Bulletin nav entry
     * follows this flag alone, so somebody who has not taken the job on
     * does not carry a link to a desk that is not theirs.
     */
    can_write_articles: boolean;
    /**
     * Whether this person may add and edit employee records.
     *
     * Opens the directory and the employee form, and nothing else. An
     * administrator always has it.
     */
    can_manage_people: boolean;
    /** Whether this person may add, edit and acknowledge contracts. */
    can_manage_contracts: boolean;
    /**
     * A founder: management, and exempt from review. Peter and Mark.
     *
     * Carried on the session because the test appears everywhere — the
     * roster, the leave balance, the staff count, the profile — and
     * re-deriving it from two flags in each place is how they drift.
     */
    is_founder: boolean;
    /** The linked employee record, for linking straight to "my profile". */
    employee_id: string | null;
    password_change_required: boolean;
    created_at: string;
}
