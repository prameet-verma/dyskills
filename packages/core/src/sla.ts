import { DEFAULT_BUDGET_MS } from "./constants";
import type { SlaSnapshot } from "./schemas";

/**
 * Active-time SLA clock (PRD §10.1, §10.3). Active time is wall-clock time since start minus the
 * time spent paused for human input; resuming never resets it, so clarification cannot extend
 * the budget.
 *
 * The clock is pure: every method takes the current time as an argument and nothing reads the
 * system clock, which keeps it deterministic and trivially serializable between CLI invocations.
 */
export class SlaClock {
  private constructor(
    private readonly budgetMs: number,
    private accumulatedMs: number,
    private paused: boolean,
    /** Start of the open running segment, or the moment the pause began while paused. */
    private markAt: number,
  ) {}

  /**
   * Starts a running clock.
   *
   * @param budgetMs - Active budget in milliseconds; defaults to {@link DEFAULT_BUDGET_MS}.
   * @param now - Epoch milliseconds at which the clock starts; defaults to `Date.now()`.
   */
  static start(budgetMs: number = DEFAULT_BUDGET_MS, now: number = Date.now()): SlaClock {
    return new SlaClock(budgetMs, 0, false, now);
  }

  /**
   * Restores a clock from a persisted snapshot. While paused, `segmentStartedAt` holds the pause
   * timestamp so {@link SlaClock.resume} can report the wait; a missing timestamp falls back to 0.
   */
  static from(s: SlaSnapshot): SlaClock {
    return new SlaClock(s.budgetMs, s.activeMs, s.paused, s.segmentStartedAt ?? 0);
  }

  /** Stops accumulating active time at `now`. Idempotent: pausing a paused clock is a no-op. */
  pause(now: number): void {
    if (this.paused) return;
    this.accumulatedMs += Math.max(0, now - this.markAt);
    this.paused = true;
    this.markAt = now;
  }

  /**
   * Resumes accumulating active time at `now`.
   *
   * @returns Milliseconds spent paused (the human wait), or 0 if the clock was not paused.
   */
  resume(now: number): number {
    if (!this.paused) return 0;
    const waited = Math.max(0, now - this.markAt);
    this.paused = false;
    this.markAt = now;
    return waited;
  }

  /** Active milliseconds consumed as of `now`, excluding every paused interval. */
  activeMs(now: number): number {
    return this.paused ? this.accumulatedMs : this.accumulatedMs + Math.max(0, now - this.markAt);
  }

  /** Active budget left as of `now`, floored at 0. */
  remainingMs(now: number): number {
    return Math.max(0, this.budgetMs - this.activeMs(now));
  }

  /** True once active time has reached the budget (`activeMs >= budget`). */
  isExpired(now: number): boolean {
    return this.activeMs(now) >= this.budgetMs;
  }

  /** True while the clock is paused for human input. */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Serializable state as of `now`. A running clock is folded so `activeMs` includes the open
   * segment and `segmentStartedAt` is `now`; a paused clock keeps its pause timestamp there.
   */
  snapshot(now: number): SlaSnapshot {
    if (this.paused) {
      return {
        budgetMs: this.budgetMs,
        activeMs: this.accumulatedMs,
        paused: true,
        segmentStartedAt: this.markAt,
      };
    }
    return {
      budgetMs: this.budgetMs,
      activeMs: this.activeMs(now),
      paused: false,
      segmentStartedAt: now,
    };
  }
}
