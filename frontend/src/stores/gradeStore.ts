import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { logRemove, logUpsert } from '../services/changeLog';
import { invalidateAffectedGrades, stampBasisSignatures } from '../services/gradeInvalidate';
import type { RockMassGrade, RockMassGradeDraft } from '../types/grade';
import type { WaterInflow, WaterInflowDraft } from '../types/water';

interface GradeState {
  items: RockMassGrade[];
  waters: WaterInflow[];
  loaded: boolean;
}

export const useGradeStore = defineStore('grade', {
  state: (): GradeState => ({ items: [], waters: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt),
    /** 最新判定（含已失效） */
    latestByFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt)[0],
    /** 最新有效级别：失效记录不再作为当前围岩级别 */
    validByFace: (state) => (faceId: string) =>
      state.items
        .filter((it) => it.faceId === faceId && it.invalid !== true)
        .sort((a, b) => b.judgedAt - a.judgedAt)[0],
    watersByFace: (state) => (faceId: string) =>
      state.waters.filter((it) => it.faceId === faceId).sort((a, b) => a.chainage - b.chainage),
  },
  actions: {
    async load() {
      const grades = await db.grades.toArray();
      this.items = grades.sort((a, b) => b.judgedAt - a.judgedAt);
      const waters = await db.waters.toArray();
      this.waters = waters.sort((a, b) => a.chainage - b.chainage);
      this.loaded = true;
    },
    async addGrade(draft: RockMassGradeDraft) {
      const joints = await db.joints.where('faceId').equals(draft.faceId).toArray();
      const waters = await db.waters.where('faceId').equals(draft.faceId).toArray();
      const base: RockMassGrade = { ...toPlain(draft), id: newId('grade'), judgedAt: Date.now() };
      const record = stampBasisSignatures(base, joints, waters);
      const saved = (await logUpsert('grades', record, draft.faceId)) as unknown as RockMassGrade;
      this.items = [saved, ...this.items];
      return saved;
    },
    async addWater(draft: WaterInflowDraft) {
      const record: WaterInflow = { ...toPlain(draft), id: newId('water'), measuredAt: Date.now() };
      const saved = (await logUpsert('waters', record, draft.faceId)) as unknown as WaterInflow;
      this.waters = [...this.waters, saved].sort((a, b) => a.chainage - b.chainage);
      // 涌水状态变化后关联围岩级别失效并重新判定
      await invalidateAffectedGrades([draft.faceId], { track: true, source: '本机新增涌水记录' });
      return saved;
    },
    async removeWater(id: string) {
      const current = this.waters.find((it) => it.id === id) ?? (await db.waters.get(id));
      const faceId = current?.faceId ?? '';
      await logRemove('waters', id, faceId);
      this.waters = this.waters.filter((it) => it.id !== id);
      if (faceId) {
        await invalidateAffectedGrades([faceId], { track: true, source: '本机删除涌水记录' });
      }
    },
  },
});
