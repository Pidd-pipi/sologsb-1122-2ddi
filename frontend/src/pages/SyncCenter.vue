<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useSyncStore } from '../stores/syncStore';
import { useFaceStore } from '../stores/faceStore';
import {
  currentDeviceId,
  currentDeviceName,
  parseBatchFile,
  serializeBatch,
  setCurrentDevice,
} from '../utils/sync';
import FaceDiffReport from '../components/sync/FaceDiffReport.vue';
import { BATCH_STATUS_LABELS, type CatalogBatch } from '../types/sync';

const router = useRouter();
const syncStore = useSyncStore();
const faceStore = useFaceStore();

const deviceId = ref(currentDeviceId());
const deviceName = ref(currentDeviceName());
const dialogVisible = ref(false);
const reportBatch = ref<CatalogBatch | null>(null);
const reportVisible = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function showReport(batch: CatalogBatch) {
  reportBatch.value = batch;
  reportVisible.value = true;
}

const form = reactive({
  label: '',
  faceId: '',
  deviceId: '',
  deviceName: '',
});

const statusTag: Record<string, '' | 'success' | 'warning' | 'info' | 'danger'> = {
  editing: 'info',
  submitted: '',
  merged: 'success',
  conflict: 'danger',
};

const sortedBatches = computed(() =>
  [...syncStore.batches].sort((a, b) => (b.submittedAt ?? b.createdAt) - (a.submittedAt ?? a.createdAt)),
);

function switchDevice(which: 'A' | 'B') {
  const id = which === 'A' ? 'device-tablet-A' : 'device-tablet-B';
  const name = which === 'A' ? '平板A' : '平板B';
  setCurrentDevice(id, name);
  deviceId.value = id;
  deviceName.value = name;
  ElMessage.success(`已切换为${name}，接下来的离线批次由该设备产生`);
}

function openCreate() {
  form.label = '';
  form.faceId = faceStore.items[0]?.id ?? '';
  form.deviceId = deviceId.value;
  form.deviceName = deviceName.value;
  dialogVisible.value = true;
}

async function createBatch() {
  if (!form.faceId) {
    ElMessage.error('请选择掌子面');
    return;
  }
  const face = faceStore.byId(form.faceId);
  const label = form.label.trim() || `${face?.faceNo ?? '掌子面'} · ${form.deviceName || deviceName.value}`;
  const batch = await syncStore.create({
    label,
    faceIds: [form.faceId],
    deviceId: form.deviceId || deviceId.value,
    deviceName: form.deviceName,
  });
  dialogVisible.value = false;
  ElMessage.success(`已建立离线批次「${label}」，可进入继续离线编录`);
  router.push(`/sync/${batch.id}`);
}

async function commit(batch: CatalogBatch, rebase = false) {
  const outcome = await syncStore.commit(batch.id, rebase);
  if (outcome.ok) {
    if (outcome.duplicate) {
      ElMessage.warning(`批次「${batch.label}」此前已合入，已按幂等跳过，不会重复计入`);
    } else {
      ElMessage.success(`批次「${batch.label}」合入成功`);
    }
    showReport(outcome.batch);
  } else {
    ElMessage.error(`冲突：${outcome.batch.conflictReason ?? '另一台平板已先提交同一掌子面'}，本批次修改已原样保留`);
  }
}

async function submitThenCommit(batch: CatalogBatch) {
  await commit(batch, false);
}

async function retryAsIs(batch: CatalogBatch) {
  // 原样重试：不改动批次内容，重新走 CAS
  const outcome = await syncStore.commit(batch.id, false);
  if (outcome.ok) {
    ElMessage.success(outcome.duplicate ? '该批次此前已合入（幂等跳过）' : '原样重试成功，批次已合入');
    showReport(outcome.batch);
  } else {
    ElMessage.warning('对端提交仍在，再次冲突，可选择「保留两版合入」或继续等待');
  }
}

async function keepBoth(batch: CatalogBatch) {
  try {
    await ElMessageBox.confirm(
      '保留两版合入会跳过两边都改过的掌子面字段/同 ID 记录（库中版本不动），其余修改正常写入，并列出差异供人工核对。确认继续？',
      '保留两版合入',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  const outcome = await syncStore.commit(batch.id, true);
  if (outcome.ok) {
    ElMessage.success('已保留两版合入，请查看差异并核对围岩级别');
    showReport(outcome.batch);
  } else {
    ElMessage.error('合入失败，请重试');
  }
}

function download(batch: CatalogBatch) {
  const blob = new Blob([serializeBatch(batch)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `batch-${batch.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const batch = parseBatchFile(text);
    const result = await syncStore.importBatch(batch);
    if (result.existed) {
      if (result.batch.status === 'merged') {
        ElMessage.warning(`批次「${result.batch.label}」已经合入过，旧批次不会重复计入`);
      } else {
        ElMessage.info(`批次「${result.batch.label}」已存在，已打开本地保留版本`);
      }
      if (result.batch.status === 'merged') showReport(result.batch);
    } else if (result.mergedArchived) {
      ElMessage.success(`已存档外部已合入批次「${batch.label}」，仅作记录，未覆盖本机数据`);
    } else {
      ElMessage.success(`已导入批次「${batch.label}」（设备 ${batch.deviceId}），可在列表中提交合入`);
    }
  } catch (e) {
    ElMessage.error((e as Error).message || '导入失败');
  }
}

async function remove(batch: CatalogBatch) {
  try {
    await ElMessageBox.confirm(`删除批次「${batch.label}」？该操作不影响已合入的数据。`, '删除批次', {
      type: 'warning',
    });
  } catch {
    return;
  }
  await syncStore.remove(batch.id);
  ElMessage.success('已删除批次');
}

function touchCount(batch: CatalogBatch): number {
  return (
    Object.keys(batch.faces).length +
    Object.keys(batch.joints).length +
    Object.keys(batch.grades).length +
    Object.keys(batch.waters).length
  );
}

onMounted(async () => {
  await faceStore.load();
  await syncStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>离线编录批次</h2>
      <el-tag type="info" effect="plain">共 {{ syncStore.batches.length }} 个批次</el-tag>
      <el-tag type="warning" effect="plain">待处理 {{ syncStore.conflicts.length + syncStore.submitted.length }}</el-tag>
      <div class="spacer" />
      <el-button-group>
        <el-button size="small" :type="deviceName === '平板A' ? 'primary' : ''" @click="switchDevice('A')">
          模拟平板A
        </el-button>
        <el-button size="small" :type="deviceName === '平板B' ? 'primary' : ''" @click="switchDevice('B')">
          模拟平板B
        </el-button>
      </el-button-group>
      <el-tag effect="plain">当前设备：{{ deviceName }}（{{ deviceId.slice(-6) }}）</el-tag>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="两台平板分别离线编录同一掌子面，回到项目部后在此导入批次并提交合入"
      description="提交采用并发校验：先提交者写入，后提交者保留全部修改并提示冲突；冲突后可原样重试，或保留两版合入并查看差异。节理组/涌水依据变化时，关联围岩级别自动失效并按当前数据重新判定。"
    />

    <el-card shadow="never">
      <div class="toolbar">
        <el-button type="primary" @click="openCreate">新建离线批次</el-button>
        <el-button @click="fileInput?.click()">导入批次文件</el-button>
        <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFile" />
        <span class="hint">在平板A上离线编录 → 导出批次文件 → 切到平板B或项目部导入提交</span>
      </div>

      <el-table :data="sortedBatches" size="default" border style="margin-top: 12px">
        <el-table-column prop="label" label="批次" min-width="180">
          <template #default="{ row }">
            <div class="batch-label">
              <strong>{{ row.label }}</strong>
              <el-tag size="small" :type="statusTag[row.status]">{{ BATCH_STATUS_LABELS[row.status as keyof typeof BATCH_STATUS_LABELS] }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="设备" width="120">
          <template #default="{ row }">{{ row.deviceId === 'device-tablet-A' ? '平板A' : row.deviceId === 'device-tablet-B' ? '平板B' : row.deviceId.slice(-6) }}</template>
        </el-table-column>
        <el-table-column label="暂存改动" width="90">
          <template #default="{ row }">{{ touchCount(row) }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column label="合入/冲突说明" min-width="220">
          <template #default="{ row }">
            <span v-if="row.status === 'merged'" class="ok">
              已合入{{ row.mergeReport?.rejudged.length ? `，重判 ${row.mergeReport.rejudged.length} 条级别` : '' }}
            </span>
            <span v-else-if="row.status === 'conflict'" class="err">{{ row.conflictReason }}</span>
            <span v-else class="muted">尚未提交</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320">
          <template #default="{ row }">
            <el-button size="small" @click="router.push(`/sync/${row.id}`)">打开编录</el-button>
            <el-button size="small" @click="download(row)">导出</el-button>
            <el-button v-if="row.status !== 'merged'" size="small" type="primary" @click="submitThenCommit(row)">
              提交合入
            </el-button>
            <template v-if="row.status === 'conflict'">
              <el-button size="small" type="warning" @click="retryAsIs(row)">原样重试</el-button>
              <el-button size="small" type="success" @click="keepBoth(row)">保留两版</el-button>
            </template>
            <el-button v-if="row.status === 'merged'" size="small" @click="showReport(row)">查看报告</el-button>
            <el-button size="small" danger @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="sortedBatches.length === 0" description="还没有离线批次，点「新建离线批次」开始" :image-size="80" />
    </el-card>

    <el-dialog v-model="dialogVisible" title="新建离线编录批次" width="520px">
      <el-form label-width="100px">
        <el-form-item label="掌子面">
          <el-select v-model="form.faceId" placeholder="选择要离线编录的掌子面" style="width: 100%">
            <el-option v-for="f in faceStore.items" :key="f.id" :label="`${f.faceNo}（K${f.chainage}）`" :value="f.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="批次名称">
          <el-input v-model="form.label" placeholder="留空则自动用「掌子面 · 设备」" />
        </el-form-item>
        <el-form-item label="产生设备">
          <el-radio-group v-model="form.deviceId">
            <el-radio value="device-tablet-A">平板A</el-radio>
            <el-radio value="device-tablet-B">平板B</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="createBatch">创建并进入</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="reportVisible" title="合入报告" size="62%">
      <template v-if="reportBatch && reportBatch.mergeReport">
        <el-descriptions :column="2" border size="small" class="report-meta">
          <el-descriptions-item label="批次">{{ reportBatch.label }}</el-descriptions-item>
          <el-descriptions-item label="合入时间">
            {{ new Date(reportBatch.mergeReport.mergedAt).toLocaleString('zh-CN') }}
          </el-descriptions-item>
          <el-descriptions-item label="写入掌子面">{{ reportBatch.mergeReport.applied.faces }}</el-descriptions-item>
          <el-descriptions-item label="写入节理组">{{ reportBatch.mergeReport.applied.joints }}</el-descriptions-item>
          <el-descriptions-item label="写入级别">{{ reportBatch.mergeReport.applied.grades }}</el-descriptions-item>
          <el-descriptions-item label="写入涌水">{{ reportBatch.mergeReport.applied.waters }}</el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="reportBatch.mergeReport.rejudged.length"
          type="warning"
          :closable="false"
          show-icon
          style="margin: 12px 0"
          title="以下掌子面的节理组或涌水状态已变化，旧围岩级别失效并按当前数据重新判定"
        />
        <el-table v-if="reportBatch.mergeReport.rejudged.length" :data="reportBatch.mergeReport.rejudged" size="small" border>
          <el-table-column prop="faceNo" label="掌子面" min-width="120" />
          <el-table-column label="失效依据" min-width="160">
            <template #default="{ row }">{{ row.reasons.join('、') }}</template>
          </el-table-column>
          <el-table-column label="原级别→新级别" width="150">
            <template #default="{ row }">见详情页判定链</template>
          </el-table-column>
        </el-table>

        <template v-if="reportBatch.mergeReport.conflicts.length">
          <el-alert
            type="error"
            :closable="false"
            show-icon
            style="margin: 12px 0"
            :title="`${reportBatch.mergeReport.conflicts.length} 个掌子面两边都改过，已保留两版，请人工核对`"
          />
          <FaceDiffReport v-for="c in reportBatch.mergeReport.conflicts" :key="c.faceId" :conflict="c" />
        </template>

        <el-alert
          v-if="!reportBatch.mergeReport.rejudged.length && !reportBatch.mergeReport.conflicts.length"
          type="success"
          :closable="false"
          show-icon
          title="无冲突、无依据变化，批次已干净合入"
        />
      </template>
    </el-drawer>
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
.spacer {
  flex: 1;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.batch-label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hint {
  color: #97a0ad;
  font-size: 12px;
}
.muted {
  color: #97a0ad;
  font-size: 12px;
}
.ok {
  color: #2f8f5b;
  font-size: 12px;
}
.err {
  color: #d3542f;
  font-size: 12px;
}
.report-meta {
  margin-bottom: 8px;
}
</style>
