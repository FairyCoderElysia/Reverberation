/**
 * 三类用例之三：体素索引公式正确性（idx = x + 64*(z + 64*y) 与逆映射）。
 */
import { describe, expect, it } from 'vitest';
import { blockCoords, blockIndex, inBounds, WORLD_X, WORLD_Y, WORLD_Z } from '../src/world';

describe('体素索引公式（确定性关键）', () => {
  it('idx = x + 64*(z + 64*y)，且逆映射自洽', () => {
    const coords = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [63, 23, 63],
      [12, 3, 45],
      [31, 5, 17],
    ];
    for (const c of coords) {
      const [x, y, z] = c;
      const idx = blockIndex(x, y, z);
      expect(idx).toBe(x + 64 * (z + 64 * y));
      expect(blockCoords(idx)).toEqual([x, y, z]);
    }
  });

  it('全量扫描：每个合法坐标索引唯一且在范围内', () => {
    const seen = new Set<number>();
    for (let y = 0; y < WORLD_Y; y++) {
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++) {
          const idx = blockIndex(x, y, z);
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(98304);
          expect(seen.has(idx)).toBe(false);
          seen.add(idx);
          expect(inBounds(x, y, z)).toBe(true);
        }
      }
    }
    expect(seen.size).toBe(98304);
  });

  it('界外坐标判定为 false', () => {
    expect(inBounds(-1, 0, 0)).toBe(false);
    expect(inBounds(0, -1, 0)).toBe(false);
    expect(inBounds(0, 0, -1)).toBe(false);
    expect(inBounds(64, 0, 0)).toBe(false);
    expect(inBounds(0, 24, 0)).toBe(false);
    expect(inBounds(0, 0, 64)).toBe(false);
  });
});
