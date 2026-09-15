import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

// 端到端测试：启动真实 HTTP 服务 + 真实 SQLite 事务，走通关键流程
let server;
let base;
let db;

// 种子数据：1 张安全(主管,ST01) 2 李巡检(ST01) 3 王巡检(ST01) 4 赵安全(主管,ST02) 5 钱巡检(ST02)
const ZHANG = 1, LI = 2, WANG = 3, ZHAO = 4, QIAN = 5;
const DATE = '2026-09-15';

async function req(method, path, { user, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'X-User-Id': String(user) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  const created = createApp({ dbPath: ':memory:', testHooks: true });
  db = created.db;
  await new Promise((resolve) => {
    server = created.app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('生成任务：权限与跨站拦截', async () => {
  // 巡检员无权生成
  let r = await req('POST', '/api/plans/generate', { user: LI, body: { station_id: 1, shift_id: 1, plan_date: DATE } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'ONLY_SUPERVISOR');

  // 跨站生成被拒绝
  r = await req('POST', '/api/plans/generate', { user: ZHAO, body: { station_id: 1, shift_id: 1, plan_date: DATE } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'CROSS_STATION');

  // 未选择身份
  r = await req('POST', '/api/plans/generate', { body: { station_id: 1, shift_id: 1, plan_date: DATE } });
  assert.equal(r.status, 401);
});

test('生成任务：写入中途失败整体回滚，不留半条计划', async () => {
  const r = await req('POST', '/api/plans/generate', {
    user: ZHANG,
    body: { station_id: 1, shift_id: 1, plan_date: DATE, __failAt: 'tasks' },
  });
  assert.equal(r.status, 500);
  // 回滚验证：计划与任务都不存在
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plans').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
});

let planId, fuelTask, fuelTask2;
test('生成任务：成功后重复生成幂等（刷新安全）', async () => {
  let r = await req('POST', '/api/plans/generate', { user: ZHANG, body: { station_id: 1, shift_id: 1, plan_date: DATE } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.created, true);
  assert.equal(r.json.data.tasks.length, 4); // ST01 四台设备
  planId = r.json.data.plan.id;
  const fuels = r.json.data.tasks.filter((t) => t.device_type === 'fuel_dispenser');
  [fuelTask, fuelTask2] = fuels;

  // 模拟刷新后重复点击：返回同一计划，不产生重复任务
  r = await req('POST', '/api/plans/generate', { user: ZHANG, body: { station_id: 1, shift_id: 1, plan_date: DATE } });
  assert.equal(r.json.data.created, false);
  assert.equal(r.json.data.plan.id, planId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE plan_id = ?').get(planId).n, 4);
});

// 拉取该任务的检查项模板并构造结果（与前端行为一致）
async function buildResults(taskId, failIndexes = []) {
  const r = await req('GET', `/api/tasks/${taskId}`, { user: LI });
  return r.json.data.items.map((it, i) => ({
    check_item_id: it.id,
    result: failIndexes.includes(i) ? 'fail' : 'pass',
    ...(failIndexes.includes(i) ? { note: `「${it.item_name}」现场不合格` } : {}),
  }));
}

test('领取：跨站拒绝、重复领取拒绝、一台设备同一时段仅一人', async () => {
  // 跨站领取
  let r = await req('POST', `/api/tasks/${fuelTask.id}/claim`, { user: QIAN });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'CROSS_STATION');

  // 正常领取
  r = await req('POST', `/api/tasks/${fuelTask.id}/claim`, { user: LI });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.status, 'claimed');

  // 他人重复领取 → 409
  r = await req('POST', `/api/tasks/${fuelTask.id}/claim`, { user: WANG });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'TASK_ALREADY_CLAIMED');

  // 本人重复领取同样被拒绝（状态已非 pending）
  r = await req('POST', `/api/tasks/${fuelTask.id}/claim`, { user: LI });
  assert.equal(r.status, 409);

  // 李巡检再领一台（用于全合格流程）
  r = await req('POST', `/api/tasks/${fuelTask2.id}/claim`, { user: LI });
  assert.equal(r.status, 200);
});

test('开始巡检：非领取人拒绝，开始后计划锁定', async () => {
  let r = await req('POST', `/api/tasks/${fuelTask.id}/start`, { user: WANG });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'NOT_CLAIMER');

  r = await req('POST', `/api/tasks/${fuelTask.id}/start`, { user: LI });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.status, 'in_progress');

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  assert.equal(plan.status, 'locked');

  // 锁定后重复生成仍幂等，任务清单不变
  r = await req('POST', '/api/plans/generate', { user: ZHANG, body: { station_id: 1, shift_id: 1, plan_date: DATE } });
  assert.equal(r.json.data.created, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE plan_id = ?').get(planId).n, 4);
});

test('提交巡检：写入中途失败整体回滚，不留半条结果/异常', async () => {
  const results = await buildResults(fuelTask.id, [0]);
  const r = await req('POST', `/api/tasks/${fuelTask.id}/submit`, {
    user: LI,
    body: { results, idempotency_key: 'k-fail', __failAt: 'results' },
  });
  assert.equal(r.status, 500);
  // 回滚验证：任务仍在巡检中、无结果、无异常单
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(fuelTask.id).status, 'in_progress');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inspection_results').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM anomalies').get().n, 0);
});

let anomalyId;
test('提交巡检：不合格生成唯一异常单，幂等重试不重复', async () => {
  const results = await buildResults(fuelTask.id, [0, 1]);
  const r = await req('POST', `/api/tasks/${fuelTask.id}/submit`, {
    user: LI,
    body: { results, idempotency_key: 'k-1' },
  });
  assert.equal(r.status, 200);
  anomalyId = r.json.data.anomalyId;
  assert.ok(anomalyId > 0);
  assert.equal(r.json.data.failedCount, 2);

  // 异常单字段：等级1、待处理、责任人=本站安全主管、复检期限≈24h
  const a = db.prepare('SELECT * FROM anomalies WHERE id = ?').get(anomalyId);
  assert.equal(a.level, 1);
  assert.equal(a.status, 'open');
  assert.equal(a.responsible_id, ZHANG);
  const hours = (new Date(a.recheck_deadline) - new Date(a.created_at)) / 3600e3;
  assert.ok(Math.abs(hours - 24) < 0.01);

  // 同一幂等键重试（模拟提交后刷新）→ 相同响应，不产生第二张异常单
  const retry = await req('POST', `/api/tasks/${fuelTask.id}/submit`, {
    user: LI,
    body: { results, idempotency_key: 'k-1' },
  });
  assert.equal(retry.json.data.anomalyId, anomalyId);
  assert.equal(retry.json.data.idempotentReplay, true);

  // 换幂等键重复提交已完成任务 → 只读返回，仍只有一张异常单
  const again = await req('POST', `/api/tasks/${fuelTask.id}/submit`, {
    user: LI,
    body: { results, idempotency_key: 'k-2' },
  });
  assert.equal(again.json.data.alreadyCompleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM anomalies WHERE task_id = ?').get(fuelTask.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inspection_results WHERE task_id = ?').get(fuelTask.id).n, 4);
});

test('提交巡检：全部合格不产生异常单', async () => {
  await req('POST', `/api/tasks/${fuelTask2.id}/start`, { user: LI });
  const results = await buildResults(fuelTask2.id);
  const r = await req('POST', `/api/tasks/${fuelTask2.id}/submit`, {
    user: LI,
    body: { results, idempotency_key: 'k-pass' },
  });
  assert.equal(r.json.data.anomalyId, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM anomalies').get().n, 1); // 仍只有上一张
});

test('异常处理：跨站拒绝，处理→复检不通过→升级→再处理→复检通过→关闭', async () => {
  // 跨站处理被拒绝
  let r = await req('POST', `/api/anomalies/${anomalyId}/handle`, { user: QIAN, body: { action: 'start' } });
  assert.equal(r.status, 403);

  // 开始处理 → 处理中
  r = await req('POST', `/api/anomalies/${anomalyId}/handle`, { user: ZHANG, body: { action: 'start', note: '安排维修班' } });
  assert.equal(r.json.data.status, 'processing');

  // 状态机守卫：处理中不能重复开始
  r = await req('POST', `/api/anomalies/${anomalyId}/handle`, { user: ZHANG, body: { action: 'start' } });
  assert.equal(r.status, 409);

  // 处理完成 → 待复检
  r = await req('POST', `/api/anomalies/${anomalyId}/handle`, { user: ZHANG, body: { action: 'complete', note: '已更换油枪密封圈' } });
  assert.equal(r.json.data.status, 'recheck_pending');

  // 复检不通过 → 升级：Lv2、状态 escalated、期限收紧
  r = await req('POST', `/api/anomalies/${anomalyId}/recheck`, { user: LI, body: { result: 'fail', note: '仍渗漏' } });
  assert.equal(r.json.data.status, 'escalated');
  assert.equal(r.json.data.level, 2);

  // 升级后重新处理
  r = await req('POST', `/api/anomalies/${anomalyId}/handle`, { user: ZHANG, body: { action: 'start' } });
  assert.equal(r.json.data.status, 'processing');
  r = await req('POST', `/api/anomalies/${anomalyId}/handle`, { user: ZHANG, body: { action: 'complete' } });
  assert.equal(r.json.data.status, 'recheck_pending');

  // 复检通过 → 关闭
  r = await req('POST', `/api/anomalies/${anomalyId}/recheck`, { user: LI, body: { result: 'pass', note: '复测合格' } });
  assert.equal(r.json.data.status, 'closed');
  assert.ok(r.json.data.closed_at);

  // 关闭后不可再操作
  r = await req('POST', `/api/anomalies/${anomalyId}/handle`, { user: ZHANG, body: { action: 'start' } });
  assert.equal(r.status, 409);
});

test('轨迹：完整留痕且顺序正确', async () => {
  // 任务轨迹
  let r = await req('GET', `/api/trail?entity_type=task&entity_id=${fuelTask.id}`, { user: ZHANG });
  const taskActions = r.json.data.map((e) => e.action).reverse();
  assert.deepEqual(taskActions, ['task.claimed', 'task.started', 'task.completed']);

  // 异常单轨迹：创建→处理→待复检→升级→再处理→待复检→关闭
  r = await req('GET', `/api/trail?entity_type=anomaly&entity_id=${anomalyId}`, { user: ZHANG });
  const anomalyActions = r.json.data.map((e) => e.action).reverse();
  assert.deepEqual(anomalyActions, [
    'anomaly.created',
    'anomaly.handle_started',
    'anomaly.fix_submitted',
    'anomaly.escalated',
    'anomaly.handle_started',
    'anomaly.fix_submitted',
    'anomaly.closed',
  ]);

  // 计划轨迹：生成 + 锁定
  r = await req('GET', `/api/trail?entity_type=plan&entity_id=${planId}`, { user: ZHANG });
  const planActions = r.json.data.map((e) => e.action).reverse();
  assert.deepEqual(planActions, ['plan.generated', 'plan.locked']);

  // 复检记录完整
  const rechecks = db.prepare('SELECT * FROM anomaly_rechecks WHERE anomaly_id = ? ORDER BY id').all(anomalyId);
  assert.deepEqual(rechecks.map((x) => x.result), ['fail', 'pass']);
});

test('跨站读取：计划/任务/异常/轨迹均按站点归属拒绝', async () => {
  // 城西用户（钱巡检/赵安全）读取城东数据 → 一律 403
  for (const user of [QIAN, ZHAO]) {
    let r = await req('GET', '/api/plans?station_id=1', { user });
    assert.equal(r.status, 403, 'plans 跨站应拒绝');
    assert.equal(r.json.error.code, 'CROSS_STATION');

    r = await req('GET', `/api/tasks?plan_id=${planId}`, { user });
    assert.equal(r.status, 403, 'tasks 跨站应拒绝');

    r = await req('GET', `/api/tasks/${fuelTask.id}`, { user });
    assert.equal(r.status, 403, 'task 详情跨站应拒绝');

    r = await req('GET', '/api/anomalies?station_id=1', { user });
    assert.equal(r.status, 403, 'anomalies 跨站应拒绝');

    r = await req('GET', `/api/anomalies/${anomalyId}`, { user });
    assert.equal(r.status, 403, 'anomaly 详情跨站应拒绝');

    r = await req('GET', '/api/trail?station_id=1', { user });
    assert.equal(r.status, 403, 'trail 跨站应拒绝');

    r = await req('GET', `/api/trail?entity_type=anomaly&entity_id=${anomalyId}`, { user });
    assert.equal(r.status, 403, 'trail 按对象跨站应拒绝');
  }

  // 不带站点参数 → 自动限定本站，不泄露他站数据
  let r = await req('GET', '/api/plans', { user: QIAN });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.every((p) => p.station_id === 2));

  r = await req('GET', '/api/anomalies', { user: QIAN });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.every((a) => a.station_id === 2));

  r = await req('GET', '/api/trail', { user: QIAN });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.every((e) => e.station_id === 2));

  // 本站读取不受影响
  r = await req('GET', '/api/plans?station_id=1', { user: LI });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.length > 0);

  r = await req('GET', `/api/tasks?plan_id=${planId}`, { user: WANG });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.length, 4);

  r = await req('GET', `/api/anomalies/${anomalyId}`, { user: LI });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.anomaly.status, 'closed');

  r = await req('GET', `/api/trail?entity_type=task&entity_id=${fuelTask.id}`, { user: ZHANG });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.length >= 3);
});
