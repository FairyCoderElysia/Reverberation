/**
 * 可调参数默认值（tech-design 附录「可调参数默认值总表」）。
 * 单一数据源；Game 物理层之外的全局缩放系数（acoustics.tuning）在 S3 落地，
 * 本 sprint 仅保留会在窗口/渲染用到的常量，避免散落写死。
 */

/** 世界尺寸：64×64×24（有界 demo 地图） */
export const WORLD_SIZE: [number, number, number] = [64, 64, 24];

/** 地形高度范围（保证固定声源 y=12 永远处于空中、地表可站立） */
export const TERRAIN_MIN_H = 6;
export const TERRAIN_MAX_H = 11;

/** 地表最上层土壤厚度（格） */
export const SOIL_DEPTH = 1;

/** 每条材料矿脉的最小半径（保证矿脉至少覆盖 1 格非空） */
export const VEIN_MIN_RADIUS = 2;

/** 图形档渲染像素比（high 随设备 DPR 但封顶；low 固定降采样） */
export const PIXEL_RATIO_HIGH_CAP = 2;
export const PIXEL_RATIO_LOW = 0.75;

/** DDA 基准采样的射线最大距离（格，防御性上限） */
export const BENCH_RAY_MAX_DIST = 200;

