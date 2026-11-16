import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

const read: string[] = [];
let root = "";

vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: ((path: string, ...rest: unknown[]) => {
      read.push(relative(root, String(path)));
      return (actual.readdir as (...a: unknown[]) => unknown)(path, ...rest);
    }) as unknown as typeof actual.readdir,
  };
});

const { buildFileIndex } = await import("../src/index");

describe("buildFileIndex abort", () => {
  it("rejects with AbortError and reads no directory after the abort", async () => {
    root = mkdtempSync(join(tmpdir(), "ds-abort-"));
    for (const d of ["a", "b", "c"]) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, "f.txt"), "");
    }
    let checks = 0;
    // Aborts on the third check: the root and "a" are read, "b" and "c" never are.
    const signal = {
      get aborted() {
        checks++;
        return checks >= 3;
      },
    } as unknown as AbortSignal;
    await expect(buildFileIndex(root, { signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(read).toEqual(["", "a"]);
  });
});
