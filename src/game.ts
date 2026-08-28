/**
 * Game：S2 单权威运行时（世界 + 玩家 + 库存 + 挖掘 + 放置/拆除 + 存档）。
 * 渲染/UI/apphook 均为末端消费者；本模块不依赖渲染与 UI。
 */
import { effectiveMaterials, effectiveRows, MATERIAL_TABLE, MATERIAL_ZH } from './materials';
import type { MaterialOverrides } from './materials';
import { aabbIntersects, lookDirection, stepPlayer } from './player';
import type { PlayerBody, PlayerInput } from './player';
import { pickBlock, placeCellFromHit } from './pick';
import type { PickHit } from './pick';
import { parseSave, readSaveRaw, removeSave, serializeSave, writeSaveRaw } from './save';
import type { SavePayload, StorageLike } from './save';
import { findStandingSpawn, generateWorld } from './worldgen';
import type { GeneratedWorld } from './worldgen';
import {
  INTERACTION_REACH,
  MINING_SECONDS,
  PLAYER_PHYS_HZ,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  SAVE_SIZE_WARN_BYTES,
  SAVE_VERSION,
} from './config';
import { inBounds, World, WORLD_X, WORLD_Y, WORLD_Z } from './world';
import type { SoundSource, XYZA } from './types';

export interface GameOptions {
  storage?: StorageLike;
  now?: () => number;
}

/** 挖掘目标（持续命中对象） */
export interface MineTarget {
  cell: [number, number, number];
  material: number;
  placed: boolean;
}

/** 默认内存存储（测试/无 localStorage 环境兜底） */
export function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

/** 移除方块时的返还量：天然挖除 +1、玩家放置拆除全额返还；S2 每方块恰 1 单位材料。 */
const BREAK_REFUND = 1;

function browserStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    return null;
  }
  return null;
}

export class Game {
  world: World;
  seed: number;
  spawn: XYZA;
  soundSources: SoundSource[];
  storage: StorageLike | null;
  private now: () => number;

  body: PlayerBody;
  inventory: number[];
  selected: number;
  miningProgress: number;
  miningTarget: MineTarget | null;
  lastSavedAt: number;
  saveError: string | null;
  loadNotice: string | null;
  /** 交互类可见提示（挖掘/放置失败原因等），与存档异常字段 saveError 分离 */
  uiNotice: string | null;

  overrides: Map<number, MaterialOverrides>;
  private seedCounter: number;
  private accMs = 0;
  input: PlayerInput = { forward: 0, right: 0, jump: false };
  mineHeld = false;
  placePressed = false;

  constructor(generated: GeneratedWorld, opts?: GameOptions) {
    this.world = generated.world;
    this.seed = generated.seed;
    this.spawn = generated.spawn;
    this.soundSources = generated.soundSources;
    this.storage = opts?.storage !== undefined ? opts.storage : browserStorage();
    this.now = opts?.now ?? (() => Date.now());

    this.body = makeBodyAtSpawn(generated.spawn, this.world);
    this.inventory = new Array(8).fill(0) as number[];
    this.selected = 1;
    this.miningProgress = 0;
    this.miningTarget = null;
    this.lastSavedAt = 0;
    this.saveError = null;
    this.loadNotice = null;
    this.uiNotice = null;

    this.overrides = new Map<number, MaterialOverrides>();
    this.seedCounter = (generated.seed + 0x51ab3f) >>> 0;
  }

  /* ================= 玩家读取 ================= */

  get playerPos(): [number, number, number] {
    return [this.body.pos[0], this.body.pos[1], this.body.pos[2]];
  }

  playerEye(): [number, number, number] {
    return [this.body.pos[0], this.body.pos[1] + PLAYER_EYE_HEIGHT, this.body.pos[2]];
  }

  lookDir(): [number, number, number] {
    return lookDirection(this.body.yaw, this.body.pitch);
  }

  /** 当前视线命中的实体方块（null=交互距离内无目标）。 */
  pickLook(): PickHit | null {
    return pickBlock(this.world, this.playerEye(), this.lookDir(), INTERACTION_REACH);
  }

  materialSpecs() {
    return effectiveMaterials(this.overrides);
  }

  materialRows() {
    return effectiveRows(this.overrides);
  }

  /* ================= 主循环 ================= */

  /** 每帧调用；内部固定步推进物理 + 挖掘进度 + 右键放置。 */
  tickFrame(dtMs: number): void {
    const dt = Math.min(Math.max(dtMs, 0), 100);
    this.accMs += dt;
    const stepMs = 1000 / PLAYER_PHYS_HZ;
    while (this.accMs >= stepMs) {
      this.accMs -= stepMs;
      stepPlayer(this.body, this.input, 1 / PLAYER_PHYS_HZ, this.world);
    }
    this.updateMining(dt / 1000);
    if (this.placePressed) {
      this.placePressed = false;
      this.tryPlaceSelected();
    }
  }

  teleport(pos: XYZA): void {
    if (!Array.isArray(pos) || pos.length < 3) {
      throw new Error('teleport: 参数需为 [x,y,z] 三元素数组');
    }
    for (let i = 0; i < 3; i++) {
      if (typeof pos[i] !== 'number' || !Number.isFinite(pos[i])) {
        throw new Error('teleport: 坐标必须为有限数');
      }
    }
    const x = Math.min(Math.max(pos[0], 0.5), this.world.size[0] - 0.5);
    const z = Math.min(Math.max(pos[2], 0.5), this.world.size[2] - 0.5);
    const yBase = Math.min(Math.max(pos[1], 0), this.world.size[1] - 1);
    let done = false;
    for (let k = 0; k < this.world.size[1]; k++) {
      const y = yBase + k;
      if (y >= this.world.size[1]) break;
      const cand: [number, number, number] = [x, y, z];
      if (!aabbIntersects(this.world, cand)) {
        this.body.pos = cand;
        done = true;
        break;
      }
    }
    if (!done) this.body.pos = [this.spawn[0] + 0.5, this.spawn[1] + 1, this.spawn[2] + 0.5];
    this.body.vel = [0, 0, 0];
    this.body.grounded = false;
    this.cancelMining();
  }

  giveItem(id: number, n: number): void {
    if (!Number.isInteger(id) || id < 1 || id > 7) {
      throw new Error('giveItem: 材料 id 非法（需为 1..7 的整数）');
    }
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error('giveItem: 数量必须为有限数');
    }
    const amount = Math.max(0, Math.floor(n));
    this.inventory[id] = Math.max(0, this.inventory[id] + amount);
    this.autoSave();
  }

  /* ================= 挖掘 ================= */

  private targetMatches(t: MineTarget): boolean {
    return (
      !!this.miningTarget &&
      this.miningTarget.cell[0] === t.cell[0] &&
      this.miningTarget.cell[1] === t.cell[1] &&
      this.miningTarget.cell[2] === t.cell[2] &&
      this.miningTarget.material === t.material &&
      this.miningTarget.placed === t.placed
    );
  }

  private refreshMineTarget(): void {
    const hit = this.pickLook();
    if (!hit) {
      this.cancelMining();
      return;
    }
    const b = this.world.blockAt(hit.cell);
    const t: MineTarget = { cell: hit.cell, material: b.material, placed: b.placed };
    if (!this.targetMatches(t)) {
      this.miningTarget = t;
      this.miningProgress = 0;
    }
  }

  private updateMining(dt: number): void {
    if (!this.mineHeld) {
      this.cancelMining();
      return;
    }
    this.refreshMineTarget();
    if (!this.miningTarget) {
      this.miningProgress = 0;
      return;
    }
    this.miningProgress = Math.min(1, this.miningProgress + dt / MINING_SECONDS);
    if (this.miningProgress >= 1) {
      const cell = this.miningTarget.cell;
      const material = this.miningTarget.material;
      const placed = this.miningTarget.placed;
      this.cancelMining();
      this.applyBreak(cell, material, placed);
    }
  }

  cancelMining(): void {
    this.miningProgress = 0;
    this.miningTarget = null;
  }

  /**
   * 拆除方块（挖掘与拆除共用同一入库口径）：
   * 天然方块挖除入库 +1；玩家放置方块拆除全额返还（材料 1 单位，S2 无损耗）。
   * 二者当前同为「每方块 1 单位材料」；未来设施拆除的「配方返还量」在此接入。
   */
  applyBreak(cell: XYZA, material: number, _placed: boolean): void {
    const [x, y, z] = cell;
    if (!inBounds(x, y, z)) return;
    if (this.world.blockAt(cell).material === 0) return;
    this.world.removeBlock(cell);
    const refund = BREAK_REFUND;
    this.inventory[material] = Math.max(0, this.inventory[material]) + refund;
    this.autoSave();
  }

  /* ================= 放置 ================= */

  tryPlaceSelected(): { ok: boolean; reason: string } {
    const id = this.selected;
    if (id < 1 || id > 7) {
      this.uiNotice = '尚未选中任何材料（按 1-7 或点击库存槽选中）';
      return { ok: false, reason: '未选中任何材料' };
    }
    if (this.inventory[id] <= 0) {
      this.uiNotice = '库存不足：无法放置「' + this.materialNameZh(id) + '」';
      return { ok: false, reason: '库存不足' };
    }
    const hit = this.pickLook();
    if (!hit) {
      this.uiNotice = '超出交互距离或未命中目标，无法放置';
      return { ok: false, reason: '超出交互距离或未命中' };
    }
    const placeCell = placeCellFromHit(hit);
    if (!inBounds(placeCell[0], placeCell[1], placeCell[2])) {
      this.uiNotice = '目标格越界，无法放置';
      return { ok: false, reason: '目标格越界' };
    }
    if (this.world.blockAt(placeCell).material !== 0) {
      this.uiNotice = '目标格已有方块，无法放置';
      return { ok: false, reason: '目标格已有方块' };
    }
    if (cellOverlapsPlayer(this.body.pos, placeCell)) {
      this.uiNotice = '不能放置到玩家身体内';
      return { ok: false, reason: '不能放置到玩家身体内' };
    }
    const dur = this.materialSpecs()[id - 1].durability;
    this.world.putBlock(placeCell, id, dur);
    this.inventory[id] -= 1;
    this.uiNotice = null;
    this.autoSave();
    return { ok: true, reason: 'ok' };
  }

  /** 材料中文名：单一来源 MATERIAL_ZH（materials.ts），不在此自造副本。 */
  materialNameZh(id: number): string {
    const row = MATERIAL_TABLE[id - 1];
    return row ? MATERIAL_ZH[row.name] : '未知';
  }

  /* ================= 存档 ================= */

  /** 统一写档入口（自动保存与 debug.saveNow 均走此）。返回是否写成功。 */
  writeSave(): boolean {
    try {
      if (!this.storage) {
        this.saveError = '本地存储不可用（隐私模式），本次进度未持久化；游戏仍可继续。';
        return false;
      }
      const payload: SavePayload = {
        version: SAVE_VERSION,
        seed: this.seed,
        ids: this.world.ids,
        placed: this.world.placed,
        inventory: this.inventory.slice(),
        selected: this.selected,
        playerPos: this.playerPos,
        playerYaw: this.body.yaw,
        playerPitch: this.body.pitch,
        savedAt: this.now(),
      };
      const text = serializeSave(payload);
      writeSaveRaw(this.storage, text);
      this.lastSavedAt = this.now();
      this.saveError = null;
      // 体积预警（不阻塞）：序列化结果超阈值时在状态行提示
      if (text.length > SAVE_SIZE_WARN_BYTES) {
        this.uiNotice =
          '存档体积超限警告：约 ' + Math.round(text.length / 1024) + 'KB（阈值 ' + SAVE_SIZE_WARN_BYTES / 1024 + 'KB），已写入但建议留意。';
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.saveError = '自动保存失败：' + msg + '。可能是隐私模式或存储已满；游戏仍可继续。';
      return false;
    }
  }

  /** 关键事件后的同帧自动写档（contract SP2-08）。 */
  autoSave(): void {
    this.writeSave();
  }

  /** 从 storage 载入存档并整体替换运行时状态。 */
  loadSave(): 'loaded' | 'empty' | 'invalid' {
    if (!this.storage) return 'invalid';
    let text: string | null = null;
    try {
      text = readSaveRaw(this.storage);
    } catch (err) {
      this.loadNotice = '读取本地存档失败：' + (err instanceof Error ? err.message : String(err));
      return 'invalid';
    }
    if (text === null) {
      this.loadNotice = null;
      return 'empty';
    }
    const parsed = parseSave(text);
    if (!parsed.ok || !parsed.payload) {
      this.loadNotice = parsed.error ?? '存档数据损坏，已回退到全新世界。';
      return 'invalid';
    }
    const p = parsed.payload;
    this.world.ids.set(p.ids);
    this.world.placed.set(p.placed);
    this.rebuildDurability();
    this.world.recomputeAllSurfaces();
    this.seed = p.seed >>> 0;
    this.spawn = findStandingSpawn(this.world, Math.floor(p.playerPos[0]), Math.floor(p.playerPos[2]));
    this.inventory = p.inventory.slice();
    this.selected = p.selected;
    this.body = {
      pos: [p.playerPos[0], p.playerPos[1], p.playerPos[2]],
      vel: [0, 0, 0],
      yaw: p.playerYaw,
      pitch: p.playerPitch,
      grounded: false,
    };
    this.snapPlayerToAir();
    this.cancelMining();
    this.loadNotice = null;
    return 'loaded';
  }

  /**
   * 由 ids 重建 durability：非空气格 durability = 有效材料表（含 debug.setMaterial override）
   * 的对应耐久；空气格 = 0。S2 不序列化 durability，载入后必须由此恢复（contract SP2-07）。
   */
  private rebuildDurability(): void {
    const specs = this.materialSpecs();
    const ids = this.world.ids;
    const dur = this.world.durability;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      dur[i] = id >= 1 && id <= 7 ? specs[id - 1].durability : 0;
    }
  }

  /** 保证玩家 AABB 不落入实体：优先向上抬，否则回出生点。 */
  private snapPlayerToAir(): void {
    const [bx, by, bz] = this.body.pos;
    const x = Math.min(Math.max(bx, 0.5), WORLD_X - 0.5);
    const z = Math.min(Math.max(bz, 0.5), WORLD_Z - 0.5);
    const yBase = Math.min(Math.max(Math.floor(by), 0), WORLD_Y - 1);
    let done = false;
    for (let k = 0; k < WORLD_Y; k++) {
      const y = yBase + k;
      if (y >= WORLD_Y) break;
      const cand: [number, number, number] = [x, y, z];
      if (!aabbIntersects(this.world, cand)) {
        this.body.pos = cand;
        done = true;
        break;
      }
    }
    if (!done) this.body.pos = [this.spawn[0] + 0.5, this.spawn[1], this.spawn[2] + 0.5];
    this.body.vel = [0, 0, 0];
  }

  clearSave(): void {
    if (!this.storage) return;
    try {
      removeSave(this.storage);
    } catch {
      // 忽略：删除失败不影响运行态
    }
    this.loadNotice = null;
  }

  /* ================= 世界重置 ================= */

  regenerate(seed: number): void {
    const s = seed >>> 0;
    const next = generateWorld(s);
    this.applyWorld(next);
  }

  /** 等价「新游戏」：换种子 + 重置运行态 + 立即覆盖存档（contract SP2-09）。 */
  reset(): void {
    this.seedCounter = (this.seedCounter + 0x9e3779b9) >>> 0;
    this.overrides.clear();
    const next = generateWorld(this.seedCounter);
    this.applyWorld(next);
    this.inventory = new Array(8).fill(0) as number[];
    this.selected = 1;
    this.cancelMining();
    this.autoSave();
  }

  private applyWorld(next: GeneratedWorld): void {
    this.world = next.world;
    this.seed = next.seed;
    this.spawn = next.spawn;
    this.soundSources = next.soundSources;
    this.body = makeBodyAtSpawn(next.spawn, this.world);
    this.cancelMining();
  }
}

/** 出生点 → 玩家脚底浮点坐标（格中心，头顶留空气） */
function makeBodyAtSpawn(spawn: XYZA, world: World): PlayerBody {
  let pos: [number, number, number] = [spawn[0] + 0.5, spawn[1], spawn[2] + 0.5];
  if (aabbIntersects(world, pos)) {
    for (let k = 1; k < 24; k++) {
      const cand: [number, number, number] = [pos[0], pos[1] + k, pos[2]];
      if (!aabbIntersects(world, cand)) {
        pos = cand;
        break;
      }
    }
  }
  return { pos, vel: [0, 0, 0], yaw: 0, pitch: 0, grounded: false };
}

/** placeCell（单位方块）是否与玩家 AABB 相交（防止把方块放进身体里） */
function cellOverlapsPlayer(
  playerPos: [number, number, number],
  cell: [number, number, number],
): boolean {
  const [cx, cy, cz] = cell;
  const [px, py, pz] = playerPos;
  return (
    cx + 1 > px - PLAYER_HALF_WIDTH &&
    cx < px + PLAYER_HALF_WIDTH &&
    cy + 1 > py &&
    cy < py + PLAYER_HEIGHT &&
    cz + 1 > pz - PLAYER_HALF_WIDTH &&
    cz < pz + PLAYER_HALF_WIDTH
  );
}
