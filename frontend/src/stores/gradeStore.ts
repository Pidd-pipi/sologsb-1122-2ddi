import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import type { RockMassGrade, RockMassGradeDraft } from '../types/grade';
import { jointsBasisSignature, waterBasisSignature } from '../types/grade';
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
    latestByFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt)[0],
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
      // 判定依据签名：记录当前节理组与涌水摘要，离线批次合并后据此判断是否失效
      const [faceJoints, faceWaters] = await Promise.all([
        db.joints.where('faceId').equals(draft.faceId).toArray(),
        db.waters.where('faceId').equals(draft.faceId).toArray(),
      ]);
      const record: RockMassGrade = {
        ...toPlain(draft),
        id: newId('grade'),
        judgedAt: Date.now(),
        basisValid: true,
        invalidReasons: [],
        basisSignature: {
          joints: jointsBasisSignature(faceJoints),
          water: waterBasisSignature(faceWaters),
        },
        basedOnBatches: [],
      };
      await db.grades.put(toPlain(record));
      this.items = [record, ...this.items];
      return record;
    },
    async addWater(draft: WaterInflowDraft) {
      const record: WaterInflow = { ...toPlain(draft), id: newId('water'), measuredAt: Date.now() };
      await db.waters.put(toPlain(record));
      this.waters = [...this.waters, record].sort((a, b) => a.chainage - b.chainage);
      return record;
    },
    async removeWater(id: string) {
      await db.waters.delete(id);
      this.waters = this.waters.filter((it) => it.id !== id);
    },
  },
});
