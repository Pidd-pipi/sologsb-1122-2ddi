import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { logRemove, logUpsert } from '../services/changeLog';
import { invalidateAffectedGrades } from '../services/gradeInvalidate';
import type { JointSet, JointSetDraft } from '../types/joint';

interface JointState {
  items: JointSet[];
  loaded: boolean;
}

export const useJointStore = defineStore('joint', {
  state: (): JointState => ({ items: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => a.setNo - b.setNo),
  },
  actions: {
    async load() {
      const rows = await db.joints.toArray();
      rows.sort((a, b) => a.setNo - b.setNo);
      this.items = rows;
      this.loaded = true;
    },
    async add(draft: JointSetDraft) {
      const record: JointSet = { ...toPlain(draft), id: newId('joint') };
      const saved = (await logUpsert('joints', record, draft.faceId)) as unknown as JointSet;
      this.items = [...this.items, saved];
      // 节理组变化后关联围岩级别失效并重新判定
      await invalidateAffectedGrades([draft.faceId], { track: true, source: '本机修改节理组' });
      return saved;
    },
    async update(id: string, patch: Partial<JointSet>) {
      const current = this.items.find((it) => it.id === id) ?? (await db.joints.get(id));
      if (!current) return;
      const next: JointSet = { ...current, ...toPlain(patch) };
      const saved = (await logUpsert('joints', next, current.faceId)) as unknown as JointSet;
      this.items = this.items.map((it) => (it.id === id ? saved : it));
      await invalidateAffectedGrades([current.faceId], { track: true, source: '本机修改节理组' });
    },
    async remove(id: string) {
      const current = this.items.find((it) => it.id === id);
      const faceId = current?.faceId ?? (await db.joints.get(id))?.faceId;
      await logRemove('joints', id, faceId ?? '');
      this.items = this.items.filter((it) => it.id !== id);
      if (faceId) {
        await invalidateAffectedGrades([faceId], { track: true, source: '本机删除节理组' });
      }
    },
    /** 把同组产状合并到指定组：把被合并组的条数累加到目标组并删除被合并组 */
    async mergeInto(targetId: string, sourceIds: string[]) {
      const target = this.items.find((it) => it.id === targetId);
      if (!target) return;
      const sources = this.items.filter((it) => sourceIds.includes(it.id));
      const extra = sources.reduce((s, j) => s + j.jointCount, 0);
      const next: JointSet = { ...target, jointCount: target.jointCount + extra };
      await logUpsert('joints', next, target.faceId);
      for (const s of sources) {
        await logRemove('joints', s.id, target.faceId);
      }
      this.items = this.items
        .filter((it) => !sourceIds.includes(it.id))
        .map((it) => (it.id === targetId ? next : it));
      await invalidateAffectedGrades([target.faceId], { track: true, source: '本机合并同组产状' });
    },
  },
});
