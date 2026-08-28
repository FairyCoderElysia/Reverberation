/**
 * M6（S2/S3）：体素拾取（唯一 DDA 实现处——复用 world.traverseVoxels）。
 * 本模块不自行实现第二套射线遍历。
 * S3：拾取把设施格视为实体（blockAt.material !== 0 || facility !== null）。
 */
import { traverseVoxels } from './world';
import type { World } from './world';

export interface PickHit {
  cell: [number, number, number];
  face: number; // 进入该体的面（0..5）
  dist: number;
}

/**
 * 从原点沿单位方向做 DDA，返回首个实体命中（方块或设施，不含起点格自身）。
 * 原点应落在空气格（玩家眼睛）；face>=0 表示从空气进入实体。
 */
export function pickBlock(
  world: World,
  origin: [number, number, number],
  dir: [number, number, number],
  maxDist: number,
): PickHit | null {
  let hit: PickHit | null = null;
  traverseVoxels(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], maxDist, (ctx) => {
    if (ctx.face < 0) return false;
    const b = world.blockAt([ctx.x, ctx.y, ctx.z]);
    if (b.material !== 0 || b.facility !== null) {
      hit = { cell: [ctx.x, ctx.y, ctx.z], face: ctx.face, dist: ctx.t };
      return true;
    }
    return false;
  });
  return hit;
}

/** 命中面相邻的放置格（即射线来向那一侧的空气格）。 */
export function placeCellFromHit(hit: PickHit): [number, number, number] {
  const [x, y, z] = hit.cell;
  switch (hit.face) {
    case 0:
      return [x - 1, y, z];
    case 1:
      return [x + 1, y, z];
    case 2:
      return [x, y - 1, z];
    case 3:
      return [x, y + 1, z];
    case 4:
      return [x, y, z - 1];
    case 5:
      return [x, y, z + 1];
    default:
      return [x, y, z];
  }
}
