import type { TunnelFace } from './face';
import type { JointSet } from './joint';
import type { RockMassGrade } from './grade';
import type { WaterInflow } from './water';

/** 编录平板（设备）标识 */
export type DeviceId = string;

/** 批次里一条记录的变更方式 */
export type ChangeOp = 'upsert' | 'delete';

/** 批次状态机：编辑中 → 待提交 → 已合入 / 冲突 */
export type BatchStatus = 'editing' | 'submitted' | 'merged' | 'conflict';

/** 一张表的行变更集合（键为记录 id） */
export interface TableChanges<T> {
  [id: string]: { op: ChangeOp; row?: T };
}

/** 离线编录批次：两台平板各自在离线期间攒下的一次提交 */
export interface CatalogBatch {
  /** 批次唯一 id（创建时生成，重试/重导入保持不变，是幂等主键） */
  id: string;
  /** 人类可读名称，如「ZK-103 · 平板A」 */
  label: string;
  /** 产生该批次的平板标识 */
  deviceId: DeviceId;
  status: BatchStatus;
  /** 批次创建时间 */
  createdAt: number;
  /** 最近一次提交（尝试合入）时间 */
  submittedAt?: number;
  /** 成功合入时间 */
  mergedAt?: number;
  /**
   * 合入基线：创建批次时各掌子面的修订号（= 当时已合入且触及该掌子面的批次数）。
   * 提交时若某掌子面修订号已变大，说明对端先提交了同一掌子面，判定为并发冲突。
   */
  baseRev: Record<string, number>;
  /** 创建时全局已合入批次数（提交排序用） */
  baseSeq: number;
  /**
   * 共同祖先快照：创建批次时相关记录在库中的原样。
   * 保留两版时用于三方对比（祖先 / 对端现状 / 本批次）。
   */
  ancestor: {
    faces: Record<string, TunnelFace>;
    joints: Record<string, JointSet>;
    grades: Record<string, RockMassGrade>;
    waters: Record<string, WaterInflow>;
  };
  /** 该批次触及的掌子面 id（用于差异比对展示） */
  faceIds: string[];
  faces: TableChanges<TunnelFace>;
  joints: TableChanges<JointSet>;
  grades: TableChanges<RockMassGrade>;
  waters: TableChanges<WaterInflow>;
  /** 合入时服务端返回的冲突说明（冲突批次保留修改时填写） */
  conflictWith?: string;
  conflictReason?: string;
  /** 合入结果摘要（成功时） */
  mergeReport?: MergeReport;
  /** 批次格式版本 */
  schema: number;
}

/** 单掌子面两边版本对比中的一方 */
export interface FaceSideVersion {
  deviceId: DeviceId;
  label: string;
  face?: TunnelFace;
  joints: JointSet[];
  grades: RockMassGrade[];
  waters: WaterInflow[];
}

/** 某个字段的差异 */
export interface FieldDiff {
  field: string;
  label: string;
  base?: unknown;
  local?: unknown;
  remote?: unknown;
  /** 仅一边修改 */
  changedBy: 'local' | 'remote' | 'both';
}

/** 合并结果中需要人工核对的双版本 */
export interface FaceConflict {
  faceId: string;
  faceNo: string;
  /** 合入前库中版本（基线/对端） */
  base: FaceSideVersion;
  /** 本批次带来的版本 */
  incoming: FaceSideVersion;
  /** 字段级差异（掌子面基本信息） */
  fieldDiffs: FieldDiff[];
  /** 节理组 id 维度的新增/删除/修改 */
  jointDiff: { added: JointSet[]; removed: JointSet[]; changed: JointSet[] };
  waterDiff: { added: WaterInflow[]; removed: WaterInflow[]; changed: WaterInflow[] };
}

export interface MergeReport {
  batchId: string;
  /** 新写入的记录 id */
  applied: { faces: number; joints: number; grades: number; waters: number };
  /** 因去重而跳过的记录 id（已由同批次早先写入） */
  skippedDuplicates: string[];
  /** 同一掌子面两边都改过、需要保留两版核对的情况 */
  conflicts: FaceConflict[];
  /** 依据变化而失效并重新判定的掌子面 */
  rejudged: { faceId: string; faceNo: string; fromGradeId: string; toGradeId: string; reasons: string[] }[];
  mergedAt: number;
}

export const BATCH_SCHEMA_VERSION = 1;

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  editing: '编辑中',
  submitted: '待提交',
  merged: '已合入',
  conflict: '冲突',
};
