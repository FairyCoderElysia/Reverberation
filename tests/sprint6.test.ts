/**
 * Sprint 6 单测：全局能量池 + 核心采收 + 声源格不可占 + 探针 + 存档 v3/v2 迁移。
 * 覆盖 contract SP6-01..SP6-09 中可离线数值断言的部分。
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/apphook';
import { Game, memoryStorage } from '../src/game';
import { generateWorld, SOUND_SOURCE_DEFS } from '../src/worldgen';
import { createFacilityState } from '../src/facility';
import { serializeSave } from '../src/save';
import { HARVEST_TICK_MS } from '../src/config';
import type { PickHit } from '../src/pick';
import type { XYZA } from '../src/types';
import { World } from '../src/world';

const SEED = 0x20260001;

function makeEmptyApp() {
  const game = new Game(
    { world: new World(), seed: 1, spawn: [32, 14, 32] as XYZA, soundSources: [] },
    { storage: memoryStorage(), now: () => 1000 },
  );
  const app = buildApp(game, () => {}, () => {}, () => {}, () => 2);
  return { app, game };
}

function makeGeneratedApp() {
  const game = new Game(generateWorld(SEED), { storage: memoryStorage(), now: () => 1000 });
  const app = buildApp(game, () => {}, () => {}, () => {}, () => 2);
  return { app, game };
}

function advanceMs(game: Game, ms: number): void {
  // tickFrame 单帧 dt 上限 100ms；为确定性按 100ms 步进累计（不依赖真实时钟）。
  const step = 100;
  let left = ms;
  while (left > 0) {
    const chunk = Math.min(step, left);
    game.tickFrame(chunk);
    left -= chunk;
  }
}

describe('SP6-01 全局能量池唯一字段与多核心共享', () => {
  it('state.coreEnergy 为唯一全局储能字段，多核心共享；拆除重放不改变池值', () => {
    const { app, game } = makeEmptyApp();
    expect(app.state.coreEnergy).toBe(0);
    expect((app.state as unknown as Record<string, unknown>).core).toBeUndefined();

    game.setCoreEnergy(12.5);
    expect(app.state.coreEnergy).toBe(12.5);
    expect(game.coreEnergy).toBe(12.5);

    // 两个核心共享同一池
    game.giveItem(8, 2);
    const c1: XYZA = [10, 18, 10];
    const c2: XYZA = [12, 18, 12];
    expect(game.placeFacility('core', c1, 0).ok).toBe(true);
    expect(game.placeFacility('core', c2, 0).ok).toBe(true);
    expect(game.removeFacility(c1).ok).toBe(true);
    expect(app.state.coreEnergy).toBe(12.5);
    expect(game.placeFacility('core', c1, 0).ok).toBe(true);
    expect(app.state.coreEnergy).toBe(12.5);
  });
});

describe('SP6-02 采收量化', () => {
  it('近场无遮挡增量 >0；远场增量 ≤ 0.5×近场基线；clearSources 后增量===0', () => {
    const { app, game } = makeEmptyApp();

    const clearCores = (): void => {
      for (const snap of game.facilitySnapshots()) {
        if (snap.kind === 'core') game.removeFacility(snap.cell);
      }
    };

    clearCores();
    app.debug.clearSources();
    game.setCoreEnergy(0);
    game.giveItem(8, 2);

    // 近场：核心与源同线近距，无遮挡。
    const nearCell: XYZA = [34, 12, 34];
    expect(game.placeFacility('core', nearCell, 0).ok).toBe(true);
    app.debug.emitSource([32, 12, 34], [1, 1, 1]);
    advanceMs(game, HARVEST_TICK_MS * 2 + 50);
    const near = game.coreEnergy;
    expect(near).toBeGreaterThan(0);

    // 远场：同源同核心方向更远，同一 tick 窗口。
    clearCores();
    app.debug.clearSources();
    game.setCoreEnergy(0);
    const farCell: XYZA = [48, 12, 34];
    expect(game.placeFacility('core', farCell, 0).ok).toBe(true);
    app.debug.emitSource([32, 12, 34], [1, 1, 1]);
    advanceMs(game, HARVEST_TICK_MS * 2 + 50);
    const far = game.coreEnergy;
    expect(far).toBeGreaterThanOrEqual(0);
    expect(far).toBeLessThanOrEqual(0.5 * near);

    // SP6-04 标准构造：clearSources 后等 ≥2 tick，增量严格为 0。
    clearCores();
    app.debug.clearSources();
    game.setCoreEnergy(0);
    expect(game.placeFacility('core', nearCell, 0).ok).toBe(true);
    advanceMs(game, HARVEST_TICK_MS * 2 + 50);
    expect(game.coreEnergy).toBe(0);
  });
});

describe('SP6-03 固定声源格不可占', () => {
  it('音源格放置设施失败且中文提示；普通方块放置同样被拦截', () => {
    const { app, game } = makeGeneratedApp();
    const src = SOUND_SOURCE_DEFS[0].pos;
    expect(game.isSoundSourceCell(src)).toBe(true);
    game.giveItem(8, 1);
    const r = app.debug.placeFacility('core', src, 0);
    expect(r.ok).toBe(false);
    expect(app.state.uiNotice).toContain('声源格');

    // 普通方块放置路径：用 stub pickLook 把命中面相邻格设为声源格。
    const srcCell: XYZA = [SOUND_SOURCE_DEFS[0].pos[0], SOUND_SOURCE_DEFS[0].pos[1], SOUND_SOURCE_DEFS[0].pos[2]];
    const stubHit: PickHit = { cell: [srcCell[0], srcCell[1], srcCell[2] + 1] as XYZA, face: 4, dist: 2 };
    (game as unknown as { pickLook: () => PickHit | null }).pickLook = () => stubHit;
    game.giveItem(1, 1);
    game.selected = 1;
    const normal = game.tryPlaceSelected();
    expect(normal.ok).toBe(false);
    expect(normal.reason).toContain('声源格');
    expect(app.state.blockAt(srcCell).material).toBe(0);
  });
});

describe('SP6-05 探针同源只读与拆除返还', () => {
  it('state.probes reading 与 energyField.sample 完全一致；探针无耗能；拆除返还物品', () => {
    const { app, game } = makeEmptyApp();
    app.debug.clearSources();
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    game.giveItem(10, 1);
    const cell: XYZA = [36, 12, 36];
    expect(game.placeFacility('probe', cell, 0).ok).toBe(true);
    expect(app.state.probes).toHaveLength(1);
    const p = app.state.probes[0];
    expect(p.cell).toEqual(cell);
    expect(p.reading).toEqual(app.state.energyField.sample(cell));

    const before = game.coreEnergy;
    advanceMs(game, HARVEST_TICK_MS * 2 + 50);
    expect(game.coreEnergy).toBe(before);

    const removed = game.removeFacility(cell);
    expect(removed.ok).toBe(true);
    expect(app.state.probes).toHaveLength(0);
    expect(game.inventory[10]).toBe(1);
  });
});

describe('SP6-06/07 存档 v3 与 v2 迁移', () => {
  it('v3 回环：coreEnergy/设施恢复；探针读数不持久化；下次写档仍 v3', () => {
    const storage = memoryStorage();
    const g1 = new Game(generateWorld(SEED), { storage, now: () => 1000 });
    g1.giveItem(8, 1);
    g1.giveItem(10, 1);
    const coreCell: XYZA = [30, 18, 30];
    const probeCell: XYZA = [35, 18, 35];
    expect(g1.placeFacility('core', coreCell, 0).ok).toBe(true);
    expect(g1.placeFacility('probe', probeCell, 1.1).ok).toBe(true);
    g1.setCoreEnergy(23.5);
    g1.writeSave();

    const rawText = storage.getItem('voice.save.v1')!;
    const raw = JSON.parse(rawText) as Record<string, unknown>;
    expect(raw.version).toBe(3);
    expect(raw.coreEnergy).toBe(23.5);
    expect(raw.facilities as unknown[]).toHaveLength(2);
    expect(JSON.stringify(raw)).not.toContain('reading');
    expect(JSON.stringify(raw)).not.toContain('probes');

    const g2 = new Game(generateWorld(999), { storage, now: () => 2000 });
    expect(g2.loadSave()).toBe('loaded');
    expect(g2.coreEnergy).toBe(23.5);
    expect(g2.facilitySnapshots()).toHaveLength(2);
    expect(g2.facilitySnapshots()).toEqual(expect.arrayContaining([
      expect.objectContaining({ cell: coreCell, kind: 'core' }),
      expect.objectContaining({ cell: probeCell, kind: 'probe', yaw: 1.1 }),
    ]));
    expect(g2.loadNotice).toBeNull();
  });

  it('v2→v3 迁移：coreEnergy=0；保留合法设施；清除声源格重叠方块/设施并给中文提示；下次写档 v3', () => {
    const storage = memoryStorage();
    const g1 = new Game(generateWorld(SEED), { storage, now: () => 1000 });
    const legalCell: XYZA = [30, 18, 30];
    const overlapBlock: XYZA = [SOUND_SOURCE_DEFS[0].pos[0], SOUND_SOURCE_DEFS[0].pos[1], SOUND_SOURCE_DEFS[0].pos[2]];
    const overlapFacilityCell: XYZA = [SOUND_SOURCE_DEFS[1].pos[0], SOUND_SOURCE_DEFS[1].pos[1], SOUND_SOURCE_DEFS[1].pos[2]];
    g1.giveItem(8, 1);
    expect(g1.placeFacility('core', legalCell, 0.7).ok).toBe(true);
    // 构造旧档污染：通过低层直接写入，模拟早期版本/异常情况下声源格被占。
    g1.world.putBlock(overlapBlock, 5, 150);
    const i = g1.world.idx(overlapFacilityCell[0], overlapFacilityCell[1], overlapFacilityCell[2]);
    g1.world.putFacility(createFacilityState('probe', i, 1.2, 999));

    const payload = {
      version: 2,
      seed: g1.seed,
      coreEnergy: 0,
      ids: g1.world.ids,
      placed: g1.world.placed,
      inventory: g1.inventory.slice(),
      selected: g1.selected,
      playerPos: g1.playerPos,
      playerYaw: g1.body.yaw,
      playerPitch: g1.body.pitch,
      facilities: g1.world.facilityList(),
      timeOfDay: 0.3,
      day: 2,
      savedAt: 1111,
    };
    storage.setItem('voice.save.v1', serializeSave(payload));

    const g2 = new Game(generateWorld(999), { storage, now: () => 2000 });
    expect(g2.loadSave()).toBe('loaded');
    expect(g2.coreEnergy).toBe(0);
    expect(g2.loadNotice).toContain('v2');
    expect(g2.loadNotice).toContain('声源格');

    // 合法设施保留，重叠设施被移除，重叠方块被清空。
    expect(g2.facilitySnapshots()).toEqual([{ cell: legalCell, kind: 'core', yaw: 0.7 }]);
    expect(g2.world.blockAt(overlapBlock).material).toBe(0);
    expect(g2.world.blockAt(overlapBlock).placed).toBe(false);
    expect(g2.world.blockAt(overlapFacilityCell).facility).toBeNull();
    expect(g2.world.countPlacedBlocks()).toBe(1);

    g2.writeSave();
    const raw2 = JSON.parse(storage.getItem('voice.save.v1')!) as Record<string, unknown>;
    expect(raw2.version).toBe(3);
  });
});

describe('SP6-08/09 能力 schema 与调试钩子边界', () => {
  it('facilityDefs 无 logic/and/or/not/memory/clock key（详细精确 schema 已在 S3 测试）', () => {
    const { app } = makeEmptyApp();
    const keys = new Set(app.state.facilityDefs.flatMap((f) => Object.keys(f.abilities)));
    for (const forbidden of ['logic', 'and', 'or', 'not', 'memory', 'clock']) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('setCoreEnergy 有限非负、会话级不写档；reset 恢复默认', () => {
    const { app } = makeEmptyApp();
    const saved = app.state.lastSavedAt;
    app.debug.setCoreEnergy(8);
    expect(app.state.coreEnergy).toBe(8);
    expect(app.state.lastSavedAt).toBe(saved);
    expect(() => app.debug.setCoreEnergy(-1)).toThrow(/非负/);
    expect(() => app.debug.setCoreEnergy(Number.NaN)).toThrow(/有限非负数/);
    app.reset();
    expect(app.state.coreEnergy).toBe(0);
  });

  it('probeAt：合法无能量返回 [0,0,0]；非法/越界/NaN 抛中文错误', () => {
    const { app } = makeEmptyApp();
    app.debug.clearSources();
    expect(app.debug.probeAt([5, 5, 5])).toEqual([0, 0, 0]);
    expect(() => app.debug.probeAt([NaN, 5, 5] as unknown as XYZA)).toThrow(/整数/);
    expect(() => app.debug.probeAt([5.5, 5, 5] as unknown as XYZA)).toThrow(/整数/);
    expect(() => app.debug.probeAt('x' as unknown as XYZA)).toThrow(/数组/);
    expect(() => app.debug.probeAt([64, 5, 5] as XYZA)).toThrow(/边界/);
  });
});
