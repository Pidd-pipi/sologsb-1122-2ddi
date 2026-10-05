import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { logUpsert } from './changeLog';
import {
  isGradeBasisStale,
  jointBasisSignature,
  rejudgeGrade,
  waterBasisSignature,
} from './gradeBasis';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import type { RockMassGrade } from '../types/grade';

/**
 * 节理组或涌水状态变化后，使相关掌子面最新的有效级别失效并重新判定。
 *
 * - 非人工修正的级别：标记旧记录失效，按最新节理/涌水参数自动重判生成新记录；
 * - 人工修正过的级别：只标记失效（保留人工结论不被自动覆盖），等待地质员重新判定；
 * - 旧版本没有依据签名的级别记录，首次触发时一律视为依据已变化。
 *
 * @param track true=本机编辑触发，重判记录写入变更日志随批次同步；
 *              false=合入批次/解决冲突时的派生写入
 * @returns 失效的级别记录数量
 */
export async function invalidateAffectedGrades(
  faceIds: string[],
  opts: { track: boolean; source: string },
): Promise<number> {
  const uniq = Array.from(new Set(faceIds));
  let invalidated = 0;

  for (const faceId of uniq) {
    const face = await db.faces.get(faceId);
    if (!face) continue;
    const joints = await db.joints.where('faceId').equals(faceId).toArray();    const waters = await db.waters.where('faceId').equals(faceId).toArray();
    const grades = await db.grades.where('faceId').equals(faceId).toArray();
    const valid = grades.filter((g) => g.invalid !== true).sort((a, b) => b.judgedAt - a.judgedAt);
    const prev = valid[0];
    if (!prev) continue;

    // 没有依据签名的旧级别记录按依据已变化处理
    const jointChanged =
      prev.basisJointSig === undefined ? true : prev.basisJointSig !== jointBasisSignature(joints);
    const waterChanged =
      prev.basisWaterSig === undefined ? true : prev.basisWaterSig !== waterBasisSignature(waters);
    if (!jointChanged && !waterChanged) continue;

    const check = isGradeBasisStale(prev, joints, waters);
    const reasons = check.reasons.length
      ? check.reasons
      : [jointChanged ? '节理组' : '', waterChanged ? '涌水状态' : ''].filter(Boolean);
    const reasonText = `${reasons.join('、')}变化（${opts.source}），原判定依据失效`;

    await db.grades.put(
      toPlain({
        ...prev,
        invalid: true,
        invalidReason: reasonText,
        invalidatedAt: Date.now(),
      }),
    );
    invalidated += 1;

    if (prev.manualAdjusted) {
      // 人工修正级别保留结论，仅提示重新判定
      continue;
    }

    const re = rejudgeGrade(prev, face.rockStrength, joints, waters, jointChanged);
    const next: RockMassGrade = {
      id: newId('grade'),
      faceId,
      grade: re.grade,
      bqValue: re.bqValue,
      rqd: prev.rqd,
      jv: re.jv,
      kv: re.kv,
      groundwater: re.groundwater,
      spanWidth: prev.spanWidth,
      correction: re.correction,
      correctedBq: re.correctedBq,
      supportSuggestion: re.supportSuggestion,
      manualAdjusted: false,
      invalid: false,
      autoRejudged: true,
      autoRejudgeReason: reasonText,
      basisJointSig: jointBasisSignature(joints),
      basisWaterSig: waterBasisSignature(waters),
      judgedAt: Date.now(),
    };
    if (opts.track) {
      await logUpsert('grades', next, faceId);
    } else {
      await db.grades.put(toPlain(next));
    }
  }
  return invalidated;
}

/** 保存级别判定时打上当前节理/涌水依据签名 */
export function stampBasisSignatures(
  grade: RockMassGrade,
  joints: JointSet[],
  waters: WaterInflow[],
): RockMassGrade {
  return {
    ...grade,
    invalid: false,
    basisJointSig: jointBasisSignature(joints),
    basisWaterSig: waterBasisSignature(waters),
  };
}
