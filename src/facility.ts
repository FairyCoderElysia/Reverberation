/**
 * M4/M6 领域切片（S3 修复轮拆分）：设施定义/物品映射、放置/拆除/旋转底层逻辑、序列化辅助。
 * 仍保持纯领域模块：只操作 World 与设施状态，不负责库存扣减、自动存档、UI 提示。
 * Game 保留编排：校验库存 → 调本模块 → 扣/返库存 → 统一写档。
 */
import { PLAYER_HALF_WIDTH, PLAYER_HEIGHT } from './config';
import { FACILITY_ITEM_IDS, FACILITY_KIND_BY_ITEM, isFacilityKind } from './recipes';
import type { FacilityKind, FacilityState, XYZA } from './types';
import { inBounds } from './world';
import type { World } from './world';

/** S3 旋转步长（弧度）——与 contract 钉死 π/2 单一来源。 */
export const FACILITY_ROTATE_STEP = Math.PI / 2;

/**
 * 从外部输入坐标夹取为整数格坐标。
 * 返回 null 表示坐标非法（非数组/长度非 3/含非有限数），由调用方给出中文提示。
 */
export function coerceFacilityCell(cell: unknown): XYZA | null {
  if (!Array.isArray(cell) || cell.length !== 3) return null;
  const [x, y, z] = cell as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [Math.floor(x), Math.floor(y), Math.floor(z)];
}

/** yaw 归一化：保留浮点但在 [0, 2π) 内稳定，同一结果不因多次旋转漂移。 */
export function normalizeYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  const twoPi = Math.PI * 2;
  let v = yaw % twoPi;
  if (v < 0) v += twoPi;
  return v;
}

/** S3 调试 API/设施放置必须校验 yaw 为有限数；非法抛中文错误。 */
export function assertFiniteYaw(yaw: number): void {
  if (!Number.isFinite(yaw)) {
    throw new Error('placeFacility: yaw 必须为有限数');
  }
}

/** 设施种类 → 库存物品 id（单一来源 recipes.ts）。 */
export function facilityItemIdForKind(kind: FacilityKind): number {
  return FACILITY_ITEM_IDS[kind];
}

/** 库存物品 id → 设施 kind（8..12；非法返回 undefined）。 */
export function facilityKindForItem(id: number): FacilityKind | undefined {
  return FACILITY_KIND_BY_ITEM[id];
}

/** 创建内部设施状态（pos 为 gridId；外部快照由 world.facilityList 反算 cell）。 */
export function createFacilityState(
  kind: FacilityKind,
  pos: number,
  yaw: number,
  id: number,
): FacilityState {
  return {
    id,
    kind,
    pos,
    yaw: normalizeYaw(yaw),
    coreHp: 0,
    band: 3,
    linkFrom: [],
    linkTo: [],
    busState: 'idle',
  };
}

/** 深拷贝设施状态（用于对外只读快照，避免调用方拿到活引用）。 */
export function cloneFacilityState(f: FacilityState): FacilityState {
  return {
    ...f,
    linkFrom: f.linkFrom.slice(),
    linkTo: f.linkTo.slice(),
  };
}

/** placeCell（单位方块）是否与玩家 AABB 相交（防止把设施放进身体里）。 */
export function cellOverlapsPlayer(
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

/** 放置合法性与世界侧冲突检查；返回 null 表示可放，否则返回中文原因。 */
export function facilityPlacementError(
  world: World,
  cell: XYZA,
  playerPos: [number, number, number],
): string | null {
  if (!inBounds(cell[0], cell[1], cell[2])) {
    return '目标格越界，无法放置设施';
  }
  const b = world.blockAt(cell);
  if (b.material !== 0 || b.facility !== null) {
    return '目标格已有方块/设施，无法放置设施';
  }
  if (cellOverlapsPlayer(playerPos, cell)) {
    return '不能放置到玩家身体内';
  }
  return null;
}

export interface FacilityOperationResult<T = undefined> {
  ok: boolean;
  reason: string;
  value?: T;
}

/**
 * 低层放置：创建设施并写入 world。
 * 调用方仍需自行检查库存并在成功后扣减；yaw 非法会抛中文错误。
 */
export function tryPlaceFacility(
  world: World,
  kind: FacilityKind,
  cell: XYZA,
  yaw: number,
  id: number,
  playerPos: [number, number, number],
): FacilityOperationResult<FacilityState> {
  if (!isFacilityKind(kind)) return { ok: false, reason: '设施类型非法' };
  assertFiniteYaw(yaw);
  const err = facilityPlacementError(world, cell, playerPos);
  if (err) return { ok: false, reason: err };
  const i = world.idx(cell[0], cell[1], cell[2]);
  const f = createFacilityState(kind, i, yaw, id);
  world.putFacility(f);
  return { ok: true, reason: 'ok', value: f };
}

/** 低层旋转：返回新 yaw；delta 非法抛中文错误。 */
export function tryRotateFacility(
  world: World,
  cell: XYZA,
  deltaRadians: number,
): FacilityOperationResult<number> {
  if (!Number.isFinite(deltaRadians)) {
    throw new Error('rotateFacility: deltaRadians 必须为有限数');
  }
  const b = world.blockAt(cell);
  if (!b.facility) return { ok: false, reason: '目标格没有设施，无法旋转' };
  const nextYaw = normalizeYaw(b.facility.yaw + deltaRadians);
  world.updateFacilityYaw(cell, nextYaw);
  return { ok: true, reason: 'ok', value: nextYaw };
}

/** 低层拆除：返回被删设施；无设施返回失败原因。 */
export function tryRemoveFacility(
  world: World,
  cell: XYZA,
): FacilityOperationResult<FacilityState> {
  const removed = world.removeFacilityAt(cell);
  if (!removed) return { ok: false, reason: '目标格没有设施，无法拆除' };
  return { ok: true, reason: 'ok', value: removed };
}
