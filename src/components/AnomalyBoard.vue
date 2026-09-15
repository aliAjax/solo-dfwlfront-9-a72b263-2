<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { Ref } from 'vue';
import { api } from '../api';
import type { Anomaly, Meta, Recheck, User } from '../types';

const emit = defineEmits<{ (e: 'view-trail', entityType: string, entityId: number): void }>();

const meta = inject<Ref<Meta | null>>('meta')!;
const currentUser = inject<Ref<User | null>>('currentUser')!;

const stationId = ref<number>(currentUser.value?.station_id ?? 1);
const statusFilter = ref('');
const anomalies = ref<Anomaly[]>([]);
const loading = ref(false);
const acting = ref(false);

const statusMeta: Record<string, { label: string; type: 'info' | 'primary' | 'warning' | 'success' | 'danger' }> = {
  open: { label: '待处理', type: 'danger' },
  processing: { label: '处理中', type: 'primary' },
  recheck_pending: { label: '待复检', type: 'warning' },
  escalated: { label: '已升级', type: 'danger' },
  closed: { label: '已关闭', type: 'success' },
};

const myStation = computed(() => currentUser.value?.station_id);
// 数据按站点归属隔离：站点选择器仅显示本站
const visibleStations = computed(() => (meta.value?.stations ?? []).filter((s) => s.id === myStation.value));

async function refresh() {
  loading.value = true;
  try {
    anomalies.value = await api.anomalies(stationId.value || undefined, statusFilter.value || undefined);
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function handle(a: Anomaly, action: 'start' | 'complete') {
  acting.value = true;
  try {
    await api.handle(a.id, action);
    ElMessage.success(action === 'start' ? '已开始处理' : '处理完成，等待复检');
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    acting.value = false;
  }
}

// ---------- 复检 ----------
const recheckVisible = ref(false);
const recheckTarget = ref<Anomaly | null>(null);
const recheckResult = ref<'pass' | 'fail'>('pass');
const recheckNote = ref('');

function openRecheck(a: Anomaly) {
  recheckTarget.value = a;
  recheckResult.value = 'pass';
  recheckNote.value = '';
  recheckVisible.value = true;
}

async function doRecheck() {
  if (!recheckTarget.value) return;
  acting.value = true;
  try {
    const r = await api.recheck(recheckTarget.value.id, recheckResult.value, recheckNote.value || undefined);
    if (r.status === 'closed') ElMessage.success('复检通过，异常单已关闭');
    else ElMessage.error(`复检未通过，异常单已升级至 Lv${r.level}`);
    recheckVisible.value = false;
    await refresh();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    acting.value = false;
  }
}

// ---------- 详情 ----------
const detailVisible = ref(false);
const detail = ref<{ anomaly: Anomaly; rechecks: Recheck[] } | null>(null);

async function openDetail(a: Anomaly) {
  const d = await api.anomalyDetail(a.id);
  detail.value = { anomaly: d.anomaly, rechecks: d.rechecks };
  detailVisible.value = true;
}

function canAct(a: Anomaly) {
  return a.station_id === myStation.value && a.status !== 'closed';
}

watch([stationId, statusFilter], refresh);
onMounted(refresh);
</script>

<template>
  <div>
    <div class="toolbar">
      <el-select v-model="stationId" style="width: 160px" disabled>
        <el-option v-for="s in visibleStations" :key="s.id" :value="s.id" :label="s.name" />
      </el-select>
      <el-select v-model="statusFilter" style="width: 140px" placeholder="全部状态" clearable>
        <el-option v-for="(v, k) in statusMeta" :key="k" :value="k" :label="v.label" />
      </el-select>
      <el-button @click="refresh">刷新</el-button>
    </div>

    <el-table :data="anomalies" v-loading="loading" border empty-text="暂无异常单">
      <el-table-column prop="id" label="单号" width="80">
        <template #default="{ row }">#{{ row.id }}</template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
      <el-table-column label="等级" width="90">
        <template #default="{ row }">
          <el-tag :type="row.level > 1 ? 'danger' : 'warning'" effect="dark">
            Lv{{ row.level }}{{ row.level > 1 ? ' 已升级' : '' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusMeta[row.status]?.type ?? 'info'">{{ statusMeta[row.status]?.label ?? row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="responsible_name" label="责任人" width="90" />
      <el-table-column label="复检期限" width="170">
        <template #default="{ row }">
          <span :class="{ overdue: row.status !== 'closed' && row.recheck_deadline < new Date().toISOString() }">
            {{ new Date(row.recheck_deadline).toLocaleString('zh-CN', { hour12: false }) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="330">
        <template #default="{ row }">
          <template v-if="canAct(row)">
            <el-button
              v-if="row.status === 'open' || row.status === 'escalated'"
              size="small" type="primary" :loading="acting"
              @click="handle(row, 'start')"
            >开始处理</el-button>
            <el-button
              v-if="row.status === 'processing'"
              size="small" type="warning" :loading="acting"
              @click="handle(row, 'complete')"
            >处理完成</el-button>
            <el-button
              v-if="row.status === 'recheck_pending'"
              size="small" type="success" :loading="acting"
              @click="openRecheck(row)"
            >复检</el-button>
          </template>
          <el-button size="small" @click="openDetail(row)">详情</el-button>
          <el-button size="small" text @click="emit('view-trail', 'anomaly', row.id)">轨迹</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 复检对话框 -->
    <el-dialog v-model="recheckVisible" :title="`复检 — 异常单 #${recheckTarget?.id ?? ''}`" width="480px" :close-on-click-modal="false">
      <el-alert
        type="warning" :closable="false" show-icon class="mb12"
        title="复检不通过将自动升级（等级+1，复检期限收紧）"
      />
      <el-radio-group v-model="recheckResult">
        <el-radio-button value="pass">复检通过</el-radio-button>
        <el-radio-button value="fail">复检不通过</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="recheckNote" type="textarea" :rows="3" class="mt12"
        placeholder="复检说明（现场情况、整改验证结果）"
      />
      <template #footer>
        <el-button @click="recheckVisible = false">取消</el-button>
        <el-button type="primary" :loading="acting" @click="doRecheck">提交复检结论</el-button>
      </template>
    </el-dialog>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailVisible" :title="`异常单 #${detail?.anomaly.id ?? ''} 详情`" size="480px">
      <template v-if="detail">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="标题">{{ detail.anomaly.title }}</el-descriptions-item>
          <el-descriptions-item label="设备">{{ detail.anomaly.device_name }}（{{ detail.anomaly.device_code }}）</el-descriptions-item>
          <el-descriptions-item label="等级">Lv{{ detail.anomaly.level }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusMeta[detail.anomaly.status]?.type ?? 'info'">
              {{ statusMeta[detail.anomaly.status]?.label }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="责任人">{{ detail.anomaly.responsible_name ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="处理人">{{ detail.anomaly.handler_name ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="复检期限">
            {{ new Date(detail.anomaly.recheck_deadline).toLocaleString('zh-CN', { hour12: false }) }}
          </el-descriptions-item>
          <el-descriptions-item label="不合格项">
            <pre class="desc">{{ detail.anomaly.description }}</pre>
          </el-descriptions-item>
        </el-descriptions>

        <h4 class="mt16">复检记录</h4>
        <el-timeline v-if="detail.rechecks.length">
          <el-timeline-item
            v-for="r in detail.rechecks" :key="r.id"
            :type="r.result === 'pass' ? 'success' : 'danger'"
            :timestamp="new Date(r.created_at).toLocaleString('zh-CN', { hour12: false })"
          >
            {{ r.created_by_name ?? '系统' }}：{{ r.result === 'pass' ? '复检通过' : '复检不通过' }}
            <span v-if="r.note"> — {{ r.note }}</span>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无复检记录" :image-size="60" />
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; }
.mb12 { margin-bottom: 12px; }
.mt12 { margin-top: 12px; }
.mt16 { margin-top: 16px; }
.overdue { color: #f56c6c; font-weight: 600; }
.desc { white-space: pre-wrap; margin: 0; font-family: inherit; }
</style>
