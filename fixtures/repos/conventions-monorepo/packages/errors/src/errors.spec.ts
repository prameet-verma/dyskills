import { describe, expect, it } from "vitest";
import { defineError } from "./index";

describe("defineError", () => {
  it("builds a plain tagged object, not an Error", () => {
    const NotFound = defineError("NotFound");
    const e = NotFound("missing", { id: "x" });
    expect(e).toEqual({ kind: "NotFound", message: "missing", id: "x" });
    expect(e instanceof Error).toBe(false);
  });
});
