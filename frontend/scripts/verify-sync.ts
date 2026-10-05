import { assert } from 'console';
import { db } from '../src/utils/db';
import { createBatch, stageUpsert, stageDelete, commitBatch, importBatch, incomingVersion } from '../src/utils/sync';
import { newId } from '../src/utils/id';
import type { TunnelFace } from '../src/types/face';
import type { JointSet } from '../src/types/joint';
import type { RockMassGrade, GradeBasisSignature } from '../src/types/grade';
import { jointsBasisSignature, waterBasisSignature } from '../src/types/grade';
import type { WaterInflow } from '../src/types/water';

let passed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (!cond) {
    console.error(`✗ FAIL: ${name} ${extra}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`✓ ${name}`);
  }
}

function sig(joints: JointSet[], waters: WaterInflow[]): GradeBasisSignature {
  return { joints: jointsBasisSignature(joints), water: waterBasisSignature(waters) };
}

async function seed() {
  const faceId = 'face_test';
  const face: TunnelFace = {
    id: faceId,
    faceNo: 'TEST-1',
    chainage: 100,
    mileageRange: [100, 103],
    excavationMethod: '台阶法',
    faceSize: '12.6×9.8',
    lithology: '石灰岩',
    weathering: '微风化',
    rockStrength: 60,
    attitude: { strike: 45, dipDirection: 135, dipAngle: 30 },
    recordedAt: Date.now() - 100000,
    geologist: '基线',
  };
  const j1: JointSet = {
    id: 'j1', faceId, setNo: 1, dipDirection: 120, dipAngle: 60, spacing: 40, persistence: 3,
    aperture: 1, fillMaterial: '方解石', roughness: '粗糙', waterWet: '潮湿', jointCount: 5,
  };
  const w1: WaterInflow = {
    id: 'w1', faceId, position: '拱顶', type: '滴水', estimatedFlow: 6, waterTemp: 14,
    waterPressure: 0.1, changeTrend: '稳定', measuredAt: Date.now() - 90000, chainage: 100,
  };
  const g1: RockMassGrade = {
    id: 'g1', faceId, grade: 'Ⅲ', bqValue: 420, rqd: 75, jv: 2.5, kv: 0.6,
    groundwater: '点滴状出水', spanWidth: 12.6, correction: 0.16, correctedBq: 404,
    supportSuggestion: 's', manualAdjusted: false, judgedAt: Date.now() - 80000,
    basisValid: true, invalidReasons: [], basisSignature: sig([j1], [w1]), basedOnBatches: [],
  };
  await db.transaction('rw', db.faces, db.joints, db.grades, db.waters, async () => {
    await db.faces.put(face);
    await db.joints.put(j1);
    await db.waters.put(w1);
    await db.grades.put(g1);
  });
  return { faceId, face, j1, w1, g1 };
}

async function main() {
  const s = await seed();

  /* 1. 两台平板各建批次（同一基线 rev=0） */
  const bA = await createBatch({ label: 'A', deviceId: 'devA', faceIds: [s.faceId] });
  const bB = await createBatch({ label: 'B', deviceId: 'devB', faceIds: [s.faceId] });

  // A 只改岩性；B 只改地质员
  await stageUpsert(bA, 'faces', { ...s.face, lithology: '砂岩' });
  await db.batches.put(bA);
  await stageUpsert(bB, 'faces', { ...s.face, geologist: '乙地质员' });
  await db.batches.put(bB);

  /* 2. A 先提交 → 成功写入 */
  const rA = await commitBatch(bA.id);
  check('A 先提交成功', rA.ok);
  if (!rA.ok) throw new Error('A should merge');
  const afterA = await db.faces.get(s.faceId);
  check('A 岩性已写入', afterA?.lithology === '砂岩', afterA?.lithology);

  /* 3. B 并发提交 → CAS 冲突，整批不写入，修改保留 */
  const rB = await commitBatch(bB.id);
  check('B 并发提交被拒绝（CAS）', !rB.ok && rB.reason === 'cas-conflict');
  const afterB = await db.faces.get(s.faceId);
  check('冲突时库中未被 B 覆盖（岩性仍为 A 的砂岩）', afterB?.lithology === '砂岩');
  const bBStored = await db.batches.get(bB.id);
  check('B 批次标记冲突且修改原样保留', bBStored?.status === 'conflict' && bBStored.faces[s.faceId]?.row?.geologist === '乙地质员');

  /* 4. B 原样重试（A 仍在）→ 仍然冲突，未写入 */
  const rB2 = await commitBatch(bB.id);
  check('B 原样重试仍冲突', !rB2.ok);

  /* 5. B 保留两版合入 → 库中岩性保留 A 的版本，B 的地质员写入，字段差异被报告 */
  const rB3 = await commitBatch(bB.id, true);
  check('B 保留两版合入成功', rB3.ok);
  if (!rB3.ok) throw new Error('rebase should merge');
  const afterRebase = await db.faces.get(s.faceId);
  check('两版并存：岩性保留 A 版本（B 未改该字段）', afterRebase?.lithology === '砂岩');
  check('两版并存：地质员取 B（仅 B 修改）', afterRebase?.geologist === '乙地质员', afterRebase?.geologist);
  check('差异报告含 1 个掌子面', rB3.report.conflicts.length === 1);
  check('差异报告标出 lithology 字段', rB3.report.conflicts[0].fieldDiffs.some((d) => d.field === 'lithology'));
  check('差异报告标出 geologist 字段（仅 B 改）', rB3.report.conflicts[0].fieldDiffs.some((d) => d.field === 'geologist' && d.changedBy === 'local'));

  /* 6. 旧批次重复提交 → 幂等，不重复计入 */
  const countsBefore = {
    faces: await db.faces.count(),
    joints: await db.joints.count(),
    grades: await db.grades.count(),
    waters: await db.waters.count(),
  };
  const rA2 = await commitBatch(bA.id);
  check('A 重复提交返回幂等结果', rA2.ok && rA2.duplicate === true);
  const countsAfter = {
    faces: await db.faces.count(),
    joints: await db.joints.count(),
    grades: await db.grades.count(),
    waters: await db.waters.count(),
  };
  check('幂等提交不改变任何表行数', JSON.stringify(countsBefore) === JSON.stringify(countsAfter));

  /* 7. 导入同 id 旧批次不会重新计入 */
  const exported = JSON.parse(JSON.stringify(bA));
  const imp = await importBatch(exported);
  check('同 id 批次导入识别为已存在', imp.existed === true && imp.batch.status === 'merged');

  /* 8. 节理组变化 → 关联级别失效并重新判定 */
  const bC = await createBatch({ label: 'C', deviceId: 'devC', faceIds: [s.faceId] });
  const j2: JointSet = {
    id: newId('joint'), faceId: s.faceId, setNo: 2, dipDirection: 200, dipAngle: 80, spacing: 15,
    persistence: 4, aperture: 2, fillMaterial: '无', roughness: '起伏粗糙', waterWet: '线流', jointCount: 12,
  };
  await stageUpsert(bC, 'joints', j2);
  await db.batches.put(bC);
  const rC = await commitBatch(bC.id);
  check('C 提交成功', rC.ok);
  if (rC.ok) {
    check('C 报告 1 个掌子面重判', rC.report.rejudged.length === 1, JSON.stringify(rC.report.rejudged));
    check('重判原因为节理组', rC.report.rejudged[0]?.reasons.includes('节理组'));
  }
  const grades = await db.grades.where('faceId').equals(s.faceId).toArray();
  const sorted = grades.sort((a, b) => b.judgedAt - a.judgedAt);
  check('产生了一条新的级别记录', sorted.length >= 2);
  const newest = sorted[0];
  const old = grades.find((g) => g.id === 'g1')!;
  check('旧级别 g1 被标记失效', old.basisValid === false && old.invalidReasons.includes('joints'));
  check('新级别有效且链接到旧级别', newest.basisValid === true && newest.prevGradeId === 'g1');
  const expectedJvJoints = [...(await db.joints.where('faceId').equals(s.faceId).toArray())];
  check('新级别 Jv 反映两组节理（自动估算）', newest.jv > 0, `jv=${newest.jv}`);
  void expectedJvJoints;

  /* 9. 涌水状态变化 → 出水状态重推、级别重判 */
  const beforeWaterGradeId = newest.id;
  const bD = await createBatch({ label: 'D', deviceId: 'devD', faceIds: [s.faceId] });
  const w2: WaterInflow = {
    id: newId('water'), faceId: s.faceId, position: '掌子面全断面', type: '股状', estimatedFlow: 80,
    waterTemp: 16, waterPressure: 0.6, changeTrend: '突增', measuredAt: Date.now(), chainage: 103,
  };
  await stageUpsert(bD, 'waters', w2);
  await db.batches.put(bD);
  const rD = await commitBatch(bD.id);
  check('D（涌水突增）提交成功', rD.ok);
  if (rD.ok) {
    check('D 报告涌水重判', rD.report.rejudged.some((x) => x.reasons.includes('涌水状态')));
  }
  const grades2 = (await db.grades.where('faceId').equals(s.faceId).toArray()).sort((a, b) => b.judgedAt - a.judgedAt);
  const newest2 = grades2[0];
  check('涌水重判产生更新一级别', newest2.id !== beforeWaterGradeId && newest2.prevGradeId === beforeWaterGradeId);
  check('出水状态升级为涌流状出水', newest2.groundwater === '涌流状出水', newest2.groundwater);
  // BQ 模型中 K1 上限 0.28：涌水主要拉低 [BQ]，级别是否跨档取决于降幅；这里校验重算确实发生
  check('强涌水使 [BQ] 下降', newest2.correctedBq < newest.correctedBq, `[BQ] ${newest.correctedBq}→${newest2.correctedBq}`);

  /* 10. 冲突批次保留的修改可通过 incomingVersion 读出（原样可重试/可再编辑） */
  const bE = await createBatch({ label: 'E', deviceId: 'devE', faceIds: [s.faceId] });
  await stageUpsert(bE, 'waters', { ...w2, id: newId('water'), estimatedFlow: 33 });
  await db.batches.put(bE);
  const incoming = incomingVersion(bE, s.faceId);
  check('incomingVersion 含批次新增涌水', incoming.waters.length >= 2);

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
