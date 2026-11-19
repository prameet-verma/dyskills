import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostProbe } from "../src/index";

let bin: string;
beforeEach(async () => {
  bin = await realpath(await mkdtemp(join(tmpdir(), "sdk-probe-")));
});
afterEach(async () => {
  await rm(bin, { recursive: true, force: true });
});

describe("createHostProbe", () => {
  it("finds an executable and ignores a non-executable file", async () => {
    await writeFile(join(bin, "tool"), "#!/bin/sh\necho hi\n");
    await chmod(join(bin, "tool"), 0o755);
    await writeFile(join(bin, "plain"), "x");
    await chmod(join(bin, "plain"), 0o644);
    const p = createHostProbe({ PATH: bin });
    expect(await p.which("tool")).toBe(join(bin, "tool"));
    expect(await p.which("plain")).toBeNull();
    expect(await p.which("absent")).toBeNull();
    expect(await p.run(join(bin, "tool"), [])).toMatchObject({ code: 0, stdout: "hi\n" });
  });
  it("reports a missing binary as code -1 and a failing one by its code", async () => {
    await writeFile(join(bin, "bad"), "#!/bin/sh\nexit 3\n");
    await chmod(join(bin, "bad"), 0o755);
    const p = createHostProbe({ PATH: bin });
    expect((await p.run(join(bin, "nope"), [])).code).toBe(-1);
    expect((await p.run(join(bin, "bad"), [])).code).toBe(3);
  });
});

describe("probe timeout", () => {
  it("SIGKILLs a binary that traps SIGTERM and resolves near the timeout", async () => {
    await writeFile(
      join(bin, "stubborn"),
      '#!/bin/sh\nPATH=/bin:/usr/bin\ntrap "" TERM\nsleep 30\n',
    );
    await chmod(join(bin, "stubborn"), 0o755);
    const p = createHostProbe({ PATH: bin }, 300);
    const t0 = Date.now();
    const r = await p.run(join(bin, "stubborn"), []);
    expect(r.code).toBe(-1);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
