/**
 * Sprint 3 单测：F4B 俯瞰状态 / 最小时钟 / 配方合成 / 设施放置旋转拆除 / 存档 v2 回环 / v1→v2 迁移。
 * 覆盖 contract SP3-01..SP3-08 中可离线数值断言的部分。
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/apphook';
import { Game, memoryStorage } from '../src/game';
import { generateWorld } from '../src/worldgen';
import { encodeRle } from '../src/save';
import { DAY_LENGTH_SECONDS } from '../src/config';
import { pickBlock } from '../src/pick';
import { FACILITY_DEFS, RECIPES } from '../src/recipes';

const SEED = 0x20260001;

function makeGame(seed = SEED) {
  return new Game(generateWorld(seed), { storage: memoryStorage(), now: () => 1000 });
}

function makeApp(seed = SEED) {
  const game = makeGame(seed);
  const app = buildApp(game, () => {}, () => {}, () => {}, () => 2);
  return { app, game };
}

describe('S3 俯瞰视图（F4B）', () => {
  it('setViewMode/setOrbit 可读，切回第一人称玩家位置不变', () => {
    const { app, game } = makeApp();
    const posBefore = game.playerPos.slice();
    app.debug.setViewMode('orbit');
    expect(app.state.player.viewMode).toBe('orbit');
    app.debug.setOrbit({ distance: 80, yaw: 1.2, pitch: 0.55, target: [10, 12, 20] });
    expect(app.state.orbit.distance).toBe(80);
    expect(app.state.orbit.yaw).toBe(1.2);
    expect(app.state.orbit.pitch).toBeCloseTo(0.55);
    expect(app.state.orbit.target).toEqual([10, 12, 20]);
    app.debug.setViewMode('first');
    expect(app.state.player.viewMode).toBe('first');
    expect(game.playerPos).toEqual(posBefore);
  });

  it('setViewMode/setOrbit 非法输入抛中文可读错误', () => {
    const { app } = makeApp();
    expect(() => app.debug.setViewMode('top' as unknown as 'first')).toThrow(/模式/);
    expect(() => app.debug.setOrbit({ distance: Number.NaN })).toThrow(/有限数/);
  });
});

describe('S3 最小时钟（F6 前置）', () => {
  it('timeOfDay∈[0,1) 随现实时间递增，跨过 1 时 day+1；dayLengthSeconds=420', () => {
    const { app, game } = makeApp();
    expect(app.state.dayLengthSeconds).toBe(DAY_LENGTH_SECONDS);
    expect(DAY_LENGTH_SECONDS).toBe(420);
    expect(app.state.timeOfDay).toBe(0);
    expect(app.state.day).toBe(0);
    // tickFrame 固定 100ms/次；420 秒 = 4200 次，额外一次保证回绕。
    for (let i = 0; i < 4201; i++) game.tickFrame(100);
    expect(game.timeOfDay).toBeGreaterThanOrEqual(0);
    expect(game.timeOfDay).toBeLessThan(1);
    expect(game.day).toBeGreaterThanOrEqual(1);
  });

  it('静止时时钟节流也会写档（lastSavedAt>0）', () => {
    const nowRef = { t: 5000 };
    const game = new Game(generateWorld(SEED), { storage: memoryStorage(), now: () => nowRef.t });
    expect(game.lastSavedAt).toBe(0);
    // 420 秒？不需要跨日；等待单次节流周期 2s 即可触发时钟写档。
    for (let i = 0; i < 30; i++) game.tickFrame(100);
    expect(game.lastSavedAt).toBeGreaterThan(0);
  });
});

describe('S3 配方与合成（F5）', () => {
  it('state.recipes 精确 5 条且与 recipes.ts 同源', () => {
    const { app } = makeApp();
    expect(app.state.recipes).toHaveLength(5);
    expect(RECIPES).toHaveLength(5);
    expect(app.state.recipes.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(app.state.recipes[0].output.itemId).toBe(8);
    expect(app.state.recipes[4].output.itemId).toBe(12);
  });

  it('craft 成功扣材料产设施物品；不足失败且库存不变', () => {
    const { app, game } = makeApp();
    game.giveItem(6, 2);
    game.giveItem(4, 2);
    game.giveItem(3, 1);
    const beforeInv = game.inventory.slice();
    const r = app.debug.craft(1);
    expect(r.ok).toBe(true);
    expect(game.inventory[8]).toBe(beforeInv[8] + 1);
    expect(game.inventory[6]).toBe(beforeInv[6] - 2);
    expect(game.inventory[4]).toBe(beforeInv[4] - 2);
    expect(game.inventory[3]).toBe(beforeInv[3] - 1);
    // 第二次材料不足
    const before2 = game.inventory.slice();
    const r2 = app.debug.craft(1);
    expect(r2.ok).toBe(false);
    expect(game.inventory).toEqual(before2);
  });
});

describe('S3 设施基础（F5.3）', () => {
  it('placeFacility 写 blockAt.facility/placed，扣库存，块字段 ids=0/durability=0', () => {
    const { app, game } = makeApp();
    game.giveItem(8, 2);
    const cell: [number, number, number] = [10, 18, 10];
    const r = game.placeFacility('core', cell, 0);
    expect(r.ok).toBe(true);
    const b = app.state.blockAt(cell);
    expect(b.material).toBe(0);
    expect(b.durability).toBe(0);
    expect(b.placed).toBe(true);
    expect(b.facility?.kind).toBe('core');
    expect(game.inventory[8]).toBe(1);
    expect(app.state.placedBlocks).toBe(1);
  });

  it('rotateFacility 缺省步长 π/2 且归一化；removeFacility 返还物品并清格', () => {
    const { app, game } = makeApp();
    game.giveItem(9, 1);
    const cell: [number, number, number] = [11, 18, 11];
    expect(game.placeFacility('cannon', cell, 0).ok).toBe(true);
    expect(game.rotateFacility(cell).ok).toBe(true);
    expect(app.state.blockAt(cell).facility?.yaw).toBeCloseTo(Math.PI / 2, 6);
    // 再旋转两次回到 π/2+π = 3π/2（归一化后仍 [0,2π)）
    expect(game.rotateFacility(cell).ok).toBe(true);
    expect(app.state.blockAt(cell).facility?.yaw).toBeCloseTo(Math.PI, 6);
    const removed = app.debug.removeFacility(cell);
    expect(removed.ok).toBe(true);
    expect(game.inventory[9]).toBe(1);
    expect(app.state.blockAt(cell).facility).toBeNull();
    expect(app.state.blockAt(cell).placed).toBe(false);
  });

  it('设施可被 DDA 拾取（碰撞视为实体）', () => {
    const { game } = makeApp();
    game.giveItem(8, 1);
    const cell: [number, number, number] = [12, 16, 12];
    expect(game.placeFacility('core', cell, 0).ok).toBe(true);
    // 玩家出生点不一定正对设施；直接验证 pickBlock 对设施格本身返回非空即可。
    const from: [number, number, number] = [cell[0] + 0.5, cell[1] + 0.5, cell[2] + 2.5];
    const dir: [number, number, number] = [0, 0, -1];
    const h = pickBlock(game.world, from, dir, 10);
    expect(h?.cell).toEqual(cell);
  });
});

describe('S3 存档 v2 与迁移', () => {
  it('v2 回环：设施/时间/天数/库存刷新后恢复', () => {
    const storage = memoryStorage();
    const g1 = new Game(generateWorld(SEED), { storage, now: () => 1111 });
    g1.giveItem(10, 1);
    const cell: [number, number, number] = [20, 18, 20];
    expect(g1.placeFacility('probe', cell, 1.5).ok).toBe(true);
    g1.timeOfDay = 0.345;
    g1.day = 3;
    g1.inventory[11] = 7;
    g1.selected = 10;
    g1.writeSave();

    const g2 = new Game(generateWorld(999), { storage, now: () => 2222 });
    expect(g2.loadSave()).toBe('loaded');
    expect(g2.inventory).toHaveLength(13);
    expect(g2.inventory[11]).toBe(7);
    expect(g2.selected).toBe(10);
    expect(g2.timeOfDay).toBeCloseTo(0.345);
    expect(g2.day).toBe(3);
    expect(g2.facilitySnapshots()).toEqual([{ cell, kind: 'probe', yaw: 1.5 }]);
    const b = g2.world.blockAt(cell);
    expect(b.facility?.kind).toBe('probe');
    expect(b.placed).toBe(true);
  });

  it('v1 档自动迁移：库存补零/selected 夹取、设施空、时间 0/day 0，下次写为 v2', () => {
    const storage = memoryStorage();
    const g1 = new Game(generateWorld(SEED), { storage, now: () => 1000 });
    g1.giveItem(2, 5);
    g1.inventory = new Array(8).fill(0) as number[];
    g1.inventory[2] = 5;
    g1.selected = 8; // v1 越界值
    const v1 = JSON.stringify({
      version: 1,
      seed: g1.seed,
      idsB64: encodeRle(g1.world.ids),
      placedB64: encodeRle(g1.world.placed),
      inventory: g1.inventory,
      selected: g1.selected,
      playerPos: g1.playerPos,
      playerYaw: 0,
      playerPitch: 0,
      savedAt: 1000,
    });
    storage.setItem('voice.save.v1', v1);

    const g2 = new Game(generateWorld(999), { storage, now: () => 2000 });
    expect(g2.loadSave()).toBe('loaded');
    expect(g2.loadNotice).toBeNull();
    expect(g2.inventory).toHaveLength(13);
    expect(g2.inventory[2]).toBe(5);
    expect(g2.selected).toBe(1); // >7 夹取为 1
    expect(g2.facilitySnapshots()).toEqual([]);
    expect(g2.timeOfDay).toBe(0);
    expect(g2.day).toBe(0);

    // 下次写档版本为 2
    g2.writeSave();
    const raw = JSON.parse(storage.getItem('voice.save.v1')!) as Record<string, unknown>;
    expect(raw.version).toBe(2);
  });

  it('设施占格 placedBlocks 与 placed 数组同源（含设施）', () => {
    const { app, game } =
    makeApp();
    game.giveItem(12, 1);
    expect(game.placeFacility('relay', [15, 18, 15], 0).ok).toBe(true);
    expect(app.state.placedBlocks).toBe(game.world.countPlacedBlocks());
    expect(game.world.placed[game.world.idx(15, 18, 15)]).toBe(1);
  });
});

describe('S3 设施定义无行为（SP3-08）', () => {
  it('facilityDefs 5 类且 implemented=false、abilities 全 false', () => {
    const { app } = makeApp();
    expect(app.state.facilityDefs).toHaveLength(5);
    expect(FACILITY_DEFS).toHaveLength(5);
    for (const f of app.state.facilityDefs) {
      expect(f.implemented).toBe(false);
      expect(f.abilities.core).toBe(false);
      expect(f.abilities.cannon).toBe(false);
      expect(f.abilities.probe).toBe(false);
      expect(f.abilities.duct).toBe(false);
      expect(f.abilities.relay).toBe(false);
    }
  });
});
