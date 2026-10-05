import { defineStore } from 'pinia';
import { db } from '../utils/db';
import {
  commitBatch,
  createBatch,
  deleteBatch,
  importBatch,
  saveBatch,
  stageDelete,
  stageUpsert,
  unstage,
  type CreateBatchInput,
  type SyncTable,
} from '../utils/sync';
import type { CatalogBatch } from '../types/sync';
import { useFaceStore } from './faceStore';
import { useJointStore } from './jointStore';
import { useGradeStore } from './gradeStore';

interface SyncState {
  batches: CatalogBatch[];
  loaded: boolean;
}

export const useSyncStore = defineStore('sync', {
  state: (): SyncState => ({ batches: [], loaded: false }),
  getters: {
    editing: (s) => s.batches.filter((b) => b.status === 'editing'),
    submitted: (s) => s.batches.filter((b) => b.status === 'submitted'),
    conflicts: (s) => s.batches.filter((b) => b.status === 'conflict'),
    merged: (s) =>
      [...s.batches.filter((b) => b.status === 'merged')].sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0)),
    byId: (s) => (id: string) => s.batches.find((b) => b.id === id),
  },
  actions: {
    async load() {
      this.batches = await db.batches.toArray();
      this.loaded = true;
    },
    async create(input: CreateBatchInput) {
      const batch = await createBatch(input);
      this.batches = [...this.batches, batch];
      return batch;
    },
    async persist(batch: CatalogBatch) {
      await saveBatch(batch);
      this.batches = this.batches.map((b) => (b.id === batch.id ? batch : b));
    },
    async stageUpsert<T extends { id: string; faceId?: string }>(batch: CatalogBatch, table: SyncTable, row: T) {
      stageUpsert(batch, table, row);
      await this.persist(batch);
    },
    async stageDelete(batch: CatalogBatch, table: SyncTable, id: string) {
      stageDelete(batch, table, id);
      await this.persist(batch);
    },
    async unstage(batch: CatalogBatch, table: SyncTable, id: string) {
      unstage(batch, table, id);
      await this.persist(batch);
    },
    /** 提交：rebase=false 走 CAS（并发只一份写入）；rebase=true 保留两版合入 */
    async commit(batchId: string, rebase = false) {
      const outcome = await commitBatch(batchId, rebase);
      await this.load();
      // 合入后主数据可能变化，重新装载各台账
      await Promise.all([useFaceStore().load(), useJointStore().load(), useGradeStore().load()]);
      return outcome;
    },
    async importBatch(batch: CatalogBatch, opts?: { archiveMerged?: boolean }) {
      const result = await importBatch(batch, opts);
      await this.load();
      return result;
    },
    async remove(batchId: string) {
      await deleteBatch(batchId);
      this.batches = this.batches.filter((b) => b.id !== batchId);
    },
  },
});
