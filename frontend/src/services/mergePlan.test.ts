import { describe, expect, it } from 'vitest';
import { diffFields, jsonEqual, planMerge, type LocalContext } from './mergePlan';
import type { SyncBatch, ChangeEntry } from '../types/sync';
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
    rockStrength: 62,
    attitude: { strike: 42, dipDirection: 132, dipAngle: 34 },
    recordedAt: 1000,
    geologist: '岑柏川',
    updatedAt: 1000,
    ...over,
  };
}

function batch(changes: SyncBatch['changes'], batchId = 'batch_x'): SyncBatch {
  return {
    format: 'gbtunnelface-batch',
    schemaVersion: 3,
    batchId,
    deviceId: 'deviceB',
    deviceName: '乙机',
    exportedAt: 5000,
    baseVersion: 0,
    changes,
  };
}

function pendingChange(snapshot: unknown, updatedAt: number): ChangeEntry {
  return {
    key: 'faces:f1',
    tableName: 'faces',
    recordId: 'f1',
    faceId: 'f1',
    operation: 'upsert',
    snapshot,
    updatedAt,
    deviceId: 'deviceA',
    batchId: null,
  };
}

describe('planMerge 合并规划', () => {
  it('本机无记录时直接写入', () => {
    const b = batch([
      {
        tableName: 'faces',
        recordId: 'f1',
        faceId: 'f1',
        operation: 'upsert',
        snapshot: face(),
        updatedAt: 2000,
        deviceId: 'deviceB',
      },
    ]);
    const ctx = new Map<string, LocalContext>([['faces:f1', { record: null, pending: null, lastLogged: null }]]);
    const plan = planMerge(b, ctx);
    expect(plan.actions[0].type).toBe('apply-upsert');
    expect(plan.conflicts).toHaveLength(0);
  });

  it('同一掌子面两边都改过时产生 face-diverge 冲突且不直接写入', () => {
    const local = face({ lithology: '泥岩', updatedAt: 3000 });
    const remote = face({ lithology: '砂岩', updatedAt: 4000 });
    const b = batch([
      {
        tableName: 'faces',
        recordId: 'f1',
        faceId: 'f1',
        operation: 'upsert',
        snapshot: remote,
        updatedAt: 4000
        ,
        deviceId: 'deviceB',
      },
    ]);
    const ctx = new Map<string, LocalContext>([
      ['faces:f1', { record: local, pending: pendingChange(local, 3000), lastLogged: null }],
    ]);
    const plan = planMerge(b, ctx);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].kind).toBe('face-diverge');
    expect(plan.actions.every((a) => a.type === 'skip')).toBe(true);
  });

  it('只有对端改过（本机无未提交修改、时间更新）时直接覆盖', () => {
    const local = face({ lithology: '石灰岩', updatedAt: 2000 });
    const remote = face({ lithology: '砂岩', updatedAt: 4000 });
    const b = batch([
      {
        tableName: 'faces',
        recordId: 'f1',
        faceId: 'f1',
        operation: 'upsert',
        snapshot: remote,
        updatedAt: 4000,
        deviceId: 'deviceB',
      },
    ]);
    const logged: ChangeEntry = { ...pendingChange(local, 2000), batchId: 'batch_old', deviceId: 'deviceA' };
    const ctx = new Map<string, LocalContext>([['faces:f1', { record: local, pending: null, lastLogged: logged }]]);
    const plan = planMerge(b, ctx);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.actions[0].type).toBe('apply-upsert');
  });

  it('对端删除而本机有未提交修改时登记 remote-delete-local-edit 冲突', () => {
    const local = face();
    const b = batch([
      {
        tableName: 'joints',
        recordId: 'j1',
        faceId: 'f1',
        operation: 'remove',
        updatedAt: 4000,
        deviceId: 'deviceB',
      },
    ]);
    const ctx = new Map<string, LocalContext>([
      [
        'joints:j1',
        {
          record: { id: 'j1' },
          pending: { ...pendingChange({ id: 'j1' }, 3000), key: 'joints:j1', tableName: 'joints', recordId: 'j1' },
          lastLogged: null,
        },
      ],
    ]);
    const plan = planMerge(b, ctx);
    expect(plan.conflicts[0].kind).toBe('remote-delete-local-edit');
    expect(plan.conflicts[0].remoteSnapshot).toBeUndefined();
  });

  it('内容一致时不产生冲突（忽略 updatedAt 元数据）', () => {
    const local = face({ updatedAt: 3000 });
    const remote = face({ updatedAt: 4000 });
    expect(jsonEqual(local, remote)).toBe(true);
    const b = batch([
      {
        tableName: 'faces',
        recordId: 'f1',
        faceId: 'f1',
        operation: 'upsert',
        snapshot: remote,
        updatedAt: 4000,
        deviceId: 'deviceB',
      },
    ]);
    const ctx = new Map<string, LocalContext>([
      ['faces:f1', { record: local, pending: pendingChange(local, 3000), lastLogged: null }],
    ]);
    const plan = planMerge(b, ctx);
    expect(plan.conflicts).toHaveLength(0);
  });
});

describe('diffFields 字段差异', () => {
  it('标出岩性与倾角差异', () => {
    const diffs = diffFields(
      face({ lithology: '石灰岩', attitude: { strike: 42, dipDirection: 132, dipAngle: 34 } }),
      face({ lithology: '泥岩', attitude: { strike: 42, dipDirection: 132, dipAngle: 55 } }),
    );
    const paths = diffs.map((d) => d.path);
    expect(paths).toContain('lithology');
    expect(paths).toContain('attitude.dipAngle');
    expect(paths).not.toContain('attitude.strike');
  });
});
