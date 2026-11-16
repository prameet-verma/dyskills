import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseConfigFile } from "../src/config-file";

describe("chooseConfigFile", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  async function tmp(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "chooseconfig-"));
    dirs.push(d);
    return d;
  }

  it("returns the first candidate, in order, that is an existing regular file", async () => {
    const dir = await tmp();
    const a = join(dir, "a.jsonc");
    const b = join(dir, "b.json");
    const fallback = join(dir, "fallback.jsonc");
    expect(await chooseConfigFile([a, b], fallback)).toBe(fallback);
    await writeFile(b, "{}");
    expect(await chooseConfigFile([a, b], fallback)).toBe(b);
    await writeFile(a, "{}");
    expect(await chooseConfigFile([a, b], fallback)).toBe(a);
  });

  it("falls back when no candidate exists", async () => {
    const dir = await tmp();
    const fallback = join(dir, "fallback.jsonc");
    expect(await chooseConfigFile([join(dir, "x.json"), join(dir, "y.json")], fallback)).toBe(
      fallback,
    );
  });

  it("skips a candidate that is a directory, not a regular file", async () => {
    const dir = await tmp();
    const notAFile = join(dir, "notafile.json");
    await mkdir(notAFile);
    const real = join(dir, "real.json");
    await writeFile(real, "{}");
    const fallback = join(dir, "fallback.jsonc");
    expect(await chooseConfigFile([notAFile, real], fallback)).toBe(real);
  });
});
