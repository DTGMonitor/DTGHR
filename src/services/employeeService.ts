import api from "@/lib/api";
import type { Employee, EmployeeListResponse } from "@/types/employee";

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

export interface EmployeeUpdateData {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    department?: string;
    position?: string;
    date_of_joining?: string;
    annual_leave_opening_balance?: number;
    is_active?: boolean;
}

export const employeeService = {
    list(params: {
        page?: number;
        page_size?: number;
        search?: string;
        department?: string;
    }): Promise<{ data: EmployeeListResponse }> {
        return api.get("/employees", { params });
    },

    get(id: string): Promise<{ data: Employee }> {
        return api.get(`/employees/${id}`);
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
