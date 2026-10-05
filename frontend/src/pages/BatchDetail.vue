<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useSyncStore } from '../stores/syncStore';
import { useFaceStore } from '../stores/faceStore';
import { incomingVersion, serializeBatch, type SyncTable } from '../utils/sync';
import {
  deriveGroundwater,
  GROUNDWATERS,
  GRADE_SUPPORT,
  jointsBasisSignature,
  ROCK_GRADES,
  waterBasisSignature,
  type RockGrade,
} from '../types/grade';
import { FILL_MATERIALS, WATER_WETS, type WaterWet } from '../types/joint';
import { CHANGE_TRENDS, INFLOW_TYPES } from '../types/water';
import { useGradeCalc } from '../hooks/useGradeCalc';
import { newId } from '../utils/id';
import { attitudeText, formatChainage } from '../utils/geoMath';
import GradeTag from '../components/common/GradeTag.vue';
import FaceDiffReport from '../components/sync/FaceDiffReport.vue';

const route = useRoute();
const router = useRouter();
const syncStore = useSyncStore();
const faceStore = useFaceStore();

const batchId = computed(() => String(route.params.id ?? ''));
const batch = computed(() => syncStore.byId(batchId.value));
const faceId = computed(() => batch.value?.faceIds[0] ?? '');

// 批次工作区数据 = 共同祖先 + 已暂存增改删（不触碰主库）
const working = computed(() => (batch.value ? incomingVersion(batch.value, faceId.value) : null));
const face = computed(() => working.value?.face);
const joints = computed(() => working.value?.joints ?? []);
const waters = computed(() => working.value?.waters ?? []);
const grades = computed(() =>
  [...(working.value?.grades ?? [])].sort((a, b) => b.judgedAt - a.judgedAt),
);
const latestGrade = computed(() => grades.value[0]);

const faceForm = reactive({
  faceNo: '',
  chainage: 0,
  excavationMethod: '台阶法' as string,
  faceSize: '',
  lithology: '',
  weathering: '',
  rockStrength: 60,
  geologist: '',
  attitude: { strike: 0, dipDirection: 0, dipAngle: 0 },
});

watch(
  face,
  (f) => {
    if (!f) return;
    Object.assign(faceForm, {
      faceNo: f.faceNo,
      chainage: f.chainage,
      excavationMethod: f.excavationMethod,
      faceSize: f.faceSize,
      lithology: f.lithology,
      weathering: f.weathering,
      rockStrength: f.rockStrength,
      geologist: f.geologist,
      attitude: { ...f.attitude },
    });
  },
  { immediate: true },
);

async function saveFace() {
  if (!batch.value || !face.value) return;
  const row = { ...face.value, ...JSON.parse(JSON.stringify(faceForm)) };
  await syncStore.stageUpsert(batch.value, 'faces', row);
  ElMessage.success('掌子面修改已暂存到本离线批次（主库未改动）');
}

/* 节理组 */
const jointForm = reactive({
  setNo: 1,
  dipDirection: 120,
  dipAngle: 60,
  spacing: 40,
  persistence: 3,
  aperture: 1,
  fillMaterial: '方解石' as (typeof FILL_MATERIALS)[number],
  roughness: '粗糙' as string,
  waterWet: '潮湿' as WaterWet,
  jointCount: 5,
});
async function addJoint() {
  if (!batch.value) return;
  if (joints.value.some((j) => j.setNo === jointForm.setNo)) {
    ElMessage.error(`组号 J${jointForm.setNo} 已存在`);
    return;
  }
  await syncStore.stageUpsert(batch.value, 'joints', {
    id: newId('joint'),
    faceId: faceId.value,
    ...JSON.parse(JSON.stringify(jointForm)),
  });
  jointForm.setNo += 1;
  ElMessage.success('节理组已暂存');
}
async function deleteJoint(id: string) {
  if (!batch.value) return;
  await syncStore.stageDelete(batch.value, 'joints', id);
}

/* 涌水 */
const waterForm = reactive({
  position: '',
  type: '滴水' as (typeof INFLOW_TYPES)[number],
  estimatedFlow: 5,
  waterTemp: 15,
  waterPressure: 0.1,
  changeTrend: '稳定' as (typeof CHANGE_TRENDS)[number],
  chainage: 0,
});
watch(
  faceId,
  () => {
    waterForm.chainage = face.value?.chainage ?? 0;
  },
  { immediate: true },
);
async function addWater() {
  if (!batch.value) return;
  if (!waterForm.position.trim()) {
    ElMessage.error('出水部位必填');
    return;
  }
  await syncStore.stageUpsert(batch.value, 'waters', {
    id: newId('water'),
    faceId: faceId.value,
    ...JSON.parse(JSON.stringify(waterForm)),
    position: waterForm.position.trim(),
  });
  waterForm.position = '';
  ElMessage.success('涌水记录已暂存');
}
async function deleteWater(id: string) {
  if (!batch.value) return;
  await syncStore.stageDelete(batch.value, 'waters', id);
}

/* 围岩级别：按当前节理/涌水实时试算，保存为暂存判定（依据签名取自当前工作区） */
const { input, result, patch } = useGradeCalc(() => joints.value);
const manual = ref(false);
const manualGrade = ref<RockGrade>('Ⅲ');
watch(
  () => [face.value, waters.value] as const,
  () => {
    if (face.value) {
      patch({
        rockStrength: face.value.rockStrength,
        spanWidth: Number(face.value.faceSize.split('×')[0]) || 12,
        groundwater: deriveGroundwater(waters.value, input.value.groundwater),
      });
    }
  },
  { immediate: true, deep: true },
);
const finalGrade = computed<RockGrade>(() => (manual.value ? manualGrade.value : result.value.grade));

async function saveGrade() {
  if (!batch.value || !face.value) return;
  const now = Date.now();
  await syncStore.stageUpsert(batch.value, 'grades', {
    id: newId('grade'),
    faceId: faceId.value,
    grade: finalGrade.value,
    bqValue: result.value.bq,
    rqd: input.value.rqd,
    jv: result.value.jv,
    kv: input.value.kv,
    groundwater: input.value.groundwater,
    spanWidth: input.value.spanWidth,
    correction: Number((result.value.k1 + result.value.k2 + input.value.extraCorrection).toFixed(3)),
    correctedBq: result.value.correctedBq,
    supportSuggestion: GRADE_SUPPORT[finalGrade.value],
    manualAdjusted: manual.value,
    judgedAt: now,
    basisValid: true,
    invalidReasons: [],
    basisSignature: {
      joints: jointsBasisSignature(joints.value),
      water: waterBasisSignature(waters.value),
    },
    basedOnBatches: [],
  });
  ElMessage.success('围岩级别判定已随本批次暂存，将带依据签名参与合入');
}

/* 已暂存改动 */
const stagedTables: { key: SyncTable; label: string }[] = [
  { key: 'faces', label: '掌子面' },
  { key: 'joints', label: '节理组' },
  { key: 'grades', label: '围岩级别' },
  { key: 'waters', label: '涌水' },
];
const stagedRows = computed(() => {
  if (!batch.value) return [];
  const out: { table: SyncTable; tableLabel: string; id: string; op: string; name: string }[] = [];
  stagedTables.forEach(({ key, label }) => {
    Object.entries(batch.value![key]).forEach(([id, c]) => {
      out.push({ table: key, tableLabel: label, id, op: c.op, name: changeName(key, c.row) });
    });
  });
  return out;
});
function changeName(table: SyncTable, row: unknown): string {
  const r = row as Record<string, unknown> | undefined;
  if (!r) return '删除';
  if (table === 'faces') return String(r.faceNo ?? '');
  if (table === 'joints') return `J${r.setNo} ${attitudeText(Number(r.dipDirection), Number(r.dipAngle))}`;
  if (table === 'waters') return `${r.position}（${r.type} ${r.estimatedFlow}L/min）`;
  if (table === 'grades') return `${r.grade} 级 · [BQ] ${r.correctedBq}`;
  return '';
}
async function unstageChange(table: SyncTable, id: string) {
  if (!batch.value) return;
  await syncStore.unstage(batch.value, table, id);
}

/* 提交 / 冲突处理 */
async function commit(rebase = false) {
  if (!batch.value) return;
  const outcome = await syncStore.commit(batch.value.id, rebase);
  if (outcome.ok) {
    ElMessage.success(outcome.duplicate ? '该批次此前已合入（幂等跳过，不重复计入）' : '批次合入成功');
  } else {
    ElMessage.error(`冲突：${outcome.batch.conflictReason ?? '另一台平板已先提交'}，修改原样保留在本批次中`);
  }
}
async function retryAsIs() {
  await commit(false);
}
async function keepBoth() {
  try {
    await ElMessageBox.confirm(
      '保留两版合入会跳过两边都改过的字段/同 ID 记录（库中版本不动），其余写入并列差异。确认？',
      '保留两版合入',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  await commit(true);
}
function download() {
  if (!batch.value) return;
  const blob = new Blob([serializeBatch(batch.value)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `batch-${batch.value.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const mergeConflicts = computed(() => batch.value?.mergeReport?.conflicts ?? []);

onMounted(async () => {
  await faceStore.load();
  await syncStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>离线批次 · {{ batch?.label ?? '未找到' }}</h2>
      <el-tag v-if="batch" :type="batch.status === 'conflict' ? 'danger' : batch.status === 'merged' ? 'success' : 'info'">
        {{ batch.status === 'editing' ? '编辑中' : batch.status === 'submitted' ? '待提交' : batch.status === 'merged' ? '已合入' : '冲突' }}
      </el-tag>
      <el-tag type="info" effect="plain">{{ face?.faceNo ?? faceId }}</el-tag>
      <div class="spacer" />
      <el-button @click="download">导出批次文件</el-button>
      <el-button @click="router.push('/sync')">返回批次中心</el-button>
    </div>

    <el-alert v-if="batch?.status === 'conflict'" type="error" :closable="false" show-icon
      :title="`并发冲突：${batch.conflictReason ?? '另一台平板已先提交同一掌子面'}`"
      description="本批次的全部修改未写入、原样保留。可「原样重试」（若对端已撤回则成功），或「保留两版合入」让两边版本并存并列出差异。"
      style="margin-bottom: 4px"
    />
    <el-alert v-if="batch?.status === 'merged'" type="success" :closable="false" show-icon
      title="该批次已合入；再次提交会按批次 id 幂等跳过，旧批次不会重复计入"
      style="margin-bottom: 4px"
    />

    <div v-if="!batch" class="empty"><el-empty description="批次不存在或已删除" /></div>

    <template v-else-if="face">
      <div class="commit-bar">
        <el-button type="primary" :disabled="batch.status === 'merged'" @click="commit(false)">提交合入</el-button>
        <el-button type="warning" :disabled="batch.status !== 'conflict'" @click="retryAsIs">原样重试</el-button>
        <el-button type="success" :disabled="batch.status === 'merged'" @click="keepBoth">保留两版合入</el-button>
        <span class="hint">提交时做并发校验：对端先提交则本批不写入并标记冲突</span>
      </div>

      <el-card shadow="never">
        <template #header><strong>已暂存改动（{{ stagedRows.length }}）— 仅保存在本批次，主库未变</strong></template>
        <el-table :data="stagedRows" size="small" border>
          <el-table-column prop="tableLabel" label="数据" width="100" />
          <el-table-column prop="name" label="内容" min-width="220" />
          <el-table-column label="方式" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.op === 'delete' ? 'danger' : ''">
                {{ row.op === 'delete' ? '删除' : '增改' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="撤销暂存" width="100">
            <template #default="{ row }">
              <el-button size="small" @click="unstageChange(row.table, row.id)">撤销</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="stagedRows.length === 0" description="尚未暂存任何修改" :image-size="50" />
      </el-card>

      <div class="grid">
        <div class="col">
          <el-card shadow="never">
            <template #header><strong>掌子面基本信息</strong></template>
            <el-form label-width="92px" size="small">
              <el-form-item label="编号"><el-input v-model="faceForm.faceNo" /></el-form-item>
              <el-form-item label="里程 m"><el-input-number v-model="faceForm.chainage" :min="0" /></el-form-item>
              <el-form-item label="开挖方式">
                <el-select v-model="faceForm.excavationMethod" style="width: 100%">
                  <el-option label="全断面" value="全断面" />
                  <el-option label="台阶法" value="台阶法" />
                  <el-option label="CD 法" value="CD 法" />
                </el-select>
              </el-form-item>
              <el-form-item label="断面尺寸"><el-input v-model="faceForm.faceSize" /></el-form-item>
              <el-form-item label="岩性"><el-input v-model="faceForm.lithology" /></el-form-item>
              <el-form-item label="风化"><el-input v-model="faceForm.weathering" /></el-form-item>
              <el-form-item label="抗压强度"><el-input-number v-model="faceForm.rockStrength" :min="1" :max="300" /></el-form-item>
              <el-form-item label="地质员"><el-input v-model="faceForm.geologist" /></el-form-item>
              <el-form-item label="倾向/倾角/走向">
                <el-input-number v-model="faceForm.attitude.dipDirection" :min="0" :max="360" />
                <el-input-number v-model="faceForm.attitude.dipAngle" :min="0" :max="90" />
                <el-input-number v-model="faceForm.attitude.strike" :min="0" :max="360" />
              </el-form-item>
              <el-form-item>
                <el-button type="primary" @click="saveFace">暂存掌子面修改</el-button>
              </el-form-item>
            </el-form>
          </el-card>

          <el-card shadow="never">
            <template #header><strong>节理组（{{ joints.length }}）</strong></template>
            <el-table :data="joints" size="small" border>
              <el-table-column label="组" width="50"><template #default="{ row }">J{{ row.setNo }}</template></el-table-column>
              <el-table-column label="产状" width="110">
                <template #default="{ row }">{{ attitudeText(row.dipDirection, row.dipAngle) }}</template>
              </el-table-column>
              <el-table-column prop="spacing" label="间距" width="60" />
              <el-table-column prop="waterWet" label="渗水" width="70" />
              <el-table-column prop="jointCount" label="条数" width="55" />
              <el-table-column label="删" width="55">
                <template #default="{ row }">
                  <el-button size="small" link type="danger" @click="deleteJoint(row.id)">×</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-divider />
            <el-form label-width="72px" size="small">
              <el-form-item label="组号"><el-input-number v-model="jointForm.setNo" :min="1" /></el-form-item>
              <el-form-item label="倾向/倾角">
                <el-input-number v-model="jointForm.dipDirection" :min="0" :max="360" />
                <el-input-number v-model="jointForm.dipAngle" :min="0" :max="90" />
              </el-form-item>
              <el-form-item label="间距cm"><el-input-number v-model="jointForm.spacing" :min="1" /></el-form-item>
              <el-form-item label="渗水">
                <el-select v-model="jointForm.waterWet">
                  <el-option v-for="w in WATER_WETS" :key="w" :label="w" :value="w" />
                </el-select>
              </el-form-item>
              <el-form-item label="条数"><el-input-number v-model="jointForm.jointCount" :min="1" /></el-form-item>
              <el-form-item>
                <el-button type="primary" @click="addJoint">暂存新节理组</el-button>
              </el-form-item>
            </el-form>
          </el-card>
        </div>

        <div class="col">
          <el-card shadow="never">
            <template #header><strong>涌水记录（{{ waters.length }}）</strong></template>
            <el-table :data="waters" size="small" border>
              <el-table-column label="里程" width="95">
                <template #default="{ row }">{{ formatChainage(row.chainage) }}</template>
              </el-table-column>
              <el-table-column prop="position" label="部位" min-width="100" />
              <el-table-column prop="type" label="类型" width="60" />
              <el-table-column label="L/min" width="65">
                <template #default="{ row }">{{ row.estimatedFlow }}</template>
              </el-table-column>
              <el-table-column label="删" width="45">
                <template #default="{ row }">
                  <el-button size="small" link type="danger" @click="deleteWater(row.id)">×</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-divider />
            <el-form label-width="72px" size="small">
              <el-form-item label="部位"><el-input v-model="waterForm.position" /></el-form-item>
              <el-form-item label="类型">
                <el-select v-model="waterForm.type">
                  <el-option v-for="t in INFLOW_TYPES" :key="t" :label="t" :value="t" />
                </el-select>
              </el-form-item>
              <el-form-item label="涌水量"><el-input-number v-model="waterForm.estimatedFlow" :min="0" :max="1000" /></el-form-item>
              <el-form-item label="趋势">
                <el-select v-model="waterForm.changeTrend">
                  <el-option v-for="c in CHANGE_TRENDS" :key="c" :label="c" :value="c" />
                </el-select>
              </el-form-item>
              <el-form-item label="里程"><el-input-number v-model="waterForm.chainage" :min="0" /></el-form-item>
              <el-form-item>
                <el-button type="primary" @click="addWater">暂存新涌水记录</el-button>
              </el-form-item>
            </el-form>
          </el-card>

          <el-card shadow="never">
            <template #header><strong>围岩级别判定（随批次）</strong></template>
            <div v-if="latestGrade" class="grade-line">
              <GradeTag :grade="latestGrade.grade" />
              <el-tag v-if="!latestGrade.basisValid" type="danger" size="small">
                依据失效：{{ latestGrade.invalidReasons?.map((r) => (r === 'joints' ? '节理组' : '涌水状态')).join('、') }}
              </el-tag>
              <span class="hint">[BQ] {{ latestGrade.correctedBq }} · 出水 {{ latestGrade.groundwater }}</span>
            </div>
            <el-divider />
            <el-form label-width="92px" size="small">
              <el-form-item label="RQD %"><el-input-number v-model="input.rqd" :min="0" :max="100" /></el-form-item>
              <el-form-item label="Kv"><el-input-number v-model="input.kv" :min="0" :max="1" :step="0.01" /></el-form-item>
              <el-form-item label="出水状态">
                <el-select v-model="input.groundwater" style="width: 100%">
                  <el-option v-for="g in GROUNDWATERS" :key="g" :label="g" :value="g" />
                </el-select>
              </el-form-item>
              <el-form-item label="其它修正"><el-input-number v-model="input.extraCorrection" :min="0" :max="1" :step="0.01" /></el-form-item>
            </el-form>
            <div class="grade-line">
              <GradeTag :grade="finalGrade" />
              <span class="hint">BQ {{ result.bq }} · [BQ] {{ result.correctedBq }}（出水状态已按当前涌水记录联动）</span>
            </div>
            <el-checkbox v-model="manual" style="margin: 6px 0">人工修正级别</el-checkbox>
            <el-radio-group v-if="manual" v-model="manualGrade" size="small">
              <el-radio-button v-for="g in ROCK_GRADES" :key="g" :value="g">{{ g }}</el-radio-button>
            </el-radio-group>
            <div>
              <el-button type="primary" @click="saveGrade">暂存级别判定</el-button>
            </div>
          </el-card>
        </div>
      </div>

      <template v-if="mergeConflicts.length">
        <el-divider content-position="left">保留两版的差异（{{ mergeConflicts.length }}）</el-divider>
        <FaceDiffReport v-for="c in mergeConflicts" :key="c.faceId" :conflict="c" />
      </template>
    </template>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.commit-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.grade-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0;
  flex-wrap: wrap;
}
.hint {
  color: #97a0ad;
  font-size: 12px;
}
.empty {
  padding: 40px 0;
}
</style>
