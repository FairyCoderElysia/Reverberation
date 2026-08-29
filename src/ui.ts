/**
 * M10（最小子集）：材料参数面板 + 库存栏 + 合成面板 + 准星反馈（中文）。
 * 全部数据与 state 同源（材料面板读 effectiveMaterials，库存/配方读 state.inventory/selected），不写状态。
 */
import { MATERIAL_ZH } from './materials';
import { FACILITY_KIND_BY_ITEM, itemName } from './recipes';
import type { Recipe } from './recipes';
import { BAND_COLORS, BAND_ZH, FACILITY_COLORS, MATERIAL_COLORS } from './theme';
import type { MaterialSpec } from './types';
import type { MaterialName } from './types';

/** 库存/选中回流决策的纯函数（Mn5：把 onFrame 接线做成可测路径）。 */
export function inventorySignature(inventory: number[]): string {
  return inventory.join(',');
}

/** 返回 true 表示当前帧需要重绘库存栏（库存或选中变化）。 */
export function shouldRefreshInventory(
  invSig: string,
  lastInvSig: string,
  selected: number,
  lastSelected: number,
): boolean {
  return invSig !== lastInvSig || selected !== lastSelected;
}

/** S5：声场图例纯 HTML 构建（文本/色块均来自 BAND_ZH 与 BAND_COLORS 单源）。 */
export function soundLegendHtml(): string {
  return BAND_ZH.map(
    (name, i) =>
      `<span class="sound-legend-item"><i class="sound-legend-swatch" style="background:${BAND_COLORS[i] ?? '#fff'}"></i>${name}</span>`,
  ).join('');
}

/** S5：图例 DOM 与 state.soundView.legend 同步（legend=false 隐藏，true 显示）。 */
export function renderSoundLegend(legendVisible: boolean): void {
  const el = document.getElementById('sound-legend');
  if (!el) return;
  el.innerHTML = soundLegendHtml();
  el.style.display = legendVisible ? '' : 'none';
}

/** S5：声场视图 UI 按钮文本（与 state.soundView.visible 同源）。 */
export function renderSoundViewButton(visible: boolean): void {
  const el = document.getElementById('sound-view-toggle');
  if (!el) return;
  el.textContent = visible ? '声场视图：开（V）' : '声场视图：关（V）';
}

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
 * 渲染库存栏（SP2-06 / S3 物品扩展）：1-12 物品数量 + 当前选中高亮。
 * 与 state.inventory / state.selected 同源；点击回调切换选中（仅转发意图）。
 */
export function renderInventory(
  inventory: number[],
  selected: number,
  onSelect: (id: number) => void,
): void {
  const el = document.getElementById('inventory-bar');
  if (!el) return;
  const slots = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    .map((id) => {
      const zh = itemName(id);
      const n = inventory[id] ?? 0;
      const sel = id === selected ? 'slot-selected' : '';
      const keyHint = id <= 9 ? `（数字键 ${id}）` : '（点击选择）';
      return `<div class="slot ${sel}" data-id="${id}" title="${zh}${keyHint}"><span class="slot-count">${n}</span><span class="slot-name" style="--c:${colorFor(id)}">${zh}</span></div>`;
    })
    .join('');
  el.innerHTML = `<div class="inv-head">库存（1-9 热键 / 点击切换）</div><div class="inv-slots">${slots}</div>`;
  el.querySelectorAll<HTMLElement>('.slot').forEach((node) => {
    node.addEventListener('click', () => {
      const id = Number(node.getAttribute('data-id'));
      if (Number.isInteger(id) && id >= 1 && id <= 12) onSelect(id);
    });
  });
}

/** 渲染合成面板（F5）：显示 5 个配方与材料清单，点击合成按钮转发 craft 意图。 */
export function renderRecipes(
  recipes: readonly Recipe[],
  inventory: number[],
  onCraft: (recipeId: number) => void,
): void {
  const el = document.getElementById('recipe-panel');
  if (!el) return;
  const html = recipes
    .map((r) => {
      const ings = r.ingredients
        .map((ing) => {
          const enough = (inventory[ing.itemId] ?? 0) >= ing.qty;
          const cn = itemName(ing.itemId);
          return `<span class="ing ${enough ? '' : 'ing-missing'}">${cn}×${ing.qty}</span>`;
        })
        .join(' ');
      const outName = itemName(r.output.itemId);
      return `<div class="recipe"><div class="recipe-name">${r.name}<button class="craft-btn" data-recipe="${r.id}">合成</button></div><div class="recipe-ing">${ings} → ${outName}×${r.output.count}</div></div>`;
    })
    .join('');
  el.innerHTML = `<div class="panel-head">合成（F5 设施物品）</div>${html}`;
  el.querySelectorAll<HTMLButtonElement>('.craft-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-recipe'));
      if (Number.isInteger(id)) onCraft(id);
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

/** S6：渲染全局储能读数（与 state.coreEnergy 同源；UI 只读显示，不写状态）。 */
export function renderEnergyReadout(coreEnergy: number): void {
  const el = document.getElementById('energy-readout');
  if (!el) return;
  const display = Number.isFinite(coreEnergy) ? Math.max(0, coreEnergy).toFixed(2) : '0.00';
  if (el.textContent !== '全局储能：' + display) {
    el.textContent = '全局储能：' + display;
  }
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
  if (id >= 1 && id <= 7) return MATERIAL_COLORS[id - 1] ?? '#fff';
  const kind = FACILITY_KIND_BY_ITEM[id];
  return kind ? FACILITY_COLORS[kind] ?? '#fff' : '#fff';
}

function legColor(id: number): string {
  return BAND_COLORS[id] ?? '#fff';
}
