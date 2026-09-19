import { rpc, sanitiseFilterValue, supabase, toApiError } from "@/lib/supabase";
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

const SEARCH_COLUMNS = ["first_name", "last_name", "email", "employee_id"];

export const employeeService = {
    async list(params: {
        page?: number;
        page_size?: number;
        search?: string;
        department?: string;
    }): Promise<{ data: EmployeeListResponse }> {
        const page = params.page ?? 1;
        const pageSize = params.page_size ?? 20;
        const from = (page - 1) * pageSize;

        let query = supabase
            .from("employees_view")
            .select("*", { count: "exact" })
            .eq("is_active", true);

        const search = sanitiseFilterValue(params.search ?? "");
        if (search) {
            query = query.or(SEARCH_COLUMNS.map((c) => `${c}.ilike.%${search}%`).join(","));
        }

        const department = sanitiseFilterValue(params.department ?? "");
        if (department) {
            query = query.ilike("department", `%${department}%`);
        }

        const { data, error, count } = await query
            .order("created_at", { ascending: false })
            .range(from, from + pageSize - 1);

        if (error) throw toApiError(error);

        return {
            data: {
                items: (data ?? []) as Employee[],
                total: count ?? 0,
                page,
                page_size: pageSize,
            },
        };
    },

    async get(id: string): Promise<{ data: Employee }> {
        const { data, error } = await supabase
            .from("employees_view")
            .select("*")
            .eq("id", id)
            .single();
        if (error) throw toApiError(error);
        return { data: data as Employee };
    },

    async create(data: EmployeeCreateData): Promise<{ data: Employee }> {
        return { data: await rpc<Employee>("create_employee", { p_payload: data }) };
    },

    async update(id: string, data: EmployeeUpdateData): Promise<{ data: Employee }> {
        return {
            data: await rpc<Employee>("update_employee", {
                p_employee_id: id,
                p_payload: data,
            }),
        };
    },

    async delete(id: string): Promise<void> {
        await rpc<null>("deactivate_employee", { p_employee_id: id });
    },

    async createAccount(id: string): Promise<{ data: CreateAccountResult }> {
        return {
            data: await rpc<CreateAccountResult>("create_employee_account", {
                p_employee_id: id,
            }),
        };
    },
};
