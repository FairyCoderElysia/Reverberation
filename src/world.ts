/**
 * M1 世界/区块体素存储。
 * 64×64×24 固定网格；逻辑寻址 idx = x + 64*(z + 64*y)（恒定公式，确定性关键）。
 * 提供 blockAt / surfaceHeight / 点查 / DDA 射线遍历（全游戏唯一体素射线实现）。
 */
import type { BlockRef, FacilitySnapshot, FacilityState, XYZA } from './types';

export const WORLD_X = 64;
export const WORLD_Y = 24;
export const WORLD_Z = 64;

/** 逻辑寻址公式（tech-design §3.2，确定性关键） */
export function blockIndex(x: number, y: number, z: number): number {
  return x + WORLD_X * (z + WORLD_Z * y);
}

/** 由线性索引反解坐标（用于单测验证公式自洽；后续设施反向寻址/坐标解码可复用）。 */
export function blockCoords(idx: number): XYZA {
  const x = idx % WORLD_X;
  const z = Math.floor(idx / WORLD_X) % WORLD_Z;
  const y = Math.floor(idx / (WORLD_X * WORLD_Z));
  return [x, y, z];
}

export function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && x < WORLD_X && y >= 0 && y < WORLD_Y && z >= 0 && z < WORLD_Z;
}

export interface DdaVisitContext {
  x: number;
  y: number;
  z: number;
  t: number;
  face: number; // 0..5，进入该体的面
  prev?: XYZA;
}

/**
 * Amanatides & Woo DDA 体素遍历（确定性；全游戏唯一体素射线实现）。
 * 按穿越顺序访问体素；回退时返回 true 可提前终止。
 */
export function traverseVoxels(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  visit: (ctx: DdaVisitContext) => boolean | void,
): number {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  let tMaxX = dx !== 0 ? (stepX > 0 ? (x + 1 - ox) : (ox - x)) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (stepY > 0 ? (y + 1 - oy) : (oy - y)) * tDeltaY : Infinity;
  let tMaxZ = dz !== 0 ? (stepZ > 0 ? (z + 1 - oz) : (oz - z)) * tDeltaZ : Infinity;

  let t = 0;
  let face = -1;
  let steps = 0;

  while (t <= maxT) {
    steps += 1;
    const ctx: DdaVisitContext = { x, y, z, t, face };
    const stop = visit(ctx);
    if (stop === true) return steps;

    // 沿 tMax 最小的轴步进一格（三轴并列时按 x→y→z 的固定顺序，保证确定性）
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      t = tMaxX;
      tMaxX += tDeltaX;
      x += stepX;
      face = stepX > 0 ? 0 : 1; // 0=+X面进入, 1=-X面
    } else if (tMaxY <= tMaxZ) {
      t = tMaxY;
      tMaxY += tDeltaY;
      y += stepY;
      face = stepY > 0 ? 2 : 3;
    } else {
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      z += stepZ;
      face = stepZ > 0 ? 4 : 5;
    }

    if (!inBounds(x, y, z)) break;
  }
  return steps;
}

/** 轴对齐法线（face 0/1→X, 2/3→Y, 4/5→Z），用于反射方向 */
export function faceNormal(face: number): XYZA {
  switch (face) {
    case 0:
      return [1, 0, 0];
    case 1:
      return [-1, 0, 0];
    case 2:
      return [0, 1, 0];
    case 3:
      return [0, -1, 0];
    case 4:
      return [0, 0, 1];
    case 5:
      return [0, 0, -1];
    default:
      return [0, 0, 0];
  }
}

/** 反射方向（dir - 2*(dir·n)*n） */
export function reflectDir(dir: XYZA, n: XYZA): XYZA {
  const dot = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
  return [dir[0] - 2 * dot * n[0], dir[1] - 2 * dot * n[1], dir[2] - 2 * dot * n[2]];
}

function cloneFacilityState(f: FacilityState): FacilityState {
  return {
    ...f,
    linkFrom: f.linkFrom.slice(),
    linkTo: f.linkTo.slice(),
  };
}

export class World {
  readonly size: [number, number, number] = [WORLD_X, WORLD_Y, WORLD_Z];
  ids: Uint8Array;
  durability: Uint16Array;
  /** 放置标记（S2 增量 contract SP2-03）：1=玩家放置，0=天然/空气。与 ids 同步维护，单一来源。 */
  placed: Uint8Array;
  /** 世界内容版本号（用户实测热修）：任何 setBlock/loadSave 等改变 ids 的入口递增，供渲染器按帧检测即时重建。 */
  revision = 0;
  surfaceH: Uint8Array;
  private facilityMap: Map<number, FacilityState>;

  constructor() {
    this.ids = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);
    this.durability = new Uint16Array(WORLD_X * WORLD_Y * WORLD_Z);
    this.placed = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);
    this.surfaceH = new Uint8Array(WORLD_X * WORLD_Z);
    this.facilityMap = new Map();
  }

  /** 逻辑寻址（恒定公式） */
  idx(x: number, y: number, z: number): number {
    return blockIndex(x, y, z);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return inBounds(x, y, z);
  }

  /** 方块引用查询；界外返回空气哨兵 {material:0,durability:0,facility:null} */
  blockAt(g: XYZA): BlockRef {
    const [x, y, z] = g;
    if (!inBounds(x, y, z)) {
      return { material: 0, durability: 0, facility: null, placed: false };
    }
    const i = this.idx(x, y, z);
    const f = this.facilityMap.get(i) ?? null;
    return {
      material: this.ids[i],
      durability: this.durability[i],
      facility: f ? cloneFacilityState(f) : null,
      placed: this.placed[i] === 1,
    };
  }

  materialAt(g: XYZA): number {
    return this.blockAt(g).material;
  }

  /** 地表高度（该列最高的非空气格 y；整列为空时返回 0） */
  surfaceHeight(x: number, z: number): number {
    if (!inBounds(x, 0, z)) return 0;
    return this.surfaceH[x + WORLD_X * z];
  }

  /** 写入方块（默认天然 placed=false）；material===0 即移除并清空 placed/durability。 */
  setBlock(g: XYZA, material: number, durability: number, placed = false): void {
    const [x, y, z] = g;
    if (!inBounds(x, y, z)) return;
    const i = this.idx(x, y, z);
    this.ids[i] = material;
    this.durability[i] = material === 0 ? 0 : durability;
    this.placed[i] = material === 0 ? 0 : placed ? 1 : 0;
    // 方块写入会覆盖该格设施（S3 单一来源：一格要么材料要么设施，不会有双实体）
    this.facilityMap.delete(i);
    this.revision += 1; // 世界内容变化：渲染器按版本号感知单块变更
    // 更新该列地表高度缓存
    this.recomputeColumnSurface(x, z);
  }

  /** 玩家放置方块（S2）：材料 + 耐久（=材料常量）+ placed 标记单一入口。 */
  putBlock(g: XYZA, material: number, durability: number): void {
    this.setBlock(g, material, durability, true);
  }

  /** 移除方块（S2）：ids/durability/placed 一并复位。 */
  removeBlock(g: XYZA): void {
    this.setBlock(g, 0, 0, false);
  }

  /** 当前玩家放置方块总数（与 placed 数组同一增量来源，不另设计数器）。 */
  countPlacedBlocks(): number {
    let n = 0;
    for (let i = 0; i < this.placed.length; i++) {
      if (this.placed[i] === 1) n += 1;
    }
    return n;
  }

  /** 当前已放置设施快照（cell 派生自唯一索引公式，避免另存 pos 双源）。 */
  facilityList(): FacilitySnapshot[] {
    const out: FacilitySnapshot[] = [];
    // Map 插入序即放置序，稳定且不参与物理数值；仅用于 UI/存档快照。
    for (const f of this.facilityMap.values()) {
      out.push({ cell: blockCoords(f.pos), kind: f.kind, yaw: f.yaw });
    }
    return out;
  }

  /** 设施内部状态列表（用于渲染/未来扩展；不直接暴露给 state.facilities 以避免 cell 双源）。 */
  facilityStates(): FacilityState[] {
    return Array.from(this.facilityMap.values());
  }

  /** 放置设施：独占一格，ids/durability 为 0、placed=1、facilityMap 非空。 */
  putFacility(f: FacilityState): void {
    const [x, y, z] = blockCoords(f.pos);
    if (!inBounds(x, y, z)) {
      throw new Error('putFacility: 目标格越界，禁止写入');
    }
    const i = this.idx(x, y, z);
    if (this.ids[i] !== 0 || this.facilityMap.has(i)) {
      throw new Error('putFacility: 目标格已有方块/设施，禁止无检查覆盖');
    }
    this.ids[i] = 0;
    this.durability[i] = 0;
    this.placed[i] = 1;
    this.facilityMap.set(i, f);
    this.revision += 1;
  }

  /** 删除设施并清空该格（ids=0/durability=0/placed=0），返回被删设施或 null。 */
  removeFacilityAt(cell: XYZA): FacilityState | null {
    const [x, y, z] = cell;
    if (!inBounds(x, y, z)) return null;
    const i = this.idx(x, y, z);
    const f = this.facilityMap.get(i) ?? null;
    if (!f) return null;
    this.facilityMap.delete(i);
    this.ids[i] = 0;
    this.durability[i] = 0;
    this.placed[i] = 0;
    this.revision += 1;
    return f;
  }

  /** 更新设施朝向（yaw 弧度；S3 仅用于基础旋转，不触发行为）。 */
  updateFacilityYaw(cell: XYZA, yaw: number): boolean {
    const [x, y, z] = cell;
    if (!inBounds(x, y, z)) return false;
    const i = this.idx(x, y, z);
    const f = this.facilityMap.get(i);
    if (!f) return false;
    f.yaw = yaw;
    this.revision += 1;
    return true;
  }

  /** 清空全部设施（重置/载入前调用，避免旧档残留）。 */
  clearFacilities(): void {
    this.facilityMap.clear();
    // 不主动改 placed：调用方应随后重建 world.ids/placed 或全量 reset。
  }

  /** 从存档快照批量重建设施（内部 id 从 1 开始顺序重编，保证无冲突）。 */
  setFacilities(snapshots: readonly FacilitySnapshot[]): void {
    this.clearFacilities();
    let nextId = 1;
    for (const snap of snapshots) {
      const [x, y, z] = snap.cell;
      if (!inBounds(x, y, z)) continue;
      const i = this.idx(x, y, z);
      if (this.ids[i] !== 0 || this.facilityMap.has(i)) continue; // 跳过与方块冲突的坏档
      this.ids[i] = 0;
      this.durability[i] = 0;
      this.placed[i] = 1;
      this.facilityMap.set(i, {
        id: nextId++,
        kind: snap.kind,
        pos: i,
        yaw: snap.yaw,
        coreHp: 0,
        band: 3,
        linkFrom: [],
        linkTo: [],
        busState: 'idle',
      });
    }
    this.revision += 1;
  }

  /** 整列重算地表高度（置块后调用） */
  recomputeColumnSurface(x: number, z: number): void {
    let h = 0;
    for (let y = WORLD_Y - 1; y >= 0; y--) {
      if (this.ids[this.idx(x, y, z)] !== 0) {
        h = y;
        break;
      }
    }
    this.surfaceH[x + WORLD_X * z] = h;
  }

  /** 全部列地表高度重算（批量填充后调用一次） */
  recomputeAllSurfaces(): void {
    for (let z = 0; z < WORLD_Z; z++) {
      for (let x = 0; x < WORLD_X; x++) {
        this.recomputeColumnSurface(x, z);
      }
    }
  }
}
