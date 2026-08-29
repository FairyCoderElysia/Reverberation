/**
 * 应用入口：world 就绪前由 index.html 内联脚本先挂 window.__app 骨架；
 * 本模块生成世界（或载入存档）、构建渲染、绑定第一人称输入、填充 __app 并启动循环。
 */
import { assertDefaultTableValid, buildApp } from './apphook';
import type { __App } from './apphook';
import { generateWorld } from './worldgen';
import { Game } from './game';
import { applyLook } from './player';
import { Renderer } from './render/renderer';
import { inventorySignature, renderEnergyReadout, renderInventory, renderMaterialPanel, renderMiningProgress, renderRecipes, renderSoundLegend, renderSoundViewButton, renderStatus, shouldRefreshInventory } from './ui';
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
  let lastWorldRev = game.world.revision;
  const app: __App = buildApp(
    game,
    (g) => {
      renderer.rebuildWorld(g.world.ids, g.world.facilityList(), g.soundSources, g.spawn);
      lastWorldRev = g.world.revision;
    },
    () => {
      renderMaterialPanel(app.state.materials);
    },
    (tier: GraphicTier) => {
      renderer.setTier(tier);
    },
    () => renderer.getPixelRatio(),
    (visible: boolean) => {
      renderSoundLegend(visible);
      renderSoundViewButton(visible);
    },
  );
  window.__app = app;

  // 8. 首帧世界快照 + 面板
  renderer.rebuildWorld(game.world.ids, game.world.facilityList(), game.soundSources, game.spawn);
  renderMaterialPanel(app.state.materials);
  renderSoundLegend(app.state.soundView.legend);
  renderSoundViewButton(app.state.soundView.visible);
  lastWorldRev = game.world.revision;

  // 库存栏点选回调（与热键同一状态入口：game.selected）
  function refreshInventory(): void {
    renderInventory(app.state.inventory, game.selected, selectHandler);
  }
  function selectHandler(id: number): void {
    // 只改 selected；onFrame 下一帧统一检测并刷新库存栏（Mn2：点击与数字键一样避免重复回流）
    game.selected = id;
  }
  renderInventory(app.state.inventory, app.state.selected, selectHandler);
  renderRecipes(app.state.recipes, game.inventory, (recipeId) => {
    game.craft(recipeId);
  });

  // 载入结果的中文提示（损坏/版本不兼容可见、不白屏）；优先级同样是存档异常优先
  renderStatus(game.saveError ?? game.loadNotice ?? game.uiNotice);
  renderEnergyReadout(game.coreEnergy);

  // 9. 第一人称输入绑定
  bindInput(game, renderer);

  // 10. 帧循环（物理固定步 + 视图 + UI 回流）
  let lastInvSig = inventorySignature(game.inventory);
  let lastSelected = game.selected;
  let lastSoundViewVisible = game.soundViewVisible;
  const onFrame = (): void => {
    const now = performance.now();
    const dtMs = now - lastT;
    lastT = now;

    game.tickFrame(dtMs);
    // 用户实测热修：世界内容在运行时被放置/挖掘等修改后，下一帧立即重建 3D 场景。
    if (game.world.revision !== lastWorldRev) {
      lastWorldRev = game.world.revision;
      renderer.rebuildWorld(game.world.ids, game.world.facilityList(), game.soundSources, game.spawn);
    }
    if (game.viewMode === 'orbit') {
      renderer.setOrbitView(game.orbit);
    } else {
      renderer.setView(game.playerEye(), game.body.yaw, game.body.pitch);
    }
    // S5：声场视图（只读同源采样；能量场/世界不受可视化开关影响）
    renderer.updateSoundView(app.state.energyField, game.world, game.soundViewVisible, app.state.soundView.version);

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
    app.state.perf.visualInstances = renderer.visualInstances;
    app.state.perf.pixelRatio = renderer.getPixelRatio();
    if (game.soundViewVisible !== lastSoundViewVisible) {
      lastSoundViewVisible = game.soundViewVisible;
      renderSoundLegend(app.state.soundView.legend);
      renderSoundViewButton(app.state.soundView.visible);
    }

    renderMiningProgress(game.miningProgress);
    // UI 与 state 恒一致（SP2-06）：库存/选中任一变化后同帧重绘库存栏。
    // 数字键只改 selected，由 onFrame 统一回流（Mn2：避免同一事件重复整栏重建）。
    const invSig = inventorySignature(game.inventory);
    if (shouldRefreshInventory(invSig, lastInvSig, game.selected, lastSelected)) {
      lastInvSig = invSig;
      lastSelected = game.selected;
      refreshInventory();
      renderRecipes(app.state.recipes, game.inventory, (recipeId) => {
        game.craft(recipeId);
      });
    }
    renderEnergyReadout(game.coreEnergy);
    // 优先级：存档/载入异常 > 交互提示，避免 uiNotice 长期遮蔽 saveError/loadNotice（QA Mn4）
    renderStatus(game.saveError ?? game.loadNotice ?? game.uiNotice);
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

  // 页面关闭/隐藏兜底（用户实测第二批 B）：移动节流可能在关闭前尚未到周期，
  // 刷新/关闭/切后台时强制写一次档，保证“仅移动后刷新位置保留”。
  window.addEventListener('pagehide', () => game.flushSaveForPageHide());
  window.addEventListener('beforeunload', () => game.flushSaveForPageHide());
  window.addEventListener('visibilitychange', () => {
    // 只在隐藏时写一次，避免每个 visibilitychange 都触发；pagehide/beforeunload 仍作主要兜底。
    if (document.visibilityState === 'hidden') game.flushSaveForPageHide();
  });
}

/** 同步声场视图图例/按钮 DOM（debug.setSoundView / 热键 / 重置后立即调用）。 */
function syncSoundViewUi(game: Game): void {
  renderSoundLegend(game.soundViewVisible);
  renderSoundViewButton(game.soundViewVisible);
}

/** 键盘 + 鼠标输入绑定。视角：右键拖动 / 指针锁移动；挖掘：按住左键；放置：右键点击。 */
function bindInput(game: Game, renderer: Renderer): void {
  const keys = new Set<string>();
  const syncKeys = (): void => {
    game.input.forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    game.input.right = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    game.input.jump = keys.has('Space');
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      // 非 repeat 的 keydown 记录跳跃缓冲；keyup 只清除 held，不影响已入缓冲的边沿。
      if (!e.repeat) game.pressJump();
    }
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 9) {
        // S3：1-9 热键选物品；10-12 走库存槽点击（contract UI 约定）
        game.selected = n;
      }
    }
    if (e.code === 'KeyC') {
      if (!e.repeat) game.toggleViewMode();
    }
    if (e.code === 'KeyR') {
      if (!e.repeat) game.rotateLookedFacility();
    }
    if (e.code === 'KeyV') {
      if (!e.repeat) {
        game.setSoundView(!game.soundViewVisible);
        syncSoundViewUi(game);
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
  let orbitRotating = false;
  let orbitPanning = false;
  const DRAG_PLACE_THRESHOLD = 4; // px：右键位移小于此视为「点击放置」

  const rotate = (dx: number, dy: number): void => {
    applyLook(game.body, dx, dy, LOOK_SENSITIVITY);
  };

  if (canvas) {
    canvas.addEventListener('pointerdown', (e) => {
      if (game.viewMode === 'orbit') {
        if (e.button === 0) {
          orbitRotating = true;
          lastX = e.clientX;
          lastY = e.clientY;
        } else if (e.button === 2) {
          orbitPanning = true;
          lastX = e.clientX;
          lastY = e.clientY;
        }
        return;
      }
      if (e.button === 0) {
        game.mineHeld = true;
      } else if (e.button === 2) {
        rightDragging = true;
        rightMoved = 0;
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });
    canvas.addEventListener('wheel', (e) => {
      if (game.viewMode !== 'orbit') return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 3 : e.deltaY < 0 ? -3 : 0;
      game.setOrbit({ distance: game.orbit.distance + delta });
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('click', () => {
      if (!pointerLocked && document.pointerLockElement !== canvas && game.viewMode === 'first') {
        try {
          canvas.requestPointerLock();
        } catch {
          /* ignore：拒绝/失败则继续用右键拖动 */
        }
      }
    });
  } else {
    // 无 WebGL 降级：仍保留键盘与声场视图按钮绑定（状态可通过 __app 同步）。
    syncKeys();
  }

  // 视角/声场按钮不依赖画布：无 WebGL 降级时也必须可绑定，避免 UI 死按钮。
  const viewBtn = document.getElementById('view-toggle');
  if (viewBtn) {
    viewBtn.addEventListener('click', () => {
      game.toggleViewMode();
    });
  }
  const soundViewBtn = document.getElementById('sound-view-toggle');
  if (soundViewBtn) {
    soundViewBtn.addEventListener('click', () => {
      game.setSoundView(!game.soundViewVisible);
      syncSoundViewUi(game);
    });
  }

  window.addEventListener('pointermove', (e) => {
    if (orbitRotating || orbitPanning) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (orbitRotating) {
        game.setOrbit({
          yaw: game.orbit.yaw - dx * LOOK_SENSITIVITY,
          pitch: game.orbit.pitch - dy * LOOK_SENSITIVITY,
        });
      } else if (orbitPanning) {
        const theta = game.orbit.yaw;
        const fx = -Math.sin(theta);
        const fz = -Math.cos(theta);
        const rx = Math.cos(theta);
        const rz = -Math.sin(theta);
        const scale = 0.08;
        game.setOrbit({
          target: [
            game.orbit.target[0] - rx * dx * scale + fx * dy * scale,
            game.orbit.target[1],
            game.orbit.target[2] - rz * dx * scale + fz * dy * scale,
          ],
        });
      }
      return;
    }
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
    if (orbitRotating || orbitPanning) {
      if (e.button === 0) orbitRotating = false;
      if (e.button === 2) orbitPanning = false;
      return;
    }
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
    orbitRotating = false;
    orbitPanning = false;
    game.mineHeld = false;
  });
  document.addEventListener('pointerlockerror', () => {
    pointerLocked = false;
  });
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
      state: { ready: false, perf: { fps: 0, avgFrameMs: 0, drawCalls: 0, instances: 0, visualInstances: 0, pixelRatio: 0, lastBench: null } },
      reset: () => {},
      debug: {},
    } as unknown as __App;
  }
}

window.addEventListener('DOMContentLoaded', boot);
