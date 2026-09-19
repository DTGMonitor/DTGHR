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

export type EmployeeSortKey = "name" | "employee_id" | "department" | "position" | "date_of_joining";
export type EmployeeStatusFilter = "active" | "inactive" | "all";
export type EmployeeAccountFilter = "all" | "with" | "without";

/** Sorting by name orders on first then last, the way the directory reads. */
const SORT_COLUMNS: Record<EmployeeSortKey, string[]> = {
    name: ["first_name", "last_name"],
    employee_id: ["employee_id"],
    department: ["department", "first_name"],
    position: ["position", "first_name"],
    date_of_joining: ["date_of_joining"],
};

export const employeeService = {
    async list(params: {
        page?: number;
        page_size?: number;
        search?: string;
        department?: string;
        status?: EmployeeStatusFilter;
        account?: EmployeeAccountFilter;
        on_leave_only?: boolean;
        sort?: EmployeeSortKey;
        ascending?: boolean;
    }): Promise<{ data: EmployeeListResponse }> {
        const page = params.page ?? 1;
        const pageSize = params.page_size ?? 20;
        const from = (page - 1) * pageSize;

        let query = supabase.from("employees_view").select("*", { count: "exact" });

        const status = params.status ?? "active";
        if (status !== "all") query = query.eq("is_active", status === "active");
        if (params.account === "with") query = query.eq("has_account", true);
        if (params.account === "without") query = query.eq("has_account", false);
        if (params.on_leave_only) query = query.eq("on_leave_today", true);

        const search = sanitiseFilterValue(params.search ?? "");
        if (search) {
            query = query.or(SEARCH_COLUMNS.map((c) => `${c}.ilike.%${search}%`).join(","));
        }

        const department = sanitiseFilterValue(params.department ?? "");
        if (department) {
            query = query.eq("department", department);
        }

        if (params.sort) {
            for (const column of SORT_COLUMNS[params.sort]) {
                query = query.order(column, { ascending: params.ascending ?? true });
            }
        } else {
            query = query.order("created_at", { ascending: false });
        }

        const { data, error, count } = await query.range(from, from + pageSize - 1);

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

    /** Every department in use, for the filter dropdown. */
    async departments(): Promise<string[]> {
        const { data, error } = await supabase.from("employees_view").select("department");
        if (error) throw toApiError(error);
        const names = new Set((data ?? []).map((r) => (r as { department: string }).department));
        return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
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

    /** Off-boarding: hides them from the directory and revokes their sign-in. */
    async delete(id: string): Promise<void> {
        await rpc<null>("deactivate_employee", { p_employee_id: id });
    },

    async reactivate(id: string): Promise<{ data: Employee }> {
        return { data: await rpc<Employee>("reactivate_employee", { p_employee_id: id }) };
    },

    async createAccount(id: string): Promise<{ data: CreateAccountResult }> {
        return {
            data: await rpc<CreateAccountResult>("create_employee_account", {
                p_employee_id: id,
            }),
        };
    },
};
