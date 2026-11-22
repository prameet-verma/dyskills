import { describe, expect, it } from "vitest";
import { andThen, err, isOk, map, ok } from "./index";

describe("result", () => {
  it("maps successes and passes errors through", () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    expect(map(err("x"), (n: number) => n * 2)).toEqual(err("x"));
  });

  it("short-circuits andThen on the first error", () => {
    const failing = andThen(err("first"), () => ok(1));
    expect(isOk(failing)).toBe(false);
    expect(andThen(ok(1), (n) => ok(n + 1))).toEqual(ok(2));
  });
});
