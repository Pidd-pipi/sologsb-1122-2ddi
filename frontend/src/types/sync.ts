/** 可同步的业务表名（素描线段存在 localStorage，不纳入批次） */
export type SyncTableName = 'faces' | 'joints' | 'grades' | 'waters';

export const SYNC_TABLE_NAMES: SyncTableName[] = ['faces', 'joints', 'grades', 'waters'];

/** 变更操作类型 */
export type SyncOperation = 'upsert' | 'remove';

/** 本地变更日志（outbox）：一台平板上尚未提交的修改 */
export interface ChangeEntry {
  /** `${tableName}:${recordId}`，同一条记录只保留最新一版变更 */
  key: string;
  tableName: SyncTableName;
  recordId: string;
  /** 关联掌子面（face 记录用自身 id），用于围岩级别失效判定 */
  faceId: string;
  operation: SyncOperation;
  /** upsert 时的记录全量快照（合并基线） */
  snapshot?: unknown;
  /** 该记录最后修改时间，冲突时取较新版本 */
  updatedAt: number;
  /** 最后修改它的设备 */
  deviceId: string;
  /** 已写入导出批次的批次号；未导出为 null */
  batchId: string | null;
}

/** 批次中的一条变更（snapshot 为提交时快照） */
export interface BatchChange {
  tableName: SyncTableName;
  recordId: string;
  faceId: string;
  operation: SyncOperation;
  snapshot?: unknown;
  updatedAt: number;
  deviceId: string;
}

/** 离线编录批次：两台平板之间通过导出/导入 JSON 文件传递 */
export interface SyncBatch {
  /** 固定标识，供幂等去重 */
  format: 'gbtunnelface-batch';
  schemaVersion: 3;
  batchId: string;
  deviceId: string;
  deviceName: string;
  exportedAt: number;
  baseVersion: number;
  changes: BatchChange[];
}

/** 已合入批次登记表主键为 batchId，保证旧批次不能重复计入 */
export interface CommittedBatch {
  batchId: string;
  deviceId: string;
  deviceName: string;
  importedAt: number;
  changeCount: number;
}

/** 冲突类型 */
export type ConflictKind =
  | 'face-diverge' // 同一掌子面两边都改过
  | 'upsert-upsert' // 同一非掌子面记录两边都改过
  | 'remote-delete-local-edit' // 对方删除、本机改过
  | 'local-delete-remote-edit'; // 本机删除、对方改过

export type ConflictStatus = 'pending' | 'accepted-local' | 'accepted-remote' | 'kept-both';

/** 字段级差异 */
export interface FieldDiff {
  /** 字段路径，如 lithology / attitude.dipAngle */
  path: string;
  label: string;
  local?: unknown;
  remote?: unknown;
}

/**
 * 合入冲突。
 * 同一掌子面两边都改过时，face 行保留本机版本，对端版本整体存入 remoteSnapshot，
 * 字段级差异存入 diffs，由用户在界面上选择保留哪版或两版都留。
 */
export interface MergeConflict {
  /** `${batchId}:${tableName}:${recordId}`，同一批次重放不重复登记 */
  id: string;
  batchId: string;
  kind: ConflictKind;
  status: ConflictStatus;
  tableName: SyncTableName;
  recordId: string;
  faceId: string;
  /** 本机（当前库）版本；本机已删除时为空 */
  localSnapshot?: unknown;
  /** 批次携带的对端版本；对端删除时为空 */
  remoteSnapshot?: unknown;
  /** 仅 face-diverge 使用：字段级差异 */
  diffs: FieldDiff[];
  localUpdatedAt: number;
  remoteUpdatedAt: number;
  localDeviceId: string;
  remoteDeviceId: string;
  createdAt: number;
  resolvedAt: number | null;
}

/** 合入结果统计 */
export interface CommitResult {
  /** applied=正常写入；duplicate=批次曾经合入过，原样返回不重复计数；locked=有另一台/另一个标签页正在提交 */
  outcome: 'applied' | 'duplicate' | 'locked' | 'invalid';
  batchId: string;
  deviceName: string;
  applied: number;
  conflicts: number;
  invalidatedGrades: number;
  /** duplicate 时回显上次合入信息 */
  committedAt?: number;
  /** invalid 时的原因 */
  error?: string;
}
