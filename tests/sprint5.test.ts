/**
 * Sprint 5 单测：声场视图 + 性能档。
 * 覆盖 contract SP5-01..SP5-09 中可离线数值断言的部分。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Game, memoryStorage } from '../src/game';
import { World } from '../src/world';
import { buildApp } from '../src/apphook';
import { BAND_COLORS } from '../src/theme';
import { sampleSoundView, soundViewStepForTier } from '../src/visualization';
import { renderSoundLegend, soundLegendHtml } from '../src/ui';
import { SOUND_VIEW_SAMPLE_STEP_HIGH, SOUND_VIEW_SAMPLE_STEP_LOW } from '../src/config';
import type { XYZA } from '../src/types';

function makeApp() {
  const world = new World();
  const spawn: XYZA = [32, 14, 32];
  const game = new Game(
    { world, seed: 1, spawn, soundSources: [] },
    { storage: memoryStorage(), now: () => 1000 },
  );
  let pixelRatio = 2; // 模拟 high 档
  const app = buildApp(
    game,
    () => {},
    () => {},
    (t) => {
      pixelRatio = t === 'low' ? 0.75 : 2;
    },
    () => pixelRatio,
  );
  return { app, game };
}

describe('SP5 声场视图：visible/legend/version 状态', () => {
  it('默认 visible/legend=true；setSoundView(false) 只改显示状态，不重算、不写档', () => {
    const { app } = makeApp();
    const v0 = app.state.energyField.version;
    const savedAt0 = app.state.lastSavedAt;
    expect(app.state.soundView.visible).toBe(true);
    expect(app.state.soundView.legend).toBe(true);
    expect(app.state.soundView.version).toBe(v0);

    app.debug.setSoundView(false);
    expect(app.state.soundView.visible).toBe(false);
    expect(app.state.soundView.legend).toBe(false);
    expect(app.state.soundView.version).toBe(v0);
    expect(app.state.energyField.version).toBe(v0);
    expect(app.state.lastSavedAt).toBe(savedAt0);
  });

  it('每次能量场重算都使 soundView.version 同步递增', () => {
    const { app } = makeApp();
    const v0 = app.state.soundView.version;
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    expect(app.state.soundView.version).toBe(app.state.energyField.version);
    expect(app.state.soundView.version).toBeGreaterThan(v0);
    app.debug.recalcAcoustics();
    expect(app.state.soundView.version).toBe(app.state.energyField.version);
  });

  it('切换视角不改变 soundView.visible 与能量读数', () => {
    const { app } = makeApp();
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const s = app.state.energyField.sample([34, 12, 32]);
    app.debug.setSoundView(false);
    app.debug.setViewMode('orbit');
    expect(app.state.player.viewMode).toBe('orbit');
    expect(app.state.soundView.visible).toBe(false);
    expect(app.state.energyField.sample([34, 12, 32])).toEqual(s);
    app.debug.setViewMode('first');
    expect(app.state.player.viewMode).toBe('first');
    expect(app.state.soundView.visible).toBe(false);
  });
});

describe('SP5 图例：DOM 文本/色块与 BAND_COLORS 单源一致', () => {
  const html = soundLegendHtml();
  it('HTML 包含低/中/高频文本与三个色块颜色', () => {
    expect(html).toContain('低频');
    expect(html).toContain('中频');
    expect(html).toContain('高频');
    for (const color of BAND_COLORS) {
      expect(html).toContain(color);
    }
    expect(html.split('sound-legend-item').length - 1).toBe(3);
  });

  it('renderSoundLegend 同步图例 DOM 可见性', () => {
    const el: HTMLElement = {
      innerHTML: '',
      style: { display: '' },
    } as unknown as HTMLElement;
    const originalDoc = globalThis.document;
    globalThis.document = {
      getElementById: (id: string) => (id === 'sound-legend' ? el : null),
    } as unknown as Document;
    try {
      renderSoundLegend(true);
      expect(el.innerHTML).toContain('低频');
      expect(el.style.display).not.toBe('none');
      renderSoundLegend(false);
      expect(el.style.display).toBe('none');
    } finally {
      globalThis.document = originalDoc;
    }
  });
});

describe('SP5 可视化与数值同源', () => {
  it('sampleSoundView 计数和颜色均来自 sample；关闭可视化不改变 sample', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const before = app.state.energyField.sample([34, 12, 32]);
    const step = soundViewStepForTier('high');
    const sample = sampleSoundView(app.state.energyField, game.world, step);
    expect(sample.count).toBeGreaterThan(0);
    expect(sample.positions.length).toBe(sample.count * 3);
    expect(sample.colors.length).toBe(sample.count * 3);

    app.debug.setSoundView(false);
    expect(app.state.energyField.sample([34, 12, 32])).toEqual(before);
  });

  it('low 档采样密度使视觉点数严格低于 high 档', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const high = sampleSoundView(app.state.energyField, game.world, SOUND_VIEW_SAMPLE_STEP_HIGH);
    const low = sampleSoundView(app.state.energyField, game.world, SOUND_VIEW_SAMPLE_STEP_LOW);
    expect(low.count).toBeLessThan(high.count);
  });
});

describe('SP5 性能档', () => {
  it('state.graphicTier/soundView.tier 与 setGraphicTier 同步，low 指标严格低于 high', () => {
    const { app } = makeApp();
    expect(app.state.graphicTier).toBe('high');
    expect(app.state.soundView.tier).toBe('high');

    const high = {
      rayCount: app.state.sim.rayCount,
      bounceCount: app.state.sim.bounceCount,
      pixelRatio: app.state.perf.pixelRatio,
      physicsHz: app.state.sim.physicsHz,
    };
    expect(high.rayCount).toBe(128);
    expect(high.bounceCount).toBe(3);
    expect(high.physicsHz).toBe(15);

    app.debug.setGraphicTier('low');
    const low = {
      rayCount: app.state.sim.rayCount,
      bounceCount: app.state.sim.bounceCount,
      pixelRatio: app.state.perf.pixelRatio,
      physicsHz: app.state.sim.physicsHz,
    };
    expect(app.state.graphicTier).toBe('low');
    expect(app.state.soundView.tier).toBe('low');
    expect(low.rayCount).toBeLessThan(high.rayCount);
    expect(low.bounceCount).toBeLessThan(high.bounceCount);
    expect(low.pixelRatio).toBeLessThan(high.pixelRatio);
    expect(low.physicsHz).toBeLessThan(high.physicsHz!);

    app.debug.setGraphicTier('high');
    expect(app.state.graphicTier).toBe('high');
    expect(app.state.soundView.tier).toBe('high');
    expect(app.state.sim.rayCount).toBe(128);
  });

  it('sim.version=energyField.version，lastRecalcDurationMs 有限，reason 为规定枚举', () => {
    const { app } = makeApp();
    expect(app.state.sim.version).toBe(app.state.energyField.version);
    expect(Number.isFinite(app.state.sim.lastRecalcDurationMs)).toBe(true);
    expect(['initial', 'world', 'source', 'tuning', 'manual']).toContain(app.state.sim.lastRecalcReason);
    app.debug.clearSources();
    expect(app.state.sim.lastRecalcReason).toBe('source');
    app.debug.setTuning({ G_DIST_EXP: 1.5 });
    expect(app.state.sim.lastRecalcReason).toBe('tuning');
    app.debug.recalcAcoustics();
    expect(app.state.sim.lastRecalcReason).toBe('manual');
    expect(app.state.sim.lastRecalcDurationMs).toBe(0);
  });

  it('低档仍保持方向性结论（泡沫/混凝土墙方向）', () => {
    const { app, game } = makeApp();
    app.debug.setGraphicTier('low');
    // 泡沫墙（id=1）：高频穿透显著低于低频
    app.debug.clearSources();
    game.world.setBlock([35, 12, 32], 1, 30);
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const foam = app.state.energyField.sample([36, 12, 32]);
    expect(foam[2]).toBeLessThan(0.8 * foam[0]);

    // 混凝土墙（id=5）：低频穿透显著低于高频
    app.debug.clearSources();
    game.world.setBlock([35, 12, 32], 5, 150);
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const concrete = app.state.energyField.sample([36, 12, 32]);
    expect(concrete[0]).toBeLessThan(0.8 * concrete[2]);
  });

  it('开关声场视图不写档/不触发网络', () => {
    const { app } = makeApp();
    const saved = app.state.lastSavedAt;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response()));
    try {
      app.debug.setSoundView(false);
      app.debug.setSoundView(true);
      expect(app.state.lastSavedAt).toBe(saved);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
