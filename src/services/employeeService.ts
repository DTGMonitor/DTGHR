import api from "@/lib/api";
import type { Employee, EmployeeListResponse } from "@/types/employee";

export interface EmployeeCreateData {
    employee_id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
    department: string;
    position: string;
    date_of_joining: string; // ISO date string YYYY-MM-DD
}

export interface EmployeeUpdateData {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    department?: string;
    position?: string;
    date_of_joining?: string;
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
};
