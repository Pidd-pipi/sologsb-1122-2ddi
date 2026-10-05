import type { FieldDiff, MergeConflict, SyncBatch, BatchChange } from '../types/sync';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import type { RockMassGrade } from '../types/grade';
import type { ChangeEntry } from '../types/sync';

/** 合并规划中的一条待执行动作 */
export interface MergeAction {
  change: BatchChange;
  type: 'apply-upsert' | 'apply-remove' | 'skip';
}

export interface MergePlan {
  actions: MergeAction[];
  conflicts: Omit<MergeConflict, 'createdAt' | 'resolvedAt' | 'status'>[];
}

export interface LocalContext {
  /** 当前库中的记录（已删除则为 null） */
  record: object | null;
  /** 本机对该记录尚未提交（batchId===null）的变更；没有则 null */
  pending: ChangeEntry | null;
  /** 本机上次导出后、已经提交的变更（batchId 非空） */
  lastLogged: ChangeEntry | null;
  /** 已存在的同批次冲突（原样重试时去重） */
  existingConflict?: MergeConflict;
}

/**
 * 规划一个批次的合入方式：
 * - 本机没有该记录且无变更 → 直接写入；
 * - 只有一方改过（对方新改、本机没动）→ 按 updatedAt 直接覆盖或删除；
 * - 两边都改过 → 登记冲突：同一掌子面两边都改过时保留两版并标出差异。
 */
export function planMerge(batch: SyncBatch, contexts: Map<string, LocalContext>): MergePlan {
  const actions: MergeAction[] = [];
  const conflicts: MergePlan['conflicts'] = [];

  for (const change of batch.changes) {
    const ctx = contexts.get(`${change.tableName}:${change.recordId}`) ?? {
      record: null,
      pending: null,
      lastLogged: null,
    };

    // 本机尚未提交的修改还在 → 两边都可能改过
    if (ctx.pending) {
      const conflict = detectConflict(change, ctx, batch);
      if (conflict) {
        if (ctx.existingConflict) {
          actions.push({ change, type: 'skip' });
        } else {
          conflicts.push(conflict);
        }
        continue;
      }
      // 内容一致（含本机 pending 删除 + 对端删除的情形）：无冲突
      actions.push({ change, type: 'skip' });
      continue;
    }

    // 本机已提交的变更与对端变更同时存在，按最后修改时间裁决；时间相同且内容不同视为冲突
    if (!ctx.pending && ctx.lastLogged && ctx.record && change.operation === 'upsert') {
      const localUpdated = Number((ctx.record as Record<string, unknown> | null)?.updatedAt ?? ctx.lastLogged.updatedAt ?? 0);
      const sameContent = jsonEqual(ctx.record, change.snapshot);
      if (sameContent) {
        actions.push({ change, type: 'skip' });
        continue;
      }
      if (change.updatedAt === localUpdated) {
        if (!ctx.existingConflict) {
          conflicts.push(detectConflict(change, ctx, batch) ?? fallbackConflict(change, ctx, batch));
        }
        actions.push({ change, type: 'skip' });
        continue;
      }
      // 时间不同：较新者胜（此分支对端一定是 upsert）
      if (change.updatedAt > localUpdated) {
        actions.push({ change, type: 'apply-upsert' });
      } else {
        actions.push({ change, type: 'skip' });
      }
      continue;
    }

    // 本机从未动过（或本机版本已删除）
    if (!ctx.record) {
      actions.push({ change, type: change.operation === 'remove' ? 'skip' : 'apply-upsert' });
      continue;
    }

    const sameContent = jsonEqual(ctx.record, change.snapshot);
    if (sameContent) {
      actions.push({ change, type: 'skip' });
      continue;
    }
    // 本机有记录但没有任何变更日志 → 本机从未改过该记录（示范数据/此前合入所得），
    // 对端是唯一修改方：直接采用对端版本或删除。
    actions.push({ change, type: change.operation === 'remove' ? 'apply-remove' : 'apply-upsert' });
  }

  return { actions, conflicts };
}

function detectConflict(
  change: BatchChange,
  ctx: LocalContext,
  batch: SyncBatch,
): MergePlan['conflicts'][number] | null {
  const localSnap = ctx.pending?.operation === 'remove' ? undefined : ctx.pending?.snapshot ?? ctx.record ?? undefined;
  const localExists = ctx.pending?.operation !== 'remove' && (ctx.record !== null || ctx.pending?.snapshot);

  // 两边内容一致：不是冲突
  if (change.operation === 'upsert' && localSnap && jsonEqual(localSnap, change.snapshot)) {
    return null;
  }

  let kind: MergeConflict['kind'];
  if (change.tableName === 'faces' && change.operation === 'upsert' && localExists) {
    kind = 'face-diverge';
  } else if (change.operation === 'remove' && localExists) {
    kind = 'remote-delete-local-edit';
  } else if (change.operation === 'upsert' && ctx.pending?.operation === 'remove') {
    kind = 'local-delete-remote-edit';
  } else if (change.operation === 'upsert' && localExists) {
    kind = 'upsert-upsert';
  } else {
    return null;
  }

  const localUpdatedAt = ctx.pending?.updatedAt ?? Number((ctx.record as any)?.updatedAt ?? 0);
  const conflict = {
    id: `${batch.batchId}:${change.tableName}:${change.recordId}`,
    batchId: batch.batchId,
    kind,
    tableName: change.tableName,
    recordId: change.recordId,
    faceId: change.faceId,
    localSnapshot: localSnap as unknown,
    remoteSnapshot: change.operation === 'remove' ? undefined : change.snapshot,
    diffs: change.tableName === 'faces' ? diffFields(localSnap as TunnelFace, change.snapshot as TunnelFace) : [],
    localUpdatedAt,
    remoteUpdatedAt: change.updatedAt,
    localDeviceId: ctx.pending?.deviceId ?? '',
    remoteDeviceId: change.deviceId,
  };
  return conflict;
}

function fallbackConflict(change: BatchChange, ctx: LocalContext, batch: SyncBatch): MergePlan['conflicts'][number] {
  return {
    id: `${batch.batchId}:${change.tableName}:${change.recordId}`,
    batchId: batch.batchId,
    kind: change.tableName === 'faces' ? 'face-diverge' : 'upsert-upsert',
    tableName: change.tableName,
    recordId: change.recordId,
    faceId: change.faceId,
    localSnapshot: (ctx.record ?? undefined) as unknown,
    remoteSnapshot: change.snapshot,
    diffs:
      change.tableName === 'faces'
        ? diffFields(ctx.record as unknown as TunnelFace, change.snapshot as TunnelFace)
        : [],
    localUpdatedAt: Number((ctx.record as any)?.updatedAt ?? 0),
    remoteUpdatedAt: change.updatedAt,
    localDeviceId: '',
    remoteDeviceId: change.deviceId,
  };
}

const FIELD_LABELS: Record<string, string> = {
  faceNo: '掌子面编号',
  chainage: '里程桩号',
  mileageRange: '编录里程区间',
  excavationMethod: '开挖方式',
  faceSize: '断面尺寸',
  lithology: '岩性',
  weathering: '风化程度',
  rockStrength: '饱和抗压强度',
  'attitude.strike': '岩层走向',
  'attitude.dipDirection': '岩层倾向',
  'attitude.dipAngle': '岩层倾角',
  geologist: '地质员',
  recordedAt: '编录时间',
};

/** 列出两条掌子面记录的字段级差异（忽略同步元数据） */
export function diffFields(local?: TunnelFace, remote?: TunnelFace): FieldDiff[] {
  if (!local || !remote) return [];
  const diffs: FieldDiff[] = [];
  for (const path of Object.keys(FIELD_LABELS)) {
    const lv = getPath(local, path);
    const rv = getPath(remote, path);
    if (!jsonEqual(lv, rv)) {
      diffs.push({
        path,
        label: FIELD_LABELS[path],
        local: displayValue(path, lv),
        remote: displayValue(path, rv),
      });
    }
  }
  return diffs;
}

/** 非掌子面记录（节理组/涌水）的概要差异，供冲突列表展示 */
export function summarizeChange(tableName: string, snap: unknown): string {
  if (!snap || typeof snap !== 'object') return '—';
  const r = snap as Partial<JointSet & WaterInflow & RockMassGrade>;
  if (tableName === 'joints') {
    return `J${r.setNo} 产状 ${r.dipDirection}°∠${r.dipAngle}° · ${r.waterWet} · ${r.jointCount} 条`;
  }
  if (tableName === 'waters') {
    return `${r.type} ${r.estimatedFlow} L/min · 趋势${r.changeTrend} · ${r.position}`;
  }
  if (tableName === 'grades') {
    return `${r.grade} 级 · [BQ] ${r.correctedBq}${r.manualAdjusted ? '（人工修正）' : ''}`;
  }
  return '—';
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]), obj);
}

function displayValue(path: string, value: unknown): unknown {
  if (value === undefined) return '（无）';
  if (path === 'recordedAt' && typeof value === 'number') return new Date(value).toLocaleString('zh-CN');
  if (path === 'mileageRange' && Array.isArray(value)) return `${value[0]} ~ ${value[1]}`;
  return value;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(stripMeta(a)) === JSON.stringify(stripMeta(b));
}

/** 比较时忽略同步元数据，避免 updatedAt 不同导致永远判不一致 */
function stripMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMeta);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'updatedAt' || k === 'updatedBy' || k === 'remoteSnapshot' || k === 'remoteSource') continue;
      out[k] = stripMeta(v);
    }
    return out;
  }
  return value;
}
