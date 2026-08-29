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
import { DAY_LENGTH_SECONDS, INTERACTION_REACH } from './config';
import { blockCoords } from './world';
import type { BandEnergy, FacilityKind, FacilitySnapshot, GraphicTier, OrbitState, PerfState, SimState, SoundSource, SoundViewState, XYZA } from './types';
import type { BlockRef } from './types';
import { FACILITY_DEFS, RECIPES } from './recipes';

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
    /** S3：当前视角模式（'first' | 'orbit'） */
    viewMode: 'first' | 'orbit';
  };
  /** S3：轨道俯瞰参数（只读投影） */
  orbit: OrbitState;
  /** S3：全天相位 [0,1) */
  timeOfDay: number;
  /** S3：天数（从 0 开始） */
  day: number;
  /** S3：全天时长秒数（只读） */
  dayLengthSeconds: number;
  /** S3：配方表（与合成 UI 同源） */
  recipes: ReturnType<typeof recipeCopies>;
  /** S3/S6：设施能力定义（core/probe 真实实现；cannon/duct/relay 无真实能力） */
  facilityDefs: ReturnType<typeof facilityDefCopies>;
  /** S3：已放置设施快照（{cell,kind,yaw}，cell 单一来源） */
  facilities: FacilitySnapshot[];
  /** S6：全局能量池（唯一储能字段；多核心采收同一池，不提供 state.core.energy 实例语义） */
  coreEnergy: number;
  /** S6：探针实时只读读数（与 energyField.sample 同源；不持久化） */
  probes: { cell: XYZA; reading: BandEnergy }[];
  /** S2：库存（副本，index 1..12 为物品数量） */
  inventory: number[];
  /** S2：当前选中物品 id（1..12） */
  selected: number;
  /** S2：放置方块计数（与 world.placed 同一增量来源） */
  placedBlocks: number;
  /** 用户实测热修：世界内容版本号（放置/挖掘/载入等每次修改递增；渲染器按帧检测即时重建） */
  worldRevision: number;
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
  /** S4：能量场唯一读 API（未命中/越界返回 [0,0,0]） */
  energyField: {
    sample: (g: XYZA) => BandEnergy;
    version: number;
  };
  /** S5：全局图形档（与 debug.setGraphicTier 同源） */
  graphicTier: GraphicTier;
  /** S5：声场视图状态（version 与 energyField.version 同步；tier 派生自 graphicTier） */
  soundView: SoundViewState;
  /** S5：声学/模拟性能指标 */
  sim: SimState;
}

export interface DebugHooks {
  // S1
  regenerate: (seed: number) => void;
  setMaterial: (id: number, patch: MaterialOverrides) => void;
  resetMaterials: () => void;
  setGraphicTier: (t: GraphicTier) => void;
  /** S5 增量：声场视图开关（与 UI/热键共用同一 state.soundView.visible） */
  setSoundView: (visible: boolean) => void;
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
  // S3 增量
  setViewMode: (mode: 'first' | 'orbit') => void;
  setOrbit: (patch: Partial<OrbitState>) => void;
  craft: (recipeId: number) => { ok: boolean; reason: string };
  placeFacility: (kind: FacilityKind, cell: XYZA, yaw?: number) => { ok: boolean; reason: string };
  rotateFacility: (cell: XYZA, deltaRadians?: number) => { ok: boolean; reason: string };
  removeFacility: (cell: XYZA) => { ok: boolean; reason: string };
  // S4 增量
  /** S6：会话级设置全局储能（有限非负；不写档，reset 恢复默认） */
  setCoreEnergy: (e: number) => void;
  /** S6：读取任意格实时声能（不要求先放置探针；非法/越界/NaN 抛中文错误） */
  probeAt: (cell: XYZA) => BandEnergy;
  emitSource: (pos: XYZA, power?: BandEnergy, dir?: XYZA) => void;
  clearSources: () => void;
  recalcAcoustics: () => void;
  setTuning: (patch: Partial<import('./acoustics').AcousticTuning>) => void;
  resetTuning: () => void;
}

export interface __App {
  state: AppState;
  reset: () => void;
  debug: DebugHooks;
}

function recipeCopies() {
  return RECIPES.map((r) => ({
    id: r.id,
    name: r.name,
    ingredients: r.ingredients.map((i) => ({ itemId: i.itemId, qty: i.qty })),
    output: { ...r.output },
  }));
}

function facilityDefCopies() {
  return FACILITY_DEFS.map((f) => ({
    id: f.id,
    kind: f.kind,
    name: f.name,
    itemId: f.itemId,
    implemented: f.implemented,
    abilities: { ...f.abilities },
  }));
}

/** 构建 __app（Game 就绪后调用）。 */
export function buildApp(
  game: Game,
  onWorldChange: (game: Game) => void,
  onMaterialChange: () => void,
  onTierChange: (t: GraphicTier) => void,
  readPixelRatio: () => number,
  onSoundViewChange?: (visible: boolean) => void,
): __App {
  const perf: PerfState = {
    fps: 0,
    avgFrameMs: 0,
    drawCalls: 0,
    instances: 0,
    visualInstances: 0,
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
        power: [s.power[0], s.power[1], s.power[2]] as [number, number, number],
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
        viewMode: game.viewMode,
      };
    },
    get orbit() {
      return {
        distance: game.orbit.distance,
        yaw: game.orbit.yaw,
        pitch: game.orbit.pitch,
        target: [game.orbit.target[0], game.orbit.target[1], game.orbit.target[2]] as [number, number, number],
      };
    },
    get timeOfDay() {
      return game.timeOfDay;
    },
    get day() {
      return game.day;
    },
    get dayLengthSeconds() {
      return DAY_LENGTH_SECONDS;
    },
    get recipes() {
      return recipeCopies();
    },
    get facilityDefs() {
      return facilityDefCopies();
    },
    get facilities() {
      return game.facilitySnapshots().map((f) => ({ cell: [...f.cell] as XYZA, kind: f.kind, yaw: f.yaw }));
    },
    get coreEnergy() {
      return game.coreEnergy;
    },
    get probes() {
      return game.world
        .facilityStates()
        .filter((f) => f.kind === 'probe')
        .map((f) => ({
          cell: blockCoords(f.pos),
          reading: game.energyField.sample(blockCoords(f.pos)),
        }));
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
    get worldRevision() {
      return game.world.revision;
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
    get energyField() {
      return {
        sample: (g: XYZA) => game.energyField.sample(g),
        get version() {
          return game.energyField.version;
        },
      };
    },
    get graphicTier() {
      return game.graphicTier;
    },
    get soundView() {
      return {
        visible: game.soundViewVisible,
        legend: game.soundViewVisible,
        get version() {
          return game.energyField.version;
        },
        get tier() {
          return game.graphicTier;
        },
      };
    },
    get sim() {
      // live getter：调用方持有 const s = app.state.sim 后，重算/切档读数仍实时。
      return {
        get version() {
          return game.energyField.version;
        },
        get lastRecalcDurationMs() {
          return game.lastRecalcDurationMs;
        },
        get lastRecalcReason() {
          return game.lastRecalcReason;
        },
        get rayCount() {
          return game.acoustics.getParams().rays;
        },
        get bounceCount() {
          return game.acoustics.getParams().bounces;
        },
        get physicsHz() {
          return game.simPhysicsHz;
        },
      };
    },
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
      game.rebuildDurability(); // 有效材料表变化后回填已有世界方块（保持非空气格 durability = 当前表值）
      game.recalcAcoustics(); // 材料参数变化后声场立即反映新参数
      onMaterialChange();
    },
    resetMaterials: () => {
      game.overrides.clear();
      game.rebuildDurability();
      game.recalcAcoustics();
      onMaterialChange();
    },
    setGraphicTier: (t: GraphicTier) => {
      game.setGraphicTier(t);
      onTierChange(t);
      perf.pixelRatio = readPixelRatio();
    },
    setSoundView: (visible: boolean) => {
      if (typeof visible !== 'boolean') {
        throw new Error('setSoundView: visible 需为布尔值');
      }
      game.setSoundView(visible);
      // 立即同步图例/按钮 DOM，避免只能等下一帧 onFrame。
      onSoundViewChange?.(visible);
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
      const result = game.loadSave();
      // 与 regenerate/reset 一致：载入成功后必须重建渲染世界，避免 state 与 3D 画面脱节（QA N1）
      if (result === 'loaded') {
        onWorldChange(game);
      }
      return result;
    },
    clearSave: () => {
      game.clearSave();
    },
    teleport: (pos) => {
      game.teleport(pos);
    },
    setViewMode: (mode) => {
      game.setViewMode(mode);
    },
    setOrbit: (patch) => {
      game.setOrbit(patch ?? {});
    },
    craft: (recipeId) => {
      return game.craft(recipeId);
    },
    placeFacility: (kind, cell, yaw) => {
      return game.placeFacility(kind, cell, yaw);
    },
    rotateFacility: (cell, deltaRadians) => {
      return game.rotateFacility(cell, deltaRadians);
    },
    removeFacility: (cell) => {
      return game.removeFacility(cell);
    },
    setCoreEnergy: (e) => {
      game.setCoreEnergy(e);
    },
    probeAt: (cell) => {
      return game.probeAt(cell);
    },
    emitSource: (pos, power, dir) => {
      game.emitSource(pos, power, dir);
    },
    clearSources: () => {
      game.clearSources();
    },
    recalcAcoustics: () => {
      game.recalcAcoustics('manual');
    },
    setTuning: (patch) => {
      game.setTuning(patch);
    },
    resetTuning: () => {
      game.resetTuning();
    },
  };

  const reset = (): void => {
    game.reset();
    onWorldChange(game);
    onMaterialChange();
    onTierChange(game.graphicTier);
    perf.pixelRatio = readPixelRatio();
    onSoundViewChange?.(game.soundViewVisible);
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
