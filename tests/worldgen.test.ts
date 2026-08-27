/**
 * 三类用例之二：同种子世界生成一致性 + 地形起伏 + 矿脉 + 声源 + 出生点。
 */
import { describe, expect, it } from 'vitest';
import { generateTerrainHeights, generateWorld, SOUND_SOURCE_DEFS } from '../src/worldgen';
import { TERRAIN_MAX_H, TERRAIN_MIN_H } from '../src/config';
import { inBounds, WORLD_X, WORLD_Y, WORLD_Z } from '../src/world';
import type { XYZA } from '../src/types';

function sampleCoords(seed: number, count: number): XYZA[] {
  // 固定采样集：含地表与地下（确定性，与 RNG 无关）
  const out: XYZA[] = [];
  for (let i = 0; i < count; i++) {
    const x = (i * 17 + seed) % WORLD_X;
    const z = (i * 31 + seed * 3) % WORLD_Z;
    const y = i % WORLD_Y;
    out.push([x, y, z]);
  }
  return out;
}

describe('世界生成（确定性）', () => {
  it('同一 seed 两次生成，固定采样集逐格一致（≥100 坐标）', () => {
    const seed = 12345;
    const a = generateWorld(seed);
    const b = generateWorld(seed);
    const coords = sampleCoords(seed, 200);
    for (const g of coords) {
      const ba = a.world.blockAt(g);
      const bb = b.world.blockAt(g);
      expect(bb.material).toBe(ba.material);
      expect(bb.durability).toBe(ba.durability);
    }
  });

  it('更换 seed 后块内容发生变化（至少 1 格不同）', () => {
    const a = generateWorld(1);
    const b = generateWorld(2);
    const coords = sampleCoords(1, 4096);
    let diff = 0;
    for (const g of coords) {
      if (a.world.blockAt(g).material !== b.world.blockAt(g).material) diff += 1;
    }
    expect(diff).toBeGreaterThan(0);
  });

  it('世界尺寸 64×64×24，且 7 种材料矿脉均存在（findMaterialBlocks 等价物）', () => {
    const w = generateWorld(7).world;
    expect(w.size).toEqual([WORLD_X, WORLD_Y, WORLD_Z]);
    for (let id = 1; id <= 7; id++) {
      let found = 0;
      for (let y = 0; y < WORLD_Y; y++) {
        for (let z = 0; z < WORLD_Z; z++) {
          for (let x = 0; x < WORLD_X; x++) {
            if (w.ids[w.idx(x, y, z)] === id) found += 1;
          }
        }
      }
      expect(found).toBeGreaterThan(0);
    }
  });

  it('地形起伏：≥20 柱不等于众数高度，且存在 4 邻接 |Δh|≥1', () => {
    const w = generateWorld(42).world;
    const heights: number[] = [];
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) heights.push(w.surfaceHeight(x, z));
    }
    // 众数高度
    const freq = new Map<number, number>();
    for (const h of heights) freq.set(h, (freq.get(h) ?? 0) + 1);
    let mode = heights[0];
    let modeN = -1;
    for (const [h, n] of freq) {
      if (n > modeN) {
        modeN = n;
        mode = h;
      }
    }
    const nonMode = heights.filter((h) => h !== mode).length;
    expect(nonMode).toBeGreaterThanOrEqual(20);

    let adjDiff = false;
    for (let z = 0; z < WORLD_Z && !adjDiff; z++) {
      for (let x = 0; x < WORLD_X && !adjDiff; x++) {
        const h = w.surfaceHeight(x, z);
        if (x + 1 < WORLD_X && Math.abs(w.surfaceHeight(x + 1, z) - h) >= 1) adjDiff = true;
        else if (z + 1 < WORLD_Z && Math.abs(w.surfaceHeight(x, z + 1) - h) >= 1) adjDiff = true;
      }
    }
    expect(adjDiff).toBe(true);
  });

  it('3 个固定声源：dominantBand 0/1/2 各一、mineable=false、位置固定（跨 seed 不变）', () => {
    const a = generateWorld(11).soundSources;
    const b = generateWorld(22).soundSources;
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    const bands = a.map((s) => s.dominantBand).sort();
    expect(bands).toEqual([0, 1, 2]);
    for (let i = 0; i < 3; i++) {
      expect(a[i].mineable).toBe(false);
      expect(b[i].pos).toEqual(a[i].pos);
    }
    expect(SOUND_SOURCE_DEFS).toHaveLength(3);
  });

  it('出生点在地表上方且脚下实心', () => {
    const seed = 99;
    const g = generateWorld(seed);
    const [sx, sy, sz] = g.spawn;
    expect(inBounds(sx, sy, sz)).toBe(true);
    expect(g.world.blockAt([sx, sy, sz]).material).toBe(0); // 空气
    expect(g.world.blockAt([sx, sy - 1, sz]).material).not.toBe(0); // 脚下实心
  });

  it('generateTerrainHeights 高度边界：多 seed 所有柱高 ∈ [6,11]（QA-M1 回归）', () => {
    const seeds = [0, 1, 7, 42, 99, 123, 777, 2026, 0x20260001, 0xdeadbeef];
    for (const seed of seeds) {
      const h = generateTerrainHeights(seed >>> 0);
      expect(h).toHaveLength(WORLD_X * WORLD_Z);
      for (let i = 0; i < h.length; i++) {
        expect(h[i], 'seed=' + seed + ' idx=' + i).toBeGreaterThanOrEqual(TERRAIN_MIN_H);
        expect(h[i], 'seed=' + seed + ' idx=' + i).toBeLessThanOrEqual(TERRAIN_MAX_H);
      }
    }
  });

  it('每柱地表以上 ≥99% 为空气（多 seed 扫描，QA-M1 回归）', () => {
    for (const seed of [0, 42, 0x20260001, 0xdeadbeef]) {
      const g = generateWorld(seed);
      const w = g.world;
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
          const top = w.surfaceHeight(x, z);
          const span = WORLD_Y - 1 - top;
          expect(span).toBeGreaterThan(0);
          let airAbove = 0;
          for (let y = top + 1; y < WORLD_Y; y++) {
            if (w.ids[w.idx(x, y, z)] === 0) airAbove += 1;
          }
          expect(airAbove / span).toBeGreaterThanOrEqual(0.99);
        }
      }
    }
  });

  it('3 个固定声源格均为空气（QA-M1 回归）', () => {
    for (const seed of [0, 42, 0x20260001, 999999]) {
      const g = generateWorld(seed);
      for (const s of g.soundSources) {
        expect(s.pos).toHaveLength(3);
        expect(g.world.materialAt(s.pos), 'seed=' + seed + ' pos=' + s.pos.join(',')).toBe(0);
      }
    }
  });

  it('空气占比 ≥ 0.55（多 seed 扫描，QA-M1 回归）', () => {
    for (const seed of [0, 42, 0x20260001, 0xdeadbeef]) {
      const w = generateWorld(seed).world;
      let air = 0;
      for (let i = 0; i < w.ids.length; i++) if (w.ids[i] === 0) air += 1;
      expect(air / (WORLD_X * WORLD_Y * WORLD_Z)).toBeGreaterThanOrEqual(0.55);
    }
  });
});
