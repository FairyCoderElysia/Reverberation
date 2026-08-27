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

/** 从命中面向上轻推的微距，避免反射后的新原点与同一体素再次相交 */
const BOUNCE_EPS = 1e-6;

/**
 * 单条射线（含 bounces 次反弹）的 DDA 遍历，返回访问格数。
 * 命中后把原点推进到命中面（pos + dir*t）并沿反射方向继续遍历（Code-m6：真 DDA 多反弹路径）。
 */
function castRay(world: World, dir: XYZA, bounces: number): number {
  let pos: XYZA = [32.5, 12.5, 32.5];
  let d: XYZA = normalize(dir);
  let cells = 0;

  for (let b = 0; b <= bounces; b++) {
    let hitFace = -1;
    let hitT = 0;
    cells += traverseVoxels(
      pos[0],
      pos[1],
      pos[2],
      d[0],
      d[1],
      d[2],
      BENCH_RAY_MAX_DIST,
      (ctx) => {
        // face>=0 表示本次是「从空气进入该体素」的命中面（起点在空气），排除起点格自身
        if (ctx.face >= 0 && world.materialAt([ctx.x, ctx.y, ctx.z]) !== 0) {
          hitFace = ctx.face;
          hitT = ctx.t;
          return true;
        }
        return false;
      },
    );
    if (hitFace < 0 || b === bounces) break;
    const n = faceNormal(hitFace);
    const refl = normalize(reflectDir(d, n));
    pos = [
      pos[0] + d[0] * hitT + refl[0] * BOUNCE_EPS,
      pos[1] + d[1] * hitT + refl[1] * BOUNCE_EPS,
      pos[2] + d[2] * hitT + refl[2] * BOUNCE_EPS,
    ];
    d = refl;
  }
  return cells;
}

/** 把非有限/负值夹取为安全的有限数（QA-D1：保证三字段永远有限） */
function toFinite(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v < 0) return fallback;
  return v;
}

/** 执行基准：对当前世界采样 rays 条射线 × bounces 次反弹（多轮累计计时） */
export function runBenchRay(world: World, opts: BenchOptions): BenchResult {
  const rays = Math.max(1, opts.rays ?? 128);
  const bounces = Math.max(0, opts.bounces ?? 3);
  const dirs = fibonacciSphereDirections(rays);

  // 多轮累计计时：performance.now() 亚毫秒分辨率下，单射线可能恒为 0 导致 Infinity
  const rounds = Math.max(3, Math.ceil(32 / rays));
  const perRay: number[] = [];
  for (const dir of dirs) {
    let acc = 0;
    for (let r = 0; r < rounds; r++) {
      const t0 = performance.now();
      castRay(world, dir, bounces);
      acc += performance.now() - t0;
    }
    perRay.push(acc / rounds);
  }

  perRay.sort((a, b) => a - b);
  const sum = perRay.reduce((acc, v) => acc + v, 0);
  const avgRaw = sum / perRay.length;
  const p95Idx = Math.min(perRay.length - 1, Math.max(0, Math.ceil(perRay.length * 0.95) - 1));
  const p95Raw = perRay[p95Idx];

  const avgMs = toFinite(avgRaw, 0);
  const p95Ms = toFinite(p95Raw, avgMs);
  const raysPerSec = avgMs > 0 ? toFinite(1000 / avgMs, 0) : 0;

  return { avgMs, p95Ms, raysPerSec };
}
