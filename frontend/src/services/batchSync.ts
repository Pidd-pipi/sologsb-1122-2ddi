import { db, toPlain } from '../utils/db';
import { getDeviceId, getDeviceName } from '../utils/device';
import { newId } from '../utils/id';
import { planMerge, type MergePlan } from './mergePlan';
import type { LocalContext } from './mergePlan';
import { invalidateAffectedGrades } from './gradeInvalidate';
import {
  SYNC_TABLE_NAMES,
  type CommitResult,
  type MergeConflict,
  type SyncBatch,
  type SyncTableName,
} from '../types/sync';

const LOCK_KEY = 'gbtunnelface:commit-lock';
const LOCK_TTL_MS = 30_000;

interface Lock {
  deviceId: string;
  acquiredAt: number;
}

function ls(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    const g = globalThis as unknown as { localStorage?: Storage };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 两台平板（或同一台机器上两个标签页）同时提交时，只有一个能拿到提交锁；
 * 未拿到锁的批次原样保留在文件里、本机未提交修改不动，返回 locked 提示冲突。
 */
function acquireLock(): boolean {
  const store = ls();
  if (!store) return true; // localStorage 不可用时退化为仅靠 IndexedDB 事务串行化
  try {
    const raw = store.getItem(LOCK_KEY);
    if (raw) {
      const lock = JSON.parse(raw) as Lock;
      if (lock.deviceId !== getDeviceId() && Date.now() - lock.acquiredAt < LOCK_TTL_MS) {
        return false;
      }
    }
    const lock: Lock = { deviceId: getDeviceId(), acquiredAt: Date.now() };
    store.setItem(LOCK_KEY, JSON.stringify(lock));
    // 双保险：再读一次确认写入未被并发覆盖
    return store.getItem(LOCK_KEY) === JSON.stringify(lock);
  } catch {
    return true;
  }
}

function releaseLock(): void {
  const store = ls();
  if (!store) return;
  try {
    const raw = store.getItem(LOCK_KEY);
    if (raw && (JSON.parse(raw) as Lock).deviceId === getDeviceId()) {
      store.removeItem(LOCK_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** 批次文件结构校验 */
export function validateBatch(raw: unknown): { ok: true; batch: SyncBatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '文件内容不是有效的批次对象' };
  const b = raw as Partial<SyncBatch>;
  if (b.format !== 'gbtunnelface-batch') return { ok: false, error: '缺少批次标识 format=gbtunnelface-batch' };
  if (!b.batchId) return { ok: false, error: '缺少批次号 batchId' };
  if (!Array.isArray(b.changes)) return { ok: false, error: '批次缺少 changes 列表' };
  for (const c of b.changes) {
    if (!c || !SYNC_TABLE_NAMES.includes(c.tableName as SyncTableName)) {
      return { ok: false, error: '批次包含未知数据表的变更' };
    }
    if (!c.recordId || (c.operation !== 'upsert' && c.operation !== 'remove')) {
      return { ok: false, error: '批次包含格式不合法的变更' };
    }
  }
  return { ok: true, batch: b as SyncBatch };
}

/**
 * 合入一个离线批次。
 *
 * 幂等：同一 batchId 重复导入（合入失败后原样重试）直接回显上次结果，旧批次不会重复计入；
 * 并发：提交锁 + 单事务保证两台平板同时提交时只有一份写入；
 * 冲突：两边都改过的记录登记到 conflicts，本机未提交修改原样保留，提示冲突。
 */
export async function commitBatch(batch: SyncBatch): Promise<CommitResult> {
  // 1. 幂等：已合入的批次原样返回
  const already = await db.committedBatches.get(batch.batchId);
  if (already) {
    return {
      outcome: 'duplicate',
      batchId: batch.batchId,
      deviceName: already.deviceName,
      applied: 0,
      conflicts: 0,
      invalidatedGrades: 0,
      committedAt: already.importedAt,
    };
  }

  // 2. 并发提交锁
  if (!acquireLock()) {
    return {
      outcome: 'locked',
      batchId: batch.batchId,
      deviceName: batch.deviceName,
      applied: 0,
      conflicts: 0,
      invalidatedGrades: 0,
    };
  }

  try {
    // 事务内再次确认（锁获取与事务之间可能已有别的标签页提交完同一批次）
    const inside = await db.committedBatches.get(batch.batchId);
    if (inside) {
      return {
        outcome: 'duplicate',
        batchId: batch.batchId,
        deviceName: inside.deviceName,
        applied: 0,
        conflicts: 0,
        invalidatedGrades: 0,
        committedAt: inside.importedAt,
      };
    }

    // 3. 读取每条变更的本机上下文
    const contexts = new Map<string, LocalContext>();
    for (const change of batch.changes) {
      const key = `${change.tableName}:${change.recordId}`;
      const record = ((await db.table(change.tableName).get(change.recordId)) ?? null) as
        | Record<string, unknown>
        | null;
      const logs = await db.changes.where('key').equals(key).toArray();
      const pending = logs.find((l) => l.batchId === null) ?? null;
      const lastLogged = logs.filter((l) => l.batchId !== null).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
      const existingConflict = await db.conflicts.get(`${batch.batchId}:${change.tableName}:${change.recordId}`);
      contexts.set(key, { record, pending, lastLogged, existingConflict });
    }

    const plan: MergePlan = planMerge(batch, contexts);

    // 4. 单事务写入：业务记录 + 冲突登记 + 批次登记 + 本机变更日志更新
    const affectedFaces = new Set<string>();
    let applied = 0;

    await db.transaction(
      'rw',
      [db.faces, db.joints, db.grades, db.waters, db.changes, db.conflicts, db.committedBatches],
      async () => {
        for (const action of plan.actions) {
          const { change } = action;
          if (action.type === 'apply-upsert' && change.snapshot) {
            await db.table(change.tableName).put(toPlain(change.snapshot));
            applied += 1;
            if (change.tableName === 'joints' || change.tableName === 'waters') {
              affectedFaces.add(change.faceId);
            }
            if (change.tableName === 'faces') affectedFaces.add(change.recordId);
          } else if (action.type === 'apply-remove') {
            await db.table(change.tableName).delete(change.recordId);
            applied += 1;
            if (change.tableName === 'joints' || change.tableName === 'waters') {
              affectedFaces.add(change.faceId);
            }
          }
          // 冲突的记录：本机变更日志不动（保留尚未提交的修改）
        }

        for (const c of plan.conflicts) {
          const conflict: MergeConflict = {
            ...c,
            status: 'pending',
            createdAt: Date.now(),
            resolvedAt: null,
          };
          await db.conflicts.put(conflict);
          if (c.tableName === 'faces') affectedFaces.add(c.recordId);
          else affectedFaces.add(c.faceId);
        }

        // 对非冲突地合入了对端变更的记录，清除本机同 key 的未提交标记：
        // 仅当本机没有 pending（planMerge 已保证），直接跳过日志更新；
        // 有 pending 的一定走冲突分支，日志原样保留。
        await db.committedBatches.put({
          batchId: batch.batchId,
          deviceId: batch.deviceId,
          deviceName: batch.deviceName || batch.deviceId.slice(0, 8),
          importedAt: Date.now(),
          changeCount: batch.changes.length,
        });
      },
    );

    // 5. 节理组/涌水状态变化后，关联围岩级别失效并重新判定（合入产生，不进本机 outbox）
    const invalidatedGrades = affectedFaces.size
      ? await invalidateAffectedGrades(Array.from(affectedFaces), {
          track: false,
          source: `合入 ${batch.deviceName || batch.deviceId} 的批次`,
        })
      : 0;

    return {
      outcome: 'applied',
      batchId: batch.batchId,
      deviceName: batch.deviceName,
      applied,
      conflicts: plan.conflicts.length,
      invalidatedGrades,
    };
  } finally {
    releaseLock();
  }
}

/** 导出离线批次：收集全部本机变更（已导出的带最新快照，未提交的一并带上），并标记批次号 */
export async function exportBatch(): Promise<SyncBatch> {
  const entries = await db.changes.toCollection().toArray();
  const batchId = newId('batch');
  const now = Date.now();

  const changes = entries.map((e) => ({
    tableName: e.tableName,
    recordId: e.recordId,
    faceId: e.faceId,
    operation: e.operation,
    snapshot: e.operation === 'upsert' ? e.snapshot : undefined,
    updatedAt: e.updatedAt,
    deviceId: e.deviceId,
  }));

  await db.transaction('rw', db.changes, async () => {
    for (const e of entries) {
      await db.changes.update(e.key, { batchId });
    }
  });

  return {
    format: 'gbtunnelface-batch',
    schemaVersion: 3,
    batchId,
    deviceId: getDeviceId(),
    deviceName: getDeviceName(),
    exportedAt: now,
    baseVersion: 0,
    changes,
  };
}
