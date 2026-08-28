/**
 * 应用入口：world 就绪前由 index.html 内联脚本先挂 window.__app 骨架；
 * 本模块生成世界（或载入存档）、构建渲染、绑定第一人称输入、填充 __app 并启动循环。
 */
import { assertDefaultTableValid, buildApp } from './apphook';
import type { __App } from './apphook';
import { generateWorld } from './worldgen';
import { Game } from './game';
import { Renderer } from './render/renderer';
import { renderInventory, renderMaterialPanel, renderMiningProgress, renderStatus } from './ui';
import { LOOK_SENSITIVITY } from './config';
import type { GraphicTier } from './types';

function boot(): void {
  try {
    bootInner();
  } catch (err) {
    showBootError(err);
  }
}

function bootInner(): void {
  // 1. 材料方向性自检（违规则立即暴露）
  assertDefaultTableValid();

  // 2. 世界生成（默认种子，确定性）——随后可能被 loadSave 覆盖
  const defaultSeed = 0x20260001;
  const generated = generateWorld(defaultSeed);

  // 3. 游戏运行时（单权威：世界 + 玩家 + 库存 + 存档）
  const game = new Game(generated);

  // 4. 启动自动载入唯一存档（SP2-09「继续」路径）
  game.loadSave();

  // 5. 渲染骨架
  const container = document.getElementById('app') as HTMLElement;
  const renderer = new Renderer(container);

  // 6. 帧率观测
  let frameCount = 0;
  let accMs = 0;
  let lastT = performance.now();

  // 7. __app（覆盖 index.html 内联骨架）
  const app: __App = buildApp(
    game,
    (g) => {
      renderer.rebuildWorld(g.world.ids);
      renderer.addSourceMarkers(g.soundSources, g.spawn);
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

  // 8. 首帧世界快照 + 面板
  renderer.rebuildWorld(game.world.ids);
  renderer.addSourceMarkers(game.soundSources, game.spawn);
  renderMaterialPanel(app.state.materials);

  // 库存栏点选回调（与热键同一状态入口：game.selected）
  function refreshInventory(): void {
    renderInventory(app.state.inventory, game.selected, selectHandler);
  }
  function selectHandler(id: number): void {
    game.selected = id;
    refreshInventory();
  }
  renderInventory(app.state.inventory, app.state.selected, selectHandler);

  // 载入结果的中文提示（损坏/版本不兼容可见、不白屏）
  renderStatus(game.uiNotice ?? game.saveError ?? game.loadNotice);

  // 9. 第一人称输入绑定
  bindInput(game, renderer, refreshInventory);

  // 10. 帧循环（物理固定步 + 视图 + UI 回流）
  let lastInvSig = game.inventory.join(',');
  let lastSelected = game.selected;
  const onFrame = (): void => {
    const now = performance.now();
    const dtMs = now - lastT;
    lastT = now;

    game.tickFrame(dtMs);
    renderer.setView(game.playerEye(), game.body.yaw, game.body.pitch);

    frameCount += 1;
    accMs += dtMs;
    if (accMs >= 1000) {
      app.state.perf.fps = Math.round((frameCount * 1000) / accMs);
      app.state.perf.avgFrameMs = accMs / frameCount;
      frameCount = 0;
      accMs = 0;
    }
    app.state.perf.drawCalls = renderer.drawCalls;
    app.state.perf.instances = renderer.instances;
    app.state.perf.pixelRatio = renderer.getPixelRatio();

    renderMiningProgress(game.miningProgress);
    // UI 与 state 恒一致（SP2-06）：库存/选中任一变化后同帧重绘库存栏
    const invSig = game.inventory.join(',');
    if (invSig !== lastInvSig || game.selected !== lastSelected) {
      lastInvSig = invSig;
      lastSelected = game.selected;
      refreshInventory();
    }
    renderStatus(game.uiNotice ?? game.saveError ?? game.loadNotice);
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

/** 键盘 + 鼠标输入绑定。视角：右键拖动 / 指针锁移动；挖掘：按住左键；放置：右键点击。 */
function bindInput(game: Game, renderer: Renderer, onSelectionChange: () => void): void {
  const keys = new Set<string>();
  const syncKeys = (): void => {
    game.input.forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    game.input.right = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    game.input.jump = keys.has('Space');
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.preventDefault();
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 7) {
        game.selected = n;
        onSelectionChange();
      }
    }
    keys.add(e.code);
    syncKeys();
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    syncKeys();
  });
  window.addEventListener('blur', () => {
    keys.clear();
    syncKeys();
  });

  const canvas = renderer.domElement;
  let pointerLocked = false;
  let rightDragging = false;
  let rightMoved = 0;
  let lastX = 0;
  let lastY = 0;
  const DRAG_PLACE_THRESHOLD = 4; // px：右键位移小于此视为「点击放置」

  const rotate = (dx: number, dy: number): void => {
    game.body.yaw -= dx * LOOK_SENSITIVITY;
    game.body.pitch = clampPitch(game.body.pitch - dy * LOOK_SENSITIVITY);
  };

  if (canvas) {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        game.mineHeld = true;
      } else if (e.button === 2) {
        rightDragging = true;
        rightMoved = 0;
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('click', () => {
      if (!pointerLocked && document.pointerLockElement !== canvas) {
        try {
          canvas.requestPointerLock();
        } catch {
          /* ignore：拒绝/失败则继续用右键拖动 */
        }
      }
    });
  } else {
    // 无 WebGL 降级：只保留键盘
    syncKeys();
  }

  window.addEventListener('pointermove', (e) => {
    if (pointerLocked) {
      rotate(e.movementX, e.movementY);
    } else if (rightDragging) {
      rotate(e.clientX - lastX, e.clientY - lastY);
      rightMoved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (e.button === 0) {
      game.mineHeld = false;
      game.cancelMining();
    } else if (e.button === 2) {
      if (rightDragging && rightMoved <= DRAG_PLACE_THRESHOLD) {
        game.placePressed = true;
      }
      rightDragging = false;
      rightMoved = 0;
    }
  });
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = !!canvas && document.pointerLockElement === canvas;
    rightDragging = false;
    rightMoved = 0;
    game.mineHeld = false;
  });
  document.addEventListener('pointerlockerror', () => {
    pointerLocked = false;
  });
}

function clampPitch(p: number): number {
  const max = Math.PI * 0.49;
  if (p > max) return max;
  if (p < -max) return -max;
  return p;
}

function showNoGlFallback(): void {
  const el = document.getElementById('nogl-msg');
  if (el) el.style.display = 'block';
}

/** 启动期异常的中文错误横幅（Code-m5 + Code N3：文案不承诺不存在的字段）。 */
function showBootError(err: unknown): void {
  const el = document.getElementById('boot-error');
  if (!el) return;
  const msg = err instanceof Error ? err.message : String(err);
  el.textContent =
    '启动失败：' + msg + '。请刷新重试；如需诊断，可读取 window.__app.state（初始化为未就绪骨架）。';
  el.style.display = 'block';
  if (!window.__app) {
    window.__app = {
      state: { ready: false, perf: { fps: 0, avgFrameMs: 0, drawCalls: 0, instances: 0, pixelRatio: 0, lastBench: null } },
      reset: () => {},
      debug: {},
    } as unknown as __App;
  }
}

window.addEventListener('DOMContentLoaded', boot);
