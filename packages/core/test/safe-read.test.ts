import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSafeFile, readSafeFile } from "../src/index";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "safe-read-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("readSafeFile", () => {
  it("returns bytes, text and the sha256 of exactly those bytes", async () => {
    const p = join(dir, "SKILL.md");
    const body = Buffer.from("héllo\n", "utf8");
    await writeFile(p, body);
    const r = await readSafeFile(p);
    expect(r).toEqual({
      ok: true,
      bytes: body,
      text: "héllo\n",
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  });

  it("reports a missing file", async () => {
    expect(await readSafeFile(join(dir, "nope"))).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a directory", async () => {
    expect(await readSafeFile(dir)).toEqual({ ok: false, reason: "not-a-file" });
  });

  it("returns promptly on a FIFO", async () => {
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(await readSafeFile(fifo)).toEqual({ ok: false, reason: "not-a-file" });
    await symlink(fifo, join(dir, "SKILL.md"));
    expect(await readSafeFile(join(dir, "SKILL.md"), { realBasename: "SKILL.md" })).toEqual({
      ok: false,
      reason: "wrong-name",
    });
  });

  it("refuses a symlink to /dev/zero", async () => {
    const link = join(dir, "zero");
    await symlink("/dev/zero", link);
    expect(await readSafeFile(link)).toEqual({ ok: false, reason: "not-a-file" });
  });

  it("refuses an oversize file", async () => {
    const p = join(dir, "big");
    await writeFile(p, "x".repeat(11));
    expect(await readSafeFile(p, { maxBytes: 10 })).toEqual({ ok: false, reason: "too-large" });
    expect((await readSafeFile(p, { maxBytes: 11 })).ok).toBe(true);
  });

  it("requires the real basename when asked", async () => {
    await mkdir(join(dir, "s"));
    await writeFile(join(dir, ".env"), "SECRET=1");
    await symlink(join(dir, ".env"), join(dir, "s", "SKILL.md"));
    await writeFile(join(dir, "s", "OTHER.md"), "ok");
    expect(await readSafeFile(join(dir, "s", "SKILL.md"), { realBasename: "SKILL.md" })).toEqual({
      ok: false,
      reason: "wrong-name",
    });
    expect(await readSafeFile(join(dir, "s", "OTHER.md"), { realBasename: "SKILL.md" })).toEqual({
      ok: false,
      reason: "wrong-name",
    });
    const real = join(dir, "s", "real", "SKILL.md");
    await mkdir(join(dir, "s", "real"));
    await writeFile(real, "ok");
    await symlink(real, join(dir, "link.md"));
    expect((await readSafeFile(join(dir, "link.md"), { realBasename: "SKILL.md" })).ok).toBe(true);
  });
});

describe("readSafeFile limits", () => {
  it("accepts a file of exactly maxBytes and hashes only those bytes", async () => {
    const p = join(dir, "exact");
    await writeFile(p, "x".repeat(10));
    const r = await readSafeFile(p, { maxBytes: 10 });
    expect(r.ok && r.bytes.length).toBe(10);
    expect(r.ok && r.sha256).toBe(createHash("sha256").update("x".repeat(10)).digest("hex"));
  });

  it("follows a link only through its resolved target when a real basename is required", async () => {
    const real = join(dir, "SKILL.md");
    await writeFile(real, "ok");
    await symlink(real, join(dir, "alias"));
    // The name check resolves the link; the open then targets the resolved file, not the link.
    expect((await readSafeFile(join(dir, "alias"), { realBasename: "SKILL.md" })).ok).toBe(true);
  });
});

describe("maxBytes validation", () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("throws a TypeError for %s", (n) => {
    expect(() => readSafeFile(join(dir, "f"), { maxBytes: n })).toThrow(TypeError);
    expect(() => checkSafeFile(join(dir, "f"), { maxBytes: n })).toThrow(TypeError);
  });
});

describe("checkSafeFile", () => {
  it("validates without reading", async () => {
    const p = join(dir, "f");
    await writeFile(p, "abc");
    expect(await checkSafeFile(p)).toEqual({ ok: true });
    expect(await checkSafeFile(dir)).toEqual({ ok: false, reason: "not-a-file" });
  });
});
