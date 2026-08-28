/**
 * 全项目共享类型定义（Sprint 1 底座）。
 * 命名与 tech-design §3 对齐：坐标统一使用三轴整数格坐标。
 */

/** 三轴坐标/向量（世界格坐标，方块取整数格） */
export type XYZA = [number, number, number];

/** 频段：0=低频 1=中频 2=高频 */
export type Band = 0 | 1 | 2;

/** 三频系数元组，顺序恒为 [低频, 中频, 高频] */
export type Triplet = [number, number, number];

export type MaterialName =
  | 'foam'
  | 'wood'
  | 'glass'
  | 'stone'
  | 'concrete'
  | 'metal'
  | 'soil';

/** 材料参数：唯一数据源 materials.table（tech-design §3.1）；reflect 为派生字段 */
export interface MaterialSpec {
  id: number; // 0..6
  name: MaterialName;
  mass: number;
  durability: number;
  abs: Triplet; // 吸收系数 α
  trans: Triplet; // 透射系数 τ
  reflect: Triplet; // 派生：clamp(1-abs-trans, 0.01, 1)
}

/**
 * 方块引用：与 tech-design §4.1 IWorldRead.blockAt 字段一致。
 * S2 增量（contract SP2-03）：placed 标记原生/空气=false、玩家放置=true；
 * 由 world.placed 数组单一来源派生。
 */
export interface BlockRef {
  material: number; // 0=空气, 1..7=材料
  durability: number;
  facility: FacilityState | null;
  placed: boolean;
}

/** 玩家运行时状态（S2 增量）：pos 为脚底中心（浮点世界坐标），spawn 为出生格 */
export interface PlayerState {
  spawn: XYZA;
  pos: [number, number, number];
  vel: [number, number, number];
  yaw: number;
  pitch: number;
  grounded: boolean;
}

/** 设施种类（S3 钉死：core/cannon/probe/duct/relay，与 tech-design §3.4 对齐） */
export type FacilityKind = 'core' | 'cannon' | 'probe' | 'duct' | 'relay';

/** 轨道俯瞰参数（state.orbit 形状；内部 target 为世界浮点坐标） */
export interface OrbitState {
  distance: number;
  yaw: number;
  pitch: number;
  target: [number, number, number];
}

/** 设施状态（S1 尚不产生设施，S3 起用于基础放置/拆除/旋转；pos 为 gridId，cell 由 blockCoords 派生出外部形状） */
export interface FacilityState {
  id: number;
  kind: FacilityKind;
  pos: number;
  yaw: number;
  energy: number;
  coreHp: number;
  band: Band | 3;
  linkFrom: number[];
  linkTo: number[];
  busState: 'idle' | 'active' | 'disabled';
}

/** 存档/外部设施快照：cell 为三轴格坐标，kind/yaw 与内部单一来源 */
export interface FacilitySnapshot {
  cell: XYZA;
  kind: FacilityKind;
  yaw: number;
}

/** 物品 id 元信息（1-7 材料来自 materials.ts，8-12 设施物品来自 recipes.ts） */
export interface ItemDef {
  id: number;
  name: string;
}

/** 固定环境声源点 */
export interface SoundSource {
  id: number;
  pos: XYZA; // 世界格坐标（整数）
  dominantBand: Band; // 0/1/2 各一
  mineable: false;
}

/** 性能观测字段（state.perf） */
export interface BenchResult {
  avgMs: number;
  p95Ms: number;
  raysPerSec: number;
}

export interface PerfState {
  fps: number;
  avgFrameMs: number;
  drawCalls: number;
  instances: number;
  pixelRatio: number;
  lastBench: BenchResult | null;
}

/** 图形档 */
export type GraphicTier = 'high' | 'low';
