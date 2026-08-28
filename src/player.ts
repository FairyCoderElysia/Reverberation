/**
 * M5（玩家部分，S2）：确定性第一人称物理（重力/跳跃/AABB 碰撞）。
 * 碰撞查询复用 world.ts 的唯一索引公式与 blockAt；不在此自写第二套体素索引。
 * 同一输入序列 + 同一固定步 dt → 同一 position（SP2-12 碰撞确定性）。
 */
import {
  PLAYER_GRAVITY,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  PLAYER_JUMP_SPEED,
  PLAYER_TERMINAL_FALL,
  PLAYER_WALK_SPEED,
} from './config';
import type { World } from './world';

/** 玩家身体（脚底中心浮点坐标；yaw 绕 Y 轴，pitch 绕 X 轴） */
export interface PlayerBody {
  pos: [number, number, number];
  vel: [number, number, number];
  yaw: number;
  pitch: number;
  grounded: boolean;
}

/** 一轮输入意图（-1..1 归一化） */
export interface PlayerInput {
  forward: number; // +1 前进 -1 后退
  right: number; // +1 右移 -1 左移
  jump: boolean;
}

/** 视线方向（yaw/pitch → 单位向量，供拾取射线用）。注意：yaw 约定为绕 Y，yaw=0 朝 -Z。 */
export function lookDirection(yaw: number, pitch: number): [number, number, number] {
  const cy = Math.cos(pitch);
  return [-Math.sin(yaw) * cy, Math.sin(pitch), -Math.cos(yaw) * cy];
}

/** 玩家 AABB 是否与任何实体方块相交（使用 world.blockAt 的唯一索引来源） */
export function aabbIntersects(world: World, pos: [number, number, number]): boolean {
  const [px, py, pz] = pos;
  // 用 1e-7 收缩上界，避免 AABB 恰好贴住整数边界时误判穿越相邻格
  const x0 = Math.floor(px - PLAYER_HALF_WIDTH);
  const x1 = Math.floor(px + PLAYER_HALF_WIDTH - 1e-7);
  const y0 = Math.floor(py);
  const y1 = Math.floor(py + PLAYER_HEIGHT - 1e-7);
  const z0 = Math.floor(pz - PLAYER_HALF_WIDTH);
  const z1 = Math.floor(pz + PLAYER_HALF_WIDTH - 1e-7);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (world.blockAt([x, y, z]).material !== 0) return true;
      }
    }
  }
  return false;
}

/** 脚底正下方是否为实体（用于落地判定） */
export function isOnGround(world: World, pos: [number, number, number]): boolean {
  return aabbIntersects(world, [pos[0], pos[1] - 0.001, pos[2]]);
}

function clampPitch(p: number): number {
  const max = Math.PI * 0.49; // 不翻越上下垂直
  if (p > max) return max;
  if (p < -max) return -max;
  return p;
}

/**
 * 固定步推进（确定性）。轴分离顺序固定为 X → Z → Y；前进方向由 yaw 决定。
 * 返回推进后的 body（就地修改传入对象，调用方持有）。
 */
export function stepPlayer(
  body: PlayerBody,
  input: PlayerInput,
  dt: number,
  world: World,
): PlayerBody {
  // 1. 水平速度（yaw 决定前/右方向；与 lookDirection 同一约定：yaw=0 朝 -Z；对角归一化避免斜走加速）
  const fx = -Math.sin(body.yaw);
  const fz = -Math.cos(body.yaw);
  const rx = Math.cos(body.yaw);
  const rz = -Math.sin(body.yaw);

  let mx = fx * input.forward + rx * input.right;
  let mz = fz * input.forward + rz * input.right;
  const mlen = Math.sqrt(mx * mx + mz * mz);
  if (mlen > 1) {
    mx /= mlen;
    mz /= mlen;
  }
  const vx = mx * PLAYER_WALK_SPEED;
  const vz = mz * PLAYER_WALK_SPEED;

  // 2. X 轴（分离轴：先 X 后 Z）
  const nx = body.pos[0] + vx * dt;
  if (!aabbIntersects(world, [nx, body.pos[1], body.pos[2]])) {
    body.pos[0] = nx;
  } else {
    body.vel[0] = 0;
  }

  // 3. Z 轴
  const nz = body.pos[2] + vz * dt;
  if (!aabbIntersects(world, [body.pos[0], body.pos[1], nz])) {
    body.pos[2] = nz;
  } else {
    body.vel[2] = 0;
  }

  // 4. 落地判定（脚下 0.001 处的 AABB 是否实体）
  body.grounded = isOnGround(world, body.pos);

  // 5. 重力（固定步；禁 Math.random，确定性）
  body.vel[1] -= PLAYER_GRAVITY * dt;
  if (body.vel[1] < -PLAYER_TERMINAL_FALL) body.vel[1] = -PLAYER_TERMINAL_FALL;
  if (input.jump && body.grounded) {
    body.vel[1] = PLAYER_JUMP_SPEED;
    body.grounded = false;
  }

  // 6. Y 轴
  const ny = body.pos[1] + body.vel[1] * dt;
  if (!aabbIntersects(world, [body.pos[0], ny, body.pos[2]])) {
    body.pos[1] = ny;
  } else {
    if (body.vel[1] < 0) body.grounded = true;
    body.vel[1] = 0;
  }

  return body;
}

/** 增量视角（拖动）：pitch 夹取、yaw 保持连续。 */
export function applyLook(body: PlayerBody, dx: number, dy: number, sensitivity: number): void {
  body.yaw -= dx * sensitivity;
  body.pitch = clampPitch(body.pitch - dy * sensitivity);
}
