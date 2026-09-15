<script setup lang="ts">
import { onMounted, provide, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, setCurrentUser } from './api';
import type { Meta, User } from './types';
import TaskBoard from './components/TaskBoard.vue';
import AnomalyBoard from './components/AnomalyBoard.vue';
import TrailView from './components/TrailView.vue';

const meta = ref<Meta | null>(null);
const currentUser = ref<User | null>(null);
const activeTab = ref('tasks');
const trailTarget = ref<{ entityType: string; entityId: number } | null>(null);

provide('meta', meta);
provide('currentUser', currentUser);

function onUserChange(id: number) {
  const u = meta.value?.users.find((x) => x.id === id) ?? null;
  currentUser.value = u;
  setCurrentUser(u ? u.id : null);
  if (u) localStorage.setItem('inspection.uid', String(u.id));
}

function viewTrail(entityType: string, entityId: number) {
  trailTarget.value = { entityType, entityId };
  activeTab.value = 'trail';
}

onMounted(async () => {
  try {
    meta.value = await api.meta();
    const saved = Number(localStorage.getItem('inspection.uid'));
    const u = meta.value.users.find((x) => x.id === saved) ?? meta.value.users[0];
    if (u) onUserChange(u.id);
  } catch (e) {
    ElMessage.error('加载基础数据失败：' + (e as Error).message);
  }
});
</script>

<template>
  <div class="page">
    <header class="topbar">
      <div class="brand">
        <span class="logo">⛽</span>
        <div>
          <h1>油站设备巡检异常闭环</h1>
          <p>任务生成 → 领取巡检 → 异常处理 → 复检升级 → 轨迹留痕</p>
        </div>
      </div>
      <div class="identity" v-if="meta">
        <span class="label">当前身份</span>
        <el-select
          :model-value="currentUser?.id"
          style="width: 280px"
          @change="onUserChange"
        >
          <el-option
            v-for="u in meta.users"
            :key="u.id"
            :value="u.id"
            :label="`${u.name} · ${u.role === 'supervisor' ? '安全主管' : '巡检员'} · ${u.station_name}`"
          />
        </el-select>
      </div>
    </header>

    <el-tabs v-if="meta && currentUser" v-model="activeTab" class="main-tabs">
      <el-tab-pane label="巡检任务" name="tasks">
        <TaskBoard @view-trail="viewTrail" />
      </el-tab-pane>
      <el-tab-pane label="异常工单" name="anomalies">
        <AnomalyBoard @view-trail="viewTrail" />
      </el-tab-pane>
      <el-tab-pane label="轨迹回看" name="trail">
        <TrailView :target="trailTarget" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
