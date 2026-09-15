# 油站设备巡检异常闭环

面向油站安全主管与巡检员的设备巡检闭环系统：按站点和班次生成巡检任务 → 领取/开始巡检 → 提交检查结果 → 不合格项自动生成唯一异常单 → 处理/复检 → 复检不通过自动升级 → 全程轨迹留痕。

## 技术栈

- 前端：Vue 3 + Vite + TypeScript + Element Plus
- 后端：Node.js + Express + better-sqlite3（WAL 模式，真实事务）
- 测试：node:test 端到端测试（真实 HTTP + 真实 SQLite 事务）

## 快速开始

```bash
npm install
npm run build     # 构建前端到 dist/
npm start         # 启动服务 http://localhost:3001（API + 托管前端）
```

开发模式（前后端热更新）：

```bash
npm run server    # 后端 :3001
npm run dev       # 前端 :5173，/api 自动代理到 3001
```

运行端到端测试（真实操作走通关键流程，Node ≥ 20）：

```bash
npm test
```

> 运行时数据库 `data/app.db` 在首次启动时自动创建并写入种子数据，该目录已加入 `.gitignore`，不随项目交付。

## 种子数据

- 站点：城东加油站(ST01)、城西加油站(ST02)；班次：早/中/夜班
- 账号（页面右上角切换身份）：
  - 张安全（主管·城东）、李巡检/王巡检（巡检·城东）
  - 赵安全（主管·城西）、钱巡检（巡检·城西）
- 设备：加油机、储油罐区、油气回收装置，各配检查项模板

## 业务规则与实现机制

| 需求 | 实现 |
| --- | --- |
| 按站点+班次生成任务 | `plans` 表 `(station_id, shift_id, plan_date)` 唯一约束，重复生成幂等返回现有计划，刷新不产生重复任务 |
| 一台设备同一时段只能一人领取 | 任务按 `(plan_id, device_id)` 唯一；领取为原子条件更新 `UPDATE ... WHERE status='pending' AND claimed_by IS NULL`，重复领取返回 409 |
| 跨站操作拒绝 | 所有写操作校验操作人站点与资源站点一致，不一致返回 403 |
| 跨站读取拒绝 | 所有读接口（计划/任务/异常/轨迹）按站点归属隔离：显式请求他站数据返回 403，未指定站点时自动限定本站 |
| 巡检开始后锁定计划 | 首个任务开始时计划置为 `locked`，任务清单冻结 |
| 不合格只生成一张异常单 | `anomalies.task_id` 唯一约束 + `ON CONFLICT DO NOTHING`；多项不合格汇总进同一张单，记录复检期限（默认 24h）与责任人（本站安全主管） |
| 复检未通过升级 | 状态机 `open→processing→recheck_pending→closed`；复检失败 → `escalated`、等级+1、期限收紧至 12h，可再次处理 |
| 写入失败不留半条记录 | 所有多步写入包裹在 SQLite 事务中，任一步失败整体回滚（测试用故障注入验证） |
| 刷新不重复提交 | 提交携带幂等键（前端每次打开表单生成 UUID），命中已存键直接回放首次响应 |
| 完整轨迹 | `audit_trail` 记录每个动作（生成/锁定/领取/开始/完成/异常/升级/关闭），轨迹回看页按站点/对象筛选 |

## 页面

- **巡检任务**：按站点/日期/班次查看计划与任务，主管生成任务，巡检员领取、开始、逐项提交检查结果
- **异常工单**：异常单列表（等级/状态/复检期限/责任人），开始处理、处理完成、复检（通过关闭 / 不通过升级），详情含复检记录
- **轨迹回看**：计划/任务/异常单的全量操作时间线

## API 概览

```
GET  /api/meta                      基础数据（站点/班次/人员/设备/检查项）
POST /api/plans/generate            生成巡检任务（幂等）
GET  /api/plans                     计划列表
GET  /api/tasks?plan_id=            任务列表
POST /api/tasks/:id/claim           领取（原子互斥）
POST /api/tasks/:id/start           开始巡检（锁定计划）
POST /api/tasks/:id/submit          提交巡检（事务+幂等键，不合格生成唯一异常单）
GET  /api/anomalies                 异常单列表
POST /api/anomalies/:id/handle      处理（start/complete）
POST /api/anomalies/:id/recheck     复检（pass 关闭 / fail 升级）
GET  /api/trail                     轨迹回看
```

身份通过 `X-User-Id` 请求头标识（本地演示简化认证）。
