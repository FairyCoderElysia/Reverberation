/**
 * 世界生成（确定性）：起伏地形 + 7 材料矿脉 + 3 个固定环境声源点 + 出生点。
 * 严格禁止 Math.random —— 只使用给定 seed 的 mulberry32 RNG。
 */
import { TERRAIN_MAX_H, TERRAIN_MIN_H, VEIN_MIN_RADIUS } from './config';
import { MATERIAL_TABLE } from './materials';
import { mulberry32, randInt } from './rng';
import type { Band, SoundSource, XYZA } from './types';
import { inBounds, World, WORLD_X, WORLD_Y, WORLD_Z } from './world';

/** 3 个固定环境声源点：位置恒定（不随种子变化），dominantBand 0/1/2 各一 */
export const SOUND_SOURCE_DEFS: ReadonlyArray<{
  id: number;
  pos: XYZA;
  dominantBand: Band;
}> = [
  { id: 0, pos: [15, 12, 15], dominantBand: 0 }, // 低频
  { id: 1, pos: [48, 12, 16], dominantBand: 1 }, // 中频
  { id: 2, pos: [32, 12, 48], dominantBand: 2 }, // 高频
];

/** 每材料矿脉数量（全部 7 种均显式布矿脉，保证 findMaterialBlocks(id) ≥ 1） */
const VEINS_PER_MATERIAL = 3;

export interface GeneratedWorld {
  world: World;
  seed: number;
  spawn: XYZA;
  soundSources: SoundSource[];
}

/** 2D 值噪声：格点随机 + 双线性插值，确定性 */
function valueNoise(rng: () => number, cell: number, out: number[][]): void {
  const gx = cell + 1;
  const gz = cell + 1;
  const grid: number[][] = [];
  for (let i = 0; i < gx; i++) {
    const row: number[] = [];
    for (let j = 0; j < gz; j++) row.push(rng());
    grid.push(row);
  }
  for (let zi = 0; zi < WORLD_Z; zi++) {
    for (let xi = 0; xi < WORLD_X; xi++) {
      const u = xi / cell;
      const v = zi / cell;
      const i = Math.min(Math.floor(u), cell - 1);
      const j = Math.min(Math.floor(v), cell - 1);
      const fu = u - i;
      const fv = v - j;
      const sx = fu * fu * (3 - 2 * fu); // smoothstep
      const sy = fv * fv * (3 - 2 * fv);
      const a = grid[i][j];
      const b = grid[i + 1][j];
      const c = grid[i][j + 1];
      const d = grid[i + 1][j + 1];
      const top = a + (b - a) * sx;
      const bot = c + (d - c) * sx;
      out[zi][xi] = top + (bot - top) * sy;
    }
  }
}

/**
 * 生成地形高度数组（64×64），返回每列地表高度（0..23）。
 * 做法：两层不同格距的值噪声叠加 → 映射到 [TERRAIN_MIN_H, TERRAIN_MAX_H]。
 */
export function generateTerrainHeights(seed: number): Uint8Array {
  const h = new Uint8Array(WORLD_X * WORLD_Z);
  const n1: number[][] = Array.from({ length: WORLD_Z }, () => new Array<number>(WORLD_X));
  const n2: number[][] = Array.from({ length: WORLD_Z }, () => new Array<number>(WORLD_X));
  valueNoise(mulberry32(seed ^ 0x9e3779b9), 6, n1);
  valueNoise(mulberry32(seed ^ 0x85ebca6b), 3, n2);

  const span = TERRAIN_MAX_H - TERRAIN_MIN_H; // 5
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const n = n1[z][x] * 0.62 + n2[z][x] * 0.38; // [0,1)
      const v = TERRAIN_MIN_H + Math.round(n * span); // 6..11
      h[x + WORLD_X * z] = v;
    }
  }
  return h;
}

/** 将地形写入世界：地表土壤、地下石材 */
function fillTerrain(world: World, heights: Uint8Array): void {
  const soilDur = MATERIAL_TABLE[6].durability;
  const stoneDur = MATERIAL_TABLE[3].durability;
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const top = heights[x + WORLD_X * z];
      for (let y = 0; y <= top; y++) {
        const i = world.idx(x, y, z);
        if (y === top) {
          world.ids[i] = 6; // 土壤
          world.durability[i] = soilDur;
        } else {
          world.ids[i] = 3; // 石材
          world.durability[i] = stoneDur;
        }
      }
    }
  }
  world.recomputeAllSurfaces();
}

/**
 * 布矿脉：每条矿脉为以地表为中心的椭球（半径 2..4），替换其覆盖的实体方块。
 * 中心列地表格必被替换，保证每种材料至少 1 格。
 */
function placeVeins(world: World, seed: number): void {
  const rng = mulberry32(seed ^ 0x27d4eb2f);
  const cx0 = 8;
  const cx1 = WORLD_X - 9;
  const cz0 = 8;
  const cz1 = WORLD_Z - 9;

  for (let m = 0; m < MATERIAL_TABLE.length; m++) {
    const dur = MATERIAL_TABLE[m].durability;
    for (let v = 0; v < VEINS_PER_MATERIAL; v++) {
      const cxp = randInt(rng, cx0, cx1);
      const czp = randInt(rng, cz0, cz1);
      const r = randInt(rng, VEIN_MIN_RADIUS, 4);
      const ry = randInt(rng, 1, Math.max(1, r - 1));
      const cy = world.surfaceHeight(cxp, czp);

      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cxp + dx;
          const z = czp + dz;
          if (!inBounds(x, 0, z)) continue;
          const surf = world.surfaceHeight(x, z);
          for (let y = Math.max(0, cy - ry); y <= surf; y++) {
            const el = (dx * dx) / (r * r) + (dz * dz) / (r * r) + ((y - cy) * (y - cy)) / (ry * ry);
            if (el <= 1.0) {
              const i = world.idx(x, y, z);
              if (world.ids[i] !== 0) {
                world.ids[i] = m + 1; // id = 1..7
                world.durability[i] = dur;
              }
            }
          }
        }
      }
    }
  }
  world.recomputeAllSurfaces();
}

/** 选取出生点：固定规则，保证「地表上方、脚下实心」 */
function pickSpawn(world: World): XYZA {
  // 从世界中心向边缘扫描，取第一个满足「该格是空气且正下方一列非空」的列
  const center = Math.floor(WORLD_X / 2);
  for (let r = 0; r < WORLD_X; r++) {
    for (let z = center - r; z <= center + r; z++) {
      for (let x = center - r; x <= center + r; x++) {
        if (!inBounds(x, 0, z)) continue;
        const top = world.surfaceHeight(x, z);
        if (top <= 0) continue;
        const footY = top + 1;
        if (footY >= WORLD_Y) continue;
        if (world.blockAt([x, footY, z]).material === 0) {
          return [x, footY, z];
        }
      }
    }
  }
  // 兜底：中心列
  const fallbackTop = world.surfaceHeight(center, center);
  return [center, fallbackTop + 1, center];
}

/** 全量生成：同一 seed 两次调用结果完全一致（逐格） */
export function generateWorld(seed: number): GeneratedWorld {
  const s = seed >>> 0;
  const world = new World();
  const heights = generateTerrainHeights(s);
  fillTerrain(world, heights);
  placeVeins(world, s);

  const spawn = pickSpawn(world);
  const soundSources: SoundSource[] = SOUND_SOURCE_DEFS.map((d) => ({
    id: d.id,
    pos: [d.pos[0], d.pos[1], d.pos[2]] as XYZA,
    dominantBand: d.dominantBand,
    mineable: false,
  }));

  return { world, seed: s, spawn, soundSources };
}

