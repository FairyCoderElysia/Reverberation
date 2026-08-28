/**
 * window.__app 合同字段集成单测（SP1-02..14 中可离线数值断言的部分）。
 * 锁定 state.worldSize 口径 [64,64,24]、blockAt 哨兵、surfaceHeight/surfaceHeights 双 API、
 * 地形高度边界与空气占比、声源在空气、材料派生/方向性、regenerate 确定性、benchRay 有限数、
 * setMaterial 非法输入处理/reset、getWorldIds 副本、setGraphicTier 降级可见等合同断言。
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/apphook';
import { Game, memoryStorage } from '../src/game';
import { generateWorld } from '../src/worldgen';
import { TERRAIN_MAX_H, TERRAIN_MIN_H } from '../src/config';
import { WORLD_X, WORLD_Y, WORLD_Z } from '../src/world';

function makeApp(seed?: number) {
  const env = generateWorld(seed ?? 0x20260001);
  const game = new Game(env, { storage: memoryStorage() });
  let pixelRatio = 2; // 模拟 high 档
  const app = buildApp(
    game,
    () => {},
    () => {},
    (t) => {
      pixelRatio = t === 'low' ? 0.75 : 2;
    },
    () => pixelRatio,
  );
  return { app, game };
}

describe('window.__app 合同字段（离线审计）', () => {
  it('SP1-02：worldSize 口径为 [64,64,24]，blockAt 界外空气哨兵', () => {
    const { app } = makeApp();
    expect(app.state.worldSize).toEqual([64, 64, 24]);
    const inb = app.state.blockAt([32, 10, 32]);
    expect(inb).toHaveProperty('material');
    expect(inb).toHaveProperty('durability');
    expect(inb).toHaveProperty('facility');
    expect(inb).toHaveProperty('placed');
    expect(app.state.blockAt([-1, 0, 0])).toEqual({ material: 0, durability: 0, facility: null, placed: false });
    expect(app.state.blockAt([200, 3, 0])).toEqual({ material: 0, durability: 0, facility: null, placed: false });
  });

  it('SP1-03(v1.3)：surfaceHeight(x,z) 返回单列 number；surfaceHeights() 返回 64×64 扁平数组', () => {
    const { app } = makeApp();
    expect(typeof app.state.surfaceHeight(10, 10)).toBe('number');
    const arr = app.state.surfaceHeights();
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(64 * 64);
    for (let z = 0; z < 8; z++) {
      for (let x = 0; x < 8; x++) {
        expect(arr[x + 64 * z]).toBe(app.state.surfaceHeight(x, z));
      }
    }
  });

  it('SP1-03：地形起伏（≥20 柱非众数 + 4 邻接 |Δh|≥1）', () => {
    const { app } = makeApp();
    const arr = app.state.surfaceHeights();
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

  it('SP1-03：地形高度边界与空气占比、声源在空气（多 seed 扫描）', () => {
    for (const seed of [0, 1, 7, 42, 99, 123, 777, 0x20260001, 999999, 0xdeadbeef]) {
      const g = generateWorld(seed);
      const w = g.world;
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
          const h = w.surfaceHeight(x, z);
          expect(h).toBeGreaterThanOrEqual(TERRAIN_MIN_H);
          expect(h).toBeLessThanOrEqual(TERRAIN_MAX_H);
        }
      }
      let air = 0;
      for (let i = 0; i < w.ids.length; i++) if (w.ids[i] === 0) air += 1;
      expect(air / (WORLD_X * WORLD_Y * WORLD_Z)).toBeGreaterThanOrEqual(0.55);
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
          const top = w.surfaceHeight(x, z);
          const span = WORLD_Y - 1 - top;
          let airAbove = 0;
          for (let y = top + 1; y < WORLD_Y; y++) {
            if (w.ids[w.idx(x, y, z)] === 0) airAbove += 1;
          }
          expect(airAbove / span).toBeGreaterThanOrEqual(0.99);
        }
      }
      for (const s of g.soundSources) {
        expect(w.materialAt(s.pos)).toBe(0);
      }
      const [sx, sy, sz] = g.spawn;
      expect(w.materialAt([sx, sy, sz])).toBe(0);
      expect(w.materialAt([sx, sy - 1, sz])).not.toBe(0);
    }
  });

  it('SP1-04：findMaterialBlocks 7 种材料均有矿脉', () => {
    const { app } = makeApp(123);
    for (let id = 1; id <= 7; id++) {
      expect(app.debug.findMaterialBlocks(id).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('SP1-05：同 seed regenerate 逐格一致、异 seed 有差异', () => {
    const { app } = makeApp();
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

  it('SP1-06：soundSources 恰 3 项、三频各一、mineable=false、坐标固定、处于空气', () => {
    const { app } = makeApp();
    expect(app.state.soundSources).toHaveLength(3);
    expect(app.state.soundSources.map((s) => s.dominantBand).sort()).toEqual([0, 1, 2]);
    for (const s of app.state.soundSources) {
      expect(s.pos).toHaveLength(3);
      expect(s.mineable).toBe(false);
      expect(app.state.blockAt(s.pos).material).toBe(0);
    }
    const posA = app.state.soundSources.map((s) => s.pos);
    app.debug.regenerate(42);
    expect(app.state.soundSources.map((s) => s.pos)).toEqual(posA);
  });

  it('SP1-07/08：7 材料、耐久互异、reflect 派生一致、方向性 5 条', () => {
    const ms = makeApp().app.state.materials;
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
    const { app } = makeApp();
    const st = app.state;
    expect(typeof st.seed).toBe('number');
    expect(st.worldSize).toEqual([64, 64, 24]);
    expect(typeof st.surfaceHeight).toBe('function');
    expect(typeof st.surfaceHeights).toBe('function');
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
    const { app } = makeApp();
    const def0 = app.state.materials[0].abs[0];
    // 方向安全覆盖：泡沫低频吸收改为 0.20，仍满足 abs[2]-abs[0] ≥ 0.2
    app.debug.setMaterial(0, { abs: [0.2, undefined, undefined] });
    expect(app.state.materials[0].abs[0]).toBeCloseTo(0.2);
    app.reset();
    expect(app.state.materials[0].abs[0]).toBeCloseTo(def0);
  });

  it('Code-M1：setMaterial 非法输入被夹取（durability/mass），非有限数忽略', () => {
    const { app } = makeApp();
    app.debug.setMaterial(3, { durability: -10, mass: -3 });
    expect(app.state.materials[3].durability).toBe(1);
    expect(app.state.materials[3].mass).toBe(0);
    app.debug.setMaterial(3, { abs: [Number.NaN, undefined, undefined] });
    expect(app.state.materials[3].abs[0]).toBe(0.03);
    app.reset();
    expect(app.state.materials[3].durability).toBe(120);
    expect(app.state.materials[3].mass).toBe(8);
  });

  it('Code-M1：setMaterial 非法 id 与破坏方向性的覆盖被拒绝', () => {
    const { app } = makeApp();
    expect(() => app.debug.setMaterial(99, { durability: 5 })).toThrow();
    const foamAbsBefore = app.state.materials[0].abs.slice();
    expect(() => app.debug.setMaterial(0, { abs: [1, 1, 1] })).toThrow(/方向性/);
    expect(app.state.materials[0].abs).toEqual(foamAbsBefore);
  });

  it('SP1-12：benchRay 返回 {avgMs,p95Ms,raysPerSec} 均为有限数并写 lastBench', () => {
    const { app } = makeApp();
    const r = app.debug.benchRay({ rays: 128, bounces: 3 });
    expect(r).toHaveProperty('avgMs');
    expect(r).toHaveProperty('p95Ms');
    expect(r).toHaveProperty('raysPerSec');
    for (const v of [r.avgMs, r.p95Ms, r.raysPerSec]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(app.state.perf.lastBench).toEqual(r);
  });

  it('Code-m7：getWorldIds 返回副本，不暴露内部 Uint8Array 活引用', () => {
    const { app } = makeApp();
    const a = app.state.getWorldIds();
    const before = app.state.blockAt([0, 0, 0]).material;
    a[0] = 3;
    expect(app.state.blockAt([0, 0, 0]).material).toBe(before);
  });

  it('SP1-14：setGraphicTier(low) 后 pixelRatio 可读下降', () => {
    const { app } = makeApp();
    const before = app.state.perf.pixelRatio;
    app.debug.setGraphicTier('low');
    expect(app.state.perf.pixelRatio).toBeLessThan(before);
  });
});
