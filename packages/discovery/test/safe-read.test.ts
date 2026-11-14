import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRepoReader, resolveRepoPath, SKIPPED_DIRS } from "../src/index";

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ds-safe-"));
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
