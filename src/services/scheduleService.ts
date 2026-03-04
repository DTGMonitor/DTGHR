import api from "@/lib/api";
import type {
    WorkSchedule,
    WorkScheduleDetail,
    WorkScheduleListResponse,
    ShiftCode,
} from "@/types/schedule";

export interface ScheduleCreateData {
    name: string;
    start_date: string;
    end_date: string;
}

export interface ShiftAssignmentInput {
    employee_id: string;
    date: string;
    shift_code: ShiftCode;
    start_time?: string | null;
    end_time?: string | null;
}

export const scheduleService = {
    list(params?: {
        page?: number;
        page_size?: number;
    }): Promise<{ data: WorkScheduleListResponse }> {
        return api.get("/schedules", { params });
    },

    get(id: string): Promise<{ data: WorkScheduleDetail }> {
        return api.get(`/schedules/${id}`);
    },

    create(data: ScheduleCreateData): Promise<{ data: WorkSchedule }> {
        return api.post("/schedules", data);
    },

    saveAssignments(
        id: string,
        assignments: ShiftAssignmentInput[],
    ): Promise<{ data: WorkScheduleDetail }> {
        return api.put(`/schedules/${id}/assignments`, { assignments });
    },

    publish(id: string): Promise<{ data: WorkSchedule }> {
        return api.put(`/schedules/${id}/publish`);
    },

    unpublish(id: string): Promise<{ data: WorkSchedule }> {
        return api.put(`/schedules/${id}/unpublish`);
    },

    delete(id: string): Promise<void> {
        return api.delete(`/schedules/${id}`);
    },
};
