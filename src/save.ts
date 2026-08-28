/**
 * M9 存档（S2 初版）：单键 localStorage + schema version + RLE 二进制（ids/placed）。
 * S2 的 durability 不单独序列化（恢复时由材料常量派生）——contract SP2-07。
 * 损坏 / 版本不兼容回退为「无存档」并由调用方给中文提示，不白屏。
 */
import { SAVE_KEY, SAVE_VERSION } from './config';

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
  if (typeof o.version !== 'number' || o.version !== SAVE_VERSION) {
    return {
      ok: false,
      error: '存档版本不兼容（version=' + String(o.version) + '，当前支持 v' + SAVE_VERSION + '），已回退到全新世界。',
    };
  }
  if (!finite(o.seed)) return { ok: false, error: '存档种子字段非法，已回退到全新世界。' };

  const ids = decodeRle(typeof o.idsB64 === 'string' ? o.idsB64 : '', WORLD_CELLS);
  const placed = decodeRle(typeof o.placedB64 === 'string' ? o.placedB64 : '', WORLD_CELLS);
  if (!ids || !placed) {
    return { ok: false, error: '存档世界数据损坏（长度校验失败），已回退到全新世界。' };
  }

  const inventoryRaw = Array.isArray(o.inventory) ? o.inventory : [];
  const inventory: number[] = new Array(8).fill(0);
  for (let i = 1; i <= 7; i++) {
    const v = inventoryRaw[i];
    inventory[i] = finite(v) && v > 0 ? Math.floor(v) : 0;
  }
  const selected =
    finite(o.selected) && Number.isInteger(o.selected) && o.selected >= 1 && o.selected <= 7 ? o.selected : 1;

  const posRaw = Array.isArray(o.playerPos) ? o.playerPos : null;
  const playerPos: [number, number, number] =
    posRaw && posRaw.length === 3 && finite(posRaw[0]) && finite(posRaw[1]) && finite(posRaw[2])
      ? [posRaw[0], posRaw[1], posRaw[2]]
      : [32, 12, 32];

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
      savedAt: finite(o.savedAt) ? o.savedAt : 0,
    },
  };
}

/** 序列化存档（世界里数组 → RLE + base64 → JSON 字符串）。 */
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
