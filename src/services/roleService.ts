import api from "@/lib/api";
import type { UserResponse } from "@/types/auth";

export type AccountRole = UserResponse["role"];

/** The roles the director may hand out. Executive is set outside the app. */
export const ASSIGNABLE_ROLES: AccountRole[] = ["employee", "finance", "director"];

export const ROLE_LABELS: Record<AccountRole, string> = {
    employee: "Employee",
    finance: "Finance",
    director: "Director",
    executive: "Executive",
};

export interface RoleEntry {
    user_id: string;
    employee_id: string;
    role: AccountRole;
}

export interface RoleList {
    items: RoleEntry[];
    /** Active accounts holding finance, for the last-holder confirmation. */
    finance_count: number;
}

export interface RoleSetResult {
    user_id: string;
    role: AccountRole;
    is_superuser: boolean;
}

export const roleService = {
    list(): Promise<{ data: RoleList }> {
        return api.get("/roles");
    },

    set(userId: string, role: AccountRole): Promise<{ data: RoleSetResult }> {
        return api.put(`/roles/${userId}`, { role });
    },
};
