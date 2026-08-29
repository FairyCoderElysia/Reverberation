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

/**
 * 玩家物理固定步进（Hz）：碰撞/重力按固定步推进，保证相同输入序列确定性。
 * 仅用于玩家碰撞/重力；「PHYS_HZ」名义保留给未来声学模拟 10-20Hz 步进，勿混用。
 */
export const PLAYER_PHYS_HZ = 60;

/** 跳跃缓冲（ms）：Space keydown 边沿在限定时间内保留，快速点按不会因 keyup 落在同一帧而漏跳。 */
export const JUMP_BUFFER_MS = 150;

/** 移动自动存档节流（ms）：玩家位置/朝向发生变化后，至少间隔该时长才写一次档（避免每帧写档）。 */
export const AUTOSAVE_MOVE_INTERVAL_MS = 2000;

/** S3 最小时钟：全天相位时长（秒）—— 420s = 7 分钟（terr-design DAY_LEN/NIGHT_LEN 210+210）。 */
export const DAY_LENGTH_SECONDS = 420;

/** 存档序列化体积预警阈值（字节）：超过在状态行提示，不阻塞写档 */
export const SAVE_SIZE_WARN_BYTES = 40 * 1024;

/** 单档存档键与 schema 版本 */
export const SAVE_KEY = 'voice.save.v1';
export const SAVE_VERSION = 2;

/** 轨道俯瞰默认参数（F4B）：距离/初始偏航/俯仰；target 由 Game 启动时设为玩家出生点附近。 */
export const ORBIT_DEFAULT_DISTANCE = 42;
export const ORBIT_DEFAULT_YAW = Math.PI * 0.25;
export const ORBIT_DEFAULT_PITCH = 0.62;

/* ==== Sprint 4 声学参数默认值（tech-design 附录「可调参数默认值总表」；单一来源） ==== */

/** 声学传播默认参数（S4 只使用默认档，F7C 降级后续接入）。 */
export const ACOUSTIC_DEFAULT_PARAMS = {
  rays: 128,
  bounces: 3,
  diffract: true,
  // 默认取 1e-6：低于 tech-design 附录的 1e-4，是为了保留 SP4-02/SP4-05 所要求的
  // 远场 >1e-6 与遮挡后 >0 的低能量可读格；高于 0 仍能实现真实阈值稀疏化。
  fieldThreshold: 1e-6,
} as const;

/** Sprint 5 性能档：high 档射线/反弹预算（与默认档一致；引用默认参数，避免双份漂移）。 */
export const ACOUSTIC_PARAMS_HIGH = { ...ACOUSTIC_DEFAULT_PARAMS } as const;

/** Sprint 5 性能档：low 档射线/反弹预算（tech-design §5.4：64×2）。 */
export const ACOUSTIC_PARAMS_LOW = {
  rays: 64,
  bounces: 2,
  diffract: true,
  fieldThreshold: 1e-6,
} as const;

/** Sprint 5 性能档：模拟目标频率（可 null；本版为事件触发式，读作目标值）。 */
export const SIM_PHYSICS_HZ_HIGH = 15;
export const SIM_PHYSICS_HZ_LOW = 10;

/** Sprint 5 声场视图采样密度：high 每 2 格采样一次，low 每 3 格采样一次（保证 low visualInstances 严格下降）。 */
export const SOUND_VIEW_SAMPLE_STEP_HIGH = 2;
export const SOUND_VIEW_SAMPLE_STEP_LOW = 3;

/** Sprint 5 声场视图视觉强度映射系数（能量→亮度，单一来源；非物理系数，仅展示编码）。 */
export const SOUND_VIEW_STRENGTH_SCALE = 20;

/** 声学全局缩放默认值（唯一夸张层；debug.setTuning 可覆写运行时副本）。 */
export const ACOUSTIC_DEFAULT_TUNING = {
  G_ABSORB: 1.0,
  G_TRANS: 1.0,
  G_DIST_EXP: 2.0,
  G_DIFFRACT: 1.0,
  fieldThreshold: 1e-6,
} as const;

/** 声学调谐参数允许区间（单一来源；超范围在 Game 层统一抛中文错误）。 */
export const ACOUSTIC_TUNING_RANGES = {
  G_ABSORB: [0.5, 3.0],
  G_TRANS: [0.5, 2.0],
  G_DIST_EXP: [1.0, 3.0],
  G_DIFFRACT: [0.0, 2.0],
  fieldThreshold: [0.0, 1e-3],
} as const;

/** S4 声学传播与绕射预算常量（单一来源；acoustics.ts 只引用，不散落写死）。 */
export const ACOUSTIC_MAX_RAY_DIST = 160;
export const ACOUSTIC_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/**
 * 声学方向回归基础方向集：主轴 6 + 面对角 12 + 体对角 8 = 26。
 * 全向声源无论 high/low 都会先保留这些主方向，确保斜向/非主轴用例有可复现的
 * 确定性射线覆盖；剩余预算再填充 Fibonacci 球面。
 */
export const ACOUSTIC_PRINCIPAL_DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
  [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
  [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1],
  [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
  [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
] as const;
export const ACOUSTIC_DIR_SPREAD = 0.45;
export const ACOUSTIC_DIFFRACT_MAX_DIST = 6;
export const ACOUSTIC_DIFFRACT_BEND = 0.25;
