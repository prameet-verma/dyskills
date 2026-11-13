import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET_MS, SlaClock } from "../src/index.js";

describe("SlaClock", () => {
  it("excludes paused time and does not reset on resume", () => {
    const c = SlaClock.start(60_000, 0);
    expect(c.activeMs(10_000)).toBe(10_000);
    c.pause(18_000);
    expect(c.activeMs(100_000)).toBe(18_000);
    expect(c.remainingMs(100_000)).toBe(42_000);
    expect(c.resume(100_000)).toBe(82_000);
    expect(c.activeMs(110_000)).toBe(28_000);
  });

  it("pause is idempotent; resume while running returns 0", () => {
    const c = SlaClock.start(60_000, 0);
    expect(c.resume(5_000)).toBe(0);
    c.pause(10_000);
    c.pause(20_000);
    expect(c.isPaused()).toBe(true);
    expect(c.activeMs(30_000)).toBe(10_000);
    expect(c.resume(40_000)).toBe(30_000);
    expect(c.isPaused()).toBe(false);
    expect(c.activeMs(45_000)).toBe(15_000);
  });

  it("expires exactly at budget", () => {
    const c = SlaClock.start(60_000, 0);
    expect(c.isExpired(59_999)).toBe(false);
    expect(c.isExpired(60_000)).toBe(true);
    expect(c.remainingMs(90_000)).toBe(0);
  });

  it("defaults to DEFAULT_BUDGET_MS", () => {
    expect(SlaClock.start(undefined, 0).snapshot(0).budgetMs).toBe(DEFAULT_BUDGET_MS);
  });

  it("round-trips through snapshot while paused and while running", () => {
    const running = SlaClock.start(60_000, 0);
    running.pause(5_000);
    running.resume(9_000);
    const r2 = SlaClock.from(running.snapshot(12_000));
    expect(r2.activeMs(20_000)).toBe(running.activeMs(20_000));
    expect(r2.isPaused()).toBe(false);

    const paused = SlaClock.start(60_000, 0);
    paused.pause(7_000);
    const p2 = SlaClock.from(paused.snapshot(8_000));
    expect(p2.isPaused()).toBe(true);
    expect(p2.activeMs(50_000)).toBe(paused.activeMs(50_000));
    expect(p2.resume(50_000)).toBe(43_000);
  });
});
