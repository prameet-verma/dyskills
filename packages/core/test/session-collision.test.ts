import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queue: string[] = [];
vi.mock("node:crypto", async (orig) => {
  const real = await orig<typeof import("node:crypto")>();
  return {
    ...real,
    randomBytes: (n: number) => {
      const next = queue.shift();
      return next === undefined ? real.randomBytes(n) : Buffer.from(next, "hex");
    },
  };
});

import { writeSessionFile } from "../src/index";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ds-coll-"));
});
afterEach(async () => {
  queue.length = 0;
  await rm(dir, { recursive: true, force: true });
});

describe("writeSessionFile temp-name collisions", () => {
  it("retries once after a collision and keeps the planted file", async () => {
    await writeFile(join(dir, ".f.json.aaaaaaaa.tmp"), "planted");
    queue.push("aaaaaaaa", "bbbbbbbb");
    await writeSessionFile(dir, "f.json", "new");
    expect(await readFile(join(dir, ".f.json.aaaaaaaa.tmp"), "utf8")).toBe("planted");
    expect(await readFile(join(dir, "f.json"), "utf8")).toBe("new");
  });
  it("throws EEXIST after two collisions and keeps both planted files", async () => {
    await writeFile(join(dir, ".f.json.aaaaaaaa.tmp"), "p1");
    await writeFile(join(dir, ".f.json.bbbbbbbb.tmp"), "p2");
    queue.push("aaaaaaaa", "bbbbbbbb");
    await expect(writeSessionFile(dir, "f.json", "new")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(dir, ".f.json.aaaaaaaa.tmp"), "utf8")).toBe("p1");
    expect(await readFile(join(dir, ".f.json.bbbbbbbb.tmp"), "utf8")).toBe("p2");
    expect((await readdir(dir)).sort()).toEqual([".f.json.aaaaaaaa.tmp", ".f.json.bbbbbbbb.tmp"]);
  });
});
