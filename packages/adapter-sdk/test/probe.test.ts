import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const script = async (name: string, body: string): Promise<string> => {
  await writeFile(join(bin, name), `#!/bin/sh\nPATH=/bin:/usr/bin\n${body}\n`);
  await chmod(join(bin, name), 0o755);
  return join(bin, name);
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("probe timeout and process groups", () => {
  it("SIGKILLs a TERM-trapping binary and its grandchild by the timeout", async () => {
    const pidfile = join(bin, "pid");
    const f = await script("stubborn", `trap "" TERM\nsleep 31 &\necho $! > ${pidfile}\nwait`);
    const p = createHostProbe({ PATH: bin }, 400);
    const t0 = Date.now();
    const r = await p.run(f, []);
    expect(r.code).toBe(-1);
    expect(Date.now() - t0).toBeLessThan(2_000);
    await settle(200);
    expect(alive(Number((await readFile(pidfile, "utf8")).trim()))).toBe(false);
  });
  it("returns the real exit code and output when a background child holds stdout", async () => {
    const f = await script("bgchild", "sleep 32 &\necho 9.9.9\nexit 0");
    const t0 = Date.now();
    const r = await createHostProbe({ PATH: bin }, 5_000).run(f, []);
    expect(r).toMatchObject({ code: 0, stdout: "9.9.9\n" });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
  it("kills the grandchild of a waiter on timeout", async () => {
    const pidfile = join(bin, "pid2");
    const f = await script("waiter", `(trap "" TERM; sleep 33) &\necho $! > ${pidfile}\nwait`);
    await createHostProbe({ PATH: bin }, 400).run(f, []);
    await settle(200);
    expect(alive(Number((await readFile(pidfile, "utf8")).trim()))).toBe(false);
  });
});
