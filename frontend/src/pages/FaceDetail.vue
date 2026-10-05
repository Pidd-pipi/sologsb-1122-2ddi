<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeCalc } from '../hooks/useGradeCalc';
import SketchCanvas from '../components/common/SketchCanvas.vue';
import GradeTag from '../components/common/GradeTag.vue';
import { attitudeText, formatChainage } from '../utils/geoMath';
import { GRADE_SUPPORT } from '../types/grade';
import { diffFields } from '../services/mergePlan';

const route = useRoute();
const router = useRouter();
const faceStore = useFaceStore();
const jointStore = useJointStore();
const gradeStore = useGradeStore();

const faceId = computed(() => String(route.params.id ?? ''));
const face = computed(() => faceStore.byId(faceId.value));
const joints = computed(() => jointStore.byFace(faceId.value));
const grades = computed(() => gradeStore.byFace(faceId.value));
const latest = computed(() => grades.value[0]);
const latestValid = computed(() => gradeStore.validByFace(faceId.value));
/** 最近一次失效记录（其依据已变化） */
const invalidated = computed(() => grades.value.find((g) => g.invalid === true));
const previousGrade = computed(() => grades.value.filter((g) => g.invalid !== true)[1]);

/** 两版都留的合并冲突：对端归档版本与字段差异 */
const remoteDiffs = computed(() =>
  face.value?.remoteSnapshot ? diffFields(face.value, face.value.remoteSnapshot) : [],
);

const { result, patch } = useGradeCalc(() => joints.value);
const segmentCount = ref(0);

/** SketchCanvas 变更回调（用命名函数避免模板内联箭头参数丢类型） */
function onSketchChange(segs: { id: string }[]): void {
  segmentCount.value = segs.length;
}

/** 与上循环级别比对结论 */
const gradeCompare = computed(() => {
  if (!latestValid.value) return '';
  if (!previousGrade.value) return `本掌子面首次判定为 ${latestValid.value.grade} 级围岩`;
  const order = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];
  const delta = order.indexOf(latestValid.value.grade) - order.indexOf(previousGrade.value.grade);
  if (delta === 0) return `与上一循环一致（${latestValid.value.grade} 级）`;
  return delta > 0
    ? `较上一循环变差 ${delta} 级：${previousGrade.value.grade} → ${latestValid.value.grade}`
    : `较上一循环变好 ${-delta} 级：${previousGrade.value.grade} → ${latestValid.value.grade}`;
});

onMounted(async () => {
  await faceStore.load();
  await jointStore.load();
  await gradeStore.load();
  if (face.value) {
    patch({ rockStrength: face.value.rockStrength, spanWidth: Number(face.value.faceSize.split('×')[0]) || 12 });
  }
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>掌子面详情 · {{ face?.faceNo ?? '未找到' }}</h2>
      <GradeTag v-if="latestValid" :grade="latestValid.grade" />
      <el-tag v-else type="info">未判定级别</el-tag>
      <el-tag v-if="invalidated" type="danger" effect="dark">
        原 {{ invalidated.grade }} 级已失效
      </el-tag>
      <el-tag type="info" effect="plain">节理 {{ joints.length }} 组</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="router.push(`/faces/${faceId}/joints`)">节理录入</el-button>
      <el-button @click="router.push(`/faces/${faceId}/water`)">涌水记录</el-button>
      <el-button @click="router.push(`/grade/${faceId}`)">围岩级别判定</el-button>
      <el-button @click="router.push('/faces')">返回台账</el-button>
    </div>

    <el-alert v-if="!face" type="warning" :closable="false" show-icon title="未找到该掌子面（可能已被删除）" />

    <div v-if="face" class="grid">
      <div class="left">
        <el-card shadow="never">
          <template #header><strong>基本信息</strong></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="掌子面编号">{{ face.faceNo }}</el-descriptions-item>
            <el-descriptions-item label="里程桩号">{{ formatChainage(face.chainage) }}</el-descriptions-item>
            <el-descriptions-item label="编录里程区间">
              {{ formatChainage(face.mileageRange[0]) }} ~ {{ formatChainage(face.mileageRange[1]) }}
            </el-descriptions-item>
            <el-descriptions-item label="开挖方式">{{ face.excavationMethod }}</el-descriptions-item>
            <el-descriptions-item label="开挖断面尺寸">{{ face.faceSize }} m</el-descriptions-item>
            <el-descriptions-item label="岩性 / 风化">{{ face.lithology }} / {{ face.weathering }}</el-descriptions-item>
            <el-descriptions-item label="饱和抗压强度">{{ face.rockStrength }} MPa</el-descriptions-item>
            <el-descriptions-item label="岩层产状">
              走向 {{ face.attitude.strike }}° · {{ attitudeText(face.attitude.dipDirection, face.attitude.dipAngle) }}
            </el-descriptions-item>
            <el-descriptions-item label="地质员">{{ face.geologist }}</el-descriptions-item>
            <el-descriptions-item label="编录时间">
              {{ new Date(face.recordedAt).toLocaleString('zh-CN') }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>级别与支护</strong></template>
          <el-alert
            v-if="invalidated"
            :title="`原 ${invalidated.grade} 级判定已失效：${invalidated.invalidReason ?? '依据发生变化'}`"
            :type="latestValid ? 'warning' : 'error'"
            :closable="false"
            show-icon
            style="margin-bottom: 8px"
          />
          <div v-if="latestValid" class="grade-box">
            <div class="grade-line">
              <GradeTag :grade="latestValid.grade" />
              <el-tag v-if="latestValid.autoRejudged" size="small" type="warning">依据变化后自动重判</el-tag>
              <el-tag v-else-if="latestValid.manualAdjusted" size="small">人工修正</el-tag>
            </div>
            <span class="muted">[BQ] = {{ latestValid.correctedBq }}（BQ {{ latestValid.bqValue }}，修正 {{ latestValid.correction }}）</span>
            <p v-if="latestValid.autoRejudgeReason" class="muted rejudge-note">{{ latestValid.autoRejudgeReason }}</p>
            <p class="support">{{ latestValid.supportSuggestion || GRADE_SUPPORT[latestValid.grade] }}</p>
            <p class="muted">{{ gradeCompare }}</p>
            <div v-if="invalidated" class="stale-old">
              失效记录：{{ invalidated.grade }} 级（BQ {{ invalidated.bqValue }}，[BQ] {{ invalidated.correctedBq }}）
            </div>
          </div>
          <div v-else-if="invalidated">
            <p class="muted">原级别已失效，且为人工修正结论，需人工重新判定：</p>
            <el-button type="primary" size="small" @click="router.push(`/grade/${faceId}`)">前往重新判定</el-button>
          </div>
          <div v-else>
            <p class="muted">尚未判定级别，按当前参数实时试算：</p>
            <GradeTag :grade="result.grade" />
            <p class="support">{{ result.support }}</p>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>节理组列表（{{ joints.length }} 组）</strong></template>
          <el-table :data="joints" size="small" border>
            <el-table-column label="组号" width="70">
              <template #default="{ row }">J{{ row.setNo }}</template>
            </el-table-column>
            <el-table-column label="产状" width="140">
              <template #default="{ row }">{{ attitudeText(row.dipDirection, row.dipAngle) }}</template>
            </el-table-column>
            <el-table-column prop="spacing" label="间距 cm" width="90" />
            <el-table-column prop="persistence" label="延伸 m" width="90" />
            <el-table-column prop="aperture" label="张开 mm" width="90" />
            <el-table-column prop="fillMaterial" label="充填" width="90" />
            <el-table-column prop="waterWet" label="渗水" width="90" />
            <el-table-column prop="jointCount" label="条数" width="80" />
          </el-table>
          <el-empty v-if="joints.length === 0" description="暂无节理组记录" :image-size="60" />
        </el-card>
      </div>

      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <strong>岩性素描图</strong>
            <span class="muted">已布置 {{ segmentCount }} 条结构面线段（自动保存在浏览器本地）</span>
          </div>
        </template>
        <SketchCanvas
          :face-id="face.id"
          :lithology="face.lithology"
          :attitude="face.attitude"
          @change="onSketchChange"
        />
      </el-card>
    </div>

    <el-card v-if="face && face.remoteSnapshot" shadow="never" class="remote-card">
      <template #header>
        <div class="card-head">
          <strong>合并保留的对端版本（两版都留）</strong>
          <el-tag size="small" type="warning">存在 {{ remoteDiffs.length }} 处差异</el-tag>
          <span v-if="face.remoteSource" class="muted">来源 {{ face.remoteSource }}</span>
        </div>
      </template>
      <el-table :data="remoteDiffs" size="small" border>
        <el-table-column prop="label" label="差异字段" width="150" />
        <el-table-column label="本机版本（当前主版本）" min-width="180">
          <template #default="{ row }"><span class="local-val">{{ row.local }}</span></template>
        </el-table-column>
        <el-table-column label="对端版本（归档保留）" min-width="180">
          <template #default="{ row }"><span class="remote-val">{{ row.remote }}</span></template>
        </el-table-column>
      </el-table>
      <p class="muted" style="margin: 8px 0 0">
        对端编号 {{ face.remoteSnapshot.faceNo }} · {{ face.remoteSnapshot.lithology }}（{{ face.remoteSnapshot.weathering }}）
        · {{ formatChainage(face.remoteSnapshot.chainage) }} · 地质员 {{ face.remoteSnapshot.geologist }}
      </p>
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
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: 620px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.left {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.support {
  margin: 8px 0;
  color: #2f3a46;
}
.grade-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grade-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rejudge-note {
  margin: 2px 0;
}
.stale-old {
  margin-top: 4px;
  font-size: 12px;
  color: #b04a2f;
  text-decoration: line-through;
  opacity: 0.85;
}
.remote-card :deep(.local-val) {
  color: #1f4f8a;
}
.remote-card :deep(.remote-val) {
  color: #b45309;
}
</style>
