import { describe, expect, it } from "vitest";
import { hasPrefix, newId } from "./index";

describe("newId", () => {
  it("prefixes and does not repeat", () => {
    const a = newId("ord");
    expect(hasPrefix("ord", a)).toBe(true);
    expect(newId("ord")).not.toBe(a);
  });
});
