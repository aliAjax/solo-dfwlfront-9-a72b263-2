<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { Ref } from 'vue';
import { api, ApiError } from '../api';
import type { CheckItem, Meta, Plan, Task, User } from '../types';

const emit = defineEmits<{ (e: 'view-trail', entityType: string, entityId: number): void }>();

const meta = inject<Ref<Meta | null>>('meta')!;
const currentUser = inject<Ref<User | null>>('currentUser')!;

const today = new Date().toISOString().slice(0, 10);
const stationId = ref<number>(currentUser.value?.station_id ?? 1);
const planDate = ref(today);
const shiftId = ref<number>(1);

const plan = ref<Plan | null>(null);
const tasks = ref<Task[]>([]);
const loading = ref(false);
const generating = ref(false);

const isSupervisor = computed(() => currentUser.value?.role === 'supervisor');
const myStation = computed(() => currentUser.value?.station_id);

const taskStatus = {
  pending: { label: '待领取', type: 'info' as const },
  claimed: { label: '已领取', type: 'warning' as const },
  in_progress: { label: '巡检中', type: 'primary' as const },
  completed: { label: '已完成', type: 'success' as const },
};

async function refresh() {
  loading.value = true;
  try {
    const plans = await api.plans(stationId.value, planDate.value);
    const p = plans.find((x) => x.shift_id === shiftId.value) ?? null;
    plan.value = p;
    tasks.value = p ? await api.tasks(p.id) : [];
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function generate() {
  generating.value = true;
  try {
    const r = await api.generatePlan(stationId.value, shiftId.value, planDate.value);
    ElMessage.success(
      r.created
        ? `已生成 ${r.tasks.length} 台设备的巡检任务`
        : '该班次任务已存在，直接返回现有任务（未重复生成）',
    );
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    generating.value = false;
  }
}

async function doClaim(t: Task) {
  try {
    await api.claim(t.id);
    ElMessage.success(`已领取「${t.device_name}」`);
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
    await refresh();
  }
}

async function doStart(t: Task) {
  try {
    await api.start(t.id);
    ElMessage.success('巡检开始，计划已锁定');
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

// ---------- 提交巡检 ----------
const submitVisible = ref(false);
const submitTask = ref<Task | null>(null);
const submitItems = ref<(CheckItem & { result: 'pass' | 'fail' | null; note: string })[]>([]);
const submitting = ref(false);
const idemKey = ref('');

async function openSubmit(t: Task) {
  const detail = await api.taskDetail(t.id);
  submitTask.value = t;
  submitItems.value = detail.items.map((it) => ({ ...it, result: null, note: '' }));
  idemKey.value = crypto.randomUUID(); // 每次打开对话框生成幂等键：刷新/重试不会重复提交
  submitVisible.value = true;
}

const allAnswered = computed(() => submitItems.value.every((it) => it.result !== null));

async function doSubmit() {
  if (!submitTask.value || !allAnswered.value) return;
  submitting.value = true;
  try {
    const r = await api.submit(
      submitTask.value.id,
      submitItems.value.map((it) => ({ check_item_id: it.id, result: it.result!, note: it.note || undefined })),
      idemKey.value,
    );
    if (r.anomalyId) {
      ElMessage.warning(`巡检完成，${r.failedCount} 项不合格，已生成异常单 #${r.anomalyId}`);
    } else {
      ElMessage.success('巡检完成，全部合格');
    }
    submitVisible.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    submitting.value = false;
  }
}

// ---------- 查看已完成任务 ----------
const viewVisible = ref(false);
const viewData = ref<{ task: Task; results: { item_name: string; result: string; note: string | null }[] } | null>(null);

async function openView(t: Task) {
  const detail = await api.taskDetail(t.id);
  viewData.value = { task: t, results: detail.results };
  viewVisible.value = true;
}

function canClaim(t: Task) {
  return t.status === 'pending' && stationId.value === myStation.value;
}
function canStart(t: Task) {
  return t.status === 'claimed' && t.claimed_by === currentUser.value?.id;
}
function canSubmit(t: Task) {
  return t.status === 'in_progress' && t.claimed_by === currentUser.value?.id;
}

watch([stationId, planDate, shiftId], refresh);
onMounted(refresh);
</script>

<template>
  <div>
    <div class="toolbar">
      <el-select v-model="stationId" style="width: 160px" placeholder="站点">
        <el-option v-for="s in meta?.stations ?? []" :key="s.id" :value="s.id" :label="s.name" />
      </el-select>
      <el-date-picker v-model="planDate" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width: 160px" />
      <el-select v-model="shiftId" style="width: 130px" placeholder="班次">
        <el-option
          v-for="s in meta?.shifts ?? []"
          :key="s.id"
          :value="s.id"
          :label="`${s.name} ${s.start_time}-${s.end_time}`"
        />
      </el-select>
      <el-button
        v-if="isSupervisor"
        type="primary"
        :loading="generating"
        :disabled="stationId !== myStation"
        @click="generate"
      >
        生成巡检任务
      </el-button>
      <el-tag v-if="plan" :type="plan.status === 'locked' ? 'danger' : 'success'" effect="dark">
        计划{{ plan.status === 'locked' ? '已锁定' : '开放中' }} · 完成 {{ plan.done_count }}/{{ plan.task_count }}
      </el-tag>
      <el-tag v-else type="info">该班次尚未生成任务</el-tag>
    </div>

    <el-table :data="tasks" v-loading="loading" border empty-text="暂无任务，请由安全主管生成">
      <el-table-column prop="device_code" label="设备编号" width="110" />
      <el-table-column prop="device_name" label="设备名称" min-width="130" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="taskStatus[row.status as keyof typeof taskStatus].type">
            {{ taskStatus[row.status as keyof typeof taskStatus].label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="claimed_by_name" label="领取人" width="90">
        <template #default="{ row }">{{ row.claimed_by_name ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="异常单" width="110">
        <template #default="{ row }">
          <el-link v-if="row.anomaly_id" type="danger" @click="emit('view-trail', 'anomaly', row.anomaly_id)">
            异常单 #{{ row.anomaly_id }}
          </el-link>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="300">
        <template #default="{ row }">
          <el-button v-if="canClaim(row)" size="small" type="primary" @click="doClaim(row)">领取</el-button>
          <el-button v-if="canStart(row)" size="small" type="warning" @click="doStart(row)">开始巡检</el-button>
          <el-button v-if="canSubmit(row)" size="small" type="success" @click="openSubmit(row)">提交巡检</el-button>
          <el-button v-if="row.status === 'completed'" size="small" @click="openView(row)">查看结果</el-button>
          <el-button size="small" text @click="emit('view-trail', 'task', row.id)">轨迹</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 提交巡检对话框 -->
    <el-dialog v-model="submitVisible" :title="`提交巡检 — ${submitTask?.device_name ?? ''}`" width="640px" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" show-icon title="请逐项判定；存在不合格项时将自动生成一张异常单" class="mb12" />
      <div v-for="it in submitItems" :key="it.id" class="check-row">
        <div class="check-head">
          <span class="check-name">{{ it.item_name }}</span>
          <span class="check-std">标准：{{ it.standard }}</span>
        </div>
        <div class="check-body">
          <el-radio-group v-model="it.result">
            <el-radio-button value="pass">合格</el-radio-button>
            <el-radio-button value="fail">不合格</el-radio-button>
          </el-radio-group>
          <el-input
            v-if="it.result === 'fail'"
            v-model="it.note"
            placeholder="异常情况说明（将写入异常单）"
            size="small"
            style="flex: 1"
          />
        </div>
      </div>
      <template #footer>
        <el-button @click="submitVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!allAnswered" :loading="submitting" @click="doSubmit">
          提交巡检结果
        </el-button>
      </template>
    </el-dialog>

    <!-- 查看结果对话框 -->
    <el-dialog v-model="viewVisible" :title="`巡检结果 — ${viewData?.task.device_name ?? ''}`" width="560px">
      <el-table :data="viewData?.results ?? []" border>
        <el-table-column prop="item_name" label="检查项" min-width="150" />
        <el-table-column label="结论" width="90">
          <template #default="{ row }">
            <el-tag :type="row.result === 'pass' ? 'success' : 'danger'">
              {{ row.result === 'pass' ? '合格' : '不合格' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="说明" min-width="140">
          <template #default="{ row }">{{ row.note ?? '—' }}</template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.mb12 { margin-bottom: 12px; }
.check-row {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.check-head { display: flex; justify-content: space-between; margin-bottom: 8px; }
.check-name { font-weight: 600; }
.check-std { color: #909399; font-size: 12px; }
.check-body { display: flex; gap: 12px; align-items: center; }
</style>
