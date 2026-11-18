import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { checkRelease } from "../../scripts/check-release";
import { ROOT } from "./harness";

const CLI = join(ROOT, "packages/cli");
const SLOW = 180_000;

let tmp: string;
let pkgDir: string;
let packFiles: string[];
let pkg: Record<string, unknown>;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ds-pack-"));
  // Never published: `pack` only writes a tarball into tmp. Offline: the runtime dependencies are
  // linked from the workspace install instead of fetched.
  // `--ignore-scripts`: `prepack` would rebuild (and first empty) `dist/` while the other e2e files
  // are spawning it; global setup has just built it, which is what gets packed.
  execFileSync("pnpm", ["pack", "--ignore-scripts", "--pack-destination", tmp], {
    cwd: CLI,
    stdio: "pipe",
  });
  const tgz = join(tmp, readdirSync(tmp).find((f) => f.endsWith(".tgz")) as string);
  packFiles = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l !== "" && !l.endsWith("/"))
    .map((l) => l.replace(/^package\//, ""));
  const out = join(tmp, "extract");
  execFileSync("mkdir", [out]);
  execFileSync("tar", ["-xzf", tgz, "-C", out]);
  pkgDir = join(out, "package");
  symlinkSync(join(CLI, "node_modules"), join(pkgDir, "node_modules"));
  pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
}, SLOW);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Fake harness binaries and a `dynamic-skills` shim; PATH is only this directory. */
function writeFakeBins(binDir: string, entry: string): void {
  mkdirSync(binDir, { recursive: true });
  const fakes: Record<string, string> = {
    claude: "2.1.325 (Claude Code)",
    codex: "codex-cli 0.169.0",
    opencode: "1.19.5",
  };
  const put = (name: string, body: string) => {
    writeFileSync(join(binDir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(binDir, name), 0o755);
  };
  for (const [name, v] of Object.entries(fakes)) {
    put(name, `if [ "$1" = "--version" ]; then echo '${v}'; fi\nexit 0`);
  }
  put("dynamic-skills", `exec '${process.execPath}' '${entry}' "$@"`);
}

/**
 * Drops only the two known pre-publish gaps (no `license`, no `repository` field), and only when
 * the field is really absent; every other `checkRelease` problem is kept.
 */
export function openReleaseGaps(pkg: Record<string, unknown>, problems: string[]): string[] {
  return problems.filter(
    (p) =>
      !(
        (pkg.license === undefined &&
          p === "package.json has no license field (choose a license and add LICENSE)") ||
        (pkg.repository === undefined && p === "package.json has no repository field with a url")
      ),
  );
}

/** Runs the packed binary with a minimal environment (nothing of the real user's reaches it). */
function runPacked(argv: string[]): { code: number; stdout: string } {
  const home = join(tmp, "home");
  writeFakeBins(join(tmp, "bin"), join(pkgDir, "dist/index.js"));
  execFileSync("mkdir", ["-p", home, join(tmp, "dshome"), join(tmp, "etc"), join(tmp, "repo")]);
  try {
    const stdout = execFileSync(process.execPath, [join(pkgDir, "dist/index.js"), ...argv], {
      cwd: join(tmp, "repo"),
      encoding: "utf8",
      timeout: 90_000,
      env: {
        PATH: join(tmp, "bin"),
        HOME: home,
        TMPDIR: tmp,
        DYNAMIC_SKILLS_HOME: join(tmp, "dshome"),
        DYNAMIC_SKILLS_ETC_DIR: join(tmp, "etc"),
      },
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, stdout: err.stdout };
  }
}

describe("release gap filter", () => {
  it("keeps a stray LICENSE.txt and any other real problem", () => {
    const p = { name: "dynamic-skills" } as Record<string, unknown>;
    const problems = checkRelease({
      pkg: p,
      packFiles: [
        "dist/index.js",
        "skills/dynamic-skill-bootstrap/SKILL.md",
        "package.json",
        "README.md",
        "LICENSE.txt",
      ],
    });
    const kept = openReleaseGaps(p, problems);
    expect(kept).toContain("tarball contains unexpected file LICENSE.txt");
    expect(kept.some((m) => m.includes("no license field"))).toBe(false);
    // A present-but-empty field is a real problem, not an open gap.
    const empty = { ...p, license: "" };
    expect(
      openReleaseGaps(empty, checkRelease({ pkg: empty, packFiles: [] })).some((m) =>
        m.includes("no license field"),
      ),
    ).toBe(true);
  });
});

describe("packed package", () => {
  it("packs a dist built by this run's global setup", () => {
    // Slack for coarse file-system timestamps.
    const built = statSync(join(CLI, "dist/index.js")).mtimeMs;
    expect(built).toBeGreaterThanOrEqual(inject("buildStartedAt") - 2000);
  });

  it("satisfies the release allow-list and includes the bootstrap skill", () => {
    expect(packFiles).toContain("skills/dynamic-skill-bootstrap/SKILL.md");
    // The license and repository fields are open pre-publish decisions (the release workflow
    // enforces them); everything else `checkRelease` checks must already hold.
    expect(openReleaseGaps(pkg, checkRelease({ pkg, packFiles }))).toEqual([]);
  });

  it("ships a bootstrap skill byte-identical to the source", () => {
    expect(readFileSync(join(pkgDir, "skills/dynamic-skill-bootstrap/SKILL.md"))).toEqual(
      readFileSync(join(ROOT, "skills/dynamic-skill-bootstrap/SKILL.md")),
    );
  });

  it("declares every bare import of dist/index.js and no workspace dependency", () => {
    const code = readFileSync(join(pkgDir, "dist/index.js"), "utf8");
    const specs = new Set<string>();
    const found = [
      ...code.matchAll(/^\s*(?:import|export)\b[^;"']*?\bfrom\s*["']([^"']+)["']/gm),
      ...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ];
    for (const m of found) {
      const spec = m[1] as string;
      if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) continue;
      // Bundled dependencies import Node builtins without the `node:` prefix.
      if (builtinModules.includes(spec)) continue;
      specs.add(
        spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : (spec.split("/")[0] as string),
      );
    }
    expect(specs.size).toBeGreaterThan(0);
    const deps = Object.keys((pkg.dependencies ?? {}) as object);
    for (const s of specs) expect(deps, `bare import ${s}`).toContain(s);
    expect(JSON.stringify(pkg)).not.toContain("workspace:");
    expect(deps.filter((d) => d.startsWith("@dynamic-skills/"))).toEqual([]);
  });

  it(
    "runs --version from the extracted package",
    () => {
      const r = runPacked(["--version"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, version: pkg.version });
    },
    SLOW,
  );

  it(
    "init --harness codex --dry-run plans the bootstrap skill",
    () => {
      const r = runPacked(["init", "--harness", "codex", "--dry-run"]);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      const writes = out.harnesses[0].writes as { action: string; path: string }[];
      expect(
        writes.some(
          (x) => x.action === "create" && x.path.endsWith("dynamic-skill-bootstrap/SKILL.md"),
        ),
      ).toBe(true);
    },
    SLOW,
  );
});
