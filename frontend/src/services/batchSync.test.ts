// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

// node 环境没有 localStorage（device.ts 与提交锁需要）
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
(globalThis as unknown as { localStorage?: unknown }).localStorage ??= new MemoryStorage();

import { db } from '../utils/db';
import { logUpsert } from './changeLog';
import { commitBatch } from './batchSync';
import { exportBatch } from './batchSync';
import { invalidateAffectedGrades, stampBasisSignatures } from './gradeInvalidate';
import { resolveConflict } from './conflictResolve';
import { newId } from '../utils/id';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import type { RockMassGrade } from '../types/grade';
import type { SyncBatch } from '../types/sync';

function face(): TunnelFace {
  return {
    id: 'f1',
    faceNo: 'ZK-102',
    chainage: 12480,
    mileageRange: [12480, 12483],
    excavationMethod: '台阶法',
    faceSize: '12.6×9.8',
    lithology: '石灰岩',
    weathering: '微风化',
    rockStrength: 60,
    attitude: { strike: 42, dipDirection: 132, dipAngle: 34 },
    recordedAt: 1000,
    geologist: '甲',
  };
}

function joint(over: Partial<JointSet> = {}): JointSet {
  return {
    id: 'j1',
    faceId: 'f1',
    setNo: 1,
    dipDirection: 120,
    dipAngle: 60,
    spacing: 40,
    persistence: 3,
    aperture: 1,
    fillMaterial: '方解石',
    roughness: '粗糙',
    waterWet: '潮湿',
    jointCount: 5,
    ...over,
  };
}

function water(over: Partial<WaterInflow> = {}): WaterInflow {
  return {
    id: 'w1',
    faceId: 'f1',
    position: '拱顶',
    type: '滴水',
    estimatedFlow: 5,
    waterTemp: 15,
    waterPressure: 0.1,
    changeTrend: '稳定',
    measuredAt: 1000,
    chainage: 100,
    ...over,
  };
}

function grade(joints: JointSet[], waters: WaterInflow[]): RockMassGrade {
  const base: RockMassGrade = {
    id: 'g1',
    faceId: 'f1',
    grade: 'Ⅲ',
    bqValue: 358,
    rqd: 78,
    jv: 6,
    kv: 0.61,
    groundwater: '点滴状出水',
    spanWidth: 12.6,
    correction: 0.1,
    correctedBq: 348,
    supportSuggestion: '',
    manualAdjusted: false,
    judgedAt: 1000,
  };
  return stampBasisSignatures(base, joints, waters);
}

/**
 * 模拟"另一台平板"：不经过本机 outbox，直接构造批次内容。
 */
function remoteBatch(changes: SyncBatch['changes']): SyncBatch {
  return {
    format: 'gbtunnelface-batch',
    schemaVersion: 3,
    batchId: newId('batch'),
    deviceId: 'deviceB',
    deviceName: '乙机',
    exportedAt: Date.now(),
    baseVersion: 0,
    changes,
  };
}

beforeEach(async () => {
  // localStorage 锁与设备标识
  const storesList = [db.faces, db.joints, db.grades, db.waters, db.changes, db.conflicts, db.committedBatches];
  await db.transaction('rw', storesList, async () => {
    await Promise.all(storesList.map((t) => t.clear()));
  });
  if (typeof globalThis.localStorage !== 'undefined') {
    globalThis.localStorage.clear();
  }
});

describe('批次合入端到端', () => {
  it('同一批次重复合入不重复计入（原样重试幂等）', async () => {
    await db.faces.put(face());
    const remote = face();
    remote.lithology = '泥岩';
    remote.updatedAt = 5000;
    const b = remoteBatch([
      {
        tableName: 'faces',
        recordId: 'f1',
        faceId: 'f1',
        operation: 'upsert',
        snapshot: remote,
        updatedAt: 5000,
        deviceId: 'deviceB',
      },
    ]);

    const first = await commitBatch(b);
    expect(first.outcome).toBe('applied');
    expect(first.applied).toBe(1);

    const second = await commitBatch(b);
    expect(second.outcome).toBe('duplicate');
    expect(second.applied).toBe(0);

    const committed = await db.committedBatches.toArray();
    expect(committed).toHaveLength(1);
  });

  it('两边都改同一掌子面：只登记冲突、本机未提交修改保留', async () => {
    const local = face();
    local.lithology = '泥岩';
    await logUpsert('faces', local, local.id); // 本机未提交修改

    const remote = face();
    remote.lithology = '砂岩';
    remote.updatedAt = 9000;
    const b = remoteBatch([
      {
        tableName: 'faces',
        recordId: 'f1',
        faceId: 'f1',
        operation: 'upsert',
        snapshot: remote,
        updatedAt: 9000,
        deviceId: 'deviceB',
      },
    ]);

    const result = await commitBatch(b);
    expect(result.conflicts).toBe(1);
    const conflicts = await db.conflicts.toArray();
    expect(conflicts[0].kind).toBe('face-diverge');
    expect(conflicts[0].diffs.some((d) => d.path === 'lithology')).toBe(true);

    // 本机版本未被覆盖
    const after = (await db.faces.get('f1')) as TunnelFace;
    expect(after.lithology).toBe('泥岩');
    // 本机未提交修改仍在 outbox
    const pending = await db.changes.filter((c) => c.batchId === null).toArray();
    expect(pending).toHaveLength(1);
    // 批次本身已登记（不会重复计入）
    expect(await db.committedBatches.count()).toBe(1);
  });

  it('两版都留后掌子面带 remoteSnapshot 且导出中保留对端差异', async () => {
    const local = face();
    local.lithology = '泥岩';
    await logUpsert('faces', local, local.id);
    const remote = face();
    remote.lithology = '砂岩';
    remote.updatedAt = 9000;
    const b = remoteBatch([
      {
        tableName: 'faces',
        recordId: 'f1',
        faceId: 'f1',
        operation: 'upsert',
        snapshot: remote,
        updatedAt: 9000,
        deviceId: 'deviceB',
      },
    ]);
    await commitBatch(b);
    const conflict = (await db.conflicts.toArray())[0];

    await resolveConflict(conflict.id, 'kept-both');
    const after = (await db.faces.get('f1')) as TunnelFace;
    expect(after.lithology).toBe('泥岩');
    expect(after.remoteSnapshot?.lithology).toBe('砂岩');

    const exported = await exportBatch();
    const faceChange = exported.changes.find((c) => c.tableName === 'faces');
    expect((faceChange?.snapshot as TunnelFace).remoteSnapshot?.lithology).toBe('砂岩');
  });

  it('涌水状态变化后原级别失效，非人工级别自动重判；人工级别只失效不覆盖', async () => {
    await db.faces.put(face());
    const joints = [joint()];
    await db.joints.bulkPut(joints);
    const waters = [water()];
    await db.waters.bulkPut(waters);
    await db.grades.put(grade(joints, waters));

    // 对端把涌水增强为股状 68 L/min
    const remoteWaters = [water({ type: '股状', estimatedFlow: 68, changeTrend: '突增' })];
    const b = remoteBatch([
      {
        tableName: 'waters',
        recordId: 'w1',
        faceId: 'f1',
        operation: 'upsert',
        snapshot: remoteWaters[0],
        updatedAt: 9000,
        deviceId: 'deviceB',
      },
    ]);
    const result = await commitBatch(b);
    expect(result.invalidatedGrades).toBe(1);

    const grades = await db.grades.toArray();
    const old = grades.find((g) => g.id === 'g1');
    expect(old?.invalid).toBe(true);
    expect(old?.invalidReason).toContain('涌水');
    const rejudged = grades.find((g) => g.autoRejudged);
    expect(rejudged).toBeTruthy();
    expect(rejudged?.groundwater).toBe('涌流状出水');
    expect(rejudged?.invalid).toBe(false);
    // 自动重判 [BQ] 应低于原值（地下水修正系数变大）
    expect(rejudged?.correctedBq).toBeLessThan(348);
  });

  it('人工修正的级别依据变化后只失效，不自动生成重判记录', async () => {
    await db.faces.put(face());
    const joints = [joint()];
    const waters = [water()];
    await db.joints.bulkPut(joints);
    await db.waters.bulkPut(waters);
    const g = grade(joints, waters);
    g.manualAdjusted = true;
    g.grade = 'Ⅴ';
    await db.grades.put(g);

    await invalidateAffectedGrades(['f1'], { track: false, source: '测试删除节理' });
    // 先造变化：删掉节理后再触发
    await db.joints.clear();
    await invalidateAffectedGrades(['f1'], { track: false, source: '测试删除节理' });

    const grades = await db.grades.where('faceId').equals('f1').toArray();
    const stillManual = grades.find((x) => x.manualAdjusted);
    expect(stillManual?.invalid).toBe(true);
    expect(grades.filter((x) => x.autoRejudged)).toHaveLength(0);
  });

  it('本机节理变化走 outbox，合并批次后级别失效联动不写本机 outbox（track 区分）', async () => {
    await db.faces.put(face());
    const joints = [joint()];
    const waters = [water()];
    await db.joints.bulkPut(joints);
    await db.waters.bulkPut(waters);
    await db.grades.put(grade(joints, waters));

    // 对端新增一个节理组
    const j2 = joint({ id: 'j2', setNo: 2, spacing: 8 });
    const b = remoteBatch([
      {
        tableName: 'joints',
        recordId: 'j2',
        faceId: 'f1',
        operation: 'upsert',
        snapshot: j2,
        updatedAt: 9000,
        deviceId: 'deviceB',
      },
    ]);
    await commitBatch(b);
    // 自动重判记录不应出现在本机 outbox（不是本机的修改）
    const pending = await db.changes.filter((c) => c.batchId === null).toArray();
    expect(pending.some((c) => c.tableName === 'grades')).toBe(false);
  });

  it('另一台设备持锁时提交返回 locked，不写入任何数据', async () => {
    globalThis.localStorage.setItem(
      'gbtunnelface:commit-lock',
      JSON.stringify({ deviceId: 'device-other', acquiredAt: Date.now() }),
    );
    const b = remoteBatch([
      {
        tableName: 'faces',
        recordId: 'f9',
        faceId: 'f9',
        operation: 'upsert',
        snapshot: { ...face(), id: 'f9' },
        updatedAt: 9000,
        deviceId: 'deviceB',
      },
    ]);
    const result = await commitBatch(b);
    expect(result.outcome).toBe('locked');
    expect(await db.faces.get('f9')).toBeUndefined();
    expect(await db.committedBatches.count()).toBe(0);

    // 锁释放后用同一批次原样重试 → 正常合入
    globalThis.localStorage.removeItem('gbtunnelface:commit-lock');
    const retry = await commitBatch(b);
    expect(retry.outcome).toBe('applied');
    expect(await db.faces.get('f9')).toBeTruthy();
  });
});

