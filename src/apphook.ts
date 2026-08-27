/**
 * M12 调试句柄 window.__app（初版）：state / reset() / debug()。
 * 覆盖 Sprint 1 全部数值断言字段（SP1-02..14）。
 */
import { runBenchRay } from './bench';
import { PIXEL_RATIO_HIGH_CAP } from './config';
import {
  effectiveMaterials,
  MATERIAL_TABLE,
  validateDefaultTable,
} from './materials';
import { mergeTriplet } from './materials';
import type { MaterialOverrides } from './materials';
import { generateWorld, SOUND_SOURCE_DEFS } from './worldgen';
import type { GraphicTier, PerfState, SoundSource, XYZA } from './types';
import { World } from './world';

export interface AppState {
  seed: number;
  worldSize: [number, number, number];
  materials: ReturnType<typeof effectiveMaterials>;
  soundSources: SoundSource[];
  player: { spawn: XYZA };
  perf: PerfState;
  blockAt: (g: XYZA) => { material: number; durability: number; facility: unknown };
  /**
   * SP1-03/SP1-10 地表高度读取。
   * - surfaceHeight(x, z) 返回单列地表高度（数字）；
   * - surfaceHeight() 无参调用返回 64×64 扁平高度数组（x + 64*z 序），
   *   满足 contract v1.2「返回 64×64 高度数组」的数值断言口径（双形态兼容）。
   */
  surfaceHeight: {
    (x: number, z: number): number;
    (): number[];
  };
  getWorldIds: () => Uint8Array; // 渲染/测试共享的世界快照
}

export interface DebugHooks {
  regenerate: (seed: number) => void;
  setMaterial: (id: number, patch: MaterialOverrides) => void;
  resetMaterials: () => void;
  setGraphicTier: (t: GraphicTier) => void;
  benchRay: (opts?: { rays?: number; bounces?: number }) => {
    avgMs: number;
    p95Ms: number;
    raysPerSec: number;
  };
  findMaterialBlocks: (id: number) => XYZA[];
}

export interface __App {
  state: AppState;
  reset: () => void;
  debug: DebugHooks;
}

export interface AppEnvironment {
  world: World;
  seed: number;
  spawn: XYZA;
  soundSources: SoundSource[];
}

/** 构建 __app（world 就绪后调用） */
export function buildApp(
  env: AppEnvironment,
  onRegenerate: (env: AppEnvironment) => void,
  onMaterialChange: () => void,
  onTierChange: (t: GraphicTier) => void,
  readPixelRatio: () => number,
): __App {
  let world = env.world;
  let seed = env.seed;
  let spawn = env.spawn;
  let soundSources = env.soundSources;
  const overrides = new Map<number, MaterialOverrides>();

  // 单调种子来源：与 Math.random 无关；世界生成路径内只使用注入 seed 的 RNG
  let seedCounter = (seed + 0x51ab3f) >>> 0;

  const perf: PerfState = {
    fps: 0,
    avgFrameMs: 0,
    drawCalls: 0,
    instances: 0,
    pixelRatio: PIXEL_RATIO_HIGH_CAP,
    lastBench: null,
  };

  const findMaterialBlocks = (id: number): XYZA[] => {
    const out: XYZA[] = [];
    const [wx, wy, wz] = world.size;
    for (let y = 0; y < wy; y++) {
      for (let z = 0; z < wz; z++) {
        for (let x = 0; x < wx; x++) {
          if (world.ids[world.idx(x, y, z)] === id) out.push([x, y, z]);
        }
      }
    }
    return out;
  };

  const regenerate = (s: number): void => {
    const next = generateWorld(s);
    world = next.world;
    seed = next.seed;
    spawn = next.spawn;
    soundSources = next.soundSources;
    onRegenerate(next);
  };

  const reset = (): void => {
    // 等价「新游戏」：换种子 + 恢复默认材料参数
    seedCounter = (seedCounter + 0x9e3779b9) >>> 0;
    overrides.clear();
    const next = generateWorld(seedCounter);
    world = next.world;
    seed = next.seed;
    spawn = next.spawn;
    soundSources = next.soundSources;
    onRegenerate(next);
    onMaterialChange();
  };

  const state: AppState = {
    get seed() {
      return seed;
    },
    get worldSize() {
      // 合同 SP1-02 要求 [64,64,24]（宽, 深, 高）；world.size 内部为 [x,y,z]=[64,24,64]，需转换口径。
      const [wx, wy, wz] = world.size;
      return [wx, wz, wy] as [number, number, number];
    },
    get materials() {
      return effectiveMaterials(overrides);
    },
    get soundSources() {
      return soundSources.map((s) => ({
        id: s.id,
        pos: [s.pos[0], s.pos[1], s.pos[2]] as XYZA,
        dominantBand: s.dominantBand,
        mineable: false as const,
      }));
    },
    get player() {
      return { spawn: [spawn[0], spawn[1], spawn[2]] as XYZA };
    },
    perf,
    blockAt: (g: XYZA) => {
      const b = world.blockAt(g);
      return { material: b.material, durability: b.durability, facility: b.facility as unknown };
    },
    surfaceHeight: ((x?: number, z?: number) => {
      if (x === undefined || z === undefined) {
        // 无参：返回 64×64 扁平高度数组（复制，避免暴露内部 TypedArray 被改写）
        return Array.from(world.surfaceH);
      }
      return world.surfaceHeight(x, z);
    }) as AppState['surfaceHeight'],
    getWorldIds: () => world.ids,
  };

  const debug: DebugHooks = {
    regenerate,
    setMaterial: (id: number, patch: MaterialOverrides) => {
      if (!Number.isInteger(id) || id < 0 || id >= MATERIAL_TABLE.length) return;
      const prev = overrides.get(id) ?? {};
      const next: MaterialOverrides = {
        abs: mergeTriplet(prev.abs, patch.abs),
        trans: mergeTriplet(prev.trans, patch.trans),
        durability: patch.durability ?? prev.durability,
        mass: patch.mass ?? prev.mass,
      };
      overrides.set(id, next);
      onMaterialChange();
    },
    resetMaterials: () => {
      overrides.clear();
      onMaterialChange();
    },
    setGraphicTier: (t: GraphicTier) => {
      onTierChange(t);
      perf.pixelRatio = readPixelRatio();
    },
    benchRay: (opts) => {
      const res = runBenchRay(world, opts ?? {});
      perf.lastBench = res;
      return res;
    },
    findMaterialBlocks: findMaterialBlocks,
  };

  return { state, reset, debug };
}

/** 启动时对默认材料表做方向性自检（违规则抛错，避免带病上线） */
export function assertDefaultTableValid(): void {
  const errors = validateDefaultTable();
  if (errors.length > 0) {
    throw new Error('材料方向性约束校验失败: ' + errors.join('; '));
  }
}

export const SOUND_SOURCE_COUNT = SOUND_SOURCE_DEFS.length;
