import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan, createHostProbe, verifyInstall, type InstallPlan } from "../src/index";

let root: string;
let binDir: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sdk-verify-")));
  binDir = join(root, "bin");
  await mkdir(binDir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const mk = (writes: InstallPlan["writes"], verify: InstallPlan["verify"] = []): InstallPlan => ({
  harness: "codex",
  scope: "project",
  projectRoot: root,
  writes,
  notes: [],
  verify,
});
const exe = async (name: string, body: string) => {
  await writeFile(join(binDir, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(binDir, name), 0o755);
};

describe("verifyInstall", () => {
  it("fails for a missing planned file", async () => {
    const p = mk([
      {
        kind: "file",
        path: join(root, "x"),
        content: Buffer.from("a"),
        committable: true,
        purpose: "t",
        within: root,
      },
    ]);
    const r = await verifyInstall(p, createHostProbe({ PATH: binDir }));
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.ok).toBe(false);
  });
  it("passes after apply and checks merge contents", async () => {
    await exe("dynamic-skills", "exit 0");
    const p = mk([
      {
        kind: "file",
        path: join(root, "f"),
        content: Buffer.from("a"),
        committable: true,
        purpose: "t",
        within: root,
      },
      {
        kind: "json-merge",
        path: join(root, "s.json"),
        patch: { a: [1], b: { c: 1 } },
        committable: true,
        purpose: "t",
        within: root,
      },
    ]);
    await applyPlan(p, { dryRun: false, force: false });
    expect((await verifyInstall(p, createHostProbe({ PATH: binDir }))).ok).toBe(true);
    await writeFile(join(root, "s.json"), '{"a":[2]}');
    expect((await verifyInstall(p, createHostProbe({ PATH: binDir }))).ok).toBe(false);
  });
  it("skips a command whose binary is missing", async () => {
    await exe("dynamic-skills", "exit 0");
    const p = mk([], [{ name: "v", bin: "ghost", args: [], expect: /x/ }]);
    const r = await verifyInstall(p, createHostProbe({ PATH: binDir }));
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "v")?.detail).toBe("skipped: ghost not on PATH");
  });
  it("fails when stdout does not match, passes when it does", async () => {
    await exe("dynamic-skills", "exit 0");
    await exe("tool", "echo hello");
    const probe = createHostProbe({ PATH: binDir });
    expect(
      (await verifyInstall(mk([], [{ name: "v", bin: "tool", args: [], expect: /nope/ }]), probe))
        .ok,
    ).toBe(false);
    expect(
      (await verifyInstall(mk([], [{ name: "v", bin: "tool", args: [], expect: /hello/g }]), probe))
        .ok,
    ).toBe(true);
  });
  it("fails when dynamic-skills is not on PATH", async () => {
    const r = await verifyInstall(mk([]), createHostProbe({ PATH: binDir }));
    expect(r.ok).toBe(false);
  });
});
