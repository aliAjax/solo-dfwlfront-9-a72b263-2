<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { Ref } from 'vue';
import { api } from '../api';
import type { Meta, TrailEvent, User } from '../types';

const props = defineProps<{ target: { entityType: string; entityId: number } | null }>();

const meta = inject<Ref<Meta | null>>('meta')!;
const currentUser = inject<Ref<User | null>>('currentUser')!;

const stationId = ref<number>(currentUser.value?.station_id ?? 1);
// 数据按站点归属隔离：站点选择器仅显示本站
const visibleStations = computed(() =>
  (meta.value?.stations ?? []).filter((s) => s.id === currentUser.value?.station_id),
);
const entityType = ref('');
const entityId = ref<number | null>(null);
const events = ref<TrailEvent[]>([]);
const loading = ref(false);

const actionLabels: Record<string, string> = {
  'plan.generated': '生成巡检计划',
  'plan.locked': '计划锁定',
  'task.claimed': '领取任务',
  'task.started': '开始巡检',
  'task.completed': '完成巡检',
  'anomaly.created': '生成异常单',
  'anomaly.handle_started': '开始处理',
  'anomaly.fix_submitted': '处理完成待复检',
  'anomaly.escalated': '复检未通过 · 升级',
  'anomaly.closed': '复检通过 · 关闭',
};

const entityLabels: Record<string, string> = { plan: '计划', task: '任务', anomaly: '异常单' };

function tagType(action: string) {
  if (action.includes('escalated')) return 'danger';
  if (action.includes('closed') || action.includes('completed')) return 'success';
  if (action.includes('locked')) return 'warning';
  return 'primary';
}

async function refresh() {
  loading.value = true;
  try {
    events.value = await api.trail(
      stationId.value || undefined,
      entityType.value || undefined,
      entityId.value ?? undefined,
    );
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

function fmtDetail(raw: string | null) {
  if (!raw) return '';
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(d)
      .filter(([, v]) => v !== null && v !== '')
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join('，');
  } catch {
    return raw;
  }
}

watch(
  () => props.target,
  (t) => {
    if (t) {
      entityType.value = t.entityType;
      entityId.value = t.entityId;
      refresh();
    }
  },
);
watch([stationId, entityType, entityId], refresh);
onMounted(refresh);
</script>

<template>
  <div>
    <div class="toolbar">
      <el-select v-model="stationId" style="width: 160px" disabled>
        <el-option v-for="s in visibleStations" :key="s.id" :value="s.id" :label="s.name" />
      </el-select>
      <el-select v-model="entityType" style="width: 130px" placeholder="全部对象" clearable>
        <el-option v-for="(v, k) in entityLabels" :key="k" :value="k" :label="v" />
      </el-select>
      <el-input-number v-model="entityId" :min="1" placeholder="对象ID" style="width: 140px" controls-position="right" />
      <el-button @click="refresh">查询</el-button>
    </div>

    <el-timeline v-loading="loading" class="trail">
      <el-timeline-item
        v-for="e in events"
        :key="e.id"
        :timestamp="new Date(e.created_at).toLocaleString('zh-CN', { hour12: false })"
        :type="tagType(e.action)"
        :hollow="false"
      >
        <div class="event">
          <el-tag size="small" :type="tagType(e.action)" effect="plain">
            {{ entityLabels[e.entity_type] ?? e.entity_type }} #{{ e.entity_id }}
          </el-tag>
          <strong>{{ actionLabels[e.action] ?? e.action }}</strong>
          <span class="actor">{{ e.actor_name ?? '系统' }}</span>
          <span v-if="e.detail" class="detail">{{ fmtDetail(e.detail) }}</span>
        </div>
      </el-timeline-item>
    </el-timeline>
    <el-empty v-if="!loading && events.length === 0" description="暂无轨迹记录" />
  </div>
</template>

<style scoped>
.toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.trail { padding-left: 4px; max-width: 860px; }
.event { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.actor { color: #606266; }
.detail { color: #909399; font-size: 12px; }
</style>
