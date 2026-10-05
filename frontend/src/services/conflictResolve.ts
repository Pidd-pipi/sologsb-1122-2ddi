import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { getDeviceId } from '../utils/device';
import { invalidateAffectedGrades } from './gradeInvalidate';
import type { TunnelFace } from '../types/face';
import type { ConflictStatus, SyncTableName } from '../types/sync';

/**
 * 在当前事务内追加一条本机变更日志（与冲突解决写入同事务）。
 * 与 services/changeLog.logUpsert 的区别：调用方已经在事务里写过业务表，
 * 这里只补日志，避免嵌套事务重复 put。
 */
async function appendChange(
  tableName: SyncTableName,
  recordId: string,
  faceId: string,
  operation: 'upsert' | 'remove',
  snapshot?: unknown,
): Promise<void> {
  await db.changes.put({
    key: `${tableName}:${recordId}`,
    tableName,
    recordId,
    faceId,
    operation,
    snapshot,
    updatedAt: Date.now(),
    deviceId: getDeviceId(),
    batchId: null,
  });
}

/**
 * 解决一条合入冲突。所有动作都登记为本机变更（继续保留在待提交修改中），
 * 因此解决结果可在下一批次导出给对端；同一冲突重复操作时按当前状态幂等处理。
 */
export async function resolveConflict(
  conflictId: string,
  status: Exclude<ConflictStatus, 'pending'>,
): Promise<void> {
  const conflict = await db.conflicts.get(conflictId);
  if (!conflict) return;

  await db.transaction(
    'rw',
    [db.faces, db.joints, db.grades, db.waters, db.changes, db.conflicts],
    async () => {
      if (status === 'accepted-local') {
        // 以本机版本为准：对 face-diverge 清掉可能归档的对端版本，其余记录本机快照已在库中
        if (conflict.tableName === 'faces') {
          const local = (conflict.localSnapshot ?? null) as TunnelFace | null;
          if (local) {
            const clean: TunnelFace = { ...toPlain(local), remoteSnapshot: undefined, remoteSource: undefined };
            await db.faces.put(clean);
          }
        }
        // remote-delete-local-edit 选择保留本机：本机快照重新落库（若当前已被删）
        if (conflict.kind === 'remote-delete-local-edit' && conflict.localSnapshot) {
          const snapshot = stripConflictMeta(toPlain(conflict.localSnapshot) as Record<string, unknown>);
          await db.table(conflict.tableName).put(snapshot);
          await appendChange(conflict.tableName, conflict.recordId, conflict.faceId, 'upsert', snapshot);
        }
      }

      if (status === 'accepted-remote') {
        if (conflict.remoteSnapshot) {
          if (conflict.tableName === 'faces') {
            const remote = toPlain(conflict.remoteSnapshot) as TunnelFace;
            const clean: TunnelFace = {
              ...remote,
              remoteSnapshot: undefined,
              remoteSource: undefined,
              updatedAt: Date.now(),
              updatedBy: getDeviceId(),
            };
            await db.faces.put(clean);
            await appendChange('faces', clean.id, clean.id, 'upsert', clean);
          } else {
            const snapshot = withMeta(stripConflictMeta(toPlain(conflict.remoteSnapshot) as Record<string, unknown>));
            await db.table(conflict.tableName).put(snapshot);
            await appendChange(conflict.tableName, conflict.recordId, conflict.faceId, 'upsert', snapshot);
          }
        } else {
          // 对端操作为删除
          await db.table(conflict.tableName).delete(conflict.recordId);
          await appendChange(conflict.tableName, conflict.recordId, conflict.faceId, 'remove');
        }
      }

      if (status === 'kept-both' && conflict.tableName === 'faces' && conflict.localSnapshot && conflict.remoteSnapshot) {
        // 同一掌子面两边都改过：本机版本作为主版本，对端版本归档到 remoteSnapshot 标出差异
        const local = toPlain(conflict.localSnapshot) as TunnelFace;
        const remote = toPlain(conflict.remoteSnapshot) as TunnelFace;
        const source = `批次${conflict.batchId.slice(-6)} / 设备${conflict.remoteDeviceId.slice(-6)}`;
        const main: TunnelFace = {
          ...local,
          remoteSnapshot: { ...remote, remoteSnapshot: undefined, remoteSource: undefined },
          remoteSource: source,
          updatedAt: Date.now(),
          updatedBy: getDeviceId(),
        };
        await db.faces.put(main);
        await appendChange('faces', main.id, main.id, 'upsert', main);
      }

      await db.conflicts.update(conflictId, { status, resolvedAt: Date.now() });
    },
  );

  // 节理组/涌水冲突按对端版本解决后，关联围岩级别同样要失效并重新判定
  if (
    status === 'accepted-remote' &&
    (conflict.tableName === 'joints' || conflict.tableName === 'waters')
  ) {
    await invalidateAffectedGrades([conflict.faceId], {
      track: true,
      source: '冲突解决采用对端版本',
    });
  }
}

function withMeta(record: Record<string, unknown>): Record<string, unknown> {
  return { ...record, updatedAt: Date.now(), updatedBy: getDeviceId() };
}

function stripConflictMeta(record: Record<string, unknown>): Record<string, unknown> {
  delete record.remoteSnapshot;
  delete record.remoteSource;
  return record;
}

/** 重新打开一条已解决冲突（用户反悔时） */
export async function reopenConflict(conflictId: string): Promise<void> {
  await db.conflicts.update(conflictId, { status: 'pending', resolvedAt: null });
}

/** 生成归档对端掌子面的独立副本（两版都留的另一种落法：另建一个掌子面） */
export async function forkRemoteFace(conflictId: string): Promise<string | null> {
  const conflict = await db.conflicts.get(conflictId);
  if (!conflict || conflict.tableName !== 'faces' || !conflict.remoteSnapshot) return null;
  const remote = toPlain(conflict.remoteSnapshot) as TunnelFace;
  const copy: TunnelFace = {
    ...remote,
    id: newId('face'),
    faceNo: `${remote.faceNo}（对端版）`,
    recordedAt: Date.now(),
    remoteSnapshot: undefined,
    remoteSource: `来自批次 ${conflict.batchId.slice(-6)}`,
    updatedAt: Date.now(),
    updatedBy: getDeviceId(),
  };
  await db.faces.put(copy);
  await appendChange('faces', copy.id, copy.id, 'upsert', copy);
  await db.conflicts.update(conflictId, { status: 'kept-both', resolvedAt: Date.now() });
  return copy.id;
}
