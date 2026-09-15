import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';
import {
  HttpError,
  generatePlan,
  claimTask,
  startTask,
  submitInspection,
  handleAnomaly,
  recheckAnomaly,
  getTaskJoined,
  listTasksOfPlan,
} from './services.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ dbPath = ':memory:', testHooks = false } = {}) {
  const db = createDb(dbPath);
  const app = express();
  app.use(express.json());

  const ok = (res, data) => res.json({ ok: true, data });

  // 身份中间件：X-User-Id 头标识当前操作人（本地演示简化认证）
  app.use('/api', (req, res, next) => {
    if (req.path === '/meta' || req.path === '/health') return next();
    const uid = Number(req.get('X-User-Id'));
    const user = uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) : null;
    if (!user) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '请先选择操作人身份' } });
    req.user = user;
    next();
  });

  const hooksOf = (req) => (testHooks && req.body && req.body.__failAt ? { failAt: req.body.__failAt } : {});

  app.get('/api/health', (req, res) => ok(res, { status: 'up' }));

  app.get('/api/meta', (req, res) => {
    ok(res, {
      stations: db.prepare('SELECT * FROM stations ORDER BY id').all(),
      shifts: db.prepare('SELECT * FROM shifts ORDER BY id').all(),
      users: db
        .prepare(
          `SELECT u.*, s.name AS station_name FROM users u JOIN stations s ON s.id = u.station_id ORDER BY u.id`
        )
        .all(),
      devices: db.prepare('SELECT * FROM devices ORDER BY station_id, code').all(),
      checkItems: db.prepare('SELECT * FROM check_items ORDER BY device_type, seq').all(),
    });
  });

  // 生成巡检任务（幂等）
  app.post('/api/plans/generate', (req, res) => {
    const { station_id, shift_id, plan_date } = req.body || {};
    if (!station_id || !shift_id || !/^\d{4}-\d{2}-\d{2}$/.test(plan_date || '')) {
      throw new HttpError(400, 'BAD_PARAMS', '参数不完整：需要 station_id、shift_id、plan_date(YYYY-MM-DD)');
    }
    ok(res, generatePlan(db, req.user, { stationId: station_id, shiftId: shift_id, planDate: plan_date }, hooksOf(req)));
  });

  app.get('/api/plans', (req, res) => {
    const { station_id, plan_date } = req.query;
    const rows = db
      .prepare(
        `SELECT p.*, s.name AS station_name, sh.name AS shift_name,
                (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id) AS task_count,
                (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id AND t.status = 'completed') AS done_count
         FROM plans p JOIN stations s ON s.id = p.station_id JOIN shifts sh ON sh.id = p.shift_id
         WHERE (? IS NULL OR p.station_id = ?) AND (? IS NULL OR p.plan_date = ?)
         ORDER BY p.plan_date DESC, p.id DESC`
      )
      .all(station_id || null, station_id || null, plan_date || null, plan_date || null);
    ok(res, rows);
  });

  app.get('/api/tasks', (req, res) => {
    const planId = Number(req.query.plan_id);
    if (!planId) throw new HttpError(400, 'BAD_PARAMS', '缺少 plan_id');
    ok(res, listTasksOfPlan(db, planId));
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = getTaskJoined(db, Number(req.params.id));
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    const items = db.prepare('SELECT * FROM check_items WHERE device_type = ? ORDER BY seq').all(task.device_type);
    const results = db.prepare('SELECT * FROM inspection_results WHERE task_id = ? ORDER BY id').all(task.id);
    const anomaly = db.prepare('SELECT * FROM anomalies WHERE task_id = ?').get(task.id) || null;
    ok(res, { task, items, results, anomaly });
  });

  app.post('/api/tasks/:id/claim', (req, res) => ok(res, claimTask(db, req.user, Number(req.params.id))));
  app.post('/api/tasks/:id/start', (req, res) => ok(res, startTask(db, req.user, Number(req.params.id))));
  app.post('/api/tasks/:id/submit', (req, res) => {
    const { results, idempotency_key } = req.body || {};
    ok(res, submitInspection(db, req.user, Number(req.params.id), { results, idempotencyKey: idempotency_key }, hooksOf(req)));
  });

  app.get('/api/anomalies', (req, res) => {
    const { station_id, status } = req.query;
    ok(
      res,
      db
        .prepare(
          `SELECT a.*, d.name AS device_name, d.code AS device_code, u.name AS responsible_name, h.name AS handler_name
           FROM anomalies a
           JOIN devices d ON d.id = a.device_id
           LEFT JOIN users u ON u.id = a.responsible_id
           LEFT JOIN users h ON h.id = a.handler_id
           WHERE (? IS NULL OR a.station_id = ?) AND (? IS NULL OR a.status = ?)
           ORDER BY a.status = 'closed', a.id DESC`
        )
        .all(station_id || null, station_id || null, status || null, status || null)
    );
  });

  app.get('/api/anomalies/:id', (req, res) => {
    const a = db
      .prepare(
        `SELECT a.*, d.name AS device_name, d.code AS device_code, u.name AS responsible_name, h.name AS handler_name
         FROM anomalies a
         JOIN devices d ON d.id = a.device_id
         LEFT JOIN users u ON u.id = a.responsible_id
         LEFT JOIN users h ON h.id = a.handler_id
         WHERE a.id = ?`
      )
      .get(Number(req.params.id));
    if (!a) throw new HttpError(404, 'ANOMALY_NOT_FOUND', '异常单不存在');
    const rechecks = db
      .prepare(
        `SELECT r.*, u.name AS created_by_name FROM anomaly_rechecks r
         LEFT JOIN users u ON u.id = r.created_by WHERE r.anomaly_id = ? ORDER BY r.id`
      )
      .all(a.id);
    const results = db.prepare('SELECT * FROM inspection_results WHERE task_id = ? ORDER BY id').all(a.task_id);
    ok(res, { anomaly: a, rechecks, results });
  });

  app.post('/api/anomalies/:id/handle', (req, res) =>
    ok(res, handleAnomaly(db, req.user, Number(req.params.id), req.body || {}))
  );
  app.post('/api/anomalies/:id/recheck', (req, res) =>
    ok(res, recheckAnomaly(db, req.user, Number(req.params.id), req.body || {}))
  );

  // 轨迹回看
  app.get('/api/trail', (req, res) => {
    const { station_id, entity_type, entity_id } = req.query;
    ok(
      res,
      db
        .prepare(
          `SELECT * FROM audit_trail
           WHERE (? IS NULL OR station_id = ?)
             AND (? IS NULL OR entity_type = ?)
             AND (? IS NULL OR entity_id = ?)
           ORDER BY id DESC LIMIT 200`
        )
        .all(
          station_id || null,
          station_id || null,
          entity_type || null,
          entity_type || null,
          entity_id ? Number(entity_id) : null,
          entity_id ? Number(entity_id) : null
        )
    );
  });

  // 生产模式：托管前端构建产物
  const dist = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // 统一错误处理：HttpError → 对应状态码；其余 → 500
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    console.error(err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  return { app, db };
}
