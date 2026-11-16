import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasTopLevelPermissionsKey } from "../src/install";

describe("hasTopLevelPermissionsKey", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  async function fileWith(text: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "permkey-"));
    dirs.push(dir);
    const path = join(dir, "opencode.jsonc");
    await writeFile(path, text);
    return path;
  }

  it("finds a top-level permissions key with a comment between the key and the colon", async () => {
    const path = await fileWith('{ "permissions" /* c */ : [] }');
    expect(await hasTopLevelPermissionsKey(path)).toBe(true);
  });

  it("does not warn for a nested permissions key", async () => {
    const path = await fileWith('{ "permission": { "permissions": "ask" } }');
    expect(await hasTopLevelPermissionsKey(path)).toBe(false);
  });

  it("does not warn for a key name that only appears inside a string value", async () => {
    const path = await fileWith('{ "note": "set permissions later" }');
    expect(await hasTopLevelPermissionsKey(path)).toBe(false);
  });

  it("does not warn when the document root is an array", async () => {
    const path = await fileWith('[{ "permissions": [] }]');
    expect(await hasTopLevelPermissionsKey(path)).toBe(false);
  });

  it("does not warn for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "permkey-"));
    dirs.push(dir);
    expect(await hasTopLevelPermissionsKey(join(dir, "missing.json"))).toBe(false);
  });

  it("finds a top-level permissions key in plain JSON too", async () => {
    const path = await fileWith('{ "permission": {}, "permissions": [] }');
    expect(await hasTopLevelPermissionsKey(path)).toBe(true);
  });

  it("handles a trailing comma", async () => {
    const path = await fileWith('{ "permission": {}, "permissions": [], }');
    expect(await hasTopLevelPermissionsKey(path)).toBe(true);
  });

  it("returns false on a genuine parse error", async () => {
    const path = await fileWith("{ permissions: [} ");
    expect(await hasTopLevelPermissionsKey(path)).toBe(false);
  });
});
