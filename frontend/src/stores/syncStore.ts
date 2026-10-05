import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { getDeviceId, getDeviceName } from '../utils/device';
import { commitBatch, exportBatch, validateBatch } from '../services/batchSync';
import { resolveConflict, reopenConflict, forkRemoteFace } from '../services/conflictResolve';
import { countPendingChanges } from '../services/changeLog';
import type { ChangeEntry, CommittedBatch, CommitResult, MergeConflict, SyncBatch } from '../types/sync';

interface SyncState {
  deviceId: string;
  deviceName: string;
  pendingCount: number;
  changes: ChangeEntry[];
  conflicts: MergeConflict[];
  committed: CommittedBatch[];
  lastResult: CommitResult | null;
  loaded: boolean;
}

export const useSyncStore = defineStore('sync', {
  state: (): SyncState => ({
    deviceId: getDeviceId(),
    deviceName: getDeviceName(),
    pendingCount: 0,
    changes: [],
    conflicts: [],
    committed: [],
    lastResult: null,
    loaded: false,
  }),
  getters: {
    pendingConflicts: (state) => state.conflicts.filter((c) => c.status === 'pending'),
    resolvedConflicts: (state) => state.conflicts.filter((c) => c.status !== 'pending'),
  },
  actions: {
    async load() {
      this.deviceId = getDeviceId();
      this.deviceName = getDeviceName();
      this.changes = await db.changes.toCollection().toArray();
      this.conflicts = await db.conflicts.toCollection().sortBy('createdAt');
      this.conflicts.reverse();
      this.committed = (await db.committedBatches.toArray()).sort((a, b) => b.importedAt - a.importedAt);
      this.pendingCount = await countPendingChanges();
      this.loaded = true;
    },
    /** 导出本机批次为 JSON 文件 */
    async exportToFile(): Promise<SyncBatch> {
      const batch = await exportBatch();
      const blob = new Blob([JSON.stringify(batch, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gbtunnelface-batch-${batch.batchId.slice(-6)}-${new Date(batch.exportedAt)
        .toISOString()
        .slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      await this.load();
      return batch;
    },
    /** 读取并合入批次文件 */
    async importFromFile(file: File): Promise<CommitResult> {
      const text = await file.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        const result: CommitResult = {
          outcome: 'invalid',
          batchId: '',
          deviceName: '',
          applied: 0,
          conflicts: 0,
          invalidatedGrades: 0,
          error: '文件不是合法 JSON',
        };
        this.lastResult = result;
        return result;
      }
      const validated = validateBatch(raw);
      if (!validated.ok) {
        const result: CommitResult = {
          outcome: 'invalid',
          batchId: '',
          deviceName: '',
          applied: 0,
          conflicts: 0,
          invalidatedGrades: 0,
          error: validated.error,
        };
        this.lastResult = result;
        return result;
      }
      const result = await commitBatch(validated.batch);
      this.lastResult = result;
      await this.load();
      return result;
    },
    async resolve(id: string, status: 'accepted-local' | 'accepted-remote' | 'kept-both') {
      await resolveConflict(id, status);
      await this.load();
    },
    async reopen(id: string) {
      await reopenConflict(id);
      await this.load();
    },
    async forkFace(id: string) {
      const newId = await forkRemoteFace(id);
      await this.load();
      return newId;
    },
  },
});
