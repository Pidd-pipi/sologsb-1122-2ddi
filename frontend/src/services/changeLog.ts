import { db, toPlain } from '../utils/db';
import { getDeviceId } from '../utils/device';
import type { SyncTableName } from '../types/sync';

function changeKey(tableName: SyncTableName, recordId: string): string {
  return `${tableName}:${recordId}`;
}

/**
 * 本地写入（新增或修改）一条业务记录，并登记到变更日志。
 * 业务表与日志在同一个 Dexie 事务内提交，保证「写入即有待提交修改」。
 * 快照始终为最新全量，已导出的旧修改仍挂在同一个 key 上，再次导出即为最新版。
 */
export async function logUpsert(
  tableName: SyncTableName,
  record: object,
  faceId: string,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const withMeta: Record<string, unknown> = {
    ...toPlain(record),
    updatedAt: now,
    updatedBy: getDeviceId(),
  };
  const recordId = (record as { id: string }).id;

  await db.transaction('rw', [db.table(tableName), db.changes], async () => {
    await db.table(tableName).put(toPlain(withMeta));
    await db.changes.put({
      key: changeKey(tableName, recordId),
      tableName,
      recordId,
      faceId,
      operation: 'upsert',
      snapshot: toPlain(withMeta),
      updatedAt: now,
      deviceId: getDeviceId(),
      batchId: null,
    });
  });
  return withMeta;
}

/** 本地删除一条业务记录，并登记删除变更 */
export async function logRemove(tableName: SyncTableName, recordId: string, faceId: string): Promise<void> {
  await db.transaction('rw', [db.table(tableName), db.changes], async () => {
    await db.table(tableName).delete(recordId);
    await db.changes.put({
      key: changeKey(tableName, recordId),
      tableName,
      recordId,
      faceId,
      operation: 'remove',
      snapshot: undefined,
      updatedAt: Date.now(),
      deviceId: getDeviceId(),
      batchId: null,
    });
  });
}

/** 尚未提交（或已提交后又改过）的本地变更数量 */
export async function countPendingChanges(): Promise<number> {
  return db.changes.filter((c) => c.batchId === null).count();
}
