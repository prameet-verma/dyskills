import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fingerprintFile, getRepoRevision } from "../src/index";

const made: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(prefix);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("returns 'untracked' outside git and a sha inside git", async () => {
  const outside = tmp(join(tmpdir(), "ds-rev-"));
  expect(await getRepoRevision(outside)).toBe("untracked");
  expect(await getRepoRevision(join(outside, "missing"))).toBe("untracked");

  const repo = tmp(join(tmpdir(), "ds-git-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, "f.txt"), "hi");
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "c",
  );
  expect(await getRepoRevision(repo)).toMatch(/^[0-9a-f]{40}$/);
});

it("fingerprints files as 64-char hex", async () => {
  const dir = tmp(join(tmpdir(), "ds-fp-"));
  const f = join(dir, "a.txt");
  writeFileSync(f, "hello");
  const h = await fingerprintFile(f);
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

it("refuses to fingerprint a directory, an oversize file or a missing file", async () => {
  const dir = tmp(join(tmpdir(), "ds-fp-"));
  const f = join(dir, "big.txt");
  writeFileSync(f, "x".repeat(20));
  await expect(fingerprintFile(dir)).rejects.toThrow(/not-a-file/);
  await expect(fingerprintFile(f, 10)).rejects.toThrow(/too-large/);
  await expect(fingerprintFile(join(dir, "nope"))).rejects.toThrow(/missing/);
});

it("ignores GIT_* variables in the caller's environment", async () => {
  const repo = tmp(join(tmpdir(), "ds-git-env-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, "f.txt"), "hi");
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "c",
  );
  const expected = await getRepoRevision(repo);
  expect(expected).toMatch(/^[0-9a-f]{40}$/);
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = "/nonexistent";
  try {
    expect(await getRepoRevision(repo)).toBe(expected);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});
