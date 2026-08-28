/**
 * 可调参数默认值（tech-design 附录「可调参数默认值总表」+\ S2 增量）。
 * 单一数据源；renderer / game / ui 一律从本文件引用，禁止散落写死。
 */

/** 图形档渲染像素比（Code N1：high 随设备 DPR 但封顶；low 固定降采样） */
export const PIXEL_RATIO_HIGH_CAP = 2;
export const PIXEL_RATIO_LOW = 0.75;

/** 地形高度范围（保证固定声源 y=12 永远处于空中、地表可站立） */
export const TERRAIN_MIN_H = 6;
export const TERRAIN_MAX_H = 11;

/** 每条材料矿脉的最小半径（保证矿脉至少覆盖 1 格非空） */
export const VEIN_MIN_RADIUS = 2;

/** DDA 基准采样的射线最大距离（格，防御性上限） */
export const BENCH_RAY_MAX_DIST = 200;

/* ==== Sprint 2 增量（单一来源；tech-design §附回写项） ==== */

/** 挖掘/放置/拆除交互距离上限（格），state.interactionReach 引用此处 */
export const INTERACTION_REACH = 6;

/** 挖掘一个方块所需持续命中时长（秒） */
export const MINING_SECONDS = 1.2;

/** 玩家 AABB：半宽（水平，格）与身高（格） */
export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
/** 视角（相机）离脚底高度（格） */
export const PLAYER_EYE_HEIGHT = 1.62;

/** 第一人称移动参数（格/秒、格/秒²、格/秒）——可辩护的夸张物理 */
export const PLAYER_WALK_SPEED = 4.5;
export const PLAYER_GRAVITY = 22;
export const PLAYER_JUMP_SPEED = 8.0;
export const PLAYER_TERMINAL_FALL = 40;
/** 鼠标视角灵敏度（弧度 / 像素） */
export const LOOK_SENSITIVITY = 0.0025;

/** 物理固定步进（Hz）：碰撞/重力按固定步推进，保证相同输入序列确定性 */
export const PHYS_HZ = 60;

/** 单档存档键与 schema 版本 */
export const SAVE_KEY = 'voice.save.v1';
export const SAVE_VERSION = 1;
