import { db } from './db';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { GradeBasis, RockMassGrade } from '../types/grade';
import {
  BASIS_LABELS,
  diffBasis,
  jointsBasisSignature,
  rejudgeGrade,
  waterBasisSignature,
} from '../types/grade';
import type { WaterInflow } from '../types/water';
import {
  BATCH_SCHEMA_VERSION,
  type CatalogBatch,
  type DeviceId,
  type FaceConflict,
  type FieldDiff,
  type MergeReport,
  type TableChanges,
} from '../types/sync';
import { newId } from './id';

const DEVICE_KEY = 'gbtunnelface:device-id';
const DEVICE_NAME_KEY = 'gbtunnelface:device-name';

export type SyncTable = 'faces' | 'joints' | 'grades' | 'waters';

const TABLES: SyncTable[] = ['faces', 'joints', 'grades', 'waters'];

/* ---------------------------------- 设备 ---------------------------------- */

/** 当前平板标识（存 localStorage，导出的批次会携带） */
export function currentDeviceId(): DeviceId {
  let id = '';
  try {
    id = window.localStorage.getItem(DEVICE_KEY) ?? '';
  } catch {
    id = '';
  }
  if (!id) {
    id = newId('dev');
    try {
      window.localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* 忽略 */
    }
  }
  return id;
}

export function currentDeviceName(): string {
  try {
    return window.localStorage.getItem(DEVICE_NAME_KEY) ?? '本机';
  } catch {
    return '本机';
  }
}

export function setCurrentDevice(id: DeviceId, name: string): void {
  try {
    window.localStorage.setItem(DEVICE_KEY, id);
    window.localStorage.setItem(DEVICE_NAME_KEY, name);
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------ 修订号 / 基线 ----------------------------- */

/** 某掌子面当前修订号 = 已合入且触及该掌子面的批次数 */
function revisionsFromMerged(merged: CatalogBatch[]): Map<string, number> {
  const rev = new Map<string, number>();
  merged
    .filter((b) => b.status === 'merged')
    .sort((a, b) => (a.mergedAt ?? 0) - (b.mergedAt ?? 0))
    .forEach((b) => {
      b.faceIds.forEach((fid) => rev.set(fid, (rev.get(fid) ?? 0) + 1));
    });
  return rev;
}

/* -------------------------------- 批次创建 -------------------------------- */

export interface CreateBatchInput {
  label: string;
  deviceId?: DeviceId;
  deviceName?: string;
  /** 该批次要编录的掌子面（可在后续继续 stage 时扩充） */
  faceIds: string[];
}

/** 建一个离线批次：记录共同祖先快照与合入基线修订号 */
export async function createBatch(input: CreateBatchInput): Promise<CatalogBatch> {
  const deviceId = input.deviceId ?? currentDeviceId();
  const merged = await db.batches.where('status').equals('merged').toArray();
  const rev = revisionsFromMerged(merged);
  const faceIds = Array.from(new Set(input.faceIds));

  const [faces, joints, grades, waters] = await Promise.all([
    db.faces.toArray(),
    db.joints.toArray(),
    db.grades.toArray(),
    db.waters.toArray(),
  ]);
  const faceSet = new Set(faceIds);
  const byFace = <T extends { id: string; faceId?: string }>(rows: T[]) =>
    Object.fromEntries(rows.filter((r) => r.faceId && faceSet.has(r.faceId)).map((r) => [r.id, r]));

  const ancestorFaces = Object.fromEntries(faces.filter((f) => faceSet.has(f.id)).map((f) => [f.id, f]));
  const now = Date.now();

  const batch: CatalogBatch = {
    id: newId('batch'),
    label: input.label,
    deviceId,
    status: 'editing',
    createdAt: now,
    baseRev: Object.fromEntries(faceIds.map((fid) => [fid, rev.get(fid) ?? 0])),
    baseSeq: merged.length,
    faceIds,
    faces: {},
    joints: {},
    grades: {},
    waters: {},
    ancestor: {
      faces: ancestorFaces,
      joints: byFace(joints),
      grades: byFace(grades),
      waters: byFace(waters),
    },
    schema: BATCH_SCHEMA_VERSION,
  };
  await db.batches.put(batch);
  return batch;
}

/* -------------------------------- 暂存修改 -------------------------------- */

function ensureFace(batch: CatalogBatch, faceId?: string) {
  if (faceId && !batch.faceIds.includes(faceId)) batch.faceIds.push(faceId);
}

/** 暂存一条新增/修改；若已还原回祖先内容则自动撤销暂存 */
export function stageUpsert<T extends { id: string; faceId?: string }>(
  batch: CatalogBatch,
  table: SyncTable,
  row: T,
): void {
  const changes = batch[table] as unknown as TableChanges<T>;
  const ancestor = (batch.ancestor[table] as unknown as Record<string, T>)[row.id];
  if (ancestor && stableEqual(ancestor, row)) {
    delete changes[row.id];
    return;
  }
  changes[row.id] = { op: 'upsert', row };
  ensureFace(batch, table === 'faces' ? row.id : row.faceId);
}

/** 暂存删除 */
export function stageDelete(batch: CatalogBatch, table: SyncTable, id: string): void {
  const changes = batch[table];
  const row = (batch.ancestor[table] as Record<string, { faceId?: string }>)[id];
  changes[id] = { op: 'delete' };
  ensureFace(batch, table === 'faces' ? id : row?.faceId);
}

export function unstage(batch: CatalogBatch, table: SyncTable, id: string): void {
  delete batch[table][id];
}

/** 深比较（均为可结构化克隆的普通数据） */
function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 字段级三方合并（保留两版）：
 * - 仅本批次（incoming）相对祖先改动的叶子 → 取 incoming；
 * - 仅对端（current）改动或两边都改动的叶子 → 保留 current（两边都改留库中版本，差异另报）。
 */
function mergeLeaves(ancestor: unknown, current: unknown, incoming: unknown): unknown {
  if (isPlainObject(ancestor) || isPlainObject(current) || isPlainObject(incoming)) {
    const a = isPlainObject(ancestor) ? ancestor : {};
    const c = isPlainObject(current) ? current : {};
    const l = isPlainObject(incoming) ? incoming : {};
    const out: Record<string, unknown> = {};
    new Set([...Object.keys(a), ...Object.keys(c), ...Object.keys(l)]).forEach((key) => {
      out[key] = mergeLeaves(a[key], c[key], l[key]);
    });
    return out;
  }
  const localChanged = !stableEqual(ancestor, incoming);
  const remoteChanged = !stableEqual(ancestor, current);
  return localChanged && !remoteChanged ? incoming : current;
}

export async function saveBatch(batch: CatalogBatch): Promise<void> {
  await db.batches.put(batch);
}

/* ------------------------------ 批次导入导出 ------------------------------ */

export function serializeBatch(batch: CatalogBatch): string {
  return JSON.stringify({ type: 'gbtunnelface-batch', schema: BATCH_SCHEMA_VERSION, batch });
}

export function parseBatchFile(text: string): CatalogBatch {
  const data = JSON.parse(text) as { type?: string; batch?: CatalogBatch };
  const batch = data.batch ?? (data as unknown as CatalogBatch);
  if (!batch || !batch.id || !Array.isArray(batch.faceIds)) {
    throw new Error('文件不是有效的离线编录批次');
  }
  return batch;
}

/* -------------------------------- 版本还原 -------------------------------- */

interface SideSnapshot {
  face?: TunnelFace;
  joints: JointSet[];
  grades: RockMassGrade[];
  waters: WaterInflow[];
}

/** 还原「本批次带来的版本」：祖先 + 本批次暂存的增改删 */
export function incomingVersion(batch: CatalogBatch, faceId: string): SideSnapshot {
  const pickFace = (id: string): TunnelFace | undefined => {
    const c = batch.faces[id];
    if (c?.op === 'delete') return undefined;
    return (c?.row as TunnelFace | undefined) ?? (batch.ancestor.faces[id] as TunnelFace | undefined);
  };
  const collect = <T extends { id: string; faceId?: string }>(
    tableKey: SyncTable,
    changes: TableChanges<T>,
    ancestor: Record<string, T>,
  ): T[] => {
    const ids = new Set<string>([
      ...Object.keys(ancestor).filter((id) => ancestor[id].faceId === faceId),
      ...Object.keys(changes),
    ]);
    const out: T[] = [];
    ids.forEach((id) => {
      const c = changes[id];
      if (c?.op === 'delete') return;
      const row = c?.row ?? ancestor[id];
      // faces 表的行 id 即掌子面 id；其余表用 faceId 归属
      const belongs = tableKey === 'faces' ? row.id === faceId : row.faceId === faceId;
      if (row && belongs) out.push(row);
    });
    return out;
  };
  return {
    face: pickFace(faceId),
    joints: collect('joints', batch.joints, batch.ancestor.joints),
    grades: collect('grades', batch.grades, batch.ancestor.grades),
    waters: collect('waters', batch.waters, batch.ancestor.waters),
  };
}

/* -------------------------------- 三方差异 -------------------------------- */

type FaceScalar = string | number | boolean;
const FACE_FIELD_LABELS: { key: string; label: string; get: (f: TunnelFace) => FaceScalar | undefined }[] = [
  { key: 'faceNo', label: '掌子面编号', get: (f) => f.faceNo },
  { key: 'chainage', label: '里程桩号', get: (f) => f.chainage },
  { key: 'excavationMethod', label: '开挖方式', get: (f) => f.excavationMethod },
  { key: 'faceSize', label: '断面尺寸', get: (f) => f.faceSize },
  { key: 'lithology', label: '岩性', get: (f) => f.lithology },
  { key: 'weathering', label: '风化程度', get: (f) => f.weathering },
  { key: 'rockStrength', label: '饱和抗压强度', get: (f) => f.rockStrength },
  { key: 'geologist', label: '地质员', get: (f) => f.geologist },
  { key: 'attitude.dipDirection', label: '倾向', get: (f) => f.attitude.dipDirection },
  { key: 'attitude.dipAngle', label: '倾角', get: (f) => f.attitude.dipAngle },
  { key: 'attitude.strike', label: '走向', get: (f) => f.attitude.strike },
];

function scalarChanged(a: FaceScalar | undefined, b: FaceScalar | undefined): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** 掌子面基本信息三方字段差异（祖先 / 库中对端 / 本批次） */
function faceFieldDiffs(
  ancestor: TunnelFace | undefined,
  current: TunnelFace | undefined,
  incoming: TunnelFace | undefined,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  FACE_FIELD_LABELS.forEach(({ key, label, get }) => {
    const b = ancestor ? get(ancestor) : undefined;
    const r = current ? get(current) : undefined;
    const l = incoming ? get(incoming) : undefined;
    let remoteChanged: boolean;
    let localChanged: boolean;
    if (ancestor) {
      remoteChanged = scalarChanged(b, r);
      localChanged = scalarChanged(b, l);
    } else {
      // 无共同祖先（新建掌子面）：以某一边是否实际持有该记录来区分改动方
      remoteChanged = current !== undefined;
      localChanged = incoming !== undefined;
    }
    if (!remoteChanged && !localChanged) return;
    diffs.push({
      field: key,
      label,
      base: b,
      remote: r,
      local: l,
      changedBy: remoteChanged && localChanged ? 'both' : remoteChanged ? 'remote' : 'local',
    });
  });
  return diffs;
}

function diffRecordSet<T extends { id: string }>(
  ancestor: Record<string, T>,
  current: Map<string, T>,
  incoming: T[],
): { added: T[]; removed: T[]; changed: T[] } {
  const added: T[] = [];
  const removed: T[] = [];
  const changed: T[] = [];
  incoming.forEach((row) => {
    const cur = current.get(row.id);
    const anc = ancestor[row.id];
    if (!cur) {
      added.push(row);
    } else if (anc && !stableEqual(anc, cur) && !stableEqual(anc, row)) {
      changed.push(row); // 两边都改了
    }
  });
  current.forEach((cur, id) => {
    const inIncoming = incoming.some((r) => r.id === id);
    if (!inIncoming && ancestor[id]) removed.push(cur);
  });
  return { added, removed, changed };
}

/** 计算同一掌子面两边版本的差异（用于保留两版后的核对展示） */
export function buildFaceConflicts(
  batch: CatalogBatch,
  current: { faces: Map<string, TunnelFace>; joints: Map<string, JointSet>; grades: Map<string,RockMassGrade>; waters: Map<string, WaterInflow> },
): FaceConflict[] {
  const result: FaceConflict[] = [];
  batch.faceIds.forEach((faceId) => {
    const incoming = incomingVersion(batch, faceId);
    const ancestorFace = batch.ancestor.faces[faceId];
    const currentFace = current.faces.get(faceId);
    const fieldDiffs = faceFieldDiffs(ancestorFace, currentFace, incoming.face);

    const ancJoints = Object.fromEntries(
      Object.values(batch.ancestor.joints).filter((j) => j.faceId === faceId).map((j) => [j.id, j]),
    );
    const ancWaters = Object.fromEntries(
      Object.values(batch.ancestor.waters).filter((w) => w.faceId === faceId).map((w) => [w.id, w]),
    );
    const curJoints = new Map([...current.joints].filter(([, j]) => j.faceId === faceId));
    const curWaters = new Map([...current.waters].filter(([, w]) => w.faceId === faceId));
    const jointDiff = diffRecordSet(ancJoints, curJoints, incoming.joints);
    const waterDiff = diffRecordSet(ancWaters, curWaters, incoming.waters);

    const bothSidesEdited =
      fieldDiffs.length > 0 ||
      jointDiff.added.length + jointDiff.removed.length + jointDiff.changed.length > 0 ||
      waterDiff.added.length + waterDiff.removed.length + waterDiff.changed.length > 0;
    if (!bothSidesEdited) return;

    result.push({
      faceId,
      faceNo: currentFace?.faceNo ?? incoming.face?.faceNo ?? ancestorFace?.faceNo ?? faceId,
      base: {
        deviceId: 'ancestor',
        label: '共同基线',
        face: ancestorFace,
        joints: Object.values(ancJoints),
        grades: Object.values(batch.ancestor.grades).filter((g) => g.faceId === faceId),
        waters: Object.values(ancWaters),
      },
      incoming: {
        deviceId: batch.deviceId,
        label: batch.label,
        face: incoming.face,
        joints: incoming.joints,
        grades: incoming.grades,
        waters: incoming.waters,
      },
      fieldDiffs,
      jointDiff,
      waterDiff,
    });
  });
  return result;
}

/* -------------------------------- 合入提交 -------------------------------- */

export type CommitOutcome =
  | { ok: true; duplicate?: boolean; report: MergeReport; batch: CatalogBatch }
  | { ok: false; reason: 'cas-conflict'; batch: CatalogBatch; other?: CatalogBatch };

interface CommitContext {
  rows: {
    faces: Map<string, TunnelFace>;
    joints: Map<string, JointSet>;
    grades: Map<string, RockMassGrade>;
    waters: Map<string, WaterInflow>;
  };
  merged: CatalogBatch[];
}

function emptyReport(batchId: string): MergeReport {
  return {
    batchId,
    applied: { faces: 0, joints: 0, grades: 0, waters: 0 },
    skippedDuplicates: [],
    conflicts: [],
    rejudged: [],
    mergedAt: 0,
  };
}

function putRow(ctx: CommitContext, table: SyncTable, row: unknown) {
  const map = ctx.rows[table] as Map<string, any>;
  map.set((row as { id: string }).id, row);
}

function deleteRow(ctx: CommitContext, table: SyncTable, id: string) {
  ctx.rows[table].delete(id);
}

/** 应用批次的增改删；rebase=true 时保留库中两版，只合入不冲突的增量 */
function applyOps(batch: CatalogBatch, ctx: CommitContext, rebase: boolean, report: MergeReport): void {
  TABLES.forEach((table) => {
    const changes = batch[table];
    Object.keys(changes).forEach((id) => {
      const change = changes[id];
      const current = ctx.rows[table].get(id) as { id: string; faceId?: string } | undefined;
      const ancestor = (batch.ancestor[table] as Record<string, unknown>)[id] as
        | { id: string; faceId?: string }
        | undefined;

      if (change.op === 'delete') {
        // rebase 下若对端也改过该行，则不删除，保留差异交人工处理
        if (rebase && ancestor && current && !stableEqual(ancestor, current)) {
          report.skippedDuplicates.push(id);
          return;
        }
        if (current) {
          deleteRow(ctx, table, id);
          report.applied[table] += 1;
        }
        return;
      }

      const row = change.row as { id: string; faceId?: string; basedOnBatches?: string[] };
      if (!row) return;

      // 掌子面本体：rebase 时按字段三方合并——仅本批次改的字段写入，两边都改保留库中版本
      if (table === 'faces' && rebase && ancestor && current && !stableEqual(ancestor, current)) {
        const mergedRow = mergeLeaves(ancestor, current, row) as typeof row;
        // 行标识与库中保持一致
        mergedRow.id = (current as { id: string }).id;
        if (stableEqual(mergedRow, current)) {
          report.skippedDuplicates.push(id);
          return;
        }
        putRow(ctx, table, mergedRow);
        report.applied[table] += 1;
        return;
      }
      // 节理/涌水/级别：rebase 时同一行两边都改过则整行保留库中版本（差异另报，新增行正常写入）
      if (table !== 'faces' && rebase && ancestor && current && !stableEqual(ancestor, current)) {
        report.skippedDuplicates.push(id);
        return;
      }

      if (table === 'grades') {
        const grade = row as RockMassGrade;
        grade.basedOnBatches = Array.from(new Set([...(grade.basedOnBatches ?? []), batch.id]));
      }
      putRow(ctx, table, row);
      report.applied[table] += 1;
    });
  });
}

/** 合入后对每个触及掌子面做依据校验：节理组/涌水变化则旧级别失效并重新判定 */
function validateAndRejudge(batch: CatalogBatch, ctx: CommitContext, report: MergeReport): void {
  const batchSet = new Set([batch.id]);
  batch.faceIds.forEach((faceId) => {
    const face = ctx.rows.faces.get(faceId);
    if (!face) return; // 掌子面被删除则不校验
    const joints = [...ctx.rows.joints.values()].filter((j) => j.faceId === faceId);
    const waters = [...ctx.rows.waters.values()].filter((w) => w.faceId === faceId);
    const grades = [...ctx.rows.grades.values()].filter((g) => g.faceId === faceId);
    if (grades.length === 0) return;

    const latest = grades.sort((a, b) => b.judgedAt - a.judgedAt)[0];
    const sig = latest.basisSignature ?? { joints: '', water: '' };
    if (!sig.joints && !sig.water) return; // v3 之前的老记录：首次重存后才纳入校验

    const currentSig = { joints: jointsBasisSignature(joints), water: waterBasisSignature(waters) };
    const reasons = diffBasis(sig, currentSig);
    if (reasons.length === 0 || latest.basedOnBatches?.includes(batch.id)) {
      // 本批次自身已携带对应判定，或依据未变，无需重判
      return;
    }

    const renewed = rejudgeGrade(latest, {
      rockStrength: face.rockStrength,
      spanWidth: Number(face.faceSize.split('×')[0]) || 12,
      joints,
      waters,
    });
    renewed.basedOnBatches = Array.from(new Set([...(renewed.basedOnBatches ?? []), ...batchSet]));
    const invalidated: RockMassGrade = { ...latest, basisValid: false, invalidReasons: reasons };
    ctx.rows.grades.set(invalidated.id, invalidated);
    ctx.rows.grades.set(renewed.id, renewed);
    report.applied.grades += 1;
    report.rejudged.push({
      faceId,
      faceNo: face.faceNo,
      fromGradeId: invalidated.id,
      toGradeId: renewed.id,
      reasons: reasons.map((r: GradeBasis) => BASIS_LABELS[r]),
    });
  });
}

/**
 * 提交（合入）一个离线批次。
 * - 已合入的同 id 批次直接返回既有报告（幂等：原样重试/旧批次重导入都不会重复计入）。
 * - CAS：任一触及掌子面的修订号高于基线，说明对端先提交，整批不写入并返回冲突。
 * - 全部写入与失效重判在同一个 IndexedDB 事务内完成，保证两台平板同时提交只有一份落库。
 */
export async function commitBatch(batchId: string, rebase = false): Promise<CommitOutcome> {
  return db.transaction('rw', db.faces, db.joints, db.grades, db.waters, db.batches, async () => {
    const stored = await db.batches.get(batchId);
    if (!stored) throw new Error('批次不存在');
    if (stored.status === 'merged' && stored.mergeReport) {
      return { ok: true as const, duplicate: true, report: stored.mergeReport, batch: stored };
    }

    const [allFaces, allJoints, allGrades, allWaters, allBatches] = await Promise.all([
      db.faces.toArray(),
      db.joints.toArray(),
      db.grades.toArray(),
      db.waters.toArray(),
      db.batches.toArray(),
    ]);
    const ctx: CommitContext = {
      rows: {
        faces: new Map(allFaces.map((r) => [r.id, r])),
        joints: new Map(allJoints.map((r) => [r.id, r])),
        grades: new Map(allGrades.map((r) => [r.id, r])),
        waters: new Map(allWaters.map((r) => [r.id, r])),
      },
      merged: allBatches.filter((b) => b.status === 'merged'),
    };

    if (!rebase) {
      const rev = revisionsFromMerged(ctx.merged);
      const staleFace = stored.faceIds.find((fid) => (rev.get(fid) ?? 0) > (stored.baseRev[fid] ?? 0));
      if (staleFace) {
        const other = ctx.merged
          .filter((b) => b.faceIds.includes(staleFace))
          .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))[0];
        const conflicted: CatalogBatch = {
          ...stored,
          status: 'conflict',
          submittedAt: Date.now(),
          conflictWith: other?.id,
          conflictReason: `掌子面 ${other ? '' : ''}已被另一台平板先提交（${other?.label ?? '未知批次'}），本批次修改原样保留`,
        };
        await db.batches.put(conflicted);
        return { ok: false as const, reason: 'cas-conflict', batch: conflicted, other };
      }
    }

    const report = emptyReport(stored.id);
    // 合入前对端版本快照：保留两版的差异报告要基于它，而不是已被本批次改写的上下文
    const remoteRows: CommitContext['rows'] = {
      faces: new Map(ctx.rows.faces),
      joints: new Map(ctx.rows.joints),
      grades: new Map(ctx.rows.grades),
      waters: new Map(ctx.rows.waters),
    };
    applyOps(stored, ctx, rebase, report);
    validateAndRejudge(stored, ctx, report);

    // 差异报告：rebase 保留两版时需要；普通 CAS 合入理论上无对端改动，仍计算以备展示
    if (rebase) {
      report.conflicts = buildFaceConflicts(stored, remoteRows);
    }

    await Promise.all([
      db.faces.bulkPut([...ctx.rows.faces.values()]),
      db.joints.bulkPut([...ctx.rows.joints.values()]),
      db.grades.bulkPut([...ctx.rows.grades.values()]),
      db.waters.bulkPut([...ctx.rows.waters.values()]),
    ]);

    const now = Date.now();
    report.mergedAt = now;
    const merged: CatalogBatch = {
      ...stored,
      status: 'merged',
      submittedAt: stored.submittedAt ?? now,
      mergedAt: now,
      conflictWith: undefined,
      conflictReason: undefined,
      mergeReport: report,
    };
    await db.batches.put(merged);
    return { ok: true as const, report, batch: merged };
  });
}

/**
 * 导入外部批次。
 * - 同 id 已存在：保留库中状态（旧批次不会被重新计入）。
 * - 状态为 submitted/editing/conflict：原样落地，等待提交走 CAS。
 * - 状态为 merged：默认仅存档（不覆盖本地主数据）；archive=false 时按保留两版方式补齐其数据，
 *   并保持 merged（幂等状态），调用方应先取得用户确认。
 */
export async function importBatch(
  batch: CatalogBatch,
  opts: { archiveMerged?: boolean } = { archiveMerged: true },
): Promise<{ batch: CatalogBatch; existed: boolean; mergedArchived: boolean }> {
  const existing = await db.batches.get(batch.id);
  if (existing) {
    return { batch: existing, existed: true, mergedArchived: false };
  }

  if (batch.status === 'merged' && opts.archiveMerged) {
    // 仅存档：保留其 merged 标记但不触碰主表，修订号也不因它变化（避免覆盖风险）
    const archived: CatalogBatch = {
      ...batch,
      status: 'merged',
      conflictReason: '外部已合入批次，仅存档，未写入本机主数据',
    };
    await db.batches.put(archived);
    return { batch: archived, existed: false, mergedArchived: true };
  }

  // submitted/editing/conflict 原样落地等待提交；merged 且要求补数据时先落地再以保留两版方式合入
  const fresh: CatalogBatch = { ...batch, status: batch.status === 'merged' ? 'submitted' : batch.status };
  await db.batches.put(fresh);
  if (batch.status === 'merged') {
    const outcome = await commitBatch(fresh.id, true);
    return { batch: outcome.batch, existed: false, mergedArchived: false };
  }
  return { batch: fresh, existed: false, mergedArchived: false };
}

export async function deleteBatch(batchId: string): Promise<void> {
  await db.batches.delete(batchId);
}

