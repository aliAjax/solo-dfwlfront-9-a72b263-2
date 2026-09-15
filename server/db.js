import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('supervisor','inspector')),
  station_id INTEGER NOT NULL REFERENCES stations(id)
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  UNIQUE (station_id, code)
);

CREATE TABLE IF NOT EXISTS check_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_type TEXT NOT NULL,
  item_name TEXT NOT NULL,
  standard TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

-- 巡检计划：同一站点+班次+日期唯一（幂等生成的自然键）
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  plan_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (station_id, shift_id, plan_date)
);

-- 巡检任务：同一计划内每台设备一条，天然保证“每台设备同一时段只能被一人领取”
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  device_id INTEGER NOT NULL REFERENCES devices(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','in_progress','completed')),
  claimed_by INTEGER REFERENCES users(id),
  claimed_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (plan_id, device_id)
);

CREATE TABLE IF NOT EXISTS inspection_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  check_item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('pass','fail')),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, check_item_id)
);

-- 异常单：task_id 唯一 —— 一次巡检不合格只生成一张异常单
CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  station_id INTEGER NOT NULL REFERENCES stations(id),
  device_id INTEGER NOT NULL REFERENCES devices(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','processing','recheck_pending','closed','escalated')),
  responsible_id INTEGER REFERENCES users(id),
  handler_id INTEGER REFERENCES users(id),
  recheck_deadline TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anomaly_rechecks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anomaly_id INTEGER NOT NULL REFERENCES anomalies(id),
  result TEXT NOT NULL CHECK (result IN ('pass','fail')),
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- 全量操作轨迹
CREATE TABLE IF NOT EXISTS audit_trail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- 幂等键：刷新/重试不会重复提交
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  user_id INTEGER,
  endpoint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_results_task ON inspection_results(task_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_station ON anomalies(station_id, status);
CREATE INDEX IF NOT EXISTS idx_trail_entity ON audit_trail(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_trail_station ON audit_trail(station_id);
`;

const SEED = `
INSERT INTO stations (code, name) VALUES
  ('ST01', '城东加油站'),
  ('ST02', '城西加油站');

INSERT INTO shifts (name, start_time, end_time) VALUES
  ('早班', '06:00', '14:00'),
  ('中班', '14:00', '22:00'),
  ('夜班', '22:00', '06:00');

INSERT INTO users (username, name, role, station_id) VALUES
  ('zhangaq', '张安全', 'supervisor', 1),
  ('liuxj',  '李巡检', 'inspector',  1),
  ('wangxj', '王巡检', 'inspector',  1),
  ('zhaoaq', '赵安全', 'supervisor', 2),
  ('qianxj', '钱巡检', 'inspector',  2);

INSERT INTO devices (station_id, code, name, type) VALUES
  (1, 'JYJ-01', '1号加油机',   'fuel_dispenser'),
  (1, 'JYJ-02', '2号加油机',   'fuel_dispenser'),
  (1, 'CG-01',  '储油罐区',    'tank'),
  (1, 'YQ-01',  '油气回收装置', 'vapor_recovery'),
  (2, 'JYJ-01', '1号加油机',   'fuel_dispenser'),
  (2, 'CG-01',  '储油罐区',    'tank');

INSERT INTO check_items (device_type, item_name, standard, seq) VALUES
  ('fuel_dispenser', '油枪及管路无渗漏', '目视无油迹、无滴漏', 1),
  ('fuel_dispenser', '急停按钮有效',     '按下后整机断电', 2),
  ('fuel_dispenser', '静电接地完好',     '接地线无断裂、夹具紧固', 3),
  ('fuel_dispenser', '显示屏与键盘正常', '显示清晰、按键灵敏', 4),
  ('tank',           '罐体及阀门无渗漏', '无油迹、无异味', 1),
  ('tank',           '呼吸阀工作正常',   '阀盘活动自如、无堵塞', 2),
  ('tank',           '液位计指示正常',   '与手工检尺比对误差≤2mm', 3),
  ('vapor_recovery', '真空泵运行正常',   '无异响、无过热', 1),
  ('vapor_recovery', '回收管路无泄漏',   '接口无油气味、压力正常', 2);
`;

export function createDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const count = db.prepare('SELECT COUNT(*) AS n FROM stations').get().n;
  if (count === 0) db.exec(SEED);
  return db;
}
