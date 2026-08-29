/**
 * M13 声场可视化纯采样层（Sprint 5）。
 *
 * 只读 `energyField.sample(g)` 和世界方块相态，不修改任何模拟/世界/存档数据；
 * 渲染层不另算物理系数，只做「能量 → 视觉强度 / 三频色相」的展示编码。
 * BAND_COLORS 作为三频视觉编码单源（theme.ts）。
 */
import type { EnergyField } from './acoustics';
import type { GraphicTier } from './types';
import { BAND_COLORS } from './theme';
import { SOUND_VIEW_SAMPLE_STEP_HIGH, SOUND_VIEW_SAMPLE_STEP_LOW, SOUND_VIEW_STRENGTH_SCALE } from './config';
import { WORLD_X, WORLD_Y, WORLD_Z } from './world';
import type { World } from './world';

/** 声场可视化采样结果：位置/颜色均为 packed Float32Array，便于直接喂给 Three Points */
export interface SoundVisualSample {
  positions: Float32Array;
  colors: Float32Array;
  count: number;
}

/** 各图形档对应的采样步长（low 更稀疏，保证 visualInstances 严格低于 high）。 */
export function soundViewStepForTier(tier: GraphicTier): number {
  return tier === 'low' ? SOUND_VIEW_SAMPLE_STEP_LOW : SOUND_VIEW_SAMPLE_STEP_HIGH;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/**
 * 采样能量场生成可视化点集。
 * 只把能量 >0 的空气格渲染出来；颜色 = 主导频段的 BAND_COLORS，
 * 亮度 = 总能量归一化（保证视觉强度随 sample 总能量单调上升）。
 */
export function sampleSoundView(
  field: Pick<EnergyField, 'sample'>,
  world: World,
  step: number,
): SoundVisualSample {
  const positions: number[] = [];
  const colors: number[] = [];
  const safeStep = Math.max(1, Math.floor(step));
  const rgbCache: Array<[number, number, number]> = BAND_COLORS.map(hexToRgb);
  for (let y = 0; y < WORLD_Y; y += safeStep) {
    for (let z = 0; z < WORLD_Z; z += safeStep) {
      for (let x = 0; x < WORLD_X; x += safeStep) {
        const block = world.blockAt([x, y, z]);
        if (block.material !== 0 || block.facility !== null) continue;
        const e = field.sample([x, y, z]);
        const total = e[0] + e[1] + e[2];
        if (!(total > 1e-9)) continue;
        let band = 0;
        if (e[1] > e[band]) band = 1;
        if (e[2] > e[band]) band = 2;
        const [r, g, b] = rgbCache[band] ?? [1, 1, 1];
        const strength = Math.min(1, total * SOUND_VIEW_STRENGTH_SCALE);
        positions.push(x + 0.5, y + 0.5, z + 0.5);
        colors.push(r * strength, g * strength, b * strength);
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    count: positions.length / 3,
  };
}
