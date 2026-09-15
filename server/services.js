// 业务逻辑层：所有多步写入均包裹在 better-sqlite3 事务中，
// 任一步失败整体回滚，不会留下半条任务或异常记录。

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const plusHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

function audit(db, { stationId = null, entityType, entityId, action, actor, detail = null }) {
  db.prepare(
    `INSERT INTO audit_trail (station_id, entity_type, entity_id, action, actor_id, actor_name, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    stationId,
    entityType,
    entityId,
    action,
    actor ? actor.id : null,
    actor ? actor.name : null,
    detail ? JSON.stringify(detail) : null,
    now()
  );
}

export function getTaskJoined(db, taskId) {
  return db
    .prepare(
      `SELECT t.*, p.station_id, p.shift_id, p.plan_date, p.status AS plan_status,
              d.name AS device_name, d.code AS device_code, d.type AS device_type
       FROM tasks t
       JOIN plans p ON p.id = t.plan_id
       JOIN devices d ON d.id = t.device_id
       WHERE t.id = ?`
    )
    .get(taskId);
}

export function listTasksOfPlan(db, planId) {
  return db
    .prepare(
      `SELECT t.id, t.plan_id, t.device_id, t.status, t.claimed_by, t.claimed_at,
              t.started_at, t.completed_at,
              d.code AS device_code, d.name AS device_name, d.type AS device_type,
              u.name AS claimed_by_name,
              a.id AS anomaly_id, a.status AS anomaly_status
       FROM tasks t
       JOIN devices d ON d.id = t.device_id
       LEFT JOIN users u ON u.id = t.claimed_by
       LEFT JOIN anomalies a ON a.task_id = t.id
       WHERE t.plan_id = ?
       ORDER BY d.code`
    )
    .all(planId);
}

// ---------- 生成巡检计划（幂等：站点+班次+日期唯一） ----------
export function generatePlan(db, user, { stationId, shiftId, planDate }, hooks = {}) {
  if (user.role !== 'supervisor') throw new HttpError(403, 'ONLY_SUPERVISOR', '只有安全主管可以生成巡检任务');
  if (user.station_id !== stationId) throw new HttpError(403, 'CROSS_STATION', '不能跨站操作：只能为本站点生成任务');

  const tx = db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM plans WHERE station_id = ? AND shift_id = ? AND plan_date = ?')
      .get(stationId, shiftId, planDate);
    if (existing) {
      // 幂等返回：重复生成/刷新不会产生重复任务
      return { plan: existing, created: false, tasks: listTasksOfPlan(db, existing.id) };
    }
    const info = db
      .prepare(
        `INSERT INTO plans (station_id, shift_id, plan_date, status, created_by, created_at)
         VALUES (?,?,?,'open',?,?)`
      )
      .run(stationId, shiftId, planDate, user.id, now());
    const planId = Number(info.lastInsertRowid);

    const devices = db.prepare('SELECT * FROM devices WHERE station_id = ? ORDER BY code').all(stationId);
    if (devices.length === 0) throw new HttpError(400, 'NO_DEVICES', '该站点没有可巡检设备');

    const ins = db.prepare(`INSERT INTO tasks (plan_id, device_id, status) VALUES (?,?,'pending')`);
    for (const d of devices) ins.run(planId, d.id);

    if (hooks.failAt === 'tasks') throw new Error('INJECTED_FAILURE_AFTER_TASKS');

    audit(db, {
      stationId,
      entityType: 'plan',
      entityId: planId,
      action: 'plan.generated',
      actor: user,
      detail: { shift_id: shiftId, plan_date: planDate, task_count: devices.length },
    });
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    return { plan, created: true, tasks: listTasksOfPlan(db, planId) };
  });
  return tx();
}

// ---------- 领取任务（原子条件更新：一台设备同一时段只能被一人领取） ----------
export function claimTask(db, user, taskId) {
  const tx = db.transaction(() => {
    const task = getTaskJoined(db, taskId);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    if (task.station_id !== user.station_id) throw new HttpError(403, 'CROSS_STATION', '不能跨站操作：该任务属于其他站点');

    const r = db
      .prepare(
        `UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?
         WHERE id = ? AND status = 'pending' AND claimed_by IS NULL`
      )
      .run(user.id, now(), taskId);
    if (r.changes === 0) {
      throw new HttpError(409, 'TASK_ALREADY_CLAIMED', '该设备任务已被领取，同一时段只能由一人巡检');
    }
    audit(db, {
      stationId: task.station_id,
      entityType: 'task',
      entityId: taskId,
      action: 'task.claimed',
      actor: user,
      detail: { device: task.device_name, plan_date: task.plan_date },
    });
    return getTaskJoined(db, taskId);
  });
  return tx();
}

// ---------- 开始巡检（锁定计划） ----------
export function startTask(db, user, taskId) {
  const tx = db.transaction(() => {
    const task = getTaskJoined(db, taskId);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    if (task.station_id !== user.station_id) throw new HttpError(403, 'CROSS_STATION', '不能跨站操作：该任务属于其他站点');
    if (task.claimed_by !== user.id) throw new HttpError(403, 'NOT_CLAIMER', '只有领取人才能开始巡检');

    const r = db
      .prepare(`UPDATE tasks SET status = 'in_progress', started_at = ? WHERE id = ? AND status = 'claimed'`)
      .run(now(), taskId);
    if (r.changes === 0) throw new HttpError(409, 'BAD_STATUS', '任务状态不允许开始巡检');

    // 巡检开始后锁定计划：任务清单冻结，不可再变更
    const lock = db.prepare(`UPDATE plans SET status = 'locked' WHERE id = ? AND status = 'open'`).run(task.plan_id);
    if (lock.changes > 0) {
      audit(db, {
        stationId: task.station_id,
        entityType: 'plan',
        entityId: task.plan_id,
        action: 'plan.locked',
        actor: user,
        detail: { reason: '巡检开始，计划锁定' },
      });
    }
    audit(db, {
      stationId: task.station_id,
      entityType: 'task',
      entityId: taskId,
      action: 'task.started',
      actor: user,
      detail: { device: task.device_name },
    });
    return getTaskJoined(db, taskId);
  });
  return tx();
}

// ---------- 提交巡检结果（事务 + 幂等键；不合格项只生成一张异常单） ----------
export function submitInspection(db, user, taskId, { results, idempotencyKey }, hooks = {}) {
  if (!idempotencyKey) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键');

  // 命中幂等键：直接返回首次提交的响应（刷新/重试安全，不再校验请求体）
  const hit = db.prepare('SELECT response_json FROM idempotency_keys WHERE key = ?').get(idempotencyKey);
  if (hit) return { ...JSON.parse(hit.response_json), idempotentReplay: true };

  if (!Array.isArray(results) || results.length === 0) {
    throw new HttpError(400, 'RESULTS_REQUIRED', '巡检结果不能为空');
  }

  const tx = db.transaction(() => {
    const task = getTaskJoined(db, taskId);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    if (task.station_id !== user.station_id) throw new HttpError(403, 'CROSS_STATION', '不能跨站操作：该任务属于其他站点');

    if (task.status === 'completed') {
      // 已完成的任务是只读的：重复提交返回现状，不产生新数据
      const anomaly = db.prepare('SELECT id FROM anomalies WHERE task_id = ?').get(taskId);
      const response = {
        taskId,
        status: 'completed',
        alreadyCompleted: true,
        anomalyId: anomaly ? anomaly.id : null,
      };
      db.prepare(
        `INSERT INTO idempotency_keys (key, user_id, endpoint, response_json, created_at) VALUES (?,?,?,?,?)`
      ).run(idempotencyKey, user.id, 'submit', JSON.stringify(response), now());
      return response;
    }
    if (task.status !== 'in_progress') throw new HttpError(409, 'BAD_STATUS', '任务未处于巡检中状态');
    if (task.claimed_by !== user.id) throw new HttpError(403, 'NOT_CLAIMER', '只有领取人才能提交巡检结果');

    // 校验：必须覆盖该设备类型的全部检查项
    const items = db.prepare('SELECT * FROM check_items WHERE device_type = ? ORDER BY seq').all(task.device_type);
    const byId = new Map(results.map((r) => [r.check_item_id, r]));
    for (const it of items) {
      const r = byId.get(it.id);
      if (!r || (r.result !== 'pass' && r.result !== 'fail')) {
        throw new HttpError(400, 'INCOMPLETE_RESULTS', `检查项「${it.item_name}」缺少合格/不合格结论`);
      }
    }

    const ts = now();
    const insR = db.prepare(
      `INSERT INTO inspection_results (task_id, check_item_id, item_name, result, note, created_at)
       VALUES (?,?,?,?,?,?)`
    );
    for (const it of items) {
      const r = byId.get(it.id);
      insR.run(taskId, it.id, it.item_name, r.result, r.note ? String(r.note) : null, ts);
    }

    if (hooks.failAt === 'results') throw new Error('INJECTED_FAILURE_AFTER_RESULTS');

    db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).run(ts, taskId);
    audit(db, {
      stationId: task.station_id,
      entityType: 'task',
      entityId: taskId,
      action: 'task.completed',
      actor: user,
      detail: { device: task.device_name, fail_count: results.filter((r) => r.result === 'fail').length },
    });

    // 不合格 → 生成唯一异常单（task_id 唯一约束兜底，重复提交不会出第二张）
    const fails = items.filter((it) => byId.get(it.id).result === 'fail');
    let anomalyId = null;
    if (fails.length > 0) {
      const responsible =
        db.prepare(`SELECT id FROM users WHERE station_id = ? AND role = 'supervisor' ORDER BY id LIMIT 1`).get(task.station_id) ||
        { id: user.id };
      const title = `【${task.device_name}】巡检异常（${fails.length}项不合格）`;
      const description = fails
        .map((it) => {
          const note = byId.get(it.id).note;
          return `· ${it.item_name}（标准：${it.standard}）${note ? ' — ' + note : ''}`;
        })
        .join('\n');
      const info = db
        .prepare(
          `INSERT INTO anomalies
             (task_id, plan_id, station_id, device_id, title, description, level, status,
              responsible_id, recheck_deadline, created_at, updated_at)
           VALUES (?,?,?,?,?,?,1,'open',?,?,?,?)
           ON CONFLICT (task_id) DO NOTHING`
        )
        .run(taskId, task.plan_id, task.station_id, task.device_id, title, description, responsible.id, plusHours(24), ts, ts);
      anomalyId = Number(
        (info.changes > 0 ? info.lastInsertRowid : db.prepare('SELECT id FROM anomalies WHERE task_id = ?').get(taskId).id)
      );
      if (info.changes > 0) {
        audit(db, {
          stationId: task.station_id,
          entityType: 'anomaly',
          entityId: anomalyId,
          action: 'anomaly.created',
          actor: user,
          detail: { device: task.device_name, fail_count: fails.length, recheck_deadline: plusHours(24) },
        });
      }
    }

    const response = { taskId, status: 'completed', anomalyId, failedCount: fails.length };
    db.prepare(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, response_json, created_at) VALUES (?,?,?,?,?)`
    ).run(idempotencyKey, user.id, 'submit', JSON.stringify(response), now());
    return response;
  });
  return tx();
}

// ---------- 异常处理：开始处理 / 处理完成 ----------
export function handleAnomaly(db, user, anomalyId, { action, note }) {
  const tx = db.transaction(() => {
    const a = db.prepare('SELECT * FROM anomalies WHERE id = ?').get(anomalyId);
    if (!a) throw new HttpError(404, 'ANOMALY_NOT_FOUND', '异常单不存在');
    if (a.station_id !== user.station_id) throw new HttpError(403, 'CROSS_STATION', '不能跨站操作：该异常单属于其他站点');

    const ts = now();
    if (action === 'start') {
      const r = db
        .prepare(
          `UPDATE anomalies SET status = 'processing', handler_id = ?, updated_at = ?
           WHERE id = ? AND status IN ('open','escalated')`
        )
        .run(user.id, ts, anomalyId);
      if (r.changes === 0) throw new HttpError(409, 'BAD_STATUS', '当前状态不允许开始处理');
      audit(db, {
        stationId: a.station_id,
        entityType: 'anomaly',
        entityId: anomalyId,
        action: 'anomaly.handle_started',
        actor: user,
        detail: { level: a.level, note: note || null },
      });
    } else if (action === 'complete') {
      const r = db
        .prepare(
          `UPDATE anomalies SET status = 'recheck_pending', updated_at = ? WHERE id = ? AND status = 'processing'`
        )
        .run(ts, anomalyId);
      if (r.changes === 0) throw new HttpError(409, 'BAD_STATUS', '当前状态不允许提交处理结果');
      audit(db, {
        stationId: a.station_id,
        entityType: 'anomaly',
        entityId: anomalyId,
        action: 'anomaly.fix_submitted',
        actor: user,
        detail: { note: note || null },
      });
    } else {
      throw new HttpError(400, 'BAD_ACTION', '不支持的处理动作');
    }
    return db.prepare('SELECT * FROM anomalies WHERE id = ?').get(anomalyId);
  });
  return tx();
}

// ---------- 复检：通过关闭 / 不通过升级 ----------
export function recheckAnomaly(db, user, anomalyId, { result, note }) {
  if (result !== 'pass' && result !== 'fail') throw new HttpError(400, 'BAD_RESULT', '复检结论必须为 pass 或 fail');
  const tx = db.transaction(() => {
    const a = db.prepare('SELECT * FROM anomalies WHERE id = ?').get(anomalyId);
    if (!a) throw new HttpError(404, 'ANOMALY_NOT_FOUND', '异常单不存在');
    if (a.station_id !== user.station_id) throw new HttpError(403, 'CROSS_STATION', '不能跨站操作：该异常单属于其他站点');

    const ts = now();
    db.prepare(
      `INSERT INTO anomaly_rechecks (anomaly_id, result, note, created_by, created_at) VALUES (?,?,?,?,?)`
    ).run(anomalyId, result, note ? String(note) : null, user.id, ts);

    if (result === 'pass') {
      const r = db
        .prepare(
          `UPDATE anomalies SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'recheck_pending'`
        )
        .run(ts, ts, anomalyId);
      if (r.changes === 0) throw new HttpError(409, 'BAD_STATUS', '当前状态不允许复检');
      audit(db, {
        stationId: a.station_id,
        entityType: 'anomaly',
        entityId: anomalyId,
        action: 'anomaly.closed',
        actor: user,
        detail: { note: note || null },
      });
    } else {
      // 复检未通过 → 升级：等级+1、状态转为 escalated、复检期限收紧
      const newDeadline = plusHours(12);
      const r = db
        .prepare(
          `UPDATE anomalies SET status = 'escalated', level = level + 1, recheck_deadline = ?, updated_at = ?
           WHERE id = ? AND status = 'recheck_pending'`
        )
        .run(newDeadline, ts, anomalyId);
      if (r.changes === 0) throw new HttpError(409, 'BAD_STATUS', '当前状态不允许复检');
      audit(db, {
        stationId: a.station_id,
        entityType: 'anomaly',
        entityId: anomalyId,
        action: 'anomaly.escalated',
        actor: user,
        detail: { new_level: a.level + 1, new_deadline: newDeadline, note: note || null },
      });
    }
    return db.prepare('SELECT * FROM anomalies WHERE id = ?').get(anomalyId);
  });
  return tx();
}
