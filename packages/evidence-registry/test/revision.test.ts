import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fingerprintFile, getRepoRevision } from "../src/index.js";

it("returns 'untracked' outside git and a sha inside git", async () => {
  const outside = mkdtempSync(join(tmpdir(), "ds-rev-"));
  expect(await getRepoRevision(outside)).toBe("untracked");
  expect(await getRepoRevision(join(outside, "missing"))).toBe("untracked");

  const repo = mkdtempSync(join(tmpdir(), "ds-git-"));
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
  const dir = mkdtempSync(join(tmpdir(), "ds-fp-"));
  const f = join(dir, "a.txt");
  writeFileSync(f, "hello");
  const h = await fingerprintFile(f);
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});
