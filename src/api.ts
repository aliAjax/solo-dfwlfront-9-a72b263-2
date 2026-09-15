import type {
  Anomaly, CheckItem, InspectionResult, Meta, Plan, Recheck, SubmitResponse, Task, TrailEvent,
} from './types';

let currentUserId: number | null = null;

export function setCurrentUser(id: number | null) {
  currentUserId = id;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (currentUserId) headers['X-User-Id'] = String(currentUserId);
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    const err = body?.error ?? { code: 'NETWORK', message: `请求失败(${res.status})` };
    throw new ApiError(res.status, err.code, err.message);
  }
  return body.data as T;
}

const post = <T>(path: string, data: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(data) });

export const api = {
  meta: () => request<Meta>('/api/meta'),
  plans: (stationId?: number, planDate?: string) => {
    const q = new URLSearchParams();
    if (stationId) q.set('station_id', String(stationId));
    if (planDate) q.set('plan_date', planDate);
    return request<Plan[]>(`/api/plans?${q}`);
  },
  generatePlan: (stationId: number, shiftId: number, planDate: string) =>
    post<{ plan: Plan; created: boolean; tasks: Task[] }>('/api/plans/generate', {
      station_id: stationId, shift_id: shiftId, plan_date: planDate,
    }),
  tasks: (planId: number) => request<Task[]>(`/api/tasks?plan_id=${planId}`),
  taskDetail: (id: number) =>
    request<{ task: Task; items: CheckItem[]; results: InspectionResult[]; anomaly: Anomaly | null }>(
      `/api/tasks/${id}`,
    ),
  claim: (id: number) => post<Task>(`/api/tasks/${id}/claim`, {}),
  start: (id: number) => post<Task>(`/api/tasks/${id}/start`, {}),
  submit: (id: number, results: { check_item_id: number; result: 'pass' | 'fail'; note?: string }[], key: string) =>
    post<SubmitResponse>(`/api/tasks/${id}/submit`, { results, idempotency_key: key }),
  anomalies: (stationId?: number, status?: string) => {
    const q = new URLSearchParams();
    if (stationId) q.set('station_id', String(stationId));
    if (status) q.set('status', status);
    return request<Anomaly[]>(`/api/anomalies?${q}`);
  },
  anomalyDetail: (id: number) =>
    request<{ anomaly: Anomaly; rechecks: Recheck[]; results: unknown[] }>(`/api/anomalies/${id}`),
  handle: (id: number, action: 'start' | 'complete', note?: string) =>
    post<Anomaly>(`/api/anomalies/${id}/handle`, { action, note }),
  recheck: (id: number, result: 'pass' | 'fail', note?: string) =>
    post<Anomaly>(`/api/anomalies/${id}/recheck`, { result, note }),
  trail: (stationId?: number, entityType?: string, entityId?: number) => {
    const q = new URLSearchParams();
    if (stationId) q.set('station_id', String(stationId));
    if (entityType) q.set('entity_type', entityType);
    if (entityId) q.set('entity_id', String(entityId));
    return request<TrailEvent[]>(`/api/trail?${q}`);
  },
};
