/**
 * M10（最小子集）：材料参数面板 + 库存栏 + 准星反馈（中文）。
 * 全部数据与 state 同源（材料面板读 effectiveMaterials，库存栏读 state.inventory/selected），不写状态。
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

/**
 * 渲染库存栏（SP2-06）：各材料数量 + 当前选中高亮。
 * 与 state.inventory / state.selected 同源；点击回调切换选中（仅转发意图）。
 */
export function renderInventory(
  inventory: number[],
  selected: number,
  onSelect: (id: number) => void,
): void {
  const el = document.getElementById('inventory-bar');
  if (!el) return;
  const names = Object.keys(MATERIAL_ZH) as MaterialName[];
  const slots = [1, 2, 3, 4, 5, 6, 7]
    .map((id) => {
      const zh = MATERIAL_ZH[names[id - 1]];
      const n = inventory[id] ?? 0;
      const sel = id === selected ? 'slot-selected' : '';
      return `<div class="slot ${sel}" data-id="${id}" title="${zh}（数字键 ${id}）"><span class="slot-count">${n}</span><span class="slot-name" style="--c:${colorFor(id)}">${zh}</span></div>`;
    })
    .join('');
  el.innerHTML = `<div class="inv-head">库存（1-7 选择 / 点击切换）</div><div class="inv-slots">${slots}</div>`;
  el.querySelectorAll<HTMLElement>('.slot').forEach((node) => {
    node.addEventListener('click', () => {
      const id = Number(node.getAttribute('data-id'));
      if (Number.isInteger(id) && id >= 1 && id <= 7) onSelect(id);
    });
  });
}

/** 渲染挖掘进度条（0..1；0 时隐藏）。 */
export function renderMiningProgress(progress: number): void {
  const el = document.getElementById('mining-bar');
  if (!el) return;
  if (progress <= 0) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  const pct = Math.round(Math.min(1, progress) * 100);
  const fill = document.getElementById('mining-fill');
  if (fill) fill.style.width = pct + '%';
}

/** 渲染状态行（存档错误 / 载入提示等中文可见提示）。 */
export function renderStatus(message: string | null): void {
  const el = document.getElementById('status-line');
  if (!el) return;
  if (!message) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'block';
  el.textContent = message;
}

function colorFor(id: number): string {
  return MATERIAL_COLORS[id - 1] ?? '#fff';
}

function legColor(id: number): string {
  return BAND_COLORS[id] ?? '#fff';
}
