/**
 * Sprint 2 单测（SP2-12 最小断言 + 关键语义）：
 * 挖掘前后差、放置/拆除返还、碰撞确定性、存档回环、reset 换种子/立即覆盖、
 * teleport/giveItem 输入校验、placed 单一来源、interactionReach。
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/apphook';
import { generateWorld } from '../src/worldgen';
import { Game, memoryStorage } from '../src/game';
import { stepPlayer } from '../src/player';
import type { PlayerBody } from '../src/player';
import { renderInventory, shouldRefreshInventory } from '../src/ui';
import { AUTOSAVE_MOVE_INTERVAL_MS, JUMP_BUFFER_MS } from '../src/config';

const SEED = 0x20260001;

function makeGame(seed = SEED) {
  return new Game(generateWorld(seed), { storage: memoryStorage(), now: () => 1000 });
}

function makeApp(seed = SEED) {
  const game = makeGame(seed);
  const app = buildApp(game, () => {}, () => {}, () => {}, () => 2);
  return { app, game };
}

/** 在 y=14 高处放置一面天然墙，并把玩家传送到墙前 2 格、平视朝向墙（-Z）。 */
function setupWall(game: Game): [number, number, number] {
  const wx = 32;
  const wz = 32;
  game.world.setBlock([wx, 15, wz], 4, 120, false); // 天然石材墙（眼高位 y=15）
  game.selected = 1;
  game.teleport([wx + 0.5, 14, wz + 2.5]); // 脚底在 z=34.5 格中心（AABB 不跨入放置格 33）
  game.body.yaw = 0; // lookDir = (0,0,-1)
  game.body.pitch = 0;
  return [wx, 14, wz];
}

/**
 * 在 y=12 造一片高出地形的平坦支撑面，并把玩家传送到脚底 y=13（支撑面顶面）：
 * 用于确定性测试“微缝隙落地吸附 / 连续跳跃 / 移动自动存档”。
 */
function makeFlatPlatformGame(storage = memoryStorage(), now = () => 1000): Game {
  const game = new Game(generateWorld(SEED), { storage, now });
  for (let z = 8; z <= 48; z++) {
    for (let x = 28; x <= 36; x++) {
      game.world.setBlock([x, 12, z], 4, 120, false); // 石材平台，顶面 y=13
    }
  }
  game.teleport([32.5, 13, 32.5]);
  return game;
}

describe('Sprint 2 挖掘 / 放置 / 拆除', () => {
  it('SP2-02 挖掘前后差：天然方块移除、库存 +1、placed 不变', () => {
    const { game } = makeApp();
    // 找一个天然方块
    const ids = game.world.ids;
    let cell: [number, number, number] | null = null;
    let mat = 0;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== 0 && game.world.placed[i] === 0) {
        const x = i % 64;
        const z = Math.floor(i / 64) % 64;
        const y = Math.floor(i / (64 * 64));
        cell = [x, y, z];
        mat = ids[i];
        break;
      }
    }
    expect(cell).not.toBeNull();
    const before = game.inventory[mat];
    const placedBefore = game.world.countPlacedBlocks();
    game.applyBreak(cell!, mat, false);
    expect(game.world.blockAt(cell!).material).toBe(0);
    expect(game.world.blockAt(cell!).placed).toBe(false);
    expect(game.inventory[mat]).toBe(before + 1);
    expect(game.world.countPlacedBlocks()).toBe(placedBefore);
  });

  it('SP2-04 放置：库存 -1、方块 +1、placed===true、placedBlocks 单一来源', () => {
    const { app, game } = makeApp();
    setupWall(game);
    game.giveItem(1, 5);
    const r = game.tryPlaceSelected();
    expect(r.ok).toBe(true);
    expect(game.world.blockAt([32, 15, 33]).material).toBe(1);
    expect(game.world.blockAt([32, 15, 33]).placed).toBe(true);
    expect(game.inventory[1]).toBe(4);
    expect(app.state.placedBlocks).toBe(1);
    expect(game.world.countPlacedBlocks()).toBe(1);
  });

  it('SP2-04 库存恰为 1 时放置后归 0；库存不足失败', () => {
    const { game } = makeApp();
    setupWall(game);
    game.giveItem(2, 1);
    game.selected = 2;
    expect(game.tryPlaceSelected().ok).toBe(true);
    expect(game.inventory[2]).toBe(0);
    // 再放一次应失败（库存 0）
    const r2 = game.tryPlaceSelected();
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('库存不足');
  });

  it('SP2-03 拆除放置方块：全额返还（前后差 = 1 材料单位）', () => {
    const { game } = makeApp();
    setupWall(game);
    game.giveItem(3, 5);
    game.selected = 3;
    expect(game.tryPlaceSelected().ok).toBe(true);
    const invAfterPlace = game.inventory[3];
    game.applyBreak([32, 15, 33], 3, true);
    expect(game.world.blockAt([32, 15, 33]).material).toBe(0);
    expect(game.inventory[3]).toBe(invAfterPlace + 1);
    expect(game.world.countPlacedBlocks()).toBe(0);
  });

  it('SP2-05 interactionReach 默认 6，视线命中在距离上限内', () => {
    const { app, game } = makeApp();
    expect(app.state.interactionReach).toBe(6);
    setupWall(game);
    const hit = game.pickLook();
    expect(hit).not.toBeNull();
    expect(hit!.dist).toBeLessThanOrEqual(6);
  });
});

describe('Sprint 2 碰撞与确定性', () => {
  it('SP2-12 相同输入序列 → 相同 position（固定步 stepPlayer）', () => {
    const world = generateWorld(SEED).world;
    const spawn = generateWorld(SEED).spawn;
    const makeBody = (): PlayerBody => ({
      pos: [spawn[0] + 0.5, spawn[1], spawn[2] + 0.5],
      vel: [0, 0, 0],
      yaw: 0.7,
      pitch: 0,
      grounded: false,
    });
    const seq = [
      { forward: 1, right: 0, jump: false },
      { forward: 0, right: 1, jump: false },
      { forward: 1, right: 0, jump: true },
      { forward: 0, right: 0, jump: false },
      { forward: -1, right: -1, jump: false },
    ];
    const run = (): [number, number, number][] => {
      const b = makeBody();
      const trace: [number, number, number][] = [];
      for (let tick = 0; tick < 120; tick++) {
        const inp = seq[tick % seq.length];
        stepPlayer(b, inp, 1 / 60, world);
        trace.push([b.pos[0], b.pos[1], b.pos[2]]);
      }
      return trace;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });
});

describe('Sprint 2 存档回环', () => {
  it('SP2-07/12 saveNow → loadSave 后 ids/placed/库存/位置/种子逐字段相等', () => {
    const storage = memoryStorage();
    const g1 = new Game(generateWorld(SEED), { storage, now: () => 1111 });
    g1.giveItem(2, 7);
    g1.giveItem(5, 3);
    setupWall(g1);
    g1.giveItem(1, 2);
    g1.selected = 1;
    expect(g1.tryPlaceSelected().ok).toBe(true); // 在 [32,15,33] 放泡沫
    g1.teleport([40.5, 10, 40.5]);
    const posBefore = g1.playerPos.slice();
    g1.writeSave();
    expect(g1.lastSavedAt).toBe(1111);

    // 用「不同 seed」的全新 Game 载入同一存档，应恢复为 g1 的世界
    const g2 = new Game(generateWorld(999), { storage, now: () => 2222 });
    const res = g2.loadSave();
    expect(res).toBe('loaded');
    expect(g2.seed).toBe(g1.seed);
    expect(Array.from(g2.world.ids)).toEqual(Array.from(g1.world.ids));
    expect(Array.from(g2.world.placed)).toEqual(Array.from(g1.world.placed));
    expect(g2.inventory).toEqual(g1.inventory);
    expect(g2.selected).toBe(g1.selected);
    expect(g2.playerPos).toEqual(posBefore);

    // SP2-07/12：durability 逐格恢复——每个非空气格 durability === 有效材料表耐久，空气格 = 0
    const specs = g2.materialSpecs();
    const ids2 = g2.world.ids;
    const dur2 = g2.world.durability;
    for (let i = 0; i < ids2.length; i++) {
      const id = ids2[i];
      if (id !== 0) {
        expect(dur2[i]).toBe(specs[id - 1].durability);
      } else {
        expect(dur2[i]).toBe(0);
      }
    }
  });

  it('SP2-08 自动保存：放置后 lastSavedAt 更新（不调用 saveNow）', () => {
    const nowRef = { t: 5000 };
    const game = new Game(generateWorld(SEED), { storage: memoryStorage(), now: () => nowRef.t });
    setupWall(game);
    game.giveItem(1, 2);
    const before = game.lastSavedAt;
    nowRef.t = 9000;
    expect(game.tryPlaceSelected().ok).toBe(true);
    expect(game.lastSavedAt).toBeGreaterThan(before);
    expect(typeof game.lastSavedAt).toBe('number');
  });

  it('SP2-09 reset 换种子 + 立即覆盖存档；clearSave 只删键不动运行态', () => {
    const storage = memoryStorage();
    const game = new Game(generateWorld(SEED), { storage, now: () => 777 });
    const seedBefore = game.seed;
    game.giveItem(4, 5);
    game.reset();
    expect(game.seed).not.toBe(seedBefore);
    expect(storage.getItem('voice.save.v1')).not.toBeNull(); // reset 立即写档
    const invAfterReset = game.inventory.slice();
    const posAfterReset = game.playerPos.slice();
    const idsAfter = Array.from(game.world.ids);

    game.clearSave();
    expect(storage.getItem('voice.save.v1')).toBeNull();
    // 运行态不变
    expect(game.playerPos).toEqual(posAfterReset);
    expect(game.inventory).toEqual(invAfterReset);
    expect(Array.from(game.world.ids)).toEqual(idsAfter);
  });

  it('损坏/版本不兼容存档 → loadSave 返回 invalid 且不抛错、可继续新游戏', () => {
    const storage = memoryStorage();
    storage.setItem('voice.save.v1', '{"version":99,"seed":1}');
    const game = new Game(generateWorld(SEED), { storage });
    const res = game.loadSave();
    expect(res).toBe('invalid');
    expect(game.loadNotice).toMatch(/版本不兼容/);
    expect(game.world.ids.length).toBe(98304); // 仍是完整世界（不白屏）
    // 可继续 reset
    expect(() => game.reset()).not.toThrow();
  });
});

describe('Sprint 2 调试钩子输入校验', () => {
  it('giveItem 非法 id/n 抛中文可读错误', () => {
    const { app } = makeApp();
    expect(() => app.debug.giveItem(0, 3)).toThrow(/id 非法/);
    expect(() => app.debug.giveItem(8, 3)).toThrow(/id 非法/);
    expect(() => app.debug.giveItem(1, Number.NaN)).toThrow(/有限数/);
  });

  it('teleport 校验/夹取：非法输入抛错，合法坐标可读变化', () => {
    const { app, game } = makeApp();
    expect(() => app.debug.teleport([1, 2] as unknown as [number, number, number])).toThrow();
    app.debug.teleport([40.5, 10.5, 40.5]);
    expect(app.state.player.pos[0]).toBeCloseTo(40.5);
    expect(app.state.player.pos[2]).toBeCloseTo(40.5);
    expect(game.body.vel).toEqual([0, 0, 0]);
  });

  it('state.blockAt(g).placed 与 state.placedBlocks 同源', () => {
    const { app, game } = makeApp();
    setupWall(game);
    game.giveItem(1, 1);
    expect(game.tryPlaceSelected().ok).toBe(true);
    expect(app.state.blockAt([32, 15, 33]).placed).toBe(true);
    expect(app.state.blockAt([32, 16, 33]).placed).toBe(false);
    expect(app.state.placedBlocks).toBe(game.world.countPlacedBlocks());
  });
});

describe('Sprint 2 放置/恢复耐久统一取有效材料表', () => {
  it('setMaterial/resetMaterials 回填已有世界方块耐久，保持全局不变量', () => {
    const { app, game } = makeApp();
    setupWall(game); // 天然石材 [32,15,32]（material=4，默认耐久 120）
    game.giveItem(1, 1);
    game.selected = 1;
    expect(game.tryPlaceSelected().ok).toBe(true); // 放置泡沫 [32,15,33]，默认耐久 30
    expect(game.world.blockAt([32, 15, 33]).durability).toBe(30);
    expect(game.world.blockAt([32, 15, 32]).durability).toBe(120);

    app.debug.setMaterial(0, { durability: 999 }); // 有效泡沫耐久改为 999
    expect(game.world.blockAt([32, 15, 33]).durability).toBe(999);

    app.debug.resetMaterials();
    expect(game.world.blockAt([32, 15, 33]).durability).toBe(30);
    expect(game.world.blockAt([32, 15, 32]).durability).toBe(120);
  });

  it('SP2-07 + Code-m7：loadSave 用有效材料表（含 setMaterial override）重建 durability', () => {
    const storage = memoryStorage();
    const g1 = new Game(generateWorld(SEED), { storage, now: () => 1111 });
    // 覆盖混凝土耐久 → 250，用于验证「放置」与「载入重建」都走有效材料表
    g1.overrides.set(4, { durability: 250 });
    setupWall(g1);
    g1.giveItem(5, 1);
    g1.selected = 5;
    expect(g1.tryPlaceSelected().ok).toBe(true);
    expect(g1.world.blockAt([32, 15, 33]).durability).toBe(250);
    g1.writeSave();

    const g2 = new Game(generateWorld(999), { storage, now: () => 2222 });
    g2.overrides.set(4, { durability: 250 });
    expect(g2.loadSave()).toBe('loaded');
    // 放置方块按 effective=250 恢复（而非默认材料常量 150）
    expect(g2.world.blockAt([32, 15, 33]).durability).toBe(250);
  });

  it('SP2-05 后半：超出交互距离/未命中放置有可见提示，且不复用 saveError', () => {
    const { app, game } = makeApp();
    game.teleport([32.5, 20, 32.5]);
    game.giveItem(1, 3);
    game.selected = 1;
    const r = game.tryPlaceSelected();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('超出交互距离或未命中');
    expect(app.state.uiNotice).toMatch(/超出交互距离/);
    expect(app.state.saveError).toBeNull();
  });
});

describe('Sprint 2 库存 UI 回流（SP2-06）', () => {
  it('shouldRefreshInventory 锁定 onFrame 接线决策：库存/选中变化才重绘', () => {
    expect(shouldRefreshInventory('0,0', '0,0', 1, 1)).toBe(false);
    expect(shouldRefreshInventory('0,3', '0,0', 1, 1)).toBe(true);
    expect(shouldRefreshInventory('0,3,4', '0,3,4', 2, 1)).toBe(true);
    expect(shouldRefreshInventory('0,3,4', '0,3,4', 2, 2)).toBe(false);
  });

  it('renderInventory 渲染出的数量与 state 一致，库存变化后重绘', () => {
    let innerHTML = '';
    const slots: string[] = [];
    const fakeEl = {
      get innerHTML() {
        return innerHTML;
      },
      set innerHTML(v: string) {
        innerHTML = v;
      },
      querySelectorAll(): { addEventListener: () => void }[] {
        return slots as unknown as { addEventListener: () => void }[];
      },
    };
    const origDocument = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { getElementById: () => fakeEl };
    try {
      renderInventory([0, 0, 5, 0, 0, 0, 0, 0], 2, () => {});
      expect(innerHTML).toContain('>5<'); // 槽 2 数量 5
      expect(innerHTML).toContain('class="slot slot-selected" data-id="2"');

      // 库存变化后重绘：数量与选中均跟随最新 state
      renderInventory([0, 3, 5, 0, 0, 0, 0, 0], 1, () => {});
      expect(innerHTML).toContain('>3<');
      expect(innerHTML).toContain('class="slot slot-selected" data-id="1"');
      expect(innerHTML).toContain('class="slot " data-id="2"');
    } finally {
      (globalThis as Record<string, unknown>).document = origDocument;
    }
  });
});


describe('用户实测热修：快速点按跳跃缓冲', () => {
  it('keydown+keyup 同一逻辑帧后，后续 grounded 固定步仍能起跳', () => {
    const { game } = makeApp();
    game.teleport([game.spawn[0] + 0.5, game.spawn[1], game.spawn[2] + 0.5]);
    for (let i = 0; i < 3; i++) game.tickFrame(17);
    expect(game.body.grounded).toBe(true);
    const y0 = game.body.pos[1];
    // 模拟快速点按：只入缓冲，不设置 held jump（keyup 已发生）
    game.pressJump();
    game.tickFrame(17);
    expect(game.body.vel[1]).toBeGreaterThan(0);
    expect(game.body.pos[1]).toBeGreaterThan(y0);
  });

  it('空中点按后 150ms 内落地仍触发跳跃', () => {
    const { game } = makeApp();
    game.teleport([game.spawn[0] + 0.5, game.spawn[1] + 0.2, game.spawn[2] + 0.5]);
    game.pressJump();
    let jumped = false;
    for (let i = 0; i < 12; i++) {
      game.tickFrame(17);
      if (game.body.vel[1] > 0) {
        jumped = true;
        break;
      }
    }
    expect(jumped).toBe(true);
    expect(game.jumpBufferMs).toBe(0);
  });

  it('缓冲超时（>150ms）后不再触发跳跃', () => {
    const { game } = makeApp();
    game.teleport([game.spawn[0] + 0.5, game.spawn[1] + 6, game.spawn[2] + 0.5]);
    game.pressJump();
    expect(game.jumpBufferMs).toBe(JUMP_BUFFER_MS);
    // tickFrame 单次 dt 会夹取到 100ms，因此分两帧合计 200ms，确保超过 150ms 缓冲窗口。
    game.tickFrame(100);
    game.tickFrame(100);
    expect(game.jumpBufferMs).toBe(0);
    // 仍在下落：缓冲不会凭空把玩家弹起
    expect(game.body.vel[1]).toBeLessThanOrEqual(0);
  });
});

describe('用户实测热修：世界版本号与即时渲染可观测', () => {
  it('state.worldRevision 随放置/拆除递增', () => {
    const { app, game } = makeApp();
    const rev0 = app.state.worldRevision;
    setupWall(game); // 天然墙使用 world.setBlock，也应递增（任意 ids 修改都触发渲染）
    const rev1 = app.state.worldRevision;
    expect(rev1).toBeGreaterThan(rev0);
    game.giveItem(1, 1);
    game.selected = 1;
    expect(game.tryPlaceSelected().ok).toBe(true);
    const rev2 = app.state.worldRevision;
    expect(rev2).toBeGreaterThan(rev1);
    game.applyBreak([32, 15, 33], 1, true);
    expect(app.state.worldRevision).toBeGreaterThan(rev2);
  });
});


describe('用户实测第二批：落地吸附与连续跳跃（缺陷 A）', () => {
  it('微缝隙 y=支撑面+0.002 且按住 Space：落地瞬间起跳', () => {
    const game = makeFlatPlatformGame();
    game.teleport([32.5, 13.002, 32.5]);
    expect(game.body.pos[1]).toBeCloseTo(13.002);
    game.input.jump = true;
    // 首步：Y 碰撞吸附到 13.0，并立即产生向上跳速（6b）。
    game.tickFrame(17);
    expect(game.body.grounded).toBe(false);
    expect(game.body.vel[1]).toBeGreaterThan(0);
    expect(game.body.pos[1]).toBeGreaterThanOrEqual(13.0);
    // 下一步：Y 轴实际位移上升，证明起跳成功。
    game.tickFrame(17);
    expect(game.body.pos[1]).toBeGreaterThan(13.0);
    game.input.jump = false;
  });

  it('从空中落到支撑面后连续多次按 Space 均能起跳（含落地后的下一次）', () => {
    const game = makeFlatPlatformGame();
    const groundY = 13;
    // 先落稳
    for (let i = 0; i < 10 && !game.body.grounded; i++) game.tickFrame(17);
    expect(game.body.grounded).toBe(true);
    expect(game.body.pos[1]).toBeCloseTo(groundY, 6);

    for (let round = 0; round < 4; round++) {
      const before = game.body.pos[1];
      game.pressJump();
      game.tickFrame(17);
      expect(game.body.vel[1]).toBeGreaterThan(0);
      expect(game.body.pos[1]).toBeGreaterThan(before);
      // 等待再次落地
      for (let i = 0; i < 180 && game.body.pos[1] > groundY + 0.01; i++) game.tickFrame(17);
      expect(game.body.pos[1]).toBeLessThanOrEqual(groundY + 0.01);
      expect(game.body.grounded).toBe(true);
    }
  });

  it('按住 Space 连跳不失效：多个跳跃段自动衔接', () => {
    const game = makeFlatPlatformGame();
    game.teleport([32.5, 13.002, 32.5]);
    game.input.jump = true;
    let jumpStarts = 0;
    let prevVel = 0;
    // 约 4 秒（60Hz 固定步）：应至少出现 2 次从下落/贴地转为上升的跳速。
    for (let i = 0; i < 240; i++) {
      game.tickFrame(17);
      if (prevVel <= 0 && game.body.vel[1] > 0) jumpStarts += 1;
      prevVel = game.body.vel[1];
    }
    game.input.jump = false;
    expect(jumpStarts).toBeGreaterThanOrEqual(2);
  });
});

describe('用户实测第二批：移动自动存档与页面兜底（缺陷 B）', () => {
  it('移动节流达到 AUTOSAVE_MOVE_INTERVAL_MS 后 lastSavedAt 更新，刷新后位置保留', () => {
    const storage = memoryStorage();
    const game = makeFlatPlatformGame(storage, () => 1000);
    expect(game.lastSavedAt).toBe(0);
    const startPos = game.playerPos.slice();
    game.input.forward = 1; // yaw=0 → -Z，平台足够长
    // 15 帧 × 100ms = 1500ms < 2000ms：尚未触发移动自动存档
    for (let i = 0; i < 15; i++) game.tickFrame(100);
    expect(game.lastSavedAt).toBe(0);
    expect(game.playerPos).not.toEqual(startPos);
    // 继续推进直到节流周期到达触发写档；在触发瞬间停止移动，使存储位置=离开前位置。
    let savedPos: number[] | null = null;
    for (let i = 0; i < 20 && savedPos === null; i++) {
      game.tickFrame(100);
      if (game.lastSavedAt > 0) {
        game.input.forward = 0;
        savedPos = game.playerPos.slice();
      }
    }
    expect(savedPos).not.toBeNull();
    expect(game.lastSavedAt).toBeGreaterThan(0);
    expect(savedPos!).not.toEqual(startPos);

    // 用另一 Game 载入同一存储：位置应恢复为离开前（仅移动，无挖掘/放置）
    const g2 = new Game(generateWorld(999), { storage, now: () => 2222 });
    expect(g2.loadSave()).toBe('loaded');
    expect(g2.playerPos).toEqual(savedPos);
  });

  it('flushSaveForPageHide 立即写档：页面关闭兜底不丢移动', () => {
    const storage = memoryStorage();
    const game = makeFlatPlatformGame(storage, () => 1234);
    // 直接产生一次移动
    game.body.pos[2] -= 0.5;
    game.flushSaveForPageHide();
    expect(game.lastSavedAt).toBe(1234);
    expect(storage.getItem('voice.save.v1')).not.toBeNull();

    const g2 = new Game(generateWorld(999), { storage, now: () => 2222 });
    expect(g2.loadSave()).toBe('loaded');
    expect(g2.playerPos).not.toEqual([32.5, 13, 32.5]);
  });

  it('移动节流常量从 config 单源引用且为 1-3 秒区间', () => {
    expect(AUTOSAVE_MOVE_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    expect(AUTOSAVE_MOVE_INTERVAL_MS).toBeLessThanOrEqual(3000);
  });
});
