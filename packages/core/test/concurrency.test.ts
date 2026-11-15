import { describe, expect, it } from "vitest";
import { mapConcurrent } from "../src/index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapConcurrent", () => {
  it("never exceeds the limit and preserves order", async () => {
    let inFlight = 0,
      max = 0;
    const out = await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await sleep(10);
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(max).toBe(2);
  });

  it("propagates rejection", async () => {
    const boom = new Error("boom");
    await expect(
      mapConcurrent([1, 2, 3, 4], 2, async (n) => {
        if (n === 3) throw boom;
        return n;
      }),
    ).rejects.toBe(boom);
  });

  it("stops starting items after abort", async () => {
    const ctl = new AbortController();
    const called: number[] = [];
    const p = mapConcurrent(
      [1, 2, 3, 4],
      1,
      async (n) => {
        called.push(n);
        ctl.abort();
        await sleep(5);
        return n;
      },
      { signal: ctl.signal },
    );
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(called).toEqual([1]);
  });
});
