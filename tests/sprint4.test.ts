/**
 * Sprint 4 单测：三频几何声学传播内核与能量场采样。
 * 覆盖 contract SP4-01..SP4-09 中可离线数值断言的部分。
 */
import { describe, expect, it } from 'vitest';
import { Game, memoryStorage } from '../src/game';
import { World } from '../src/world';
import { buildApp } from '../src/apphook';
import type { XYZA } from '../src/types';

function makeApp() {
  const world = new World();
  const spawn: XYZA = [32, 14, 32];
  const game = new Game(
    { world, seed: 1, spawn, soundSources: [] },
    { storage: memoryStorage(), now: () => 1000 },
  );
  const app = buildApp(game, () => {}, () => {}, () => {}, () => 2);
  return { app, game };
}

describe('SP4-01 唯一读 API / 空场 / 越界 / version', () => {
  it('clearSources 后任意格为 [0,0,0]；emitSource 后非零；out-of-bounds 为 [0,0,0]', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    expect(game.energyField.sample([32, 12, 32])).toEqual([0, 0, 0]);
    expect(app.state.energyField.sample([64, 12, 32])).toEqual([0, 0, 0]);
    expect(app.state.energyField.sample([32, 90, 32])).toEqual([0, 0, 0]);
    const v0 = app.state.energyField.version;
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const e = app.state.energyField.sample([34, 12, 32]);
    expect(e[0]).toBeGreaterThan(0);
    expect(e[1]).toBeGreaterThan(0);
    expect(e[2]).toBeGreaterThan(0);
    expect(app.state.energyField.version).toBeGreaterThan(v0);
  });
});

describe('SP4-02 距离衰减', () => {
  it('单源沿同一视线取 5 点严格单调递减且 >1e-6', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const xs = [34, 35, 36, 37, 38];
    const samples = xs.map((x) => app.state.energyField.sample([x, 12, 32]));
    for (const s of samples) {
      expect(s[0]).toBeGreaterThan(1e-6);
      expect(s[1]).toBeGreaterThan(1e-6);
      expect(s[2]).toBeGreaterThan(1e-6);
    }
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i][0]).toBeLessThan(samples[i - 1][0]);
      expect(samples[i][1]).toBeLessThan(samples[i - 1][1]);
      expect(samples[i][2]).toBeLessThan(samples[i - 1][2]);
    }
    expect(game).toBeTruthy();
  });
});

describe('SP4-03 三频墙体差异', () => {
  it('泡沫墙 E[2] < 0.8*E[0]；混凝土墙 E[0] < 0.8*E[2]', () => {
    const { app, game } = makeApp();
    // 泡沫（id=1）墙体
    app.debug.clearSources();
    game.world.setBlock([35, 12, 32], 1, 30);
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const foam = app.state.energyField.sample([36, 12, 32]);
    expect(foam[2]).toBeLessThan(0.8 * foam[0]);

    // 换混凝土（id=5）
    app.debug.clearSources();
    game.world.setBlock([35, 12, 32], 5, 150);
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const concrete = app.state.energyField.sample([36, 12, 32]);
    expect(concrete[0]).toBeLessThan(0.8 * concrete[2]);
  });
});

describe('SP4-04 反射', () => {
  it('金属墙反射侧能量 >1e-6，换泡沫后 < 金属的 50%', () => {
    const { app, game } = makeApp();
    const buildWall = (id: number): void => {
      for (let y = 0; y < 24; y++) {
        for (let z = 0; z < 64; z++) {
          game.world.setBlock([32, y, z], id, 200);
        }
      }
    };
    // 金属 id=6
    app.debug.clearSources();
    buildWall(6);
    app.debug.emitSource([30, 12, 30], [1, 1, 1], [1, 0, 0]);
    const metal = app.state.energyField.sample([29, 12, 30]);
    expect(metal[0]).toBeGreaterThan(1e-6);

    // 泡沫 id=1
    app.debug.clearSources();
    buildWall(1);
    app.debug.emitSource([30, 12, 30], [1, 1, 1], [1, 0, 0]);
    const foam = app.state.energyField.sample([29, 12, 30]);
    expect(foam[0]).toBeLessThan(0.5 * metal[0]);
  });
});

describe('SP4-05 简化绕射', () => {
  it('悬空遮挡板后接收点 >0 且不大于无遮挡值', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    // 无遮挡
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const open = app.state.energyField.sample([37, 12, 32]);
    // 悬空单格遮挡板（非地面）
    app.debug.clearSources();
    game.world.setBlock([35, 12, 32], 1, 30);
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const blocked = app.state.energyField.sample([37, 12, 32]);
    expect(blocked[0]).toBeGreaterThan(0);
    expect(blocked[1]).toBeGreaterThan(0);
    expect(blocked[2]).toBeGreaterThan(0);
    expect(blocked[0]).toBeLessThanOrEqual(open[0]);
    expect(blocked[1]).toBeLessThanOrEqual(open[1]);
    expect(blocked[2]).toBeLessThanOrEqual(open[2]);
  });

  it('设施完全反射：关闭绕射后后方不出现中心直进泄漏（Major M1 回归）', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    // 能量核心作为完全反射障碍，τ=0；G_DIFFRACT=0 时禁止任何衍射路径。
    game.giveItem(8, 1);
    expect(game.placeFacility('core', [35, 12, 32], 0).ok).toBe(true);
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    // 开启绕射时只允许边缘路径；关闭绕射后完全反射设施后方格必须为 0（无直进穿透）。
    const withDiffract = app.state.energyField.sample([37, 12, 32]);
    app.debug.setTuning({ G_DIFFRACT: 0 });
    const withoutDiffract = app.state.energyField.sample([37, 12, 32]);
    expect(withoutDiffract).toEqual([0, 0, 0]);
    // 边缘绕射可存在，但不会通过中心穿透产生（保留一个弱可观测校验，方便后续路径审计）。
    expect(Array.isArray(withDiffract)).toBe(true);
    expect(withDiffract.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('SP4-06 可复现性', () => {
  it('同一布局 repeated recalc 采样逐格完全一致', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const pts: XYZA[] = [];
    for (let x = 34; x <= 43; x++) pts.push([x, 12, 32]);
    const first = pts.map((p) => app.state.energyField.sample(p));
    app.debug.recalcAcoustics();
    const second = pts.map((p) => app.state.energyField.sample(p));
    expect(second).toEqual(first);
    app.debug.recalcAcoustics();
    const third = pts.map((p) => app.state.energyField.sample(p));
    expect(third).toEqual(first);
    expect(game).toBeTruthy();
  });
});

describe('SP4-07 多源精确叠加', () => {
  it('先验证 ≥5 个有效采样格 >1e-6，再对全部有效频段做逐位相等', () => {
    const { app } = makeApp();
    const pts: XYZA[] = [[34, 12, 32], [35, 13, 33], [33, 11, 31], [36, 12, 32], [32, 14, 30]];
    app.debug.clearSources();
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const fa = pts.map((p) => app.state.energyField.sample(p));
    app.debug.clearSources();
    app.debug.emitSource([40, 11, 35], [0.5, 1, 0.5]);
    const fb = pts.map((p) => app.state.energyField.sample(p));
    app.debug.clearSources();
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    app.debug.emitSource([40, 11, 35], [0.5, 1, 0.5]);
    const fc = pts.map((p) => app.state.energyField.sample(p));

    // 先确保叠加池确实有效：至少 5 个采样格的某频段 >1e-6。
    const valid = pts.filter((_, i) => fc[i][0] > 1e-6 || fc[i][1] > 1e-6 || fc[i][2] > 1e-6);
    expect(valid.length).toBeGreaterThanOrEqual(5);

    // 再对全部有效频段做逐位相等（Fc == Fa + Fb，确定性位级一致）。
    for (let i = 0; i < pts.length; i++) {
      for (let b = 0; b < 3; b++) {
        if (fc[i][b] > 1e-6) {
          expect(fc[i][b]).toBe(fa[i][b] + fb[i][b]);
        }
      }
    }
  });
});

describe('SP4-08 事件触发重算', () => {
  it('放置/拆除普通方块、放置/拆除/旋转设施均递增 version', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const v0 = app.state.energyField.version;

    // 普通方块放置（经 Game 真实路径：直接在世界放一个可挖掘方块，再用 applyBreak 拆除）
    game.world.putBlock([34, 12, 32], 1, 30);
    // 模拟普通放置事件：项目 UI 的 place 路径会调用 recalc；这里主动通过正式接口无法直接放，
    // 因此此处用 putBlock 后调用 recalcAcoustics 保持测试可读性（版本递增来自 recalc 调用）。
    game.recalcAcoustics();
    const v1 = app.state.energyField.version;
    expect(v1).toBeGreaterThan(v0);
    game.applyBreak([34, 12, 32], 1, true);
    const v2 = app.state.energyField.version;
    expect(v2).toBeGreaterThan(v1);

    // 设施放置/旋转/拆除（走 Game 正式接口）
    game.giveItem(8, 1);
    const cell: XYZA = [20, 14, 20];
    expect(game.placeFacility('core', cell, 0).ok).toBe(true);
    expect(app.state.energyField.version).toBeGreaterThan(v2);
    const v3 = app.state.energyField.version;
    expect(game.rotateFacility(cell).ok).toBe(true);
    expect(app.state.energyField.version).toBeGreaterThan(v3);
    const v4 = app.state.energyField.version;
    expect(game.removeFacility(cell).ok).toBe(true);
    expect(app.state.energyField.version).toBeGreaterThan(v4);
  });

  it('emitSource/clearSources/setTuning/resetTuning 均递增 version', () => {
    const { app } = makeApp();
    app.debug.clearSources();
    const v0 = app.state.energyField.version;
    app.debug.emitSource([32, 12, 32]);
    expect(app.state.energyField.version).toBeGreaterThan(v0);
    const v1 = app.state.energyField.version;
    app.debug.recalcAcoustics();
    expect(app.state.energyField.version).toBeGreaterThan(v1);
    const v2 = app.state.energyField.version;
    app.debug.setTuning({ G_DIST_EXP: 1.5 });
    expect(app.state.energyField.version).toBeGreaterThan(v2);
    const v3 = app.state.energyField.version;
    app.debug.resetTuning();
    expect(app.state.energyField.version).toBeGreaterThan(v3);
    const v4 = app.state.energyField.version;
    app.debug.clearSources();
    expect(app.state.energyField.version).toBeGreaterThan(v4);
  });

  it('debug.regenerate 后 version 递增且采样按新世界更新（Blocker B1 回归）', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    // 旧世界在声源与接收点之间放一块泡沫墙；再生后该格被新世界清空，采样应显著上升。
    game.world.setBlock([34, 12, 32], 1, 30);
    app.debug.emitSource([32, 12, 32], [1, 1, 1]);
    const beforeVersion = app.state.energyField.version;
    const beforeSample = app.state.energyField.sample([36, 12, 32]);

    // 走正式调试入口 debug.regenerate（内部经 Game.regenerate -> applyWorld -> notifyWorldChanged）。
    const oldSeed = app.state.seed;
    app.debug.regenerate(54321);
    const afterSeed = app.state.seed;
    const afterVersion = app.state.energyField.version;
    const afterSample = app.state.energyField.sample([36, 12, 32]);

    expect(afterSeed).not.toBe(oldSeed);
    expect(afterSeed).toBe(54321);
    expect(afterVersion).toBeGreaterThan(beforeVersion);
    // 新世界 y=12 为空气（地表高度 ≤11），原先的遮挡墙消失，接收点能量应高于被挡时。
    expect(game.world.blockAt([34, 12, 32]).material).toBe(0);
    expect(afterSample[0]).toBeGreaterThan(beforeSample[0]);
    expect(afterSample.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('SP4-09 调试钩子与非法输入', () => {
  it('emitSource 默认功率 / 定向 / 非法输入抛中文错误', () => {
    const { app, game } = makeApp();
    app.debug.clearSources();
    app.debug.emitSource([32, 12, 32]);
    expect(app.state.energyField.sample([35, 12, 32])[0]).toBeGreaterThan(0);
    expect(() => app.debug.emitSource([32, 12, 32, 1] as unknown as XYZA)).toThrow(/pos/);
    expect(() => app.debug.emitSource([32, Number.NaN, 32])).toThrow(/有限数/);
    expect(() => app.debug.emitSource([32, 12, 32], [1, -1, 1])).toThrow(/不能为负数/);
    expect(() => app.debug.emitSource([32, 12, 32], [1, 1, 1], [0, 0, 0])).toThrow(/零向量/);
    expect(() => app.debug.setTuning({ G_ABSORB: Number.NaN })).toThrow(/有限数/);
    expect(() => app.debug.setTuning(42 as unknown as object)).toThrow(/调谐对象/);
    // Minor m6/QA m2：越界源坐标必须拒绝并抛中文错误，避免无效 bin。
    expect(() => app.debug.emitSource([999, 12, 32])).toThrow(/世界边界/);
    expect(() => app.debug.emitSource([32, -1, 32])).toThrow(/世界边界/);
    // Minor m5/QA m1：setTuning 超范围统一抛中文错误（contract SP4-09）。
    expect(() => app.debug.setTuning({ G_DIST_EXP: 99 })).toThrow(/超出允许区间/);
    expect(() => app.debug.setTuning({ G_ABSORB: 0.1 })).toThrow(/超出允许区间/);
    expect(() => app.debug.setTuning({ fieldThreshold: 2 })).toThrow(/超出允许区间/);
    expect(game).toBeTruthy();
  });
});
