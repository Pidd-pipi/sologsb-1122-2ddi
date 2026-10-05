import type { JointSet } from '../types/joint';
import type { WaterInflow, InflowType } from '../types/water';
import {
  GRADE_SUPPORT,
  type Groundwater,
  type RockGrade,
  type RockMassGrade,
} from '../types/grade';
import { estimateJv } from '../utils/geoMath';
import { gradeFromBq, GROUNDWATER_K1, spanK2 } from '../hooks/useGradeCalc';

/** 节理组依据签名：组数量、各组产状/间距/渗水状态/条数变化都会使签名变化 */
export function jointBasisSignature(joints: JointSet[]): string {
  const sorted = [...joints].sort((a, b) => a.id.localeCompare(b.id));
  const parts = sorted.map(
    (j) =>
      `${j.id}|${j.setNo}|${j.dipDirection}|${j.dipAngle}|${j.spacing}|${j.persistence}|${j.aperture}|${j.fillMaterial}|${j.roughness}|${j.waterWet}|${j.jointCount}`,
  );
  return `J:${parts.join(';')}`;
}

/** 涌水依据签名：记录数量、出水类型/涌水量/趋势/部位变化都会使签名变化 */
export function waterBasisSignature(waters: WaterInflow[]): string {
  const sorted = [...waters].sort((a, b) => a.id.localeCompare(b.id));
  const parts = sorted.map(
    (w) => `${w.id}|${w.type}|${w.estimatedFlow}|${w.changeTrend}|${w.position}|${w.chainage}`,
  );
  return `W:${parts.join(';')}`;
}

/** 级别是否因节理或涌水依据变化而失效 */
export function isGradeBasisStale(
  grade: RockMassGrade,
  joints: JointSet[],
  waters: WaterInflow[],
): { stale: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (grade.basisJointSig !== undefined && grade.basisJointSig !== jointBasisSignature(joints)) {
    reasons.push('节理组');
  }
  if (grade.basisWaterSig !== undefined && grade.basisWaterSig !== waterBasisSignature(waters)) {
    reasons.push('涌水状态');
  }
  return { stale: reasons.length > 0, reasons };
}

/**
 * 由涌水记录推导级别判定用的出水状态（K1）。
 * 涌水类型与涌水量同时变化都能反映涌水状态改变。
 */
export function inferGroundwater(waters: WaterInflow[], joints: JointSet[]): Groundwater {
  if (waters.length > 0) {
    const latest = [...waters].sort((a, b) => b.measuredAt - a.measuredAt)[0];
    const maxFlow = Math.max(...waters.map((w) => w.estimatedFlow));
    const worstType = worstInflowType(waters.map((w) => w.type));
    if (maxFlow >= 60 || worstType === '股状') return '涌流状出水';
    if (maxFlow >= 20 || worstType === '线流') return '线状出水';
    if (maxFlow >= 5 || worstType === '滴水') return '点滴状出水';
    // 有记录但量很小，视为潮湿
    void latest;
    return '潮湿';
  }
  // 没有涌水记录时，退而参考节理渗水状态
  const has = (wet: string) => joints.some((j) => j.waterWet === wet);
  if (has('线流')) return '线状出水';
  if (has('滴水')) return '点滴状出水';
  if (has('潮湿')) return '潮湿';
  return '干燥';
}

const INFLOW_ORDER: Record<InflowType, number> = { 渗水: 0, 滴水: 1, 线流: 2, 股状: 3 };

function worstInflowType(types: InflowType[]): InflowType {
  return types.reduce<InflowType>((worst, t) => (INFLOW_ORDER[t] > INFLOW_ORDER[worst] ? t : worst), '渗水');
}

/** 由节理体密度 Jv 近似岩体完整性系数 Kv（经验映射，仅用于自动重判） */
export function kvFromJv(jv: number): number {
  if (jv <= 0) return 0.6;
  if (jv < 3) return 0.75;
  if (jv < 10) return 0.55;
  if (jv < 20) return 0.35;
  if (jv < 30) return 0.2;
  return 0.1;
}

export interface RejudgeInput {
  rockStrength: number;
  rqd: number;
  jv: number;
  kv: number;
  groundwater: Groundwater;
  spanWidth: number;
  extraCorrection: number;
}

export interface RejudgeResult {
  grade: RockGrade;
  bqValue: number;
  correctedBq: number;
  correction: number;
  supportSuggestion: string;
  kv: number;
  jv: number;
  groundwater: Groundwater;
}

/**
 * 按现行 BQ 规则用最新参数重算级别。
 * - 仅涌水变化：BQ 沿用原判定（Rc/Kv 等基本指标未变），只重取地下水修正 K1；
 * - 节理变化：由新 Jv 重估 Kv，并用当前岩石强度重算 BQ；
 * RQD、洞跨等沿用原判定。
 *
 * @param jointsChanged 节理依据是否变化
 */
export function rejudgeGrade(
  prev: RockMassGrade,
  rockStrength: number,
  joints: JointSet[],
  waters: WaterInflow[],
  jointsChanged: boolean,
): RejudgeResult {
  const jv = estimateJv(joints);
  const groundwater = inferGroundwater(waters, joints);
  const kv = jointsChanged ? kvFromJv(jv) : prev.kv;
  const bq = jointsChanged ? round1(90 + 3 * rockStrength + 250 * kv) : prev.bqValue;
  const spanWidth = prev.spanWidth;
  const extraCorrection = Math.max(
    0,
    prev.correction - (GROUNDWATER_K1[prev.groundwater] ?? 0) - spanK2(spanWidth),
  );

  const k1 = GROUNDWATER_K1[groundwater] ?? 0;
  const k2 = spanK2(spanWidth);
  const correction = round3(k1 + k2 + extraCorrection);
  const correctedBq = round1(bq - 100 * correction);
  const grade = gradeFromBq(correctedBq);
  return {
    grade,
    bqValue: bq,
    correctedBq,
    correction,
    supportSuggestion: GRADE_SUPPORT[grade],
    kv,
    jv,
    groundwater,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
