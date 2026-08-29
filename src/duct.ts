/**
 * Sprint 7 专用导管/中继网络模块。
 *
 * 网络模型（contract v1.3）：
 * - 节点 = duct / relay 设施格。
 * - 边 = 6 邻接（x/y/z 相邻）节点。
 * - 入口 = 与任何活动声源格 6 邻接的节点；entryEnergy = energyField.sample(entryCell)。
 * - BFS 首次发现/生成树：入口按 grid index 升序入队，邻居序固定
 *   +X,-X,+Y,-Y,+Z,-Z；每个节点只在首次发现时赋值一次，不合并、不松弛、不放大。
 * - DUCT_TRANSMIT/RELAY_GAIN 常量来自 config.ts 单源。
 * - 入口节点本身是 relay 时不执行入口增益；增益仅在从另一节点进入 relay 时生效。
 * - 出口 = 与任一 core 6 邻接的节点；全局出口按节点去重求和，多核心不重复计账。
 *
 * 本模块是网络能量的唯一实现处；UI/渲染不得另算。
 */
import { DUCT_TRANSMIT, RELAY_GAIN } from './config';
import type { BandEnergy, FacilityKind, FacilityState, XYZA } from './types';
import { blockCoords, blockIndex, inBounds } from './world';
import type { World } from './world';

export type DuctNodeKind = 'duct' | 'relay';

export interface DuctNetworkNode {
  cell: XYZA;
  kind: DuctNodeKind;
  energy: BandEnergy;
}

export interface DuctNetworkState {
  /** 每次网络重算递增（reset/loadSave/regenerate 也走重算路径）。 */
  version: number;
  /** 全部 duct/relay 节点（含未连通节点，未连通能量为 [0,0,0]）；按 grid index 升序。 */
  nodes: DuctNetworkNode[];
  /** 全局出口去重后的三频网络能量和（供 core 入账只使用一次）。运行时不持久化。 */
  networkTotal: BandEnergy;
}

/** 固定邻居访问序：+X,-X,+Y,-Y,+Z,-Z（contract v1.3 钉死）。 */
export const DUCT_NEIGHBOR_ORDER: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function zeroBand(): BandEnergy {
  return [0, 0, 0];
}

function cloneBand(e: BandEnergy): BandEnergy {
  return [e[0], e[1], e[2]];
}

function addBand(target: BandEnergy, src: BandEnergy): void {
  target[0] += src[0];
  target[1] += src[1];
  target[2] += src[2];
}

function isDuctOrRelay(kind: FacilityKind): kind is DuctNodeKind {
  return kind === 'duct' || kind === 'relay';
}

function hasAdjacentCell(cell: XYZA, targets: readonly number[]): boolean {
  const [x, y, z] = cell;
  for (const [dx, dy, dz] of DUCT_NEIGHBOR_ORDER) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (!inBounds(nx, ny, nz)) continue;
    const ni = blockIndex(nx, ny, nz);
    if (targets.includes(ni)) return true;
  }
  return false;
}

/**
 * 计算导管网络（纯函数）。
 *
 * @param world 只读世界（含设施）
 * @param energyField 声学能量场（entry 能量唯一来源）
 * @param sourceCells 当前活动声源格（固定环境源 + 调试源）
 * @param version 本次网络版本号（由调用方递增）
 */
export function computeDuctNetwork(
  world: World,
  energyField: { sample: (g: XYZA) => BandEnergy },
  sourceCells: readonly XYZA[],
  version: number,
): DuctNetworkState {
  const facilities = world
    .facilityStates()
    .filter((f): f is FacilityState & { kind: DuctNodeKind } => isDuctOrRelay(f.kind))
    .sort((a, b) => a.pos - b.pos);

  const sourceIds: number[] = [];
  for (const cell of sourceCells) {
    if (!inBounds(cell[0], cell[1], cell[2])) continue;
    sourceIds.push(blockIndex(cell[0], cell[1], cell[2]));
  }

  const coreIds: number[] = [];
  for (const c of world.facilityStates()) {
    if (c.kind === 'core') coreIds.push(c.pos);
  }

  const nodes: DuctNetworkNode[] = facilities.map((f) => ({
    cell: blockCoords(f.pos),
    kind: f.kind,
    energy: zeroBand(),
  }));
  const nodeByPos = new Map<number, DuctNetworkNode>();
  for (let i = 0; i < facilities.length; i++) {
    nodeByPos.set(facilities[i].pos, nodes[i]);
  }

  const discovered = new Set<number>();
  const queue: Array<{ pos: number; energy: BandEnergy }> = [];

  // 入口：与声源格 6 邻接的节点，按 grid index 升序作为 BFS 初始队列。
  const entries = facilities.filter((f) => hasAdjacentCell(blockCoords(f.pos), sourceIds));
  entries.sort((a, b) => a.pos - b.pos);
  for (const f of entries) {
    const node = nodeByPos.get(f.pos);
    if (!node || discovered.has(f.pos)) continue;
    const cell = blockCoords(f.pos);
    const e = energyField.sample(cell);
    // 入口初始值不额外乘 DUCT_TRANSMIT；入口 relay 也不执行入口增益。
    node.energy = cloneBand(e);
    discovered.add(f.pos);
    queue.push({ pos: f.pos, energy: cloneBand(e) });
  }

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const curCell = blockCoords(cur.pos);
    for (const [dx, dy, dz] of DUCT_NEIGHBOR_ORDER) {
      const nx = curCell[0] + dx;
      const ny = curCell[1] + dy;
      const nz = curCell[2] + dz;
      if (!inBounds(nx, ny, nz)) continue;
      const ni = blockIndex(nx, ny, nz);
      const nextNode = nodeByPos.get(ni);
      if (!nextNode || discovered.has(ni)) continue;
      const cand: BandEnergy = [
        cur.energy[0] * DUCT_TRANSMIT,
        cur.energy[1] * DUCT_TRANSMIT,
        cur.energy[2] * DUCT_TRANSMIT,
      ];
      if (nextNode.kind === 'relay') {
        cand[0] *= RELAY_GAIN;
        cand[1] *= RELAY_GAIN;
        cand[2] *= RELAY_GAIN;
      }
      nextNode.energy = cand;
      discovered.add(ni);
      queue.push({ pos: ni, energy: cloneBand(cand) });
    }
  }

  // 出口：与任一 core 6 邻接的节点，按节点去重求和（每个节点只计一次）。
  const networkTotal = zeroBand();
  for (const node of nodes) {
    if (hasAdjacentCell(node.cell, coreIds)) {
      addBand(networkTotal, node.energy);
    }
  }

  return {
    version,
    nodes,
    networkTotal,
  };
}

/** 从网络状态读取某格的节点能量；合法非节点返回 [0,0,0]。 */
export function ductEnergyFromNetwork(network: DuctNetworkState, cell: XYZA): BandEnergy {
  if (!inBounds(cell[0], cell[1], cell[2])) return zeroBand();
  const node = network.nodes.find((n) => n.cell[0] === cell[0] && n.cell[1] === cell[1] && n.cell[2] === cell[2]);
  if (!node) return zeroBand();
  return cloneBand(node.energy);
}
