/**
 * 三类用例之三：体素索引公式正确性（idx = x + 64*(z + 64*y) 与逆映射）。
 */
import { describe, expect, it } from 'vitest';
import { blockCoords, blockIndex, inBounds, World, WORLD_X, WORLD_Y, WORLD_Z } from '../src/world';

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

describe('索引公式单一来源（Code-M2）', () => {
  it('renderer 不再重复硬编码索引公式/世界尺寸，blockIndex 唯一导出', () => {
    const files = import.meta.glob('../src/render/renderer.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const src = files[Object.keys(files)[0]] ?? '';
    expect(src).toBeTruthy();
    expect(src).toContain('blockIndex');
    expect(src).toContain('WORLD_X');
    expect(src).toContain('WORLD_Y');
    expect(src).toContain('WORLD_Z');
    // 渲染层不得再出现本地魔数索引公式或尺寸常量
    expect(src).not.toMatch(/x \+ 64 \* \(z \+ 64 \* y\)/);
    expect(src).not.toMatch(/const X = 64;/);
    expect(src).not.toMatch(/const Y = 24;/);
    expect(src).not.toMatch(/const Z = 64;/);
  });
});

describe('世界版本号（用户实测热修：即时渲染跟踪）', () => {
  it('putFacility 拒绝覆盖已有方块/设施（Minor #9）', () => {
    const w = new World();
    w.putBlock([0, 0, 0], 1, 30);
    const f = {
      id: 1,
      kind: 'core' as const,
      pos: w.idx(0, 0, 0),
      yaw: 0,
      energy: 0,
      coreHp: 0,
      band: 3 as const,
      linkFrom: [],
      linkTo: [],
      busState: 'idle' as const,
    };
    expect(() => w.putFacility(f)).toThrow(/已有方块|禁止无检查覆盖/);
  });

  it('putBlock/removeBlock 每次修改 ids 都递增 revision，供渲染器按帧检测', () => {
    const w = new World();
    expect(w.revision).toBe(0);
    w.putBlock([0, 0, 0], 1, 30);
    expect(w.revision).toBe(1);
    expect(w.blockAt([0, 0, 0]).material).toBe(1);
    w.putBlock([1, 0, 0], 2, 60);
    expect(w.revision).toBe(2);
    w.removeBlock([0, 0, 0]);
    expect(w.revision).toBe(3);
    expect(w.blockAt([0, 0, 0]).material).toBe(0);
  });
});
