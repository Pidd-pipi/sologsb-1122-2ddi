import { describe, expect, it } from 'vitest';
import {
  jointBasisSignature,
  waterBasisSignature,
  inferGroundwater,
  kvFromJv,
  rejudgeGrade,
} from './gradeBasis';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import type { RockMassGrade } from '../types/grade';

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
    waterWet: '干燥',
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

function prevGrade(over: Partial<RockMassGrade> = {}): RockMassGrade {
  return {
    id: 'g1',
    faceId: 'f1',
    grade: 'Ⅲ',
    bqValue: 358,
    rqd: 78,
    jv: 6.2,
    kv: 0.61,
    groundwater: '点滴状出水',
    spanWidth: 12.6,
    correction: 0.1,
    correctedBq: 348,
    supportSuggestion: '',
    manualAdjusted: false,
    invalid: false,
    judgedAt: 1000,
    ...over,
  };
}

describe('gradeBasis 依据签名', () => {
  it('节理产状/条数/渗水状态变化都会改变签名', () => {
    const base = joint();
    const sig = jointBasisSignature([base]);
    expect(jointBasisSignature([joint({ dipAngle: 70 })])).not.toBe(sig);
    expect(jointBasisSignature([joint({ jointCount: 9 })])).not.toBe(sig);
    expect(jointBasisSignature([joint({ waterWet: '线流' })])).not.toBe(sig);
    expect(jointBasisSignature([joint({ spacing: 50 })])).not.toBe(sig);
  });

  it('涌水类型/涌水量/趋势变化都会改变签名，顺序不影响', () => {
    const sig = waterBasisSignature([water()]);
    expect(waterBasisSignature([water({ type: '股状' })])).not.toBe(sig);
    expect(waterBasisSignature([water({ estimatedFlow: 68 })])).not.toBe(sig);
    expect(waterBasisSignature([water({ changeTrend: '突增' })])).not.toBe(sig);
    const a = water({ id: 'a' });
    const b = water({ id: 'b', type: '线流', estimatedFlow: 30 });
    expect(waterBasisSignature([a, b])).toBe(waterBasisSignature([b, a]));
  });
});

describe('涌水状态推导', () => {
  it('按涌水量与类型推导地下水修正档位', () => {
    expect(inferGroundwater([], [])).toBe('干燥');
    expect(inferGroundwater([], [joint({ waterWet: '滴水' })])).toBe('点滴状出水');
    expect(inferGroundwater([water({ estimatedFlow: 30 })], [])).toBe('线状出水');
    expect(inferGroundwater([water({ estimatedFlow: 68 })], [])).toBe('涌流状出水');
    expect(inferGroundwater([water({ type: '股状', estimatedFlow: 1 })], [])).toBe('涌流状出水');
  });
});

describe('rejudgeGrade 重新判定', () => {
  it('涌水增强后修正系数增大、级别可能变差', () => {
    const prev = prevGrade();
    const before = rejudgeGrade(prev, 60, [joint()], [water({ estimatedFlow: 5 })], false);
    const after = rejudgeGrade(prev, 60, [joint()], [water({ estimatedFlow: 68, type: '股状' })], false);
    expect(after.correction).toBeGreaterThan(before.correction);
    expect(after.correctedBq).toBeLessThan(before.correctedBq);
  });

  it('节理变化后由新 Jv 重估 Kv 并重算 BQ；仅涌水变化时沿用原 Kv/BQ', () => {
    const prev = prevGrade({ kv: 0.61, bqValue: 422 });
    const kept = rejudgeGrade(prev, 60, [joint()], [water()], false);
    expect(kept.kv).toBe(0.61);
    expect(kept.bqValue).toBe(422);
    const dense = rejudgeGrade(
      prev,
      60,
      [joint({ spacing: 5 }), joint({ spacing: 6, id: 'j2' })],
      [water()],
      true,
    );
    expect(dense.kv).toBeLessThan(0.61);
    expect(dense.kv).toBe(kvFromJv(dense.jv));
    expect(dense.bqValue).not.toBe(422);
  });
});
