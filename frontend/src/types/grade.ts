import type { JointSet } from './joint';
import type { InflowType, WaterInflow } from './water';
import { estimateJv } from '../utils/geoMath';
import { newId, round } from '../utils/id';

/** 围岩级别 Ⅰ ~ Ⅵ */
export type RockGrade = 'Ⅰ' | 'Ⅱ' | 'Ⅲ' | 'Ⅳ' | 'Ⅴ' | 'Ⅵ';

export const ROCK_GRADES: RockGrade[] = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];

/** 出水状态 */
export type Groundwater = '干燥' | '潮湿' | '点滴状出水' | '线状出水' | '涌流状出水';

export const GROUNDWATERS: Groundwater[] = ['干燥', '潮湿', '点滴状出水', '线状出水', '涌流状出水'];

/** 级别判定所依赖的依据类别：节理组 / 涌水状态 */
export type GradeBasis = 'joints' | 'water';

export const BASIS_LABELS: Record<GradeBasis, string> = {
  joints: '节理组',
  water: '涌水状态',
};

/**
 * 判定依据签名：保存判定时节理组与涌水记录的摘要。
 * 合并后若当前摘要与签名不一致，说明依据已被另一台平板改动，原级别失效。
 */
export interface GradeBasisSignature {
  joints: string;
  water: string;
}

/** 围岩级别判定记录 */
export interface RockMassGrade {
  id: string;
  faceId: string;
  grade: RockGrade;
  /** 基本质量指标 BQ */
  bqValue: number;
  /** 岩石质量指标 % */
  rqd: number;
  /** 节理体密度 条/m³ */
  jv: number;
  /** 岩体完整性系数 */
  kv: number;
  groundwater: Groundwater;
  /** 洞跨 m */
  spanWidth: number;
  /** 修正系数合计 */
  correction: number;
  /** 修正后的 [BQ] */
  correctedBq: number;
  /** 支护建议 */
  supportSuggestion: string;
  /** 是否人工修正级别 */
  manualAdjusted: boolean;
  judgedAt: number;
  /** 判定依据当前是否仍有效（合并后依据变化会置为 false） */
  basisValid: boolean;
  /** 失效的依据类别 */
  invalidReasons: GradeBasis[];
  /** 判定时的依据摘要 */
  basisSignature: GradeBasisSignature;
  /** 本级别的上一条判定（重判链） */
  prevGradeId?: string;
  /** 该判定由哪些离线批次合入产生（幂等去重） */
  basedOnBatches: string[];
}

export type RockMassGradeDraft = Omit<
  RockMassGrade,
  'id' | 'judgedAt' | 'basisValid' | 'invalidReasons' | 'basisSignature' | 'prevGradeId' | 'basedOnBatches'
>;

/** 级别色带（用于 <GradeTag>） */
export const GRADE_COLOR: Record<RockGrade, string> = {
  'Ⅰ': '#1f7a4d',
  'Ⅱ': '#3f9e63',
  'Ⅲ': '#c9a227',
  'Ⅳ': '#e08b2f',
  'Ⅴ': '#d3542f',
  'Ⅵ': '#a02622',
};

/** 等级对应的支护建议 */
export const GRADE_SUPPORT: Record<RockGrade, string> = {
  'Ⅰ': '局部锚杆（φ22，L=2.0 m，间距 1.5 m），喷射混凝土 5 cm',
  'Ⅱ': '系统锚杆（φ22，L=2.5 m，间距 1.2 m）+ 喷射混凝土 8 cm',
  'Ⅲ': '系统锚杆（φ25，L=3.0 m，间距 1.0 m）+ 喷射混凝土 12 cm + 钢筋网',
  'Ⅳ': '钢拱架（I16，间距 1.0 m）+ 系统锚杆（φ25，L=3.5 m）+ 喷射混凝土 20 cm',
  'Ⅴ': '超前小导管（φ42，L=4.5 m，环向间距 0.4 m）+ 钢拱架（I18，间距 0.75 m）+ 喷射混凝土 25 cm',
  'Ⅵ': '超前管棚（φ108，L=20 m）+ 钢拱架（I20b，间距 0.5 m）+ 双层钢筋网 + 喷射混凝土 30 cm，必要时超前预注浆',
};

/** 由涌水量与出水状态给出建议措施 */
export function waterMeasure(flow: number, type: string): string {
  if (flow >= 60 || type === '股状' || type === '涌流状出水') {
    return '立即停止掌子面作业，实施超前预注浆 + 径向注浆封堵，加强排水与监测';
  }
  if (flow >= 20) return '布设环向排水盲管 + 局部注浆堵水，加密涌水量监测频次';
  if (flow >= 5) return '设置纵向排水沟与集水坑，记录变化趋势，待喷锚后复测';
  return '常规排水，保持观察并纳入日常编录';
}

/** 出水状态 → 地下水修正系数 K1（简化取值） */
export const GROUNDWATER_K1: Record<Groundwater, number> = {
  干燥: 0,
  潮湿: 0.05,
  点滴状出水: 0.1,
  线状出水: 0.18,
  涌流状出水: 0.28,
};

/** 洞跨 → 主要软弱结构面修正系数 K2（简化取值） */
export function spanK2(spanWidth: number): number {
  if (spanWidth < 5) return 0;
  if (spanWidth < 10) return 0.03;
  if (spanWidth < 15) return 0.06;
  if (spanWidth < 20) return 0.1;
  return 0.15;
}

/** 由 [BQ] 映射围岩级别 */
export function gradeFromBq(correctedBq: number): RockGrade {
  if (correctedBq > 550) return 'Ⅰ';
  if (correctedBq > 450) return 'Ⅱ';
  if (correctedBq > 350) return 'Ⅲ';
  if (correctedBq > 250) return 'Ⅳ';
  if (correctedBq > 150) return 'Ⅴ';
  return 'Ⅵ';
}

/** 涌水类型严重度 0~4（与出水状态等级对应） */
const INFLOW_SEVERITY: Record<InflowType, number> = {
  渗水: 1,
  滴水: 2,
  线流: 3,
  股状: 4,
};

const GROUNDWATER_BY_SEVERITY: Groundwater[] = ['干燥', '潮湿', '点滴状出水', '线状出水', '涌流状出水'];

/** 按估算涌水量给出严重度 */
function flowSeverity(flow: number): number {
  if (flow >= 60) return 4;
  if (flow >= 20) return 3;
  if (flow >= 5) return 2;
  if (flow > 0) return 1;
  return 0;
}

/**
 * 由当前涌水记录推断级别判定用的出水状态（取类型与涌水量的更严重者）。
 * 无涌水记录时沿用原判定（fallback）。
 */
export function deriveGroundwater(waters: WaterInflow[], fallback: Groundwater): Groundwater {
  if (waters.length === 0) return fallback;
  const severity = Math.max(...waters.map((w) => Math.max(INFLOW_SEVERITY[w.type] ?? 0, flowSeverity(w.estimatedFlow))));
  return GROUNDWATER_BY_SEVERITY[Math.min(severity, 4)] ?? fallback;
}

/** 简易稳定哈希（djb2），用于把依据摘要压缩成短签名 */
function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 节理组判定依据签名：组集合、产状、间距、条数等变化都会使签名改变 */
export function jointsBasisSignature(joints: JointSet[]): string {
  const canonical = joints
    .map((j) => ({ ...j }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((j) =>
      [
        j.id,
        j.setNo,
        round(j.dipDirection, 0),
        round(j.dipAngle, 0),
        round(j.spacing, 0),
        round(j.persistence, 1),
        round(j.aperture, 1),
        j.fillMaterial,
        j.roughness,
        j.waterWet,
        j.jointCount,
      ].join('|'),
    )
    .join(';');
  return `j${shortHash(`n=${joints.length}:${canonical}`)}`;
}

/** 涌水判定依据签名：条数、峰值涌水量、最严重类型/状态、最近一条记录 */
export function waterBasisSignature(waters: WaterInflow[]): string {
  if (waters.length === 0) return 'w0';
  const sorted = [...waters].sort((a, b) => a.id.localeCompare(b.id));
  const maxFlow = round(Math.max(...waters.map((w) => w.estimatedFlow)), 0);
  const maxType = Math.max(...waters.map((w) => INFLOW_SEVERITY[w.type] ?? 0));
  const latest = [...waters].sort((a, b) => b.measuredAt - a.measuredAt)[0];
  return shortHash(
    [
      `n=${waters.length}`,
      `flow=${maxFlow}`,
      `type=${maxType}`,
      `latest=${latest.type}:${round(latest.estimatedFlow, 0)}:${latest.changeTrend}`,
      sorted.map((w) => `${w.id}@${round(w.estimatedFlow, 0)}`).join(','),
    ].join('|'),
  );
}

/** 计算一对依据签名中发生变化的类别 */
export function diffBasis(prev: GradeBasisSignature, next: GradeBasisSignature): GradeBasis[] {
  const reasons: GradeBasis[] = [];
  if (prev.joints !== next.joints) reasons.push('joints');
  if (prev.water !== next.water) reasons.push('water');
  return reasons;
}

export interface RejudgeOptions {
  /** 当前饱和抗压强度 MPa（取自合并后的掌子面） */
  rockStrength: number;
  /** 当前洞跨 m */
  spanWidth: number;
  /** 当前节理组（自动估算 Jv 用） */
  joints: JointSet[];
  /** 当前涌水记录（重推出水状态） */
  waters: WaterInflow[];
  /** 重判时间，默认当前 */
  at?: number;
}

/**
 * 依据变化后按当前数据重新判定围岩级别。
 * 人工修正级别保留人工级别与支护建议，仅刷新指标；自动判定重新映射级别。
 * 返回一条新的判定记录（沿用 RQD/Kv，重算 BQ/[BQ]/出水状态/Jv）。
 */
export function rejudgeGrade(prev: RockMassGrade, opts: RejudgeOptions): RockMassGrade {
  const groundwater = deriveGroundwater(opts.waters, prev.groundwater);
  const k1 = GROUNDWATER_K1[groundwater] ?? 0;
  const k2 = spanK2(opts.spanWidth);
  // 从原修正系数中剥离旧 K1/K2，保留 K3（其它修正）
  const oldK1 = GROUNDWATER_K1[prev.groundwater] ?? 0;
  const oldK2 = spanK2(prev.spanWidth);
  const extra = Math.min(1, Math.max(0, round(prev.correction - oldK1 - oldK2, 3)));
  const correction = round(k1 + k2 + extra, 3);
  const bq = round(90 + 3 * opts.rockStrength + 250 * prev.kv, 1);
  const correctedBq = round(bq - 100 * correction, 1);
  const jv = prev.jv > 0 ? prev.jv : round(estimateJv(opts.joints), 2);

  const autoGrade = gradeFromBq(correctedBq);
  const grade = prev.manualAdjusted ? prev.grade : autoGrade;
  const support = prev.manualAdjusted ? prev.supportSuggestion || GRADE_SUPPORT[grade] : GRADE_SUPPORT[grade];

  return {
    ...prev,
    id: newId('grade'),
    grade,
    bqValue: bq,
    jv,
    groundwater,
    spanWidth: opts.spanWidth,
    correction,
    correctedBq,
    supportSuggestion: support,
    judgedAt: opts.at ?? Date.now(),
    basisValid: true,
    invalidReasons: [],
    basisSignature: {
      joints: jointsBasisSignature(opts.joints),
      water: waterBasisSignature(opts.waters),
    },
    prevGradeId: prev.id,
    basedOnBatches: prev.basedOnBatches ? [...prev.basedOnBatches] : [],
  };
}
