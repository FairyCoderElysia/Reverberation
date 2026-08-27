/**
 * M2 材料与声学参数表 —— 唯一数据源（tech-design §3.1 默认表，逐位落地）。
 * 其余模块（世界、UI、__app.state.materials）一律从本表读取，禁止散落写死。
 */
import type { MaterialName, MaterialSpec, Triplet } from './types';

/** 材料内部表：吸收/透射均为 [低频, 中频, 高频]，数值严格采用 tech-design §3.1 */
interface MaterialRow {
  name: MaterialName;
  mass: number;
  durability: number;
  abs: Triplet;
  trans: Triplet;
}

/** 唯一权威材料表（顺序即 id：0泡沫 1木材 2玻璃 3石材 4混凝土 5金属 6土层） */
export const MATERIAL_TABLE: readonly MaterialRow[] = [
  { name: 'foam', mass: 0.1, durability: 30, abs: [0.15, 0.4, 0.8], trans: [0.55, 0.6, 0.65] },
  { name: 'wood', mass: 0.5, durability: 60, abs: [0.2, 0.12, 0.1], trans: [0.3, 0.2, 0.15] },
  { name: 'glass', mass: 2.0, durability: 25, abs: [0.03, 0.03, 0.05], trans: [0.75, 0.7, 0.6] },
  { name: 'stone', mass: 8.0, durability: 120, abs: [0.03, 0.04, 0.06], trans: [0.2, 0.15, 0.25] },
  { name: 'concrete', mass: 12.0, durability: 150, abs: [0.05, 0.06, 0.08], trans: [0.1, 0.12, 0.25] },
  { name: 'metal', mass: 14.0, durability: 200, abs: [0.02, 0.03, 0.04], trans: [0.06, 0.08, 0.12] },
  { name: 'soil', mass: 3.0, durability: 20, abs: [0.1, 0.25, 0.35], trans: [0.4, 0.35, 0.3] },
] as const;

/** 材料中文名（仅用于 UI 展示，非判定数据） */
export const MATERIAL_ZH: Record<MaterialName, string> = {
  foam: '泡沫',
  wood: '木材',
  glass: '玻璃',
  stone: '石材',
  concrete: '混凝土',
  metal: '金属',
  soil: '土层',
};

/** 派生反射比：reflect[b] = clamp(1 - abs[b] - trans[b], 0.01, 1) */
export function deriveReflect(abs: Triplet, trans: Triplet): Triplet {
  return [0, 1, 2].map((b) => clamp01(1 - abs[b] - trans[b], 0.01)) as Triplet;
}

function clamp01(v: number, floor: number): number {
  if (v < floor) return floor;
  if (v > 1) return 1;
  return v;
}

export function materialCount(): number {
  return MATERIAL_TABLE.length;
}

/** 用（可覆盖的）有效数值构造 MaterialSpec：id、name、6 系数、耐久、派生 reflect */
export function buildMaterialSpec(id: number, row: MaterialRow): MaterialSpec {
  return {
    id,
    name: row.name,
    mass: row.mass,
    durability: row.durability,
    abs: [...row.abs] as Triplet,
    trans: [...row.trans] as Triplet,
    reflect: deriveReflect(row.abs, row.trans),
  };
}

/**
 * 方向性约束校验（F2.2 五条，等价 SP1-08）。
 * 返回违规描述列表；空数组 = 全部通过。
 */
export function validateTable(rows: readonly MaterialRow[]): string[] {
  const errors: string[] = [];
  const foam = rows[0];
  const glass = rows[2];
  const stone = rows[3];
  const concrete = rows[4];
  const metal = rows[5];
  const soil = rows[6];

  // ① 泡沫：高频吸收 ≥ 低频吸收 + 0.2（高频更吸）
  if (foam.abs[2] - foam.abs[0] < 0.2) {
    errors.push('① 泡沫 abs[2]-abs[0] < 0.2');
  }
  // ② 混凝土/石材/金属：低频透射 ≤ 高频透射（低频更隔），且至少一种严格不等
  for (const [n, m] of [
    ['concrete', concrete],
    ['stone', stone],
    ['metal', metal],
  ] as const) {
    if (!(m.trans[0] <= m.trans[2])) {
      errors.push(`② ${n} trans[0] > trans[2]`);
    }
  }
  if (!(concrete.trans[0] < concrete.trans[2] || stone.trans[0] < stone.trans[2] || metal.trans[0] < metal.trans[2])) {
    errors.push('② 混凝土/石材/金属 无一种 trans[0] < trans[2]');
  }
  // ③ 金属逐频 abs+trans 均低于泡沫与土层对应频段（高反射）
  for (let b = 0; b < 3; b++) {
    if (metal.abs[b] + metal.trans[b] >= foam.abs[b] + foam.trans[b]) {
      errors.push(`③ 金属 L/M/H[${b}] abs+trans ≥ 泡沫`);
    }
    if (metal.abs[b] + metal.trans[b] >= soil.abs[b] + soil.trans[b]) {
      errors.push(`③ 金属 L/M/H[${b}] abs+trans ≥ 土层`);
    }
  }
  // ④ 玻璃逐频 trans 均高于混凝土与金属对应频段（透声材料）
  for (let b = 0; b < 3; b++) {
    if (!(glass.trans[b] > concrete.trans[b])) {
      errors.push(`④ 玻璃 trans[${b}] ≤ 混凝土`);
    }
    if (!(glass.trans[b] > metal.trans[b])) {
      errors.push(`④ 玻璃 trans[${b}] ≤ 金属`);
    }
  }
  // ⑤ 至少一种材料跨频差异显著
  let ok5 = false;
  for (const m of rows) {
    if (Math.abs(m.trans[0] - m.trans[2]) >= 0.2 || m.abs[2] - m.abs[0] >= 0.2) {
      ok5 = true;
      break;
    }
  }
  if (!ok5) {
    errors.push('⑤ 无任何材料满足跨频差异 ≥ 0.2');
  }
  return errors;
}

/** 对默认表直接校验（供测试/启动自检使用） */
export function validateDefaultTable(): string[] {
  return validateTable(MATERIAL_TABLE);
}

export type TripletPatch = Partial<{ [K in 0 | 1 | 2]: number }>;

export interface MaterialOverrides {
  abs?: TripletPatch;
  trans?: TripletPatch;
  durability?: number;
  mass?: number;
}

/** 合并覆盖值：返回新的有效三频数组与耐久/mass */
export function applyOverride(
  row: MaterialRow,
  override: MaterialOverrides,
): MaterialRow {
  const abs = [...row.abs] as Triplet;
  const trans = [...row.trans] as Triplet;
  if (override.abs) {
    for (const b of [0, 1, 2] as const) {
      const v = override.abs[b];
      if (v !== undefined) abs[b] = v;
    }
  }
  if (override.trans) {
    for (const b of [0, 1, 2] as const) {
      const v = override.trans[b];
      if (v !== undefined) trans[b] = v;
    }
  }
  return {
    name: row.name,
    mass: override.mass ?? row.mass,
    durability: override.durability ?? row.durability,
    abs,
    trans,
  };
}

/**
 * 由（可空）覆盖表计算当前有效的 7 种 MaterialSpec（state.materials 与 F2.3 面板的共同来源）。
 */
export function effectiveMaterials(overrides: ReadonlyMap<number, MaterialOverrides>): MaterialSpec[] {
  return MATERIAL_TABLE.map((row, id) => {
    const ov = overrides.get(id) ?? {};
    const merged = applyOverride(row, ov);
    return buildMaterialSpec(id, merged);
  });
}

/** 合并两个 Partial<Triplet>：后者优先（用于 setMaterial 增量覆盖） */
export function mergeTriplet(
  base: TripletPatch | undefined,
  patch: TripletPatch | undefined,
): TripletPatch {
  const out: TripletPatch = {};
  for (const b of [0, 1, 2] as const) {
    const v = patch?.[b] ?? base?.[b];
    if (v !== undefined) out[b] = v;
  }
  return out;
}
