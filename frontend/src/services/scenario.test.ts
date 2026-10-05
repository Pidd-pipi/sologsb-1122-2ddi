// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

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
import { exportBatch, commitBatch } from './batchSync';
import { resolveConflict } from './conflictResolve';
import type { TunnelFace } from '../types/face';

function face(over: Partial<TunnelFace> = {}): TunnelFace {
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
    ...over,
  };
}

beforeEach(async () => {
  const tables = [db.faces, db.joints, db.grades, db.waters, db.changes, db.conflicts, db.committedBatches];
  await db.transaction('rw', tables, async () => {
    await Promise.all(tables.map((t) => t.clear()));
  });
  globalThis.localStorage!.clear();
});

/** 把乙机批次快照里的掌子面改成新岩性 */
function remoteFaceEdit(batchId: string) {
  const remote = face({ lithology: '泥岩', weathering: '强风化', updatedAt: 9000 });
  return {
    format: 'gbtunnelface-batch' as const,
    schemaVersion: 3 as const,
    batchId,
    deviceId: 'deviceB',
    deviceName: '乙机',
    exportedAt: 9000,
    baseVersion: 0,
    changes: [
      {
        tableName: 'faces' as const,
        recordId: 'f1',
        faceId: 'f1',
        operation: 'upsert' as const,
        snapshot: remote,
        updatedAt: 9000,
        deviceId: 'deviceB',
      },
    ],
  };
}

describe('双平板完整走查', () => {
  it('甲机先导出 → 乙机改了同一掌子面 → 甲机也改 → 合入冲突 → 两版都留 → 解决结果可再导出', async () => {
    // 1. 甲机建立掌子面并导出基线批次
    await logUpsert('faces', face(), 'f1');
    const baseBatch = await exportBatch();
    expect(baseBatch.changes).toHaveLength(1);

    // 2. 甲机回到现场继续改（未提交修改）
    await logUpsert('faces', face({ geologist: '甲-修正' }), 'f1');

    // 3. 乙机在同一掌子面上改了岩性，先合入（甲机此时已有未提交修改）
    const batchB = remoteFaceEdit('batch_from_B');
    const resultB = await commitBatch(batchB);
    expect(resultB.conflicts).toBe(1);
    expect(resultB.applied).toBe(0);

    // 甲机数据未被覆盖，未提交修改保留
    let current = (await db.faces.get('f1')) as TunnelFace;
    expect(current.geologist).toBe('甲-修正');
    expect(current.lithology).toBe('石灰岩');
    const pending = await db.changes.filter((c) => c.batchId === null).toArray();
    expect(pending).toHaveLength(1);

    // 4. 乙机批次文件原样重试：仍是登记过的同一批次，不重复计入也不重复登记冲突
    const retry = await commitBatch(batchB);
    expect(retry.outcome).toBe('duplicate');
    expect(await db.conflicts.count()).toBe(1);

    // 5. 解决冲突：两版都留
    const conflict = (await db.conflicts.toArray())[0];
    expect(conflict.diffs.some((d) => d.path === 'lithology')).toBe(true);
    await resolveConflict(conflict.id, 'kept-both');
    current = (await db.faces.get('f1')) as TunnelFace;
    expect(current.lithology).toBe('石灰岩');
    expect(current.remoteSnapshot?.lithology).toBe('泥岩');
    expect(current.remoteSnapshot?.weathering).toBe('强风化');

    // 6. 解决结果进入甲机待提交修改，可再导出给乙机
    const next = await exportBatch();
    const faceChange = next.changes.find((c) => c.tableName === 'faces' && c.recordId === 'f1');
    expect((faceChange?.snapshot as TunnelFace).remoteSnapshot?.lithology).toBe('泥岩');

    // 7. 本机自己导出的基线批次再导入：内容与本机一致，应用 0 条、不产生冲突
    const echo = await commitBatch(baseBatch);
    expect(echo.outcome).toBe('applied');
    expect(echo.applied).toBe(0);
    expect(echo.conflicts).toBe(0);

    // 而对端批次再次导入始终幂等
    expect((await commitBatch(batchB)).outcome).toBe('duplicate');
  });
});
