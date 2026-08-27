/**
 * 应用入口：world 就绪前由 index.html 内联脚本先挂 window.__app 骨架，
 * 本模块随后生成世界、构建渲染、填充 __app 数据并启动循环与 F2.3 面板。
 */
import { assertDefaultTableValid, buildApp } from './apphook';
import type { __App } from './apphook';
import { generateWorld } from './worldgen';
import { Renderer } from './render/renderer';
import { renderMaterialPanel } from './ui';
import type { GraphicTier } from './types';

function boot(): void {
  try {
    bootInner();
  } catch (err) {
    // Code-m5：启动期异常不白屏；显示中文错误横幅，且 window.__app 骨架（index.html 已挂）仍可用。
    showBootError(err);
  }
}

function bootInner(): void {
  // 1. 材料方向性自检（违规则立即暴露）
  assertDefaultTableValid();

  // 2. 世界生成（默认种子，确定性）
  const seed = 0x20260001;
  let generated = generateWorld(seed);

  // 3. 渲染骨架
  const container = document.getElementById('app') as HTMLElement;
  const renderer = new Renderer(container);

  // 4. 帧率观测
  let frameCount = 0;
  let accMs = 0;
  let lastT = performance.now();

  // 5. __app（覆盖 index.html 内联骨架）
  const app: __App = buildApp(
    generated,
    (newEnv) => {
      generated = newEnv;
      renderer.rebuildWorld(generated.world.ids);
      renderer.addSourceMarkers(generated.soundSources, generated.spawn);
    },
    () => {
      renderMaterialPanel(app.state.materials);
    },
    (tier: GraphicTier) => {
      renderer.setTier(tier);
    },
    () => renderer.getPixelRatio(),
  );
  window.__app = app;

  // 6. 首帧世界快照 + 面板（与 state.materials 同源）
  renderer.rebuildWorld(generated.world.ids);
  renderer.addSourceMarkers(generated.soundSources, generated.spawn);
  renderMaterialPanel(app.state.materials);

  // 7. 帧循环与 perf 观测
  const onFrame = (): void => {
    const now = performance.now();
    const dt = now - lastT;
    lastT = now;
    frameCount += 1;
    accMs += dt;
    if (accMs >= 1000) {
      app.state.perf.fps = Math.round((frameCount * 1000) / accMs);
      app.state.perf.avgFrameMs = accMs / frameCount;
      frameCount = 0;
      accMs = 0;
    }
    app.state.perf.drawCalls = renderer.drawCalls;
    app.state.perf.instances = renderer.instances;
    app.state.perf.pixelRatio = renderer.getPixelRatio();
  };

  if (renderer.available) {
    renderer.start(onFrame);
  } else {
    showNoGlFallback();
    const tick = (): void => {
      onFrame();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', () => renderer.handleResize());
}

function showNoGlFallback(): void {
  const el = document.getElementById('nogl-msg');
  if (el) el.style.display = 'block';
}

/** 启动期异常的中文错误横幅（Code-m5）。 */
function showBootError(err: unknown): void {
  const el = document.getElementById('boot-error');
  if (!el) return;
  const msg = err instanceof Error ? err.message : String(err);
  el.textContent = '启动失败：' + msg + '。请刷新重试；window.__app 仍可读取世界与材料数据。';
  el.style.display = 'block';
  // 保证即使在极端错误下，调试句柄骨架依然存在（不覆盖 index.html 内联骨架）
  if (!window.__app) {
    window.__app = {
      state: { ready: false, perf: { fps: 0, avgFrameMs: 0, drawCalls: 0, instances: 0, pixelRatio: 0, lastBench: null } },
      reset: () => {},
      debug: {},
    } as unknown as __App;
  }
}

window.addEventListener('DOMContentLoaded', boot);
