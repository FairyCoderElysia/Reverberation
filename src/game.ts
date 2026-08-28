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
import { RECIPES, isFacilityKind, itemName } from './recipes';
import { GameClock } from './clock';
import {
  assertFiniteYaw,
  cellOverlapsPlayer,
  coerceFacilityCell,
  facilityItemIdForKind,
  facilityKindForItem,
  tryPlaceFacility,
  tryRotateFacility,
  tryRemoveFacility,
} from './facility';
import { findStandingSpawn, generateWorld } from './worldgen';
import type { GeneratedWorld } from './worldgen';
import {
  AUTOSAVE_MOVE_INTERVAL_MS,
  INTERACTION_REACH,
  JUMP_BUFFER_MS,
  MINING_SECONDS,
  ORBIT_DEFAULT_DISTANCE,
  ORBIT_DEFAULT_PITCH,
  ORBIT_DEFAULT_YAW,
  PLAYER_PHYS_HZ,
  PLAYER_EYE_HEIGHT,
  SAVE_SIZE_WARN_BYTES,
  SAVE_VERSION,
} from './config';
import { inBounds, World, WORLD_X, WORLD_Y, WORLD_Z } from './world';
import type { FacilityKind, FacilitySnapshot, OrbitState, SoundSource, XYZA } from './types';

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
  /** S3：当前视角模式（F4B）。切换只改变视角，不暂停游戏、不改 body.pos。 */
  viewMode: 'first' | 'orbit' = 'first';
  /** S3：轨道俯瞰参数（state.orbit 同源）。 */
  orbit: OrbitState = {
    distance: ORBIT_DEFAULT_DISTANCE,
    yaw: ORBIT_DEFAULT_YAW,
    pitch: ORBIT_DEFAULT_PITCH,
    target: [32.5, 13, 32.5],
  };
  /** S3：全天相位 [0,1)，从 0 开始随现实时间递增；回绕时 day+1。 */
  get timeOfDay(): number {
    return this.clock.timeOfDay;
  }

  set timeOfDay(v: number) {
    this.clock.timeOfDay = v;
  }

  /** S3：存活天数（从 0 开始）。 */
  get day(): number {
    return this.clock.day;
  }

  set day(v: number) {
    this.clock.day = v;
  }

  /** S3：最小化时钟（推进/回绕/节流待写状态集中在 clock.ts）。 */
  private readonly clock: GameClock;
  /** S3：设施内部 id 分配器（载入后基于已有设施最大 id +1）。 */
  nextFacilityId = 1;

  overrides: Map<number, MaterialOverrides>;
  private seedCounter: number;
  private accMs = 0;
  input: PlayerInput = { forward: 0, right: 0, jump: false };
  /** 跳跃缓冲剩余毫秒（用户实测热修）：由 main 在 Space 非 repeat keydown 写入，固定步物理消费。 */
  jumpBufferMs = 0;
  /** 玩家位置/朝向相对最近一次成功写档是否有变化（B 移动自动存档）。 */
  private moveDirty = false;
  /** 自上次成功写档后累计的移动节流毫秒数（B 移动自动存档）。 */
  private moveAutosaveAccumMs = 0;
  /** 最近一次成功写档时的玩家位置/朝向快照（B 移动自动存档）。 */
  private lastSavedMoveState: [number, number, number, number, number] | null = null;
  /** clearSave 后抑制 pagehide/beforeunload/visibilitychange 兜底写档，直到下一次成功 writeSave 才恢复。 */
  private suppressUnloadSave = false;
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
    // 初始移动快照对齐出生点：未发生移动前不触发移动节流写档。
    this.lastSavedMoveState = this.moveStateTuple();
    this.inventory = new Array(13).fill(0) as number[];
    this.selected = 1;
    this.orbit.target = [this.spawn[0] + 0.5, this.spawn[1] + 2, this.spawn[2] + 0.5];
    this.clock = new GameClock();
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
      // 跳跃缓冲：由 stepPlayer 在「该固定步 grounded」时消费；未落地则stepPlayer按固定步时间递减。
      const physInput: PlayerInput = { ...this.input };
      if (this.jumpBufferMs > 0) physInput.jumpBufferMs = this.jumpBufferMs;
      stepPlayer(this.body, physInput, 1 / PLAYER_PHYS_HZ, this.world);
      this.jumpBufferMs = physInput.jumpBufferMs ?? 0;
    }
    this.clock.advance(dt);
    this.updateMoveAutoSave(dt);
    if (this.clock.updateAutoSave(dt, AUTOSAVE_MOVE_INTERVAL_MS)) {
      this.autoSave();
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
    this.jumpBufferMs = 0;
    this.cancelMining();
  }

  /** 记录一次跳跃按键边沿（main 的 keydown 调用；keyup 不影响已入缓冲的边沿）。 */
  pressJump(): void {
    this.jumpBufferMs = JUMP_BUFFER_MS;
  }

  giveItem(id: number, n: number): void {
    if (!Number.isInteger(id) || id < 1 || id > 12) {
      throw new Error('giveItem: 物品 id 非法（需为 1..12 的整数）');
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
    if (b.material === 0) {
      // S3：设施格不是可挖掘方块；挖掘进度不针对设施（拆除走 removeFacility）。
      this.cancelMining();
      return;
    }
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
    this.uiNotice = null; // 成功移除时清除旧的失败提示（QA Mn4）
    this.autoSave();
  }

  /* ================= 放置 ================= */

  /** 合成（F5）：从 recipes.ts 唯一配方表扣材料、产设施物品。 */
  craft(recipeId: number): { ok: boolean; reason: string } {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) {
      this.uiNotice = '配方不存在（id=' + String(recipeId) + '）';
      return { ok: false, reason: '配方不存在' };
    }
    for (const ing of recipe.ingredients) {
      if ((this.inventory[ing.itemId] ?? 0) < ing.qty) {
        this.uiNotice = '材料不足：无法合成「' + recipe.name + '」，缺少 ' + itemName(ing.itemId) + ' ×' + String(ing.qty);
        return { ok: false, reason: '材料不足' };
      }
    }
    for (const ing of recipe.ingredients) {
      this.inventory[ing.itemId] -= ing.qty;
    }
    this.inventory[recipe.output.itemId] += recipe.output.count;
    this.uiNotice = null;
    this.autoSave();
    return { ok: true, reason: 'ok' };
  }

  tryPlaceSelected(): { ok: boolean; reason: string } {
    const id = this.selected;
    if (id < 1 || id > 12) {
      this.uiNotice = '尚未选中任何物品（按 1-9 或点击库存槽选中）';
      return { ok: false, reason: '未选中任何物品' };
    }
    if (this.inventory[id] <= 0) {
      this.uiNotice = '库存不足：无法放置「' + this.itemNameZh(id) + '」';
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
    if (this.world.blockAt(placeCell).material !== 0 || this.world.blockAt(placeCell).facility !== null) {
      this.uiNotice = '目标格已有方块/设施，无法放置';
      return { ok: false, reason: '目标格已有方块' };
    }
    if (cellOverlapsPlayer(this.body.pos, placeCell)) {
      this.uiNotice = '不能放置到玩家身体内';
      return { ok: false, reason: '不能放置到玩家身体内' };
    }
    if (id >= 8 && id <= 12) {
      const kind = facilityKindForItem(id);
      if (!kind) {
        this.uiNotice = '设施物品 id 非法，无法放置';
        return { ok: false, reason: '设施物品 id 非法' };
      }
      return this.placeFacilityAtCell(kind, placeCell, 0);
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

  /** 物品中文名（1-7 材料 + 8-12 设施物品，来自 recipes.ts/ITEM_NAMES）。 */
  itemNameZh(id: number): string {
    if (id >= 1 && id <= 7) return this.materialNameZh(id);
    return itemName(id);
  }

  /** 视角模式切换（F4B）。 */
  setViewMode(mode: 'first' | 'orbit'): void {
    if (mode !== 'first' && mode !== 'orbit') {
      throw new Error('setViewMode: 模式需为 first 或 orbit');
    }
    this.viewMode = mode;
  }

  toggleViewMode(): void {
    this.viewMode = this.viewMode === 'first' ? 'orbit' : 'first';
  }

  /** 设置轨道俯瞰参数（不直接写 state，只改运行时；可逆）。 */
  setOrbit(patch: Partial<OrbitState>): void {
    if (patch.distance !== undefined) {
      if (!Number.isFinite(patch.distance)) throw new Error('setOrbit: distance 必须为有限数');
      this.orbit.distance = Math.min(200, Math.max(3, patch.distance));
    }
    if (patch.yaw !== undefined) {
      if (!Number.isFinite(patch.yaw)) throw new Error('setOrbit: yaw 必须为有限数');
      this.orbit.yaw = patch.yaw;
    }
    if (patch.pitch !== undefined) {
      if (!Number.isFinite(patch.pitch)) throw new Error('setOrbit: pitch 必须为有限数');
      this.orbit.pitch = Math.min(1.45, Math.max(-1.45, patch.pitch));
    }
    if (patch.target !== undefined) {
      if (!Array.isArray(patch.target) || patch.target.length !== 3 || patch.target.some((v) => !Number.isFinite(v))) {
        throw new Error('setOrbit: target 需为 [x,y,z] 有限数组');
      }
      this.orbit.target = [patch.target[0], patch.target[1], patch.target[2]];
    }
  }

  /** 当前设施快照（cell 派生，单源）。 */
  facilitySnapshots(): FacilitySnapshot[] {
    return this.world.facilityList();
  }

  /** 调试/UI 放置设施（kind 必须合法；cell 为整数格；yaw 弧度缺省 0；yaw 非法抛错）。 */
  placeFacility(kind: FacilityKind, cell: XYZA, yaw = 0): { ok: boolean; reason: string } {
    if (!isFacilityKind(kind)) {
      return { ok: false, reason: '设施类型非法' };
    }
    const cc = coerceFacilityCell(cell);
    if (!cc) {
      this.uiNotice = '设施坐标非法，无法放置';
      return { ok: false, reason: '设施坐标非法' };
    }
    return this.placeFacilityAtCell(kind, cc, yaw);
  }

  private placeFacilityAtCell(kind: FacilityKind, cell: XYZA, yaw: number): { ok: boolean; reason: string } {
    assertFiniteYaw(yaw);
    const itemId = facilityItemIdForKind(kind);
    if ((this.inventory[itemId] ?? 0) <= 0) {
      this.uiNotice = '库存不足：无法放置「' + itemName(itemId) + '」';
      return { ok: false, reason: '库存不足' };
    }
    const res = tryPlaceFacility(this.world, kind, cell, yaw, this.nextFacilityId, this.body.pos);
    if (!res.ok) {
      this.uiNotice = res.reason;
      return { ok: false, reason: res.reason };
    }
    this.nextFacilityId += 1;
    this.inventory[itemId] -= 1;
    this.uiNotice = null;
    this.autoSave();
    return { ok: true, reason: 'ok' };
  }

  /** 调试/UI 旋转设施（缺省步长 π/2）。 */
  rotateFacility(cell: XYZA, deltaRadians = Math.PI / 2): { ok: boolean; reason: string } {
    const cc = coerceFacilityCell(cell);
    if (!cc) {
      this.uiNotice = '设施坐标非法，无法旋转';
      return { ok: false, reason: '设施坐标非法' };
    }
    const res = tryRotateFacility(this.world, cc, deltaRadians);
    if (!res.ok) {
      this.uiNotice = res.reason;
      return { ok: false, reason: res.reason };
    }
    this.uiNotice = null;
    this.autoSave();
    return { ok: true, reason: 'ok' };
  }

  /** 拆除设施（返还对应设施物品 id 8..12；S3 临时口径）。 */
  removeFacility(cell: XYZA): { ok: boolean; reason: string } {
    const cc = coerceFacilityCell(cell);
    if (!cc) {
      this.uiNotice = '设施坐标非法，无法拆除';
      return { ok: false, reason: '设施坐标非法' };
    }
    const res = tryRemoveFacility(this.world, cc);
    if (!res.ok) {
      this.uiNotice = res.reason;
      return { ok: false, reason: res.reason };
    }
    const itemId = facilityItemIdForKind(res.value!.kind);
    this.inventory[itemId] += 1;
    this.uiNotice = null;
    this.autoSave();
    return { ok: true, reason: 'ok' };
  }

  /** R 键：旋转准星正对/命中的设施。 */
  rotateLookedFacility(): { ok: boolean; reason: string } {
    const hit = this.pickLook();
    if (!hit) {
      this.uiNotice = '准星未命中设施，无法旋转';
      return { ok: false, reason: '准星未命中设施' };
    }
    return this.rotateFacility(hit.cell, Math.PI / 2);
  }

  /* ================= 时钟（逻辑已拆至 src/clock.ts） ================= */

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
        facilities: this.world.facilityList(),
        timeOfDay: this.timeOfDay,
        day: this.day,
        savedAt: this.now(),
      };
      const text = serializeSave(payload);
      writeSaveRaw(this.storage, text);
      this.lastSavedAt = this.now();
      // 成功写档后恢复页面关闭兜底：clearSave 的抑制只应持续到下一次有效保存。
      this.suppressUnloadSave = false;
      // 任何成功写档都已持久化当前玩家位置/朝向，因此清除移动待写标记。
      this.moveDirty = false;
      this.moveAutosaveAccumMs = 0;
      this.lastSavedMoveState = this.moveStateTuple();
      // S3：成功写档同时清除时钟待写标记（静止时 timeOfDay 也会周期落盘）。
      this.clock.markSaved();
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
      // 失败时复位节流累计，避免每帧重复写档；待写脏标记保留，下一周期再重试。
      this.moveAutosaveAccumMs = 0;
      this.clock.backoff();
      return false;
    }
  }

  /** 关键事件后的同帧自动写档（contract SP2-08）。 */
  autoSave(): void {
    this.writeSave();
  }

  /** 当前玩家位置/朝向快照（B 移动自动存档）。 */
  private moveStateTuple(): [number, number, number, number, number] {
    return [this.body.pos[0], this.body.pos[1], this.body.pos[2], this.body.yaw, this.body.pitch];
  }

  /** 检测移动并执行节流自动写档（B：移动/跳跃后不再丢失刷新进度）。 */
  private updateMoveAutoSave(dtMs: number): void {
    if (!this.moveDirty) {
      const cur = this.moveStateTuple();
      const prev = this.lastSavedMoveState;
      if (prev === null || cur[0] !== prev[0] || cur[1] !== prev[1] || cur[2] !== prev[2] || cur[3] !== prev[3] || cur[4] !== prev[4]) {
        this.moveDirty = true;
      }
    }
    if (!this.moveDirty) {
      this.moveAutosaveAccumMs = 0;
      return;
    }
    this.moveAutosaveAccumMs += dtMs;
    if (this.moveAutosaveAccumMs >= AUTOSAVE_MOVE_INTERVAL_MS) {
      this.autoSave();
    }
  }

  /** 页面关闭/隐藏兜底：由 main 的 pagehide/beforeunload/visibilitychange 调用，立即写档。 */
  flushSaveForPageHide(): void {
    if (this.suppressUnloadSave) return;
    this.writeSave();
  }

  /** 从 storage 载入存档并整体替换运行时状态。 */
  loadSave(): 'loaded' | 'empty' | 'invalid' {
    this.uiNotice = null; // 载入动作（无论结果）清除旧交互提示，避免遮蔽 loadNotice/saveError
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
    this.world.revision += 1; // 载入会整体替换 ids/placed，版本号同步递增
    this.world.setFacilities(p.facilities); // S3：恢复设施（cell→gridId 单一换算）
    this.rebuildDurability();
    this.world.recomputeAllSurfaces();
    this.seed = p.seed >>> 0;
    this.spawn = findStandingSpawn(this.world, Math.floor(p.playerPos[0]), Math.floor(p.playerPos[2]));
    this.inventory = p.inventory.slice();
    this.selected = p.selected;
    this.timeOfDay = p.timeOfDay;
    this.day = p.day;
    this.body = {
      pos: [p.playerPos[0], p.playerPos[1], p.playerPos[2]],
      vel: [0, 0, 0],
      yaw: p.playerYaw,
      pitch: p.playerPitch,
      grounded: false,
    };
    this.snapPlayerToAir();
    // 载入成功后把俯瞰中心同步到当前玩家位置，避免旧世界出生点残留。
    this.orbit.target = [this.body.pos[0], this.body.pos[1] + 2, this.body.pos[2]];
    this.cancelMining();
    this.jumpBufferMs = 0;
    // 载入后把移动快照对齐到已恢复位置，避免无移动也触发节流写档。
    this.moveDirty = false;
    this.moveAutosaveAccumMs = 0;
    this.lastSavedMoveState = this.moveStateTuple();
    // 时钟快照同样对齐，避免载入后立刻触发无意义写档。
    this.clock.markSaved();
    this.nextFacilityId = this.world.facilityStates().reduce((mx, f) => Math.max(mx, f.id), 0) + 1;
    this.loadNotice = null;
    return 'loaded';
  }

  /**
   * 由 ids 重建 durability：非空气格 durability = 有效材料表（含 debug.setMaterial override）
   * 的对应耐久；空气格 = 0。S2 不序列化 durability，载入后必须由此恢复（contract SP2-07）。
   * 同时用于 setMaterial/resetMaterials 改变有效表后回填已有世界方块，维持全局不变量。
   */
  rebuildDurability(): void {
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
      this.suppressUnloadSave = true;
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
    this.inventory = new Array(13).fill(0) as number[];
    this.selected = 1;
    this.timeOfDay = 0;
    this.day = 0;
    this.clock.reset(0, 0);
    this.viewMode = 'first';
    this.orbit = {
      distance: ORBIT_DEFAULT_DISTANCE,
      yaw: ORBIT_DEFAULT_YAW,
      pitch: ORBIT_DEFAULT_PITCH,
      target: [this.spawn[0] + 0.5, this.spawn[1] + 2, this.spawn[2] + 0.5],
    };
    this.nextFacilityId = 1;
    this.cancelMining();
    this.autoSave();
  }

  private applyWorld(next: GeneratedWorld): void {
    this.world = next.world;
    this.seed = next.seed;
    this.spawn = next.spawn;
    this.soundSources = next.soundSources;
    this.body = makeBodyAtSpawn(next.spawn, this.world);
    this.nextFacilityId = 1;
    this.orbit.target = [this.body.pos[0], this.body.pos[1] + 2, this.body.pos[2]];
    this.cancelMining();
    this.jumpBufferMs = 0;
    this.uiNotice = null;
    this.loadNotice = null;
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

