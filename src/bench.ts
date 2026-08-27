/**
 * 性能 spike：DDA 射线遍历基准（debug.benchRay 的数据来源）。
 * 在当前世界网格上做确定性方向的射线遍历 + 反弹，统计耗时。
 */
import { BENCH_RAY_MAX_DIST } from './config';
import type { BenchResult, XYZA } from './types';
import { faceNormal, reflectDir, traverseVoxels, World } from './world';

export interface BenchOptions {
  rays?: number;
  bounces?: number;
}

/** 归一化向量 */
function normalize(v: XYZA): XYZA {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** 斐波那契球面：n 个近似均匀分布的方向（确定性，无随机） */
export function fibonacciSphereDirections(n: number): XYZA[] {
  const dirs: XYZA[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    dirs.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }
  return dirs;
}

/** 单条射线（含 bounces 次反弹）的 DDA 遍历，返回访问格数 */
function castRay(world: World, dir: XYZA, bounces: number): number {
  let pos: XYZA = [32.5, 12.5, 32.5];
  let d: XYZA = normalize(dir);
  let cells = 0;

  for (let b = 0; b <= bounces; b++) {
    let hitFace = -1;
    let hitSolid = false;
    cells += traverseVoxels(
      pos[0],
      pos[1],
      pos[2],
      d[0],
      d[1],
      d[2],
      BENCH_RAY_MAX_DIST,
      (ctx) => {
        if (world.materialAt([ctx.x, ctx.y, ctx.z]) !== 0) {
          hitFace = ctx.face;
          hitSolid = true;
          return true;
        }
        return false;
      },
    );
    if (!hitSolid || b === bounces || hitFace < 0) break;
    // 命中：把点推回命中格中心附近，并按面法线反射
    const n = faceNormal(hitFace);
    d = normalize(reflectDir(d, n));
  }
  return cells;
}

/** 执行基准：对当前世界采样 rays 条射线 × bounces 次反弹 */
export function runBenchRay(world: World, opts: BenchOptions): BenchResult {
  const rays = Math.max(1, opts.rays ?? 128);
  const bounces = Math.max(1, opts.bounces ?? 3);
  const dirs = fibonacciSphereDirections(rays);

  const perRay: number[] = [];
  for (const dir of dirs) {
    const t0 = performance.now();
    castRay(world, dir, bounces);
    perRay.push(performance.now() - t0);
  }

  perRay.sort((a, b) => a - b);
  const sum = perRay.reduce((acc, v) => acc + v, 0);
  const avgMs = sum / perRay.length;
  const p95Idx = Math.min(perRay.length - 1, Math.ceil(perRay.length * 0.95) - 1);
  const p95Ms = perRay[Math.max(0, p95Idx)];
  const raysPerSec = avgMs > 0 ? 1000 / avgMs : Infinity;

  return { avgMs, p95Ms, raysPerSec };
}
