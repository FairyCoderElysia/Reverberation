/**
 * M3 声学模拟内核（Sprint 4）。
 *
 * 实现三频几何声学传播：DDA 射线（复用 world.traverseVoxels）+ 简化反射/透射/
 * 距离衰减/吸收/简化绕射。传播只在本文件内实现，材料三频参数唯一来源为 materials.ts。
 *
 * 确定性约束：
 * - 折射/反射/衰减全部使用固定顺序与显式三元组运算；
 * - 禁止 Math.random 进入本模块；
 * - 固定射线序列（Fibonacci 球面 或 定向锥内确定性采样）。
 */
import { ACOUSTIC_DEFAULT_PARAMS, ACOUSTIC_DEFAULT_TUNING } from './config';
import type { BandEnergy, MaterialSpec, XYZA } from './types';

export type { BandEnergy } from './types';
import { blockIndex, faceNormal, inBounds, reflectDir, traverseVoxels } from './world';
import type { World } from './world';

/** 声学事件：所有内部声源（环境/调试/炮/怪/天灾）统一走此接口 */
export interface AcousticEvent {
  kind: 'environment' | 'debug' | 'cannon' | 'monster' | 'storm';
  pos: XYZA;
  /** 定向发射方向；未提供 = 全向 */
  dir?: XYZA;
  /** 源归一化功率，默认 [1,1,1]（由调用方填充） */
  power: BandEnergy;
}

/** 游戏性全局缩放（唯一夸张层） */
export interface AcousticTuning {
  G_ABSORB: number;
  G_TRANS: number;
  G_DIST_EXP: number;
  G_DIFFRACT: number;
}

/** 传播参数（性能/精度；S4 未做降级 UI，但保留默认值） */
export interface AcousticParams {
  rays: number;
  bounces: number;
  diffract: boolean;
  fieldThreshold: number;
}

/** 能量场：稀疏 bins + 版本号 + 唯一读 API sample(g) */
export interface EnergyField {
  bins: Map<number, BandEnergy>;
  version: number;
  sample: (g: XYZA) => BandEnergy;
}

/** 默认参数（tech-design 附录参数表；S4 只使用默认档；常量单一来源 config.ts） */
export const DEFAULT_ACOUSTIC_PARAMS: AcousticParams = { ...ACOUSTIC_DEFAULT_PARAMS };

/** 默认调谐参数（tech-design §3.1；常量单一来源 config.ts） */
export const DEFAULT_ACOUSTIC_TUNING: AcousticTuning = { ...ACOUSTIC_DEFAULT_TUNING };

const MAX_RAY_DIST = 160;
const EPS = 1e-9;
const TWO_PI = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function normalizeDir(v: XYZA): XYZA {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len <= EPS) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function addToBin(map: Map<number, BandEnergy>, idx: number, e: BandEnergy): void {
  const cur = map.get(idx);
  if (!cur) {
    map.set(idx, [e[0], e[1], e[2]]);
    return;
  }
  cur[0] += e[0];
  cur[1] += e[1];
  cur[2] += e[2];
}

function mergeField(target: Map<number, BandEnergy>, src: Map<number, BandEnergy>): void {
  // Map 迭代仅用于合并；数值累加顺序由 source 列表顺序固定，不依赖桶内随机序。
  for (const [idx, e] of src) {
    addToBin(target, idx, e);
  }
}

/** 全向/定向确定性方向序列 */
function deterministicDirections(rayCount: number, dir?: XYZA): XYZA[] {
  const out: XYZA[] = [];
  if (!dir) {
    // 固定轴射线优先：保证沿主轴的确定性采样在回归脚本中可重复、可断言。
    const cardinals: XYZA[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const sphereCount = Math.max(0, rayCount - cardinals.length);
    for (let i = 0; i < cardinals.length && i < rayCount; i++) out.push(cardinals[i]);
    for (let i = 0; i < sphereCount; i++) {
      const y = 1 - (2 * (i + 0.5)) / sphereCount;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * GOLDEN_ANGLE;
      out.push([r * Math.cos(phi), y, r * Math.sin(phi)]);
    }
    return out;
  }

  const main = normalizeDir(dir);
  // 在 main 垂直平面上取两个正交基
  const helper =
    Math.abs(main[1]) < 0.99 ? ([0, 1, 0] as XYZA) : ([1, 0, 0] as XYZA);
  const t0 = normalizeDir([
    main[1] * helper[2] - main[2] * helper[1],
    main[2] * helper[0] - main[0] * helper[2],
    main[0] * helper[1] - main[1] * helper[0],
  ]);
  const t1 = normalizeDir([
    main[1] * t0[2] - main[2] * t0[1],
    main[2] * t0[0] - main[0] * t0[2],
    main[0] * t0[1] - main[1] * t0[0],
  ]);
  // 定向锥：第一束严格沿 main，其余围绕 main 展开，形成确定性的窄锥。
  const spread = 0.45;
  for (let i = 0; i < rayCount; i++) {
    if (i === 0) {
      out.push([main[0], main[1], main[2]]);
      continue;
    }
    const u = (i - 0.5) / rayCount;
    const v = (i * GOLDEN_ANGLE * 2.399963) % TWO_PI;
    const r = spread * Math.sqrt(u * 2);
    const px = r * Math.cos(v);
    const py = r * Math.sin(v);
    const dx = main[0] + px * t0[0] + py * t1[0];
    const dy = main[1] + px * t0[1] + py * t1[1];
    const dz = main[2] + px * t0[2] + py * t1[2];
    out.push(normalizeDir([dx, dy, dz]));
  }
  return out;
}

function distanceFactor(d: number, exponent: number): number {
  const safe = Math.max(0, d);
  return 1 / Math.pow(1 + safe, exponent);
}

/** 当前材料或设施的声学参数；设施按全反射障碍处理 */
function acousticForBlock(
  block: { material: number; facility: unknown },
  materials: readonly MaterialSpec[],
): { alpha: BandEnergy; tau: BandEnergy; rho: BandEnergy } {
  if (block.facility) {
    return {
      alpha: [0, 0, 0],
      tau: [0, 0, 0],
      rho: [1, 1, 1],
    };
  }
  const id = block.material;
  if (id < 1 || id > materials.length) {
    return { alpha: [0, 0, 0], tau: [0, 0, 0], rho: [0, 0, 0] };
  }
  const m = materials[id - 1];
  return {
    alpha: [m.abs[0], m.abs[1], m.abs[2]],
    tau: [m.trans[0], m.trans[1], m.trans[2]],
    rho: [m.reflect[0], m.reflect[1], m.reflect[2]],
  };
}

export class AcousticEngine {
  private world: World;
  private materials: () => readonly MaterialSpec[];
  private tuning: AcousticTuning = { ...DEFAULT_ACOUSTIC_TUNING };
  private params: AcousticParams = { ...DEFAULT_ACOUSTIC_PARAMS };
  private sourceCounter = 0;

  constructor(world: World, materials: () => readonly MaterialSpec[]) {
    this.world = world;
    this.materials = materials;
  }

  setWorld(world: World): void {
    this.world = world;
  }

  get tuningValue(): Readonly<AcousticTuning> {
    return { ...this.tuning };
  }

  setTuning(patch: Partial<AcousticTuning>): void {
    const t = this.tuning;
    if (patch.G_ABSORB !== undefined) t.G_ABSORB = Math.min(3, Math.max(0.5, patch.G_ABSORB));
    if (patch.G_TRANS !== undefined) t.G_TRANS = Math.min(2, Math.max(0.5, patch.G_TRANS));
    if (patch.G_DIST_EXP !== undefined) t.G_DIST_EXP = Math.min(3, Math.max(1, patch.G_DIST_EXP));
    if (patch.G_DIFFRACT !== undefined) t.G_DIFFRACT = Math.min(2, Math.max(0, patch.G_DIFFRACT));
  }

  resetTuning(): void {
    this.tuning = { ...DEFAULT_ACOUSTIC_TUNING };
  }

  /** 仅由 Game 在默认事件后调用；返回新的 field，不在这里管理源列表 */
  recalc(sources: readonly AcousticEvent[]): EnergyField {
    // 每个声源先独立计算成稀疏场，再按固定 source 顺序相加。
    // 这保证多源叠加满足 Fc == Fa + Fb（逐频位级一致：Fc = 0+A 后 +B，与 A+B 相同）。
    const merged = new Map<number, BandEnergy>();
    for (const src of sources) {
      const srcField = this.computeSourceField(src);
      mergeField(merged, srcField);
    }
    this.sourceCounter = (this.sourceCounter + 1) >>> 0;
    const version = this.sourceCounter;
    const self = this;
    return {
      bins: merged,
      version,
      sample: (g: XYZA) => self.sampleFromMap(merged, g),
    };
  }

  /** 强制重算由 Game 调用；engine 本身不持有 field 状态（Game 持有） */
  sampleFromMap(bins: Map<number, BandEnergy>, g: XYZA): BandEnergy {
    const [x, y, z] = g;
    if (!inBounds(x, y, z)) return [0, 0, 0];
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return [0, 0, 0];
    const idx = blockIndex(x, y, z);
    const e = bins.get(idx);
    if (!e) return [0, 0, 0];
    return [e[0], e[1], e[2]];
  }

  private computeSourceField(src: AcousticEvent): Map<number, BandEnergy> {
    const map = new Map<number, BandEnergy>();
    const mats = this.materials();
    const ox = src.pos[0] + 0.5;
    const oy = src.pos[1] + 0.5;
    const oz = src.pos[2] + 0.5;
    const dirs = deterministicDirections(this.params.rays, src.dir);
    const perRay = 1 / this.params.rays;
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      const rayPower: BandEnergy = [
        src.power[0] * perRay,
        src.power[1] * perRay,
        src.power[2] * perRay,
      ];
      this.traceRay(map, ox, oy, oz, d, rayPower, 0, mats, this.params.bounces);
    }
    return map;
  }

  private traceRay(
    map: Map<number, BandEnergy>,
    ox: number,
    oy: number,
    oz: number,
    dir: XYZA,
    power: BandEnergy,
    bounce: number,
    mats: readonly MaterialSpec[],
    maxBouncesLeft: number,
  ): void {
    if (power[0] <= 0 && power[1] <= 0 && power[2] <= 0) return;
    const d = normalizeDir([dir[0], dir[1], dir[2]]);
    const maxT = MAX_RAY_DIST;
    let hitPoint: [number, number, number] | null = null;
    let hitNormal: XYZA = [0, 0, 0];
    let reflectedPower: BandEnergy | null = null;
    let diffractedPower: BandEnergy | null = null;

    traverseVoxels(ox, oy, oz, d[0], d[1], d[2], maxT, (ctx) => {
      const [cx, cy, cz] = [ctx.x, ctx.y, ctx.z];
      const startX = Math.floor(ox);
      const startY = Math.floor(oy);
      const startZ = Math.floor(oz);
      if (
        bounce === 0 &&
        cx === startX &&
        cy === startY &&
        cz === startZ &&
        ctx.t <= EPS + 1e-6
      ) {
        return false;
      }

      const idx = blockIndex(cx, cy, cz);
      const dist = Math.max(0, ctx.t);
      const atten = distanceFactor(dist, this.tuning.G_DIST_EXP);
      const arrived: BandEnergy = [
        power[0] * atten,
        power[1] * atten,
        power[2] * atten,
      ];
      addToBin(map, idx, arrived);

      const block = this.world.blockAt([cx, cy, cz]);
      if (block.material === 0 && !block.facility) return false;

      const ac = acousticForBlock(block, mats);
      const arrivedAbsorb: BandEnergy = [
        clamp01(ac.alpha[0] * this.tuning.G_ABSORB),
        clamp01(ac.alpha[1] * this.tuning.G_ABSORB),
        clamp01(ac.alpha[2] * this.tuning.G_ABSORB),
      ];
      const transFactor: BandEnergy = [
        Math.pow(ac.tau[0], this.tuning.G_TRANS),
        Math.pow(ac.tau[1], this.tuning.G_TRANS),
        Math.pow(ac.tau[2], this.tuning.G_TRANS),
      ];
      const afterAbsorb: BandEnergy = [
        arrived[0] * (1 - arrivedAbsorb[0]),
        arrived[1] * (1 - arrivedAbsorb[1]),
        arrived[2] * (1 - arrivedAbsorb[2]),
      ];
      const transmitted: BandEnergy = [
        afterAbsorb[0] * transFactor[0],
        afterAbsorb[1] * transFactor[1],
        afterAbsorb[2] * transFactor[2],
      ];
      const reflected: BandEnergy = [
        afterAbsorb[0] * ac.rho[0],
        afterAbsorb[1] * ac.rho[1],
        afterAbsorb[2] * ac.rho[2],
      ];
      const diff: BandEnergy = [
        arrived[0] * this.tuning.G_DIFFRACT * 0.01,
        arrived[1] * this.tuning.G_DIFFRACT * 0.01,
        arrived[2] * this.tuning.G_DIFFRACT * 0.01,
      ];

      hitPoint = [
        ox + d[0] * ctx.t,
        oy + d[1] * ctx.t,
        oz + d[2] * ctx.t,
      ];
      hitNormal = faceNormal(ctx.face);
      reflectedPower = reflected;
      diffractedPower = diff;

      // 透射：继续穿墙（能量按透射后值）
      if (transmitted[0] > 0 || transmitted[1] > 0 || transmitted[2] > 0) {
        this.continueThrough(
          map,
          hitPoint,
          d,
          transmitted,
          bounce,
          mats,
          maxBouncesLeft - 1,
        );
      }
      return true; // 主射线在首次实体命中处停止；透射/反射/绕射由派生射线负责
    });

    // 主射线停止后处理反射/绕射
    if (hitPoint && reflectedPower && maxBouncesLeft > 0) {
      const rd = normalizeDir(reflectDir(d, hitNormal));
      const start = [
        hitPoint[0] + rd[0] * 1e-4,
        hitPoint[1] + rd[1] * 1e-4,
        hitPoint[2] + rd[2] * 1e-4,
      ] as [number, number, number];
      this.traceRay(
        map,
        start[0],
        start[1],
        start[2],
        rd,
        reflectedPower,
        bounce + 1,
        mats,
        maxBouncesLeft - 1,
      );
    }
    if (hitPoint && diffractedPower && this.params.diffract && this.tuning.G_DIFFRACT > 0) {
      this.traceDiffract(
        map,
        hitPoint,
        d,
        diffractedPower,
        mats,
        Math.max(0, maxBouncesLeft),
      );
    }
  }

  private continueThrough(
    map: Map<number, BandEnergy>,
    hitPoint: [number, number, number],
    dir: XYZA,
    power: BandEnergy,
    bounce: number,
    mats: readonly MaterialSpec[],
    maxBouncesLeft: number,
  ): void {
    // 从遮挡方块远侧继续：入射边界 + 一个完整体素，避免立即再次命中同一实体。
    const start = [
      hitPoint[0] + dir[0] * (1 + 1e-4),
      hitPoint[1] + dir[1] * (1 + 1e-4),
      hitPoint[2] + dir[2] * (1 + 1e-4),
    ] as [number, number, number];
    this.traceRay(
      map,
      start[0],
      start[1],
      start[2],
      dir,
      power,
      bounce,
      mats,
      maxBouncesLeft,
    );
  }

  /** 简化绕射射线：沿原方向穿透少量格，能量远小于直接/反射路径 */
  private traceDiffract(
    map: Map<number, BandEnergy>,
    startPoint: [number, number, number],
    dir: XYZA,
    power: BandEnergy,
    mats: readonly MaterialSpec[],
    maxBouncesLeft: number,
  ): void {
    // maxBouncesLeft 未使用：简化绕射只做固定短程泄漏，避免过度穿墙。
    void mats;
    void maxBouncesLeft;
    const d = normalizeDir([dir[0], dir[1], dir[2]]);
    const ox = startPoint[0] + d[0] * (1 + 0.5);
    const oy = startPoint[1] + d[1] * (1 + 0.5);
    const oz = startPoint[2] + d[2] * (1 + 0.5);
    const maxT = 6;
    traverseVoxels(ox, oy, oz, d[0], d[1], d[2], maxT, (ctx) => {
      const [cx, cy, cz] = [ctx.x, ctx.y, ctx.z];
      if (!inBounds(cx, cy, cz)) return true;
      const idx = blockIndex(cx, cy, cz);
      const atten = distanceFactor(Math.max(0, ctx.t), this.tuning.G_DIST_EXP);
      addToBin(map, idx, [power[0] * atten, power[1] * atten, power[2] * atten]);
      if (ctx.t > maxT) return true;
      return false;
    });
  }
}
