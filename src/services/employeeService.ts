import api, { API_BASE_URL } from "@/lib/api";
import type { Employee, EmployeeDetail, EmployeeListResponse } from "@/types/employee";

export interface CreateAccountResult {
    user_id: string;
    email: string;
    temp_password: string;
}

export interface EmployeeCreateData {
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
    department: string;
    position: string;
    date_of_joining: string;
    /** Days of annual leave carried in on the joining date. */
    annual_leave_opening_balance?: number;
}

/**
 * Everything HR may change on a record.
 *
 * Derived from `EmployeeDetail` rather than restated, so a field added to the
 * profile cannot be silently left out of the save payload.
 */
export type EmployeeUpdateData = Partial<
    Pick<
        EmployeeDetail,
        | "employee_id"
        | "first_name"
        | "last_name"
        | "email"
        | "phone"
        | "department"
        | "position"
        | "date_of_joining"
        | "annual_leave_opening_balance"
        | "is_active"
        | "date_of_birth"
        | "place_of_birth"
        | "gender"
        | "marital_status"
        | "religion"
        | "address"
        | "personal_email"
        | "emergency_contact_name"
        | "emergency_contact_relationship"
        | "emergency_contact_phone"
        | "national_id"
        | "tax_id"
        | "bpjs_health_no"
        | "bpjs_employment_no"
        | "bank_name"
        | "bank_account_number"
        | "bank_account_holder"
        | "employment_type"
        | "contract_end_date"
        | "job_level"
        | "work_location"
        | "work_pattern"
        | "is_backup_engineer"
        | "kpi_template_id"
    >
>;

export const employeeService = {
    list(params: {
        page?: number;
        page_size?: number;
        search?: string;
        department?: string;
        /** Administrators only; the server ignores it for anyone else. */
        include_inactive?: boolean;
    }): Promise<{ data: EmployeeListResponse }> {
        return api.get("/employees", { params });
    },

    get(id: string): Promise<{ data: EmployeeDetail }> {
        return api.get(`/employees/${id}`);
    },

    /**
     * URL for an employee's photo.
     *
     * `updated_at` is used as a cache-buster: the bytes are served with a
     * short private cache, so without it a freshly uploaded photo would keep
     * showing the old one until the cache expired.
     */
    photoUrl(id: string, updatedAt?: string): string {
        const base = `${API_BASE_URL}/employees/${id}/photo`;
        return updatedAt ? `${base}?v=${encodeURIComponent(updatedAt)}` : base;
    },

    uploadPhoto(id: string, file: File): Promise<void> {
        const form = new FormData();
        form.append("file", file);
        // Content-Type is deliberately left unset: the browser has to add the
        // multipart boundary itself, and naming the type here strips it.
        return api.put(`/employees/${id}/photo`, form, {
            headers: { "Content-Type": undefined },
        });
    },

    deletePhoto(id: string): Promise<void> {
        return api.delete(`/employees/${id}/photo`);
    },

    create(data: EmployeeCreateData): Promise<{ data: Employee }> {
        return api.post("/employees", data);
    },

    update(id: string, data: EmployeeUpdateData): Promise<{ data: Employee }> {
        return api.put(`/employees/${id}`, data);
    },

    delete(id: string): Promise<void> {
        return api.delete(`/employees/${id}`);
    },

    createAccount(id: string): Promise<{ data: CreateAccountResult }> {
        return api.post(`/employees/${id}/create-account`);
    },
};
