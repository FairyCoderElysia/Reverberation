/**
 * M9 存档（S2 初版 + S3 v2 扩展）：单键 localStorage + schema version + RLE 二进制。
 * S2：ids/placed 二进制，durability 不单独序列化（恢复时由材料常量派生）。
 * S3：SAVE_VERSION=2，payload 增加 facilities（{cell,kind,yaw}）、timeOfDay、day，
 *     并对旧 v1 档自动迁移（补零库存、selected 夹取、设施空、时间 0/day 0）。
 * 损坏 / 版本 0、3+ 仍按 invalid 处理并中文提示，不白屏。
 */
import { SAVE_KEY, SAVE_VERSION } from './config';
import { WORLD_X, WORLD_Y, WORLD_Z } from './world';
import type { FacilitySnapshot, FacilityKind } from './types';

/** 可注入存储（浏览器为 localStorage；测试可用内存 Map 替代）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 存档负载（ids/placed 为解码后的世界数组；持久化时由 serializeSave 转 RLE+base64）。 */
export interface SavePayload {
  version: number;
  seed: number;
  ids: Uint8Array;
  placed: Uint8Array;
  inventory: number[];
  selected: number;
  playerPos: [number, number, number];
  playerYaw: number;
  playerPitch: number;
  facilities: FacilitySnapshot[];
  timeOfDay: number;
  day: number;
  savedAt: number;
}

export const WORLD_CELLS = 64 * 64 * 24; // 98304

/** RLE（byte, count 步长≤255）→ base64。确定性。 */
export function encodeRle(data: Uint8Array): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < data.length) {
    const v = data[i];
    let count = 0;
    while (count < 255 && i < data.length && data[i] === v) {
      count += 1;
      i += 1;
    }
    bytes.push(count, v);
  }
  let bin = '';
  for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
  return btoa(bin);
}

/** base64 → RLE → Uint8Array(长度必须为 expectedLen，否则返回 null)。 */
export function decodeRle(b64: string, expectedLen: number): Uint8Array | null {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(expectedLen);
  let o = 0;
  let i = 0;
  while (i < bin.length) {
    if (i + 1 >= bin.length) return null;
    const count = bin.charCodeAt(i);
    const value = bin.charCodeAt(i + 1);
    if (!Number.isInteger(count) || count <= 0 || count > 255 || Number.isNaN(value)) return null;
    for (let k = 0; k < count; k++) {
      if (o >= expectedLen) return null;
      out[o] = value;
      o += 1;
    }
    i += 2;
  }
  return o === expectedLen ? out : null;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const FACILITY_KINDS: readonly string[] = ['core', 'cannon', 'probe', 'duct', 'relay'];

function validFacilityKind(v: unknown): v is FacilityKind {
  return typeof v === 'string' && (FACILITY_KINDS as readonly string[]).includes(v);
}

function parseFacilities(raw: unknown): FacilitySnapshot[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: FacilitySnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const cell = o.cell;
    if (
      !Array.isArray(cell) ||
      cell.length !== 3 ||
      !Number.isInteger(cell[0]) ||
      !Number.isInteger(cell[1]) ||
      !Number.isInteger(cell[2]) ||
      !(
        (cell[0] as number) >= 0 &&
        (cell[0] as number) < WORLD_X &&
        (cell[1] as number) >= 0 &&
        (cell[1] as number) < WORLD_Y &&
        (cell[2] as number) >= 0 &&
        (cell[2] as number) < WORLD_Z
      )
    ) return null;
    if (!validFacilityKind(o.kind)) return null;
    if (!finite(o.yaw)) return null;
    out.push({
      cell: [cell[0], cell[1], cell[2]],
      kind: o.kind,
      yaw: o.yaw,
    });
  }
  return out;
}

export interface ParseResult {
  ok: boolean;
  payload?: SavePayload;
  error?: string;
}

/** 解析并校验存档字符串；任何字段异常 → { ok:false, error:中文说明 }。 */
export function parseSave(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '存档数据损坏（JSON 解析失败），已回退到全新世界。' };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== 'number' || (o.version !== 1 && o.version !== SAVE_VERSION)) {
    return {
      ok: false,
      error: '存档版本不兼容（version=' + String(o.version) + '，当前支持 v' + SAVE_VERSION + '），已回退到全新世界。',
    };
  }
  const isV1 = o.version === 1;
  if (!finite(o.seed)) return { ok: false, error: '存档种子字段非法，已回退到全新世界。' };

  const ids = decodeRle(typeof o.idsB64 === 'string' ? o.idsB64 : '', WORLD_CELLS);
  const placed = decodeRle(typeof o.placedB64 === 'string' ? o.placedB64 : '', WORLD_CELLS);
  if (!ids || !placed) {
    return { ok: false, error: '存档世界数据损坏（长度校验失败），已回退到全新世界。' };
  }

  const inventoryRaw = Array.isArray(o.inventory) ? o.inventory : [];
  const inventory: number[] = new Array(13).fill(0);
  const maxCopy = isV1 ? 7 : 12;
  for (let i = 1; i <= maxCopy; i++) {
    const v = inventoryRaw[i];
    inventory[i] = finite(v) && v > 0 ? Math.floor(v) : 0;
  }

  const selected =
    finite(o.selected) && Number.isInteger(o.selected)
      ? isV1
        ? o.selected >= 1 && o.selected <= 7
          ? o.selected
          : 1
        : o.selected >= 1 && o.selected <= 12
          ? o.selected
          : 1
      : 1;

  const posRaw = Array.isArray(o.playerPos) ? o.playerPos : null;
  const playerPos: [number, number, number] =
    posRaw && posRaw.length === 3 && finite(posRaw[0]) && finite(posRaw[1]) && finite(posRaw[2])
      ? [posRaw[0], posRaw[1], posRaw[2]]
      : [32, 12, 32];

  const facilities = parseFacilities(o.facilities);
  if (!facilities) {
    return { ok: false, error: '存档设施数据损坏，已回退到全新世界。' };
  }

  const timeOfDay = isV1
    ? 0
    : finite(o.timeOfDay)
      ? Math.min(0.999999, Math.max(0, o.timeOfDay))
      : 0;
  const day = isV1
    ? 0
    : finite(o.day) && o.day > 0
      ? Math.floor(o.day)
      : 0;

  return {
    ok: true,
    payload: {
      version: o.version,
      seed: o.seed,
      ids,
      placed,
      inventory,
      selected,
      playerPos,
      playerYaw: finite(o.playerYaw) ? o.playerYaw : 0,
      playerPitch: finite(o.playerPitch) ? o.playerPitch : 0,
      facilities,
      timeOfDay,
      day,
      savedAt: finite(o.savedAt) ? o.savedAt : 0,
    },
  };
}

/** 序列化存档（世界里数组 → RLE + base64 + 设施/时钟 → JSON 字符串）。 */
export function serializeSave(p: SavePayload): string {
  return JSON.stringify({
    version: p.version,
    seed: p.seed,
    idsB64: encodeRle(p.ids),
    placedB64: encodeRle(p.placed),
    inventory: p.inventory,
    selected: p.selected,
    playerPos: p.playerPos,
    playerYaw: p.playerYaw,
    playerPitch: p.playerPitch,
    facilities: p.facilities,
    timeOfDay: p.timeOfDay,
    day: p.day,
    savedAt: p.savedAt,
  });
}

export function readSaveRaw(storage: StorageLike): string | null {
  return storage.getItem(SAVE_KEY);
}

export function writeSaveRaw(storage: StorageLike, text: string): void {
  storage.setItem(SAVE_KEY, text);
}

export function removeSave(storage: StorageLike): void {
  storage.removeItem(SAVE_KEY);
}

export function saveKey(): string {
  return SAVE_KEY;
}
