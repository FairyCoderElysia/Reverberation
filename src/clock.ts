/**
 * S3 最小时钟（F6 前置）：全天相位推进、跨日回绕、以及“静止也要节流写档”的待写状态跟踪。
 * 从 Game 拆出，减少单权威类长期膨胀；Game 只负责把 Clock 的自动保存信号接入统一 writeSave。
 */
import { DAY_LENGTH_SECONDS } from './config';

export interface GameClockOptions {
  dayLengthSeconds?: number;
  timeOfDay?: number;
  day?: number;
}

export class GameClock {
  readonly dayLengthSeconds: number;
  timeOfDay: number;
  day: number;

  private dirty = false;
  private accumMs = 0;
  private lastSaved: [number, number];

  constructor(opts: GameClockOptions = {}) {
    this.dayLengthSeconds = opts.dayLengthSeconds ?? DAY_LENGTH_SECONDS;
    this.timeOfDay = opts.timeOfDay ?? 0;
    this.day = opts.day ?? 0;
    this.lastSaved = [this.timeOfDay, this.day];
  }

  /** 当前 [timeOfDay, day] 快照。 */
  snapshot(): [number, number] {
    return [this.timeOfDay, this.day];
  }

  /** 用现实时间推进全天相位；跨过 1 时 day+1，并保持 [0,1)。 */
  advance(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return;
    this.timeOfDay += dtMs / (this.dayLengthSeconds * 1000);
    let guard = 0;
    while (this.timeOfDay >= 1 && guard < 10000) {
      this.timeOfDay -= 1;
      this.day += 1;
      guard += 1;
    }
    if (this.timeOfDay < 0 || this.timeOfDay >= 1) this.timeOfDay = 0; // 防御性归位
  }

  /**
   * 检测时钟相对上次成功写档是否有变化并按节流累计。
   * 返回 true 表示已达到节流阈值，调用方应执行一次写档。
   */
  updateAutoSave(dtMs: number, thresholdMs: number): boolean {
    const cur = this.snapshot();
    if (!this.dirty && (this.lastSaved[0] !== cur[0] || this.lastSaved[1] !== cur[1])) {
      this.dirty = true;
    }
    if (!this.dirty) {
      this.accumMs = 0;
      return false;
    }
    this.accumMs += dtMs;
    return this.accumMs >= thresholdMs;
  }

  /** 成功写档后调用：清除待写状态并把基线对齐到当前时间。 */
  markSaved(): void {
    this.dirty = false;
    this.accumMs = 0;
    this.lastSaved = [this.timeOfDay, this.day];
  }

  /** 写档失败后的退避：保留 dirty，只清零累计，避免每帧重复写档。 */
  backoff(): void {
    this.accumMs = 0;
  }

  /** 重置并向新基线对齐（loadSave/reset 后调用，避免刚载入就触发无意义写档）。 */
  reset(timeOfDay = 0, day = 0): void {
    this.timeOfDay = timeOfDay;
    this.day = day;
    this.markSaved();
  }
}
