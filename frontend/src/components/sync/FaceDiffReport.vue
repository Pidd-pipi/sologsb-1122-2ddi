<script setup lang="ts">
import { computed } from 'vue';
import type { FaceConflict } from '../../types/sync';
import { attitudeText, formatChainage } from '../../utils/geoMath';

const props = defineProps<{ conflict: FaceConflict }>();

function fmtValue(label: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (label === '里程桩号') return formatChainage(Number(value));
  return String(value);
}

const bothChanged = computed(() => props.conflict.fieldDiffs.filter((d) => d.changedBy === 'both'));
const localOnly = computed(() => props.conflict.fieldDiffs.filter((d) => d.changedBy === 'local'));
const remoteOnly = computed(() => props.conflict.fieldDiffs.filter((d) => d.changedBy === 'remote'));
</script>

<template>
  <el-card shadow="never" class="conflict-card">
    <template #header>
      <div class="head">
        <el-tag type="warning">同一掌子面两版并存</el-tag>
        <strong>{{ conflict.faceNo }}</strong>
        <span class="muted">
          库中（{{ conflict.base.deviceId === 'ancestor' ? '对端/基线' : conflict.base.label }}）
          ↔ 本批次（{{ conflict.incoming.label }}）
        </span>
      </div>
    </template>

    <template v-if="conflict.fieldDiffs.length">
      <p class="section-title">基本信息字段差异</p>
      <el-table :data="conflict.fieldDiffs" size="small" border>
        <el-table-column prop="label" label="字段" width="130" />
        <el-table-column label="共同基线" min-width="110">
          <template #default="{ row }">{{ fmtValue(row.label, row.base) }}</template>
        </el-table-column>
        <el-table-column label="库中（对端）" min-width="110">
          <template #default="{ row }">
            <span :class="{ diff: row.changedBy !== 'local' }">{{ fmtValue(row.label, row.remote) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="本批次" min-width="110">
          <template #default="{ row }">
            <span :class="{ diff: row.changedBy !== 'remote' }">{{ fmtValue(row.label, row.local) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="改动方" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.changedBy === 'both' ? 'danger' : 'info'">
              {{ row.changedBy === 'both' ? '两边都改' : row.changedBy === 'local' ? '仅本批次' : '仅对端' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-alert
        v-if="bothChanged.length"
        type="error"
        :closable="false"
        show-icon
        :title="`${bothChanged.length} 个字段两边都改过：${bothChanged.map((d) => d.label).join('、')}，已保留库中版本，需人工确认`"
        style="margin-top: 8px"
      />
    </template>

    <div class="sub">
      <span class="section-title">节理组差异</span>
      <el-tag size="small" type="success">新增 {{ conflict.jointDiff.added.length }}</el-tag>
      <el-tag size="small" type="danger">删除 {{ conflict.jointDiff.removed.length }}</el-tag>
      <el-tag size="small" type="warning">两边都改 {{ conflict.jointDiff.changed.length }}</el-tag>
    </div>
    <el-table
      v-if="conflict.jointDiff.added.length + conflict.jointDiff.removed.length + conflict.jointDiff.changed.length"
      :data="[
        ...conflict.jointDiff.added.map((j) => ({ j, k: 'added' })),
        ...conflict.jointDiff.removed.map((j) => ({ j, k: 'removed' })),
        ...conflict.jointDiff.changed.map((j) => ({ j, k: 'changed' })),
      ]"
      size="small"
      border
    >
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.k === 'added' ? 'success' : row.k === 'removed' ? 'danger' : 'warning'">
            {{ row.k === 'added' ? '本批次新增' : row.k === 'removed' ? '本批次删除' : '两边都改' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="组号" width="80">
        <template #default="{ row }">J{{ row.j.setNo }}</template>
      </el-table-column>
      <el-table-column label="产状" width="130">
        <template #default="{ row }">{{ attitudeText(row.j.dipDirection, row.j.dipAngle) }}</template>
      </el-table-column>
      <el-table-column prop="j.spacing" label="间距" width="80" />
      <el-table-column prop="j.waterWet" label="渗水" width="90" />
      <el-table-column prop="j.jointCount" label="条数" width="70" />
    </el-table>

    <div class="sub">
      <span class="section-title">涌水记录差异</span>
      <el-tag size="small" type="success">新增 {{ conflict.waterDiff.added.length }}</el-tag>
      <el-tag size="small" type="danger">删除 {{ conflict.waterDiff.removed.length }}</el-tag>
      <el-tag size="small" type="warning">两边都改 {{ conflict.waterDiff.changed.length }}</el-tag>
    </div>
    <el-table
      v-if="conflict.waterDiff.added.length + conflict.waterDiff.removed.length + conflict.waterDiff.changed.length"
      :data="[
        ...conflict.waterDiff.added.map((w) => ({ w, k: 'added' })),
        ...conflict.waterDiff.removed.map((w) => ({ w, k: 'removed' })),
        ...conflict.waterDiff.changed.map((w) => ({ w, k: 'changed' })),
      ]"
      size="small"
      border
    >
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.k === 'added' ? 'success' : row.k === 'removed' ? 'danger' : 'warning'">
            {{ row.k === 'added' ? '本批次新增' : row.k === 'removed' ? '本批次删除' : '两边都改' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="里程" width="110">
        <template #default="{ row }">{{ formatChainage(row.w.chainage) }}</template>
      </el-table-column>
      <el-table-column prop="w.position" label="部位" min-width="130" />
      <el-table-column prop="w.type" label="类型" width="80" />
      <el-table-column label="涌水量" width="100">
        <template #default="{ row }">{{ row.w.estimatedFlow }} L/min</template>
      </el-table-column>
    </el-table>

    <p v-if="localOnly.length === 0 && remoteOnly.length === 0 && bothChanged.length === 0" class="muted">
      无基本信息字段差异。
    </p>
  </el-card>
</template>

<style scoped>
.conflict-card {
  margin-bottom: 12px;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 6px;
}
.section-title {
  font-weight: 600;
  font-size: 13px;
  margin: 10px 0 6px;
}
.muted {
  color: #7b8592;
  font-size: 12px;
}
.diff {
  color: #d3542f;
  font-weight: 600;
}
</style>
