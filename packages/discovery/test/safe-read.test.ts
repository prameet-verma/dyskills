import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRepoReader,
  readRegularFile,
  resolveRepoPath,
  runDiscovery,
  SKIPPED_DIRS,
} from "../src/index";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ds-safe-"));
  created.push(base);
  const repo = join(base, "repo");
  await mkdir(join(repo, "config"), { recursive: true });
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "node_modules/x"), { recursive: true });
  await writeFile(join(repo, "README.md"), "hello");
  await writeFile(join(repo, ".env"), "SECRET=1");
  await writeFile(join(repo, "config/.env.local"), "SECRET=2");
  await writeFile(join(repo, ".git/config"), "[core]");
  await writeFile(join(repo, "node_modules/x/index.js"), "x");
  await writeFile(join(base, "outside.txt"), "outside");
  await symlink(".env", join(repo, "link.txt"));
  await symlink(".git/config", join(repo, "link-git"));
  return repo;
}

describe("resolveRepoPath", () => {
  it("classifies paths", async () => {
    const repo = await makeRepo();
    const reason = async (p: string) => {
      const r = await resolveRepoPath(repo, p);
      return r.ok ? "ok" : r.reason;
    };
    expect(await reason(".env")).toBe("secret");
    expect(await reason("config/.env.local")).toBe("secret");
    expect(await reason("link.txt")).toBe("secret");
    expect(await reason("../outside.txt")).toBe("outside-repo");
    expect(await reason("/etc/hosts")).toBe("outside-repo");
    expect(await reason(".git/config")).toBe("excluded");
    expect(await reason("link-git")).toBe("excluded");
    expect(await reason("node_modules/x/index.js")).toBe("excluded");
    expect(await reason("missing.ts")).toBe("missing");
    expect(await reason("config")).toBe("missing");
    expect(await reason("README.md")).toBe("ok");
    const dot = await resolveRepoPath(repo, "./README.md");
    expect(dot).toMatchObject({ ok: true, rel: "README.md" });
  });

  it("rejects a symlink that escapes the repository", async () => {
    const repo = await makeRepo();
    await symlink("../outside.txt", join(repo, "escape.txt"));
    expect(await resolveRepoPath(repo, "escape.txt")).toEqual({
      ok: false,
      reason: "outside-repo",
    });
  });

  it("exports the skipped directory list", () => {
    expect(SKIPPED_DIRS).toContain("node_modules");
    expect(SKIPPED_DIRS).toContain(".git");
  });
});

describe("createRepoReader", () => {
  it("reads safe files and returns null otherwise", async () => {
    const repo = await makeRepo();
    const read = createRepoReader(repo);
    expect(await read("README.md")).toBe("hello");
    expect(await read("link.txt")).toBeNull();
    expect(await read("nope")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("FIFOs", () => {
  it("never block resolution, reads or discovery", { timeout: 3000 }, async () => {
    const repo = await makeRepo();
    execFileSync("mkfifo", [join(repo, "pipe.txt")], { timeout: 30_000 });
    execFileSync("mkfifo", [join(repo, "package.json")], { timeout: 30_000 });
    expect(await resolveRepoPath(repo, "pipe.txt")).toEqual({ ok: false, reason: "missing" });
    expect(await createRepoReader(repo)("pipe.txt")).toBeNull();
    const d = await runDiscovery({ repo, task: "x" });
    expect(d.errors).toEqual([]);
    expect(d.registry.get("package-manager")).toBeUndefined();
  });
});

describe("readRegularFile", () => {
  it("reads a regular file and names why anything else is refused", async () => {
    const repo = await makeRepo();
    const fifo = join(repo, "pipe");
    execFileSync("mkfifo", [fifo], { timeout: 30_000 });
    await symlink("/dev/zero", join(repo, "zero"));
    await writeFile(join(repo, "big.txt"), "x".repeat(11));
    expect(await readRegularFile(join(repo, "README.md"))).toEqual({ ok: true, text: "hello" });
    expect(await readRegularFile(join(repo, "nope"))).toEqual({ ok: false, reason: "missing" });
    expect(await readRegularFile(fifo)).toEqual({ ok: false, reason: "not-a-file" });
    expect(await readRegularFile(join(repo, "zero"))).toEqual({ ok: false, reason: "not-a-file" });
    expect(await readRegularFile(join(repo, "config"))).toEqual({
      ok: false,
      reason: "not-a-file",
    });
    expect(await readRegularFile(join(repo, "big.txt"), 10)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});
