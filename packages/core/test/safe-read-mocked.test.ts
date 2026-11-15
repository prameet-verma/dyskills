import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hooks the test controls; the mock below consults them on every call.
const hooks = vi.hoisted(() => ({
  afterRealpath: null as null | ((resolved: string) => Promise<void>),
  trickle: false,
  statSize: 1,
}));

vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    realpath: async (p: string) => {
      const r = await real.realpath(p);
      if (hooks.afterRealpath) await hooks.afterRealpath(r);
      return r;
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const h = await real.open(...args);
      if (!hooks.trickle) return h;
      return new Proxy(h, {
        get(target, prop) {
          if (prop === "stat") {
            return async () => ({ isFile: () => true, size: hooks.statSize });
          }
          if (prop === "read") {
            // Pass through at most one byte per call.
            return (buf: Buffer, off: number, len: number, pos: number | null) =>
              target.read(buf, off, Math.min(len, 1), pos);
          }
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
});

const { readSafeFile } = await import("../src/safe-read");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "safe-read-mock-"));
});
afterEach(async () => {
  hooks.afterRealpath = null;
  hooks.trickle = false;
  await rm(dir, { recursive: true, force: true });
});

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("readSafeFile with mocked fs", () => {
  it("refuses a symlink swapped in after the name check", async () => {
    const secret = join(dir, "secret.txt");
    await writeFile(secret, "TOP SECRET");
    await mkdir(join(dir, "s"));
    const skill = join(dir, "s", "SKILL.md");
    await writeFile(skill, "fine");
    hooks.afterRealpath = async (r) => {
      await rm(r);
      await symlink(secret, r);
    };
    const r = await readSafeFile(skill, { realBasename: "SKILL.md" });
    expect(r).toEqual({ ok: false, reason: "unreadable" });
  });

  it("rejects a file over the cap even when reads return one byte at a time", async () => {
    const p = join(dir, "big");
    await writeFile(p, "y".repeat(50));
    hooks.trickle = true;
    hooks.statSize = 1;
    expect(await readSafeFile(p, { maxBytes: 10 })).toEqual({ ok: false, reason: "too-large" });
  });

  it("returns a whole file read in partial chunks, with the right hash", async () => {
    const p = join(dir, "small");
    await writeFile(p, "12345678");
    hooks.trickle = true;
    hooks.statSize = 8;
    const r = await readSafeFile(p, { maxBytes: 10 });
    expect(r).toMatchObject({ ok: true, text: "12345678", sha256: sha("12345678") });
    expect(r.ok && r.bytes.length).toBe(8);
  });

  it("grows the buffer when the file is larger than stat reported, up to the cap", async () => {
    const p = join(dir, "grew");
    await writeFile(p, "abcdefghij");
    hooks.trickle = true;
    hooks.statSize = 1;
    const r = await readSafeFile(p, { maxBytes: 10 });
    expect(r).toMatchObject({ ok: true, text: "abcdefghij", sha256: sha("abcdefghij") });
  });
});
