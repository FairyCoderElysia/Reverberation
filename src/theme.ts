/**
 * 调色板单一常量源（Code-m2）：材质 7 色 + 频段 3 色，renderer 与 ui 共同引用，禁止各处写死。
 * 色值以 hex 字符串表示（便于 ui 直接内联为 CSS 变量；renderer 用 parseInt 转 THREE.Color/数字色值）。
 */

/** 7 种材料展示色，顺序即材料 id（0 泡沫 .. 6 土层） */
export const MATERIAL_COLORS: readonly string[] = [
  '#c9e265', // 泡沫
  '#8a5a2b', // 木材
  '#7fd4e0', // 玻璃
  '#8d8d93', // 石材
  '#9aa3ad', // 混凝土
  '#cfd6dd', // 金属
  '#6b4f2f', // 土层
];

/** 频段三色：0 低频 / 1 中频 / 2 高频 */
export const BAND_COLORS: readonly string[] = [
  '#ff5d5d', // 低频
  '#ffd166', // 中频
  '#5dd9ff', // 高频
];

/** 把 #rrggbb 转为 0xrrggbb 数字色值（Three.js 材质的 color 字段用） */
export function hexToNumber(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

