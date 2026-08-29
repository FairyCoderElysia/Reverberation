/**
 * Sprint 7 单测：声导管 + 中继器网络。
 * 覆盖 contract SP7-01..SP7-09 中可离线数值断言的部分：
 * BFS 首次发现、长度衰减、中继补强、多分支不放大、多核心去重、
 * 拆除返还、网络生命周期、无逻辑门、ductEnergyAt 边界。
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/apphook';
import { computeDuctNetwork, ductEnergyFromNetwork } from '../src/duct';
import type { DuctNetworkState } from '../src/duct';
import { createFacilityState, facilityItemIdForKind } from '../src/facility';
import { Game, memoryStorage } from '../src/game';
import { DUCT_TRANSMIT, RELAY_GAIN, HARVEST_TICK_MS } from '../src/config';
import { World } from '../src/world';
import type { BandEnergy, XYZA } from '../src/types';

const ZERO = [0, 0, 0] as BandEnergy;
const E100 = [100, 0, 0] as BandEnergy;

function emptyGame(): Game {
  return new Game(
    { world: new World(), seed: 1, spawn: [32, 14, 32] as XYZA, soundSources: [] },
    { storage: memoryStorage(), now: () => 1000 },
  );
}

function emptyApp() {
  const game = emptyGame();
  const app = buildApp(game, () => {}, () => {}, () => {}, () => 2);
  return { app, game };
}

function putFacility(world: World, kind: 'core' | 'duct' | 'relay', cell: XYZA, id: number): void {
  const i = world.idx(cell[0], cell[1], cell[2]);
  world.putFacility(createFacilityState(kind, i, 0, id));
}

function sampleOnly(cells: XYZA[], value: BandEnergy) {
  return {
    sample: (g: XYZA): BandEnergy => (cells.some((c) => c[0] === g[0] && c[1] === g[1] && c[2] === g[2]) ? [...value] : [0, 0, 0]),
  };
}

function nodeEnergy(network: DuctNetworkState, cell: XYZA): BandEnergy {
  return ductEnergyFromNetwork(network, cell);
}

function sumBand(e: BandEnergy): number {
  return e[0] + e[1] + e[2];
}

describe('SP7-01 网络状态与 ductEnergyAt 边界', () => {
  it('state.ductNetwork.nodes/version 可读；合法非节点返回 0；非法输入抛中文错误', () => {
    const { app, game } = emptyApp();
    app.debug.clearSources();
    game.giveItem(11, 1);
    const nodeCell: XYZA = [30, 18, 30];
    expect(game.placeFacility('duct', nodeCell, 0).ok).toBe(true);

    expect(app.state.ductNetwork.version).toBeGreaterThan(0);
    const node = app.state.ductNetwork.nodes.find((n) => n.cell[0] === nodeCell[0] && n.cell[1] === nodeCell[1] && n.cell[2] === nodeCell[2]);
    expect(node?.kind).toBe('duct');
    expect(node?.energy).toEqual(ZERO);

    // 合法非节点
    expect(app.debug.ductEnergyAt([1, 1, 1])).toEqual(ZERO);
    // 非法：非数组/长度/NaN/越界
    expect(() => app.debug.ductEnergyAt('bad' as unknown as XYZA)).toThrow(/中文|cell/);
    expect(() => app.debug.ductEnergyAt([1, 2] as unknown as XYZA)).toThrow(/cell/);
    expect(() => app.debug.ductEnergyAt([NaN, 2, 3] as unknown as XYZA)).toThrow(/整数/);
    expect(() => app.debug.ductEnergyAt([1.5, 2, 3] as unknown as XYZA)).toThrow(/整数/);
    expect(() => app.debug.ductEnergyAt([999, 2, 3] as unknown as XYZA)).toThrow(/边界/);
  });

  it('入口 relay 不执行入口增益；非入口 relay 进入时只增益一次', () => {
    const world = new World();
    const entryCell: XYZA = [11, 10, 10];
    const secondCell: XYZA = [12, 10, 10];
    const thirdCell: XYZA = [13, 10, 10];
    const coreCell: XYZA = [14, 10, 10];
    putFacility(world, 'relay', entryCell, 1);
    putFacility(world, 'duct', secondCell, 2);
    putFacility(world, 'duct', thirdCell, 3);
    putFacility(world, 'core', coreCell, 4);
    const net = computeDuctNetwork(world, sampleOnly([entryCell], E100), [[10, 10, 10]], 1);
    // 入口 relay 能量=入口场值，不乘 1.5；下一 duct = 0.9*100
    expect(nodeEnergy(net, entryCell)).toEqual(E100);
    expect(nodeEnergy(net, secondCell)[0]).toBeCloseTo(100 * DUCT_TRANSMIT);
    // 此处 relay 是入口，未触发进入增益（因为不是“从另一节点进入”）
    const world2 = new World();
    const e2: XYZA = [11, 10, 10];
    const r2: XYZA = [12, 10, 10];
    const c2: XYZA = [13, 10, 10];
    putFacility(world2, 'duct', e2, 11);
    putFacility(world2, 'relay', r2, 12);
    putFacility(world2, 'core', c2, 13);
    const net2 = computeDuctNetwork(world2, sampleOnly([e2], E100), [[10, 10, 10]], 2);
    // 从 duct 进入 relay：0.9*100*1.5
    expect(nodeEnergy(net2, r2)[0]).toBeCloseTo(100 * DUCT_TRANSMIT * RELAY_GAIN);
  });
});

describe('SP7-02/03 无网络零与长度衰减', () => {
  it('无网络时 ductEnergyAt 为 0；短路径出口能量 > 长路径，且长 < 短*0.8', () => {
    const { app } = emptyApp();
    app.debug.clearSources();
    expect(app.debug.ductEnergyAt([20, 20, 20])).toEqual(ZERO);

    const world = new World();
    const shortEntry: XYZA = [11, 10, 10];
    const shortExit: XYZA = [12, 10, 10];
    const shortCore: XYZA = [13, 10, 10];
    putFacility(world, 'duct', shortEntry, 1);
    putFacility(world, 'duct', shortExit, 2);
    putFacility(world, 'core', shortCore, 3);
    const shortNet = computeDuctNetwork(world, sampleOnly([shortEntry], E100), [[10, 10, 10]], 1);
    const shortE = nodeEnergy(shortNet, shortExit)[0];
    expect(shortE).toBeCloseTo(100 * DUCT_TRANSMIT);

    const world2 = new World();
    const longCells: XYZA[] = [
      [11, 10, 10], [12, 10, 10], [13, 10, 10], [14, 10, 10], [15, 10, 10], [16, 10, 10],
    ];
    longCells.forEach((c, i) => putFacility(world2, 'duct', c, i + 1));
    const longCore: XYZA = [17, 10, 10];
    putFacility(world2, 'core', longCore, 20);
    const longNet = computeDuctNetwork(world2, sampleOnly([longCells[0]], E100), [[10, 10, 10]], 2);
    const longExit = longCells[5];
    const longE = nodeEnergy(longNet, longExit)[0];
    expect(longE).toBeCloseTo(100 * Math.pow(DUCT_TRANSMIT, 5));
    expect(longE).toBeLessThan(0.8 * shortE);
  });
});

describe('SP7-04 中继补强', () => {
  it('同一长路径把中段 duct 替换为 relay 后出口能量高于无 relay（>1.2×）', () => {
    const make = (withRelay: boolean) => {
      const world = new World();
      const cells: XYZA[] = [
        [11, 10, 10], [12, 10, 10], [13, 10, 10], [14, 10, 10], [15, 10, 10], [16, 10, 10],
      ];
      cells.forEach((c, i) => putFacility(world, withRelay && i === 3 ? 'relay' : 'duct', c, i + 1));
      putFacility(world, 'core', [17, 10, 10], 20);
      return computeDuctNetwork(world, sampleOnly([cells[0]], E100), [[10, 10, 10]], 1);
    };
    const noRelay = make(false);
    const withRelay = make(true);
    const noE = nodeEnergy(noRelay, [16, 10, 10])[0];
    const withE = nodeEnergy(withRelay, [16, 10, 10])[0];
    expect(withE).toBeGreaterThan(1.2 * noE);
  });
});

describe('SP7-05 多分支确定性与不放大', () => {
  it('同一入口两条分支到达同一出口时结果等于 BFS 首次发现单分支，不合并放大', () => {
    const world = new World();
    // A 入口，B 为 +X 首发现分支，D 为 +Z 分支；C 为共同出口
    const A: XYZA = [11, 10, 10];
    const B: XYZA = [12, 10, 10];
    const D: XYZA = [11, 10, 11];
    const C: XYZA = [12, 10, 11];
    putFacility(world, 'duct', A, 1);
    putFacility(world, 'duct', B, 2);
    putFacility(world, 'duct', D, 3);
    putFacility(world, 'duct', C, 4);
    putFacility(world, 'core', [13, 10, 11], 5);
    const diamond = computeDuctNetwork(world, sampleOnly([A], E100), [[10, 10, 10]], 1);

    // 单独第一条分支 A->B->C
    const worldSingle = new World();
    putFacility(worldSingle, 'duct', A, 1);
    putFacility(worldSingle, 'duct', B, 2);
    putFacility(worldSingle, 'duct', C, 3);
    putFacility(worldSingle, 'core', [13, 10, 11], 4);
    const single = computeDuctNetwork(worldSingle, sampleOnly([A], E100), [[10, 10, 10]], 2);

    const diamondC = nodeEnergy(diamond, C);
    const singleC = nodeEnergy(single, C);
    expect(diamondC).toEqual(singleC);
    expect(diamondC[0]).toBeCloseTo(100 * DUCT_TRANSMIT * DUCT_TRANSMIT);
    // 不放大：不超过较强单分支的 2 倍（此处相等）
    expect(diamondC[0]).toBeLessThan(2 * singleC[0]);
  });
});

describe('SP7-06 设施能力边界', () => {
  it('duct/relay 已实现 transport/boost；cannon 未实现；无逻辑门能力键', () => {
    const { app } = emptyApp();
    const defs = app.state.facilityDefs;
    const byKind = new Map(defs.map((d) => [d.kind, d]));
    expect(byKind.get('duct')).toMatchObject({ implemented: true, abilities: { transport: true } });
    expect(byKind.get('relay')).toMatchObject({ implemented: true, abilities: { boost: true } });
    expect(byKind.get('cannon')?.implemented).toBe(false);
    expect(byKind.get('probe')).toMatchObject({ implemented: true, abilities: { read: true } });
    expect(byKind.get('core')).toMatchObject({ implemented: true, abilities: { store: true } });

    const allAbilities = defs.flatMap((d) => Object.keys(d.abilities));
    for (const forbidden of ['logic', 'and', 'or', 'not', 'memory', 'clock']) {
      expect(allAbilities).not.toContain(forbidden);
    }
  });
});

describe('SP7-07/08 拆除返还与生命周期', () => {
  it('拆除 duct 返还物品、网络节点/出口能量消失；version 递增；刷新后拓扑恢复且不写网络', () => {
    const { app, game } = emptyApp();
    const storage = game.storage!;
    app.debug.clearSources();
    game.giveItem(8, 1);
    game.giveItem(11, 2);

    const source: XYZA = [20, 20, 20];
    const entry: XYZA = [21, 20, 20];
    const exit: XYZA = [22, 20, 20];
    const core: XYZA = [23, 20, 20];
    app.debug.emitSource(source, [1, 1, 1]);
    expect(game.placeFacility('core', core, 0).ok).toBe(true);
    expect(game.placeFacility('duct', entry, 0).ok).toBe(true);
    expect(game.placeFacility('duct', exit, 0).ok).toBe(true);

    const v1 = app.state.ductNetwork.version;
    const e1 = app.debug.ductEnergyAt(exit);
    expect(e1[0]).toBeGreaterThan(0);

    // 拆除出口 duct：网络重算后该节点为 0，且设施物品返还
    expect(game.removeFacility(exit).ok).toBe(true);
    expect(game.inventory[facilityItemIdForKind('duct')]).toBe(1);
    const v2 = app.state.ductNetwork.version;
    expect(v2).toBeGreaterThan(v1);
    expect(app.debug.ductEnergyAt(exit)).toEqual(ZERO);

    // 刷新恢复剩余位置：先写档，再 reload 到新内存 Game
    game.writeSave();
    const g2 = new Game({ world: new World(), seed: 1, spawn: [32, 14, 32] as XYZA, soundSources: [] }, { storage, now: () => 2000 });
    expect(g2.loadSave()).toBe('loaded');
    const app2 = buildApp(g2, () => {}, () => {}, () => {}, () => 2);
    const restored = app2.state.facilities.filter((f) => f.kind === 'duct' || f.kind === 'core');
    expect(restored.some((f) => f.kind === 'duct' && f.cell[0] === entry[0])).toBe(true);
    expect(restored.some((f) => f.kind === 'core' && f.cell[0] === core[0])).toBe(true);
    expect(app2.state.ductNetwork.version).toBeGreaterThan(0);
    expect(JSON.parse(storage.getItem('voice.save.v1')!)).not.toHaveProperty('ductNetwork');
    expect(JSON.parse(storage.getItem('voice.save.v1')!)).not.toHaveProperty('networkTotal');
  });

  it('reset/regenerate/loadSave 均触发网络重算；无网络时 nodes 清空', () => {
    const { app, game } = emptyApp();
    app.debug.clearSources();
    game.giveItem(11, 1);
    expect(game.placeFacility('duct', [30, 18, 30], 0).ok).toBe(true);
    const vBefore = app.state.ductNetwork.version;
    expect(app.state.ductNetwork.nodes.length).toBe(1);

    game.reset();
    const vAfterReset = app.state.ductNetwork.version;
    expect(vAfterReset).toBeGreaterThan(vBefore);
    expect(app.state.ductNetwork.nodes.length).toBe(0);

    game.giveItem(11, 1);
    expect(game.placeFacility('duct', [31, 18, 31], 0).ok).toBe(true);
    const vBeforeRegen = app.state.ductNetwork.version;
    game.regenerate(42);
    expect(app.state.ductNetwork.version).toBeGreaterThan(vBeforeRegen);
    expect(app.state.ductNetwork.nodes.length).toBe(0);

    game.autoSave();
    const storage = game.storage!;
    const g2 = new Game({ world: new World(), seed: 2, spawn: [32, 14, 32] as XYZA, soundSources: [] }, { storage, now: () => 3000 });
    const vBeforeLoad = g2.ductNetworkState.version;
    expect(g2.loadSave()).toBe('loaded');
    expect(g2.ductNetworkState.version).toBeGreaterThan(vBeforeLoad);
    const app2 = buildApp(g2, () => {}, () => {}, () => {}, () => 2);
    expect(app2.state.ductNetwork.version).toBe(app2.state.ductNetwork.version); // 可读
  });
});

describe('SP7-09 核心入账包含全局去重网络能量', () => {
  it('多核心共享同一出口时网络项只入账一次；实际能量场路径产生网络能量', () => {
    // 纯网络验证 networkTotal 去重：一个出口邻接两个 core 只计一次。
    const world = new World();
    const entry: XYZA = [11, 10, 10];
    const exit: XYZA = [12, 10, 10];
    const coreA: XYZA = [13, 10, 10];
    const coreB: XYZA = [12, 10, 11];
    putFacility(world, 'duct', entry, 1);
    putFacility(world, 'duct', exit, 2);
    putFacility(world, 'core', coreA, 3);
    putFacility(world, 'core', coreB, 4);
    const net = computeDuctNetwork(world, sampleOnly([entry], E100), [[10, 10, 10]], 1);
    expect(sumBand(net.networkTotal)).toBeCloseTo(100 * DUCT_TRANSMIT);

    // 集成：实际能量场 + 核心 tick，网络路径产生入账（方向性证据）
    const { app: app2, game: g2 } = emptyApp();
    app2.debug.clearSources();
    g2.giveItem(8, 1);
    g2.giveItem(11, 2);
    const src: XYZA = [20, 20, 20];
    const en: XYZA = [21, 20, 20];
    const ex: XYZA = [22, 20, 20];
    const co: XYZA = [23, 20, 20];
    app2.debug.emitSource(src, [1, 1, 1]);
    expect(g2.placeFacility('core', co, 0).ok).toBe(true);
    expect(g2.placeFacility('duct', en, 0).ok).toBe(true);
    expect(g2.placeFacility('duct', ex, 0).ok).toBe(true);
    const before = g2.coreEnergy;
    // 跨过至少一个 harvest tick
    for (let i = 0; i < Math.ceil(HARVEST_TICK_MS / 100) + 1; i++) {
      g2.tickFrame(100);
    }
    expect(g2.coreEnergy).toBeGreaterThan(before);
  });
});
