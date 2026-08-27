/**
 * M10（最小子集）：F2.3 最小只读材料参数面板（中文）。
 * 接收 state.materials 同源数据（effectiveMaterials），不写状态。
 */
import { MATERIAL_ZH } from './materials';
import { BAND_COLORS, MATERIAL_COLORS } from './theme';
import type { MaterialSpec } from './types';
import type { MaterialName } from './types';

const BAND_ZH = ['低频', '中频', '高频'];

/** 渲染 F2.3 面板到 #material-panel（数据与 state.materials 同源） */
export function renderMaterialPanel(specs: MaterialSpec[]): void {
  const el = document.getElementById('material-panel');
  if (!el) return;
  const rows = specs
    .map((s) => {
      const zh = MATERIAL_ZH[s.name as MaterialName];
      const cells = [0, 1, 2]
        .map((b) => {
          const abs = s.abs[b].toFixed(2);
          const tr = s.trans[b].toFixed(2);
          return `<span class="band"><b>${BAND_ZH[b]}</b> 吸${abs} 透${tr}</span>`;
        })
        .join('');
      return `<div class="mat-row"><span class="mat-name" style="--c:${colorFor(s.id)}">${zh}</span>${cells}<span class="mat-dur" title="耐久">耐久${s.durability}</span></div>`;
    })
    .join('');
  el.innerHTML = `
    <div class="panel-head">材料参数（只读 · 三频吸收/透射）</div>
    ${rows}
    <div class="panel-leg">${BAND_ZH.map((b, i) => `<i style="--lc:${legColor(i)}">${b}</i>`).join('')}</div>
  `;
}

function colorFor(id: number): string {
  return MATERIAL_COLORS[id] ?? '#fff';
}

function legColor(id: number): string {
  return BAND_COLORS[id] ?? '#fff';
}
