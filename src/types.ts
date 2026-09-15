export interface Station { id: number; code: string; name: string }
export interface Shift { id: number; name: string; start_time: string; end_time: string }
export interface User {
  id: number; username: string; name: string;
  role: 'supervisor' | 'inspector'; station_id: number; station_name?: string;
}
export interface Device { id: number; station_id: number; code: string; name: string; type: string }
export interface CheckItem { id: number; device_type: string; item_name: string; standard: string; seq: number }
export interface Meta { stations: Station[]; shifts: Shift[]; users: User[]; devices: Device[]; checkItems: CheckItem[] }

export interface Plan {
  id: number; station_id: number; shift_id: number; plan_date: string;
  status: 'open' | 'locked'; created_by: number | null; created_at: string;
  station_name?: string; shift_name?: string; task_count?: number; done_count?: number;
}

export interface Task {
  id: number; plan_id: number; device_id: number;
  status: 'pending' | 'claimed' | 'in_progress' | 'completed';
  claimed_by: number | null; claimed_at: string | null;
  started_at: string | null; completed_at: string | null;
  device_code: string; device_name: string; device_type: string;
  claimed_by_name: string | null;
  anomaly_id: number | null; anomaly_status: string | null;
}

export interface Anomaly {
  id: number; task_id: number; plan_id: number; station_id: number; device_id: number;
  title: string; description: string; level: number;
  status: 'open' | 'processing' | 'recheck_pending' | 'closed' | 'escalated';
  responsible_id: number | null; handler_id: number | null;
  recheck_deadline: string; closed_at: string | null;
  created_at: string; updated_at: string;
  device_name?: string; device_code?: string; responsible_name?: string; handler_name?: string;
}

export interface Recheck {
  id: number; anomaly_id: number; result: 'pass' | 'fail'; note: string | null;
  created_by: number | null; created_by_name?: string; created_at: string;
}

export interface TrailEvent {
  id: number; station_id: number | null; entity_type: string; entity_id: number;
  action: string; actor_id: number | null; actor_name: string | null;
  detail: string | null; created_at: string;
}

export interface InspectionResult {
  id: number; task_id: number; check_item_id: number; item_name: string;
  result: 'pass' | 'fail'; note: string | null; created_at: string;
}

export interface SubmitResponse {
  taskId: number; status: string; anomalyId: number | null;
  failedCount?: number; alreadyCompleted?: boolean; idempotentReplay?: boolean;
}
