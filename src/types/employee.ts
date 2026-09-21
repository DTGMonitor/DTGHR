export interface Employee {
    id: string;
    employee_id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone: string | null;
    department: string;
    position: string;
    date_of_joining: string;
    /** Annual leave carried in on the joining date, set by HR. */
    annual_leave_opening_balance: number;
    is_active: boolean;
    has_account: boolean;
    on_leave_today: boolean;
    created_at: string;
    updated_at: string;
}

export interface EmployeeListResponse {
    items: Employee[];
    total: number;
    page: number;
    page_size: number;
}

/** Which schedule a person appears on, and therefore what they may see. */
export type WorkPattern = "office_day" | "roster";

export type EmploymentType = "permanent" | "contract" | "probation" | "intern";

export const WORK_PATTERN_LABELS: Record<WorkPattern, string> = {
    office_day: "Office day",
    roster: "Roster",
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
    permanent: "Permanent (PKWTT)",
    contract: "Contract (PKWT)",
    probation: "Probation",
    intern: "Intern",
};

/**
 * One employee's full record.
 *
 * Separate from `Employee` because the list endpoint deliberately returns only
 * the columns the table renders — the profile is the one place that pays for
 * the rest.
 */
export interface EmployeeDetail extends Employee {
    // Personal
    date_of_birth: string | null;
    place_of_birth: string | null;
    gender: string | null;
    marital_status: string | null;
    religion: string | null;
    address: string | null;
    personal_email: string | null;

    emergency_contact_name: string | null;
    emergency_contact_relationship: string | null;
    emergency_contact_phone: string | null;

    // Statutory (Indonesia)
    national_id: string | null;
    tax_id: string | null;
    bpjs_health_no: string | null;
    bpjs_employment_no: string | null;

    // Payroll destination. No salary figures are held.
    bank_name: string | null;
    bank_account_number: string | null;
    bank_account_holder: string | null;

    // Employment
    employment_type: EmploymentType | null;
    contract_end_date: string | null;
    job_level: string | null;
    work_location: string | null;

    // Scheduling
    work_pattern: WorkPattern;
    is_backup_engineer: boolean;

    // Performance
    kpi_template_id: string | null;
    kpi_template_title: string | null;
    /** False keeps this person out of the review list (founders, new starters). */
    kpi_review_required: boolean;
    kpi_exemption_reason: string | null;

    /**
     * Whether an annual bonus is offered for this role.
     *
     * Peter, September 2026: bonuses are for management roles only at this
     * stage. Elsewhere the scorecard shows no bonus at all -- an empty bonus
     * field still reads as a promise that one is coming.
     */
    is_management_role: boolean;

    has_photo: boolean;
}
