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

window.addEventListener('DOMContentLoaded', boot);
