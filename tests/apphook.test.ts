/**
 * window.__app 合同字段集成单测（SP1-02..14 中可离线数值断言的部分）。
 * 锁定 state.worldSize 口径 [64,64,24]、blockAt 哨兵、surfaceHeight 双形态、
 * soundSources 形状、材料派生/方向性、regenerate 确定性、benchRay 结果与
 * setMaterial/reset、setGraphicTier 降级可见等合同断言，防止回归。
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/apphook';
import { generateWorld } from '../src/worldgen';

function makeApp(seed?: number) {
  const env = generateWorld(seed ?? 0x20260001);
  let pixelRatio = 2; // 模拟 high 档（与 PIXEL_RATIO_HIGH_CAP 一致）
  const app = buildApp(
    env,
    () => {},
    () => {},
    (t) => {
      pixelRatio = t === 'low' ? 0.75 : 2;
    },
    () => pixelRatio,
  );
  return app;
}

describe('window.__app 合同字段（离线审计）', () => {
  it('SP1-02：worldSize 口径为 [64,64,24]，blockAt 界外空气哨兵', () => {
    const app = makeApp();
    expect(app.state.worldSize).toEqual([64, 64, 24]);
    const inb = app.state.blockAt([32, 10, 32]);
    expect(inb).toHaveProperty('material');
    expect(inb).toHaveProperty('durability');
    expect(inb).toHaveProperty('facility');
    expect(app.state.blockAt([-1, 0, 0])).toEqual({ material: 0, durability: 0, facility: null });
    expect(app.state.blockAt([200, 3, 0])).toEqual({ material: 0, durability: 0, facility: null });
  });

  it('SP1-03：surfaceHeight(x,z) 返回单列；无参返回 64×64 数组且起伏成立', () => {
    const app = makeApp();
    expect(typeof app.state.surfaceHeight(10, 10)).toBe('number');
    const arr = app.state.surfaceHeight();
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(64 * 64);
    const freq = new Map<number, number>();
    for (const h of arr) freq.set(h, (freq.get(h) ?? 0) + 1);
    let mode = arr[0];
    let modeN = -1;
    for (const [h, n] of freq) if (n > modeN) { modeN = n; mode = h; }
    expect(arr.filter((h) => h !== mode).length).toBeGreaterThanOrEqual(20);
    let adj = false;
    for (let z = 0; z < 64 && !adj; z++) {
      for (let x = 0; x < 64 && !adj; x++) {
        const h = app.state.surfaceHeight(x, z);
        if (x + 1 < 64 && Math.abs(app.state.surfaceHeight(x + 1, z) - h) >= 1) adj = true;
        else if (z + 1 < 64 && Math.abs(app.state.surfaceHeight(x, z + 1) - h) >= 1) adj = true;
      }
    }
    expect(adj).toBe(true);
  });

  it('SP1-04：findMaterialBlocks 7 种材料均有矿脉', () => {
    const app = makeApp(123);
    for (let id = 1; id <= 7; id++) {
      expect(app.debug.findMaterialBlocks(id).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('SP1-05：同 seed regenerate 逐格一致、异 seed 有差异', () => {
    const app = makeApp();
    const coords: Array<[number, number, number]> = [];
    for (let i = 0; i < 150; i++) coords.push([(i * 13) % 64, (i * 7) % 24, (i * 29) % 64]);
    app.debug.regenerate(777);
    const a = coords.map((g) => app.state.blockAt(g).material);
    app.debug.regenerate(777);
    expect(coords.map((g) => app.state.blockAt(g).material)).toEqual(a);
    app.debug.regenerate(778);
    const c = coords.map((g) => app.state.blockAt(g).material);
    expect(c.some((v, i) => v !== a[i])).toBe(true);
  });

  it('SP1-06：soundSources 恰 3 项、三频各一、mineable=false、坐标固定', () => {
    const app = makeApp();
    expect(app.state.soundSources).toHaveLength(3);
    expect(app.state.soundSources.map((s) => s.dominantBand).sort()).toEqual([0, 1, 2]);
    for (const s of app.state.soundSources) {
      expect(s.pos).toHaveLength(3);
      expect(s.mineable).toBe(false);
    }
    const posA = app.state.soundSources.map((s) => s.pos);
    app.debug.regenerate(42);
    expect(app.state.soundSources.map((s) => s.pos)).toEqual(posA);
  });

  it('SP1-07/08：7 材料、耐久互异、reflect 派生一致、方向性 5 条', () => {
    const ms = makeApp().state.materials;
    expect(ms).toHaveLength(7);
    expect(new Set(ms.map((m) => m.durability)).size).toBe(7);
    for (const m of ms) {
      for (let b = 0; b < 3; b++) {
        expect(m.reflect[b]).toBeCloseTo(Math.min(1, Math.max(0.01, 1 - m.abs[b] - m.trans[b])));
      }
    }
    const [foam, , glass, stone, concrete, metal, soil] = ms;
    expect(foam.abs[2] - foam.abs[0]).toBeGreaterThanOrEqual(0.2);
    for (const m of [concrete, stone, metal]) expect(m.trans[0]).toBeLessThanOrEqual(m.trans[2]);
    expect([concrete, stone, metal].some((m) => m.trans[0] < m.trans[2])).toBe(true);
    for (let b = 0; b < 3; b++) {
      expect(metal.abs[b] + metal.trans[b]).toBeLessThan(foam.abs[b] + foam.trans[b]);
      expect(metal.abs[b] + metal.trans[b]).toBeLessThan(soil.abs[b] + soil.trans[b]);
      expect(glass.trans[b]).toBeGreaterThan(concrete.trans[b]);
      expect(glass.trans[b]).toBeGreaterThan(metal.trans[b]);
    }
    expect(
      ms.some((m) => Math.abs(m.trans[0] - m.trans[2]) >= 0.2 || m.abs[2] - m.abs[0] >= 0.2),
    ).toBe(true);
  });

  it('SP1-10：state 必含字段齐备，player.spawn 空气且脚下实心', () => {
    const app = makeApp();
    const st = app.state;
    expect(typeof st.seed).toBe('number');
    expect(st.worldSize).toEqual([64, 64, 24]);
    expect(typeof st.surfaceHeight).toBe('function');
    expect(typeof st.blockAt).toBe('function');
    expect(Array.isArray(st.materials)).toBe(true);
    expect(Array.isArray(st.soundSources)).toBe(true);
    expect(st.player.spawn).toHaveLength(3);
    const [sx, sy, sz] = st.player.spawn;
    expect(st.blockAt([sx, sy, sz]).material).toBe(0);
    expect(st.blockAt([sx, sy - 1, sz]).material).not.toBe(0);
    for (const k of ['fps', 'avgFrameMs', 'drawCalls', 'instances', 'pixelRatio', 'lastBench']) {
      expect(st.perf).toHaveProperty(k);
    }
  });

  it('SP1-11：setMaterial 生效、reset 恢复默认', () => {
    const app = makeApp();
    const def0 = app.state.materials[0].abs[0];
    app.debug.setMaterial(0, { abs: [0.99, undefined, undefined] });
    expect(app.state.materials[0].abs[0]).toBeCloseTo(0.99);
    app.reset();
    expect(app.state.materials[0].abs[0]).toBeCloseTo(def0);
  });

  it('SP1-12：benchRay 返回 {avgMs,p95Ms,raysPerSec} 并写 lastBench', () => {
    const app = makeApp();
    const r = app.debug.benchRay({ rays: 128, bounces: 3 });
    expect(r).toHaveProperty('avgMs');
    expect(r).toHaveProperty('p95Ms');
    expect(r).toHaveProperty('raysPerSec');
    expect(app.state.perf.lastBench).toEqual(r);
  });

  it('SP1-14：setGraphicTier(low) 后 pixelRatio 可读下降', () => {
    const app = makeApp();
    const before = app.state.perf.pixelRatio;
    app.debug.setGraphicTier('low');
    expect(app.state.perf.pixelRatio).toBeLessThan(before);
  });
});
