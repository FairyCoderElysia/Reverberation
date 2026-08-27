/**
 * 三类用例之一：材料方向性约束（SP1-08 ①②③④⑤）+ reflect 派生一致性 + 7 材料耐久互异。
 */
import { describe, expect, it } from 'vitest';
import {
  deriveReflect,
  effectiveMaterials,
  MATERIAL_TABLE,
  mergeTriplet,
  validateDefaultTable,
} from '../src/materials';

describe('材料表（唯一数据源）', () => {
  it('恰为 7 种材料，顺序固定', () => {
    expect(MATERIAL_TABLE).toHaveLength(7);
    expect(MATERIAL_TABLE.map((m) => m.name)).toEqual([
      'foam',
      'wood',
      'glass',
      'stone',
      'concrete',
      'metal',
      'soil',
    ]);
  });

  it('SP1-08 全部 5 条方向性约束同时满足', () => {
    expect(validateDefaultTable()).toEqual([]);
  });

  it('① 泡沫 abs[2]-abs[0] ≥ 0.2（高频更吸）', () => {
    const foam = MATERIAL_TABLE[0];
    expect(foam.abs[2] - foam.abs[0]).toBeGreaterThanOrEqual(0.2);
  });

  it('② 混凝土/石材/金属 trans[0] ≤ trans[2] 且至少一种严格不等', () => {
    const cols = MATERIAL_TABLE.filter((r) => ['concrete', 'stone', 'metal'].includes(r.name));
    for (const m of cols) expect(m.trans[0]).toBeLessThanOrEqual(m.trans[2]);
    expect(cols.some((m) => m.trans[0] < m.trans[2])).toBe(true);
  });

  it('③ 金属逐频 abs+trans 低于泡沫与土层（高反射）', () => {
    const metal = MATERIAL_TABLE.find((r) => r.name === 'metal')!;
    const foam = MATERIAL_TABLE.find((r) => r.name === 'foam')!;
    const soil = MATERIAL_TABLE.find((r) => r.name === 'soil')!;
    for (let b = 0; b < 3; b++) {
      expect(metal.abs[b] + metal.trans[b]).toBeLessThan(foam.abs[b] + foam.trans[b]);
      expect(metal.abs[b] + metal.trans[b]).toBeLessThan(soil.abs[b] + soil.trans[b]);
    }
  });

  it('④ 玻璃逐频 trans 高于混凝土与金属（透声）', () => {
    const glass = MATERIAL_TABLE.find((r) => r.name === 'glass')!;
    const concrete = MATERIAL_TABLE.find((r) => r.name === 'concrete')!;
    const metal = MATERIAL_TABLE.find((r) => r.name === 'metal')!;
    for (let b = 0; b < 3; b++) {
      expect(glass.trans[b]).toBeGreaterThan(concrete.trans[b]);
      expect(glass.trans[b]).toBeGreaterThan(metal.trans[b]);
    }
  });

  it('⑤ 至少一种材料跨频差异 ≥ 0.2', () => {
    const ok = MATERIAL_TABLE.some(
      (m) => Math.abs(m.trans[0] - m.trans[2]) >= 0.2 || m.abs[2] - m.abs[0] >= 0.2,
    );
    expect(ok).toBe(true);
  });

  it('每种 abs/trans 均为 [0,1] 系数，耐久为正整数且 7 种互异', () => {
    const duras = new Set<number>();
    for (const m of MATERIAL_TABLE) {
      for (let b = 0; b < 3; b++) {
        expect(m.abs[b]).toBeGreaterThanOrEqual(0);
        expect(m.abs[b]).toBeLessThanOrEqual(1);
        expect(m.trans[b]).toBeGreaterThanOrEqual(0);
        expect(m.trans[b]).toBeLessThanOrEqual(1);
      }
      expect(Number.isInteger(m.durability)).toBe(true);
      expect(m.durability).toBeGreaterThan(0);
      duras.add(m.durability);
    }
    expect(duras.size).toBe(7);
  });

  it('reflect === clamp(1-abs-trans, 0.01, 1)（派生一致）', () => {
    for (const m of MATERIAL_TABLE) {
      const expected = deriveReflect(m.abs, m.trans);
      const spec = effectiveMaterials(new Map())[MATERIAL_TABLE.indexOf(m)];
      expect(spec.reflect).toEqual(expected);
    }
  });

  it('setMaterial 覆盖后 reflect 随之重算，resetMaterials 恢复默认', () => {
    const before = effectiveMaterials(new Map())[0].reflect;
    const over = new Map<number, import('../src/materials').MaterialOverrides>();
    over.set(0, { abs: mergeTriplet(undefined, [0.9, undefined, undefined]) });
    const after = effectiveMaterials(over)[0].reflect;
    expect(after).not.toEqual(before);
    expect(before).toEqual(effectiveMaterials(new Map())[0].reflect);
  });
});
