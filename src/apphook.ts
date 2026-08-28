/**
 * M12 调试句柄 window.__app：state / reset() / debug（对象）。
 * S1 字段/钩子全部保留（不回归），S2 增量见 DebugHooks/AppState 注释。
 * 本模块绑定 Game（单权威运行时），只读投影 + 命令转发，不持有第二份状态。
 */
import { runBenchRay } from './bench';
import { effectiveRows, MATERIAL_TABLE, validateTable } from './materials';
import { mergeTriplet } from './materials';
import type { MaterialOverrides } from './materials';
import type { Game } from './game';
import { INTERACTION_REACH } from './config';
import type { GraphicTier, PerfState, SoundSource, XYZA } from './types';
import type { BlockRef } from './types';

export interface AppState {
  seed: number;
  worldSize: [number, number, number];
  materials: ReturnType<Game['materialSpecs']>;
  soundSources: SoundSource[];
  player: {
    spawn: XYZA;
    pos: [number, number, number];
    vel: [number, number, number];
    yaw: number;
    pitch: number;
    grounded: boolean;
  };
  /** S2：库存（副本，index 1..7 为材料数量） */
  inventory: number[];
  /** S2：当前选中材料 id（1..7） */
  selected: number;
  /** S2：放置方块计数（与 world.placed 同一增量来源） */
  placedBlocks: number;
  /** S2：挖掘进度 0..1（无目标时为 0） */
  miningProgress: number;
  /** S2：交互距离上限（格，默认 6） */
  interactionReach: number;
  /** S2：最近一次 writeSave 成功后的 Unix 毫秒时间戳（number） */
  lastSavedAt: number;
  /** S2：最近一次写档/载入异常的中文提示（null=无；只存存档异常，不承载交互提示） */
  saveError: string | null;
  loadNotice: string | null;
  /** S2：交互类可见提示（挖掘/放置失败原因、存档体积预警等；与 saveError 分离） */
  uiNotice: string | null;
  perf: PerfState;
  blockAt: (g: XYZA) => BlockRef;
  surfaceHeight: (x: number, z: number) => number;
  surfaceHeights: () => number[];
  getWorldIds: () => Uint8Array;
}

export interface DebugHooks {
  // S1
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
  // S2 增量
  giveItem: (id: number, n: number) => void;
  saveNow: () => void;
  loadSave: () => 'loaded' | 'empty' | 'invalid';
  clearSave: () => void;
  teleport: (pos: XYZA) => void;
}

export interface __App {
  state: AppState;
  reset: () => void;
  debug: DebugHooks;
}

/** 构建 __app（Game 就绪后调用）。 */
export function buildApp(
  game: Game,
  onWorldChange: (game: Game) => void,
  onMaterialChange: () => void,
  onTierChange: (t: GraphicTier) => void,
  readPixelRatio: () => number,
): __App {
  const perf: PerfState = {
    fps: 0,
    avgFrameMs: 0,
    drawCalls: 0,
    instances: 0,
    pixelRatio: readPixelRatio(),
    lastBench: null,
  };

  const findMaterialBlocks = (id: number): XYZA[] => {
    const out: XYZA[] = [];
    const w = game.world;
    for (let y = 0; y < w.size[1]; y++) {
      for (let z = 0; z < w.size[2]; z++) {
        for (let x = 0; x < w.size[0]; x++) {
          if (w.ids[w.idx(x, y, z)] === id) out.push([x, y, z]);
        }
      }
    }
    return out;
  };

  const state: AppState = {
    get seed() {
      return game.seed;
    },
    get worldSize() {
      // game.world.size = [x, y, z]；对外口径恒为 [x, z, y]（64,64,24）
      const [x, y, z] = game.world.size;
      return [x, z, y] as [number, number, number];
    },
    get materials() {
      return game.materialSpecs();
    },
    get soundSources() {
      return game.soundSources.map((s) => ({
        id: s.id,
        pos: [s.pos[0], s.pos[1], s.pos[2]] as XYZA,
        dominantBand: s.dominantBand,
        mineable: false as const,
      }));
    },
    get player() {
      return {
        spawn: [game.spawn[0], game.spawn[1], game.spawn[2]] as XYZA,
        pos: game.playerPos,
        vel: [game.body.vel[0], game.body.vel[1], game.body.vel[2]] as [number, number, number],
        yaw: game.body.yaw,
        pitch: game.body.pitch,
        grounded: game.body.grounded,
      };
    },
    get inventory() {
      return game.inventory.slice();
    },
    get selected() {
      return game.selected;
    },
    get placedBlocks() {
      return game.world.countPlacedBlocks();
    },
    get miningProgress() {
      return game.miningProgress;
    },
    get interactionReach() {
      return INTERACTION_REACH;
    },
    get lastSavedAt() {
      return game.lastSavedAt;
    },
    get saveError() {
      return game.saveError;
    },
    get loadNotice() {
      return game.loadNotice;
    },
    get uiNotice() {
      return game.uiNotice;
    },
    perf,
    blockAt: (g: XYZA) => game.world.blockAt(g),
    surfaceHeight: (x, z) => game.world.surfaceHeight(x, z),
    surfaceHeights: () => Array.from(game.world.surfaceH),
    getWorldIds: () => game.world.ids.slice(),
  };

  const debug: DebugHooks = {
    regenerate: (seed: number) => {
      game.regenerate(seed);
      onWorldChange(game);
    },
    setMaterial: (id: number, patch: MaterialOverrides) => {
      if (!Number.isInteger(id) || id < 0 || id >= MATERIAL_TABLE.length) {
        throw new Error('setMaterial: 材料 id 非法（需为 0..' + (MATERIAL_TABLE.length - 1) + ' 的整数）');
      }
      const prev = game.overrides.get(id) ?? {};
      const next: MaterialOverrides = {
        abs: mergeTriplet(prev.abs, patch.abs),
        trans: mergeTriplet(prev.trans, patch.trans),
        durability: patch.durability ?? prev.durability,
        mass: patch.mass ?? prev.mass,
      };
      const trial = new Map(game.overrides);
      trial.set(id, next);
      const violations = validateTable(effectiveRows(trial));
      if (violations.length > 0) {
        throw new Error('setMaterial 使材料方向性约束失效: ' + violations.join('; '));
      }
      game.overrides.set(id, next);
      onMaterialChange();
    },
    resetMaterials: () => {
      game.overrides.clear();
      onMaterialChange();
    },
    setGraphicTier: (t: GraphicTier) => {
      onTierChange(t);
      perf.pixelRatio = readPixelRatio();
    },
    benchRay: (opts) => {
      const res = runBenchRay(game.world, opts ?? {});
      perf.lastBench = res;
      return res;
    },
    findMaterialBlocks: findMaterialBlocks,
    giveItem: (id, n) => {
      game.giveItem(id, n);
    },
    saveNow: () => {
      game.writeSave();
    },
    loadSave: () => {
      return game.loadSave();
    },
    clearSave: () => {
      game.clearSave();
    },
    teleport: (pos) => {
      game.teleport(pos);
    },
  };

  const reset = (): void => {
    game.reset();
    onWorldChange(game);
    onMaterialChange();
  };

  return { state, reset, debug };
}

/** 启动时对默认材料表做方向性自检（违规则抛错，避免带病上线） */
export function assertDefaultTableValid(): void {
  const errors = validateTable(MATERIAL_TABLE);
  if (errors.length > 0) {
    throw new Error('材料方向性约束校验失败: ' + errors.join('; '));
  }
}
