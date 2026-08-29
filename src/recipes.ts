/**
 * S3 配方/物品/设施定义 —— 唯一数据源。
 * - 物品 id 1..7 = 材料（materials.ts），8..12 = 设施物品（本文件）。
 * - 配方 data 同时供 state.recipes 与合成 UI 使用，禁止两处重复定义。
 * - 设施能力清单只反映本 sprint 已实现的真实能力（S6：core=store、probe=read），
 *   无任何逻辑门/记忆/时钟等未实现功能。
 */
import type { FacilityKind, ItemDef } from './types';

export interface RecipeIngredient {
  itemId: number;
  qty: number;
}

export interface RecipeOutput {
  itemId: number;
  name: string;
  count: number;
}

export interface Recipe {
  id: number;
  name: string;
  ingredients: RecipeIngredient[];
  output: RecipeOutput;
}

export interface FacilityDef {
  id: number;
  kind: FacilityKind;
  name: string;
  itemId: number;
  implemented: boolean;
  /** 能力表只反映本 sprint 已实现的真实行为；无 logic/and/or/not/memory/clock 等未实现语义。 */
  abilities: Record<string, boolean>;
}

/** 物品 id → 中文名（1..12；1 泡沫/2 木材/3 玻璃/4 石材/5 混凝土/6 金属/7 土层） */
export const ITEM_NAMES: Record<number, string> = {
  1: '泡沫',
  2: '木材',
  3: '玻璃',
  4: '石材',
  5: '混凝土',
  6: '金属',
  7: '土层',
  8: '能量核心',
  9: '声波炮',
  10: '声学探针',
  11: '声导管',
  12: '中继器',
};

/** 设施 kind → 库存物品 id */
export const FACILITY_ITEM_IDS: Record<FacilityKind, number> = {
  core: 8,
  cannon: 9,
  probe: 10,
  duct: 11,
  relay: 12,
};

/** 库存物品 id（8..12）→ 设施 kind */
export const FACILITY_KIND_BY_ITEM: Record<number, FacilityKind> = {
  8: 'core',
  9: 'cannon',
  10: 'probe',
  11: 'duct',
  12: 'relay',
};

/** 可放置设施 id 范围（调试/UI 共用） */
export const MIN_FACILITY_ITEM_ID = 8;
export const MAX_FACILITY_ITEM_ID = 12;

/** 5 类设施定义（S6：core/probe 已实现；cannon/duct/relay 本 sprint 不做真实能力） */
export const FACILITY_DEFS: readonly FacilityDef[] = [
  {
    id: 1,
    kind: 'core',
    name: '能量核心',
    itemId: 8,
    implemented: true,
    abilities: { store: true },
  },
  {
    id: 2,
    kind: 'cannon',
    name: '声波炮',
    itemId: 9,
    implemented: false,
    abilities: {},
  },
  {
    id: 3,
    kind: 'probe',
    name: '声学探针',
    itemId: 10,
    implemented: true,
    abilities: { read: true },
  },
  {
    id: 4,
    kind: 'duct',
    name: '声导管',
    itemId: 11,
    implemented: false,
    abilities: {},
  },
  {
    id: 5,
    kind: 'relay',
    name: '中继器',
    itemId: 12,
    implemented: false,
    abilities: {},
  },
];

/** 配方表（唯一数据源；与 contract「默认配方」逐项一致） */
export const RECIPES: readonly Recipe[] = [
  {
    id: 1,
    name: '能量核心',
    ingredients: [
      { itemId: 6, qty: 2 },
      { itemId: 4, qty: 2 },
      { itemId: 3, qty: 1 },
    ],
    output: { itemId: 8, name: '能量核心', count: 1 },
  },
  {
    id: 2,
    name: '声波炮',
    ingredients: [
      { itemId: 6, qty: 2 },
      { itemId: 5, qty: 1 },
      { itemId: 3, qty: 1 },
    ],
    output: { itemId: 9, name: '声波炮', count: 1 },
  },
  {
    id: 3,
    name: '声学探针',
    ingredients: [
      { itemId: 3, qty: 1 },
      { itemId: 2, qty: 1 },
      { itemId: 6, qty: 1 },
    ],
    output: { itemId: 10, name: '声学探针', count: 1 },
  },
  {
    id: 4,
    name: '声导管',
    ingredients: [
      { itemId: 5, qty: 2 },
      { itemId: 2, qty: 1 },
    ],
    output: { itemId: 11, name: '声导管', count: 1 },
  },
  {
    id: 5,
    name: '中继器',
    ingredients: [
      { itemId: 6, qty: 1 },
      { itemId: 5, qty: 1 },
      { itemId: 2, qty: 1 },
    ],
    output: { itemId: 12, name: '中继器', count: 1 },
  },
];

/** 物品定义数组（1..12；供 UI 遍历） */
export const ITEM_DEFS: readonly ItemDef[] = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  name: ITEM_NAMES[i + 1],
}));

/** 物品中文名，非法 id 返回占位字符串（不抛错，UI 友好）。 */
export function itemName(id: number): string {
  return ITEM_NAMES[id] ?? '未知';
}

/** 合法设施 kind 判定 */
export function isFacilityKind(v: unknown): v is FacilityKind {
  return v === 'core' || v === 'cannon' || v === 'probe' || v === 'duct' || v === 'relay';
}
