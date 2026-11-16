import { describe, expect, it } from "vitest";
import { mergeJson } from "../src/index";

describe("mergeJson", () => {
  it("unions arrays keeping existing order", () => {
    const r = mergeJson({ allow: ["a"] }, { allow: ["a", "b"] });
    expect(r.value).toEqual({ allow: ["a", "b"] });
    expect(r.conflicts).toEqual([]);
  });
  it("reports a differing scalar and keeps the existing value", () => {
    const r = mergeJson({ x: 1 }, { x: 2 });
    expect(r.conflicts).toEqual(["x"]);
    expect(r.value).toEqual({ x: 1 });
  });
  it("accepts an equal scalar", () => {
    expect(mergeJson({ x: 1 }, { x: 1 }).conflicts).toEqual([]);
  });
  it("promotes a scalar where the plan says so", () => {
    const patch = {
      permission: { bash: { "dynamic-skills *": "allow", "dynamic-skills save *": "ask" } },
    };
    const promote = { paths: [["permission", "bash"]], key: "*" };
    const r = mergeJson({ permission: { bash: "ask" } }, patch, { promote });
    const bash = (r.value as { permission: { bash: Record<string, string> } }).permission.bash;
    expect(Object.keys(bash)).toEqual(["*", "dynamic-skills *", "dynamic-skills save *"]);
    expect(bash["*"]).toBe("ask");
    expect(mergeJson(r.value, patch, { promote }).value).toEqual(r.value);
  });
  it("does not promote a scalar at an unlisted path", () => {
    const r = mergeJson({ a: "ask" }, { a: { b: 1 } });
    expect(r.conflicts).toEqual(["a"]);
  });
  it("keeps existing key order and appends new keys in patch order", () => {
    const r = mergeJson({ z: 1, a: 2 }, { n1: 1, a: 2, n2: 2 });
    expect(Object.keys(r.value as object)).toEqual(["z", "a", "n1", "n2"]);
  });
  it("treats a non-object root as a conflict", () => {
    expect(mergeJson([1], { a: 1 }).conflicts).toEqual([""]);
  });
  it("keeps a __proto__ key as plain data", () => {
    const cur = JSON.parse('{"__proto__": {"x": 1}}');
    const r = mergeJson(cur, { a: 1 });
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    expect(Object.hasOwn(r.value as object, "__proto__")).toBe(true);
  });
  it("is idempotent", () => {
    const patch = { a: { b: [1, 2] }, c: "x" };
    const once = mergeJson({ a: { b: [2] } }, patch).value;
    expect(mergeJson(once, patch).value).toEqual(once);
  });
});
