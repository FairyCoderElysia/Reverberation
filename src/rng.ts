/**
 * 确定性的种子随机数发生器（mulberry32）。
 * 世界生成路径禁止 Math.random；只允许使用本模块注入种子的 RNG。
 */

/** 返回一个 [0,1) 的确定性伪随机函数（mulberry32） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 返回 [lo, hi] 闭区间内的随机整数（含两端） */
export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}
