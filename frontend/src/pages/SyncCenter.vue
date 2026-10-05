<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useSyncStore } from '../stores/syncStore';
import { useFaceStore } from '../stores/faceStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeStore } from '../stores/gradeStore';
import { summarizeChange } from '../services/mergePlan';
import { setDeviceName, getDeviceName } from '../utils/device';
import type { MergeConflict } from '../types/sync';

const syncStore = useSyncStore();
const faceStore = useFaceStore();
const jointStore = useJointStore();
const gradeStore = useGradeStore();

const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const nameEditing = ref(false);
const nameInput = ref('');

const pending = computed(() => syncStore.pendingConflicts);
const resolved = computed(() => syncStore.resolvedConflicts);

const tableLabel: Record<string, string> = {
  faces: '掌子面',
  joints: '节理组',
  grades: '围岩级别',
  waters: '涌水记录',
};

const kindLabel: Record<string, string> = {
  'face-diverge': '同一掌子面两边都改过',
  'upsert-upsert': '同一记录两边都改过',
  'remote-delete-local-edit': '对端删除、本机已修改',
  'local-delete-remote-edit': '本机删除、对端已修改',
};

const statusLabel: Record<string, { text: string; type: 'success' | 'warning' | 'info' | 'primary' }> = {
  pending: { text: '待处理', type: 'warning' },
  'accepted-local': { text: '保留本机版', type: 'primary' },
  'accepted-remote': { text: '采用对端版', type: 'success' },
  'kept-both': { text: '两版都留', type: 'info' },
};

function faceTitle(id: string): string {
  return faceStore.byId(id)?.faceNo ?? id.slice(-8);
}

function recordTitle(c: MergeConflict): string {
  if (c.tableName === 'faces') {
    const local = c.localSnapshot as { faceNo?: string } | undefined;
    const remote = c.remoteSnapshot as { faceNo?: string } | undefined;
    return local?.faceNo || remote?.faceNo || c.recordId.slice(-8);
  }
  const local = summarizeChange(c.tableName, c.localSnapshot);
  const remote = summarizeChange(c.tableName, c.remoteSnapshot);
  return local !== '—' ? local : remote;
}

async function doExport() {
  if (syncStore.changes.length === 0) {
    ElMessage.warning('本机还没有任何修改，无需导出批次');
    return;
  }
  const batch = await syncStore.exportToFile();
  ElMessage.success(`已导出批次（${batch.changes.length} 条变更），把文件交给另一台平板导入`);
}

function pickFile() {
  fileInput.value?.click();
}

async function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importing.value = true;
  try {
    const result = await syncStore.importFromFile(file);
    await Promise.all([faceStore.load(), jointStore.load(), gradeStore.load()]);
    if (result.outcome === 'applied') {
      ElMessage.success(
        `批次合入完成：写入 ${result.applied} 条，冲突 ${result.conflicts} 条，重判级别 ${result.invalidatedGrades} 条`,
      );
      if (result.conflicts > 0) {
        ElMessageBox.alert(
          `有 ${result.conflicts} 条记录两台平板都改过，已保留下方「待处理冲突」中，本机未提交的修改原样保留，请逐条处理。`,
          '存在合并冲突',
          { type: 'warning' },
        ).catch(() => undefined);
      }
    } else if (result.outcome === 'duplicate') {
      ElMessage.info(
        `该批次已于 ${result.committedAt ? new Date(result.committedAt).toLocaleString('zh-CN') : '之前'} 合入过，旧批次不重复计入`,
      );
    } else if (result.outcome === 'locked') {
      ElMessageBox.alert(
        '另一台平板（或另一个窗口）正在提交，本次未写入任何数据。本机未提交的修改原样保留，请稍后用同一批次文件原样重试。',
        '提交冲突：仅允许一份写入',
        { type: 'error' },
      ).catch(() => undefined);
    } else {
      ElMessage.error(`批次文件无效：${result.error}`);
    }
  } finally {
    importing.value = false;
    input.value = '';
  }
}

async function acceptLocal(c: MergeConflict) {
  await syncStore.resolve(c.id, 'accepted-local');
  await Promise.all([faceStore.load(), jointStore.load(), gradeStore.load()]);
  ElMessage.success('已保留本机版本');
}
async function acceptRemote(c: MergeConflict) {
  await syncStore.resolve(c.id, 'accepted-remote');
  await Promise.all([faceStore.load(), jointStore.load(), gradeStore.load()]);
  ElMessage.success('已采用对端版本，并作为本机修改保留，可在下一批次导出');
}
async function keepBoth(c: MergeConflict) {
  await syncStore.resolve(c.id, 'kept-both');
  await Promise.all([faceStore.load(), jointStore.load(), gradeStore.load()]);
  ElMessage.success('两版都已保留，差异已标在掌子面详情中');
}
async function reopen(c: MergeConflict) {
  await syncStore.reopen(c.id);
}
async function fork(c: MergeConflict) {
  const id = await syncStore.forkFace(c.id);
  await faceStore.load();
  if (id) ElMessage.success('对端版本已另存为独立掌子面');
}

function startEditName() {
  nameInput.value = syncStore.deviceName;
  nameEditing.value = true;
}
function saveName() {
  setDeviceName(nameInput.value);
  syncStore.deviceName = getDeviceName();
  nameEditing.value = false;
}

onMounted(async () => {
  await syncStore.load();
  await Promise.all([faceStore.load(), jointStore.load(), gradeStore.load()]);
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>离线批次合并</h2>
      <el-tag type="info" effect="plain">本机：{{ syncStore.deviceName }}</el-tag>
      <el-tag type="warning" v-if="syncStore.pendingCount">待提交修改 {{ syncStore.pendingCount }} 条</el-tag>
    </div>

    <el-card shadow="never">
      <template #header><strong>设备标识</strong></template>
      <div class="device-row">
        <span class="muted">设备 ID：{{ syncStore.deviceId }}</span>
        <template v-if="!nameEditing">
          <span>设备名称：<strong>{{ syncStore.deviceName }}</strong></span>
          <el-button size="small" @click="startEditName">修改名称</el-button>
        </template>
        <template v-else>
          <el-input v-model="nameInput" style="width: 200px" placeholder="如 甲机 / 乙机" />
          <el-button size="small" type="primary" @click="saveName">保存</el-button>
        </template>
        <span class="hint">两台平板请使用不同名称，批次冲突提示会显示来源设备</span>
      </div>
    </el-card>

    <div class="two-col">
      <el-card shadow="never">
        <template #header><strong>① 导出本机批次</strong></template>
        <p class="muted">
          把本机全部编录修改（掌子面、节理组、涌水、级别判定）打包成一个 JSON 文件，回到项目部后交给另一台平板导入。
          已导出过但尚未同步的修改会继续保留，直到对端合入并无冲突。
        </p>
        <el-button type="primary" @click="doExport">导出批次文件</el-button>
        <el-button @click="syncStore.load()">刷新列表</el-button>
        <el-divider />
        <div class="muted small">本机变更日志（{{ syncStore.changes.length }} 条）</div>
        <el-table :data="syncStore.changes.slice(0, 8)" size="small" border style="margin-top: 6px">
          <el-table-column label="数据" width="90">
            <template #default="{ row }">{{ tableLabel[row.tableName] }}</template>
          </el-table-column>
          <el-table-column label="操作" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.operation === 'remove' ? 'danger' : 'primary'">
                {{ row.operation === 'remove' ? '删除' : '写入' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态">
            <template #default="{ row }">
              <el-tag size="small" :type="row.batchId ? 'info' : 'warning'">
                {{ row.batchId ? `已导出 ${row.batchId.slice(-6)}` : '尚未提交' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never">
        <template #header><strong>② 导入对端批次</strong></template>
        <p class="muted">
          选择另一台平板导出的批次文件。同一批次重复导入不会重复计入；两台平板同时提交时只允许一份写入，
          未写入的一方本机修改原样保留，稍后可用原文件重试。
        </p>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          style="display: none"
          @change="onFileChosen"
        />
        <el-button type="success" :loading="importing" @click="pickFile">选择批次文件合入</el-button>
        <el-divider />
        <div class="muted small">已合入批次（{{ syncStore.committed.length }} 个）</div>
        <el-table :data="syncStore.committed.slice(0, 6)" size="small" border style="margin-top: 6px">
          <el-table-column prop="deviceName" label="来源设备" min-width="120" />
          <el-table-column prop="changeCount" label="变更数" width="80" />
          <el-table-column label="合入时间" min-width="160">
            <template #default="{ row }">{{ new Date(row.importedAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-if="syncStore.committed.length === 0" description="尚未合入过批次" :image-size="50" />
      </el-card>
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <strong>③ 待处理冲突（{{ pending.length }}）</strong>
          <span class="muted">同一记录两台平板都改过，两份修改都未丢失，请选择保留方式</span>
        </div>
      </template>
      <el-empty v-if="pending.length === 0" description="没有待处理冲突" :image-size="60" />
      <div v-for="c in pending" :key="c.id" class="conflict">
        <div class="conflict-head">
          <el-tag type="warning" size="small">{{ kindLabel[c.kind] }}</el-tag>
          <el-tag size="small">{{ tableLabel[c.tableName] }}</el-tag>
          <strong v-if="c.tableName === 'faces'">{{ recordTitle(c) }}</strong>
          <strong v-else>{{ faceTitle(c.faceId) }} · {{ recordTitle(c) }}</strong>
          <span class="muted small">对端批次 {{ c.batchId.slice(-6) }}</span>
        </div>

        <div v-if="c.tableName === 'faces'" class="diffs">
          <el-table :data="c.diffs" size="small" border>
            <el-table-column prop="label" label="差异字段" width="140" />
            <el-table-column label="本机版本" min-width="160">
              <template #default="{ row }">
                <span class="local-val">{{ row.local }}</span>
              </template>
            </el-table-column>
            <el-table-column label="对端版本" min-width="160">
              <template #default="{ row }">
                <span class="remote-val">{{ row.remote }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <div v-else class="side-by-side">
          <div class="side">
            <div class="side-title">本机版本</div>
            <span class="local-val">{{ c.localSnapshot ? recordTitle(c) : '（本机已删除）' }}</span>
          </div>
          <div class="side">
            <div class="side-title">对端版本</div>
            <span class="remote-val">{{ c.remoteSnapshot ? recordTitle(c) : '（对端已删除）' }}</span>
          </div>
        </div>

        <div class="actions">
          <el-button size="small" type="primary" @click="acceptLocal(c)">
            {{ c.kind === 'remote-delete-local-edit' ? '拒绝删除、保留本机版' : '保留本机版' }}
          </el-button>
          <el-button size="small" type="success" @click="acceptRemote(c)">
            {{ c.remoteSnapshot ? '采用对端版' : '执行对端删除' }}
          </el-button>
          <el-button
            v-if="c.tableName === 'faces' && c.localSnapshot && c.remoteSnapshot"
            size="small"
            @click="keepBoth"
          >
            两版都留（标出差异）
          </el-button>
          <el-button
            v-if="c.tableName === 'faces' && c.localSnapshot && c.remoteSnapshot"
            size="small"
            @click="fork(c)"
          >
            对端版另存为新掌子面
          </el-button>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" v-if="resolved.length">
      <template #header><strong>已处理冲突（{{ resolved.length }}）</strong></template>
      <el-table :data="resolved" size="small" border>
        <el-table-column label="数据" width="100">
          <template #default="{ row }">{{ tableLabel[row.tableName] }}</template>
        </el-table-column>
        <el-table-column label="记录" min-width="180">
          <template #default="{ row }">{{ recordTitle(row) }}</template>
        </el-table-column>
        <el-table-column label="处理结果" width="140">
          <template #default="{ row }">
            <el-tag size="small" :type="statusLabel[row.status].type">{{ statusLabel[row.status].text }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button size="small" link @click="reopen(row)">重新处理</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: start;
}
.device-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: #7b8592;
}
.small {
  font-size: 12px;
}
.hint {
  color: #97a0ad;
  font-size: 12px;
}
.conflict {
  border: 1px solid #e4e8ee;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.conflict-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.diffs {
  margin: 8px 0;
}
.side-by-side {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 8px 0;
}
.side {
  background: #f7f9fb;
  border-radius: 6px;
  padding: 8px 10px;
}
.side-title {
  font-size: 12px;
  color: #97a0ad;
  margin-bottom: 4px;
}
.local-val {
  color: #1f4f8a;
}
.remote-val {
  color: #b45309;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
