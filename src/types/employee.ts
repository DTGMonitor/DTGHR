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
