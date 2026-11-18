import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = [
  "scripts/live-smoke.sh",
  "scripts/live-smoke/lib.sh",
  "scripts/live-smoke/claude-code.sh",
  "scripts/live-smoke/codex.sh",
  "scripts/live-smoke/opencode.sh",
];
/** A shell expansion with its leading slash removed, as the script writes it. */
const v = (name: string): string => "$" + `{${name}#/}`;
const HARNESSES = ["claude-code", "codex", "opencode"] as const;

/** Source of a repo-relative script. */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Non-comment lines, so documentation of what is forbidden does not trip the checks. */
function code(rel: string): string {
  return read(rel)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

describe("live smoke scripts", () => {
  it.each(SCRIPTS)("%s passes bash -n and uses strict mode", (rel) => {
    const r = spawnSync("bash", ["-n", join(ROOT, rel)], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    if (rel !== "scripts/live-smoke/lib.sh") expect(read(rel)).toContain("set -euo pipefail");
  });

  it.each(SCRIPTS)("%s never uses a package runner for dynamic-skills (R19)", (rel) => {
    expect(read(rel)).not.toMatch(
      /\b(?:npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec)\s+dynamic-skills\b/,
    );
  });

  it.each(SCRIPTS)("%s uses no skip-all-permissions flag", (rel) => {
    const text = code(rel);
    for (const bad of [
      "--dangerously",
      "--yolo",
      "skip-permissions",
      "--auto",
      "bypassPermissions",
      "bypass-approvals",
      "--full-auto",
      "danger-full-access",
      "--approve-for-me",
      "--permission-mode",
    ]) {
      expect(text, bad).not.toContain(bad);
    }
  });

  it.each(SCRIPTS)("%s never reads secret files or dumps the environment", (rel) => {
    const text = code(rel);
    expect(text).not.toMatch(/auth\.json|\.credentials|\.netrc|\.ssh|\.env\b|api[_-]?key/i);
    expect(text).not.toMatch(/^\s*(?:env|printenv|set)\s*(?:\||$)/m);
    expect(text).not.toMatch(/\b(?:printenv|declare\s+-x|export\s+-p)\b/);
  });

  it.each(HARNESSES)("%s.sh installs with init --harness %s", (id) => {
    expect(read(`scripts/live-smoke/${id}.sh`)).toContain(`dynamic-skills init --harness ${id}`);
  });

  it("lib.sh defines the AC 28 snapshot, comparison and the AC 24 line", () => {
    const lib = read("scripts/live-smoke/lib.sh");
    expect(lib).toMatch(/snapshot_roots\(\)/);
    expect(lib).toMatch(/sha256/);
    expect(lib).toContain("$label: PASS");
    expect(lib).toContain("$label: FAIL");
    expect(lib).toContain("AC 24");
    for (const root of ["/.claude/skills", "/.agents/skills", "/.codex/skills"]) {
      expect(lib).toContain(root);
    }
    expect(lib).toContain("opencode/skills");
    expect(lib).toContain("DYNAMIC_SKILLS_ETC_DIR");
    expect(lib).toContain("DYNAMIC_SKILLS_HOME");
    expect(lib).toContain("mktemp -d");
    expect(lib).toMatch(/trap .*EXIT/);
    const pins: Record<string, string[]> = {
      "claude-code": ["2.1.325"],
      codex: ["0.169.0"],
      opencode: ["1.19.5", "2.3.0"],
    };
    for (const [id, versions] of Object.entries(pins)) {
      for (const v of versions) expect(read(`scripts/live-smoke/${id}.sh`)).toContain(v);
    }
    expect(lib).toContain("version_check");
    for (const f of ["performance.json", "discovery.json", "sufficiency.json", "report perf"]) {
      expect(lib).toContain(f);
    }
  });

  it("lib.sh records the R31 refusal and the 60 s timing", () => {
    const lib = read("scripts/live-smoke/lib.sh");
    expect(lib).toMatch(/dynamic-skills -V save/);
    expect(lib).toContain("R31");
    expect(lib).toMatch(/60/);
  });

  it("the Claude Code script denies Edit and Write on all four permanent roots", () => {
    const text = read("scripts/live-smoke/claude-code.sh");
    expect(text).toContain("--disallowedTools");
    for (const tool of ["Edit", "Write"]) {
      for (const root of [
        `${tool}(//${v("REAL_HOME")}/.claude/**)`,
        `${tool}(//${v("REAL_HOME")}/.agents/**)`,
        `${tool}(//${v("OPENCODE_GLOBAL_SKILLS")}/**)`,
        `${tool}(//${v("REPO")}/.claude/skills/**)`,
      ]) {
        expect(text, root).toContain(root);
      }
    }
    expect(text).toContain("Bash(dynamic-skills *)");
    expect(text).toContain("--add-dir");
    expect(text).toContain("native/claude-code");
    expect(text).toContain("/dynamic-skill-bootstrap");
    expect(text).toContain("D6");
  });

  it("the Codex script runs sandboxed with approvals never and records R32", () => {
    const text = read("scripts/live-smoke/codex.sh");
    expect(text).toContain("--sandbox workspace-write");
    expect(text).toContain("approval_policy=never");
    expect(text).toContain("R32");
    expect(text).toContain("$dynamic-skill-bootstrap");
  });

  it("the OpenCode script isolates its config dir and records R35 and the variant", () => {
    const text = read("scripts/live-smoke/opencode.sh");
    expect(text).toContain("OPENCODE_CONFIG_DIR");
    expect(text).toContain("--scope personal");
    expect(text).toContain("R35");
    expect(text).toContain("@dynamic-skill-bootstrap");
    expect(text).toContain("/dynamic-skill-bootstrap");
    expect(text).toContain("opencode run");
  });

  it("the dispatcher rejects an unknown or missing harness with exit 2", () => {
    for (const args of [["bogus"], [], ["codex", "weird-mode"]]) {
      const r = spawnSync("bash", [join(ROOT, "scripts/live-smoke.sh"), ...args], {
        encoding: "utf8",
      });
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/usage/i);
    }
  });
});

describe("live smoke fix round 1", () => {
  it("scopes the Claude Code file tools to the temp workspace and denies init, save and real config", () => {
    const text = read("scripts/live-smoke/claude-code.sh");
    for (const t of ["Read", "Edit", "Write"]) expect(text).toContain(t + "($scope)");
    expect(text).toContain("//" + v("TMP_REAL") + "/**");
    for (const d of [
      '"Bash(dynamic-skills init)" "Bash(dynamic-skills init *)"',
      '"Bash(dynamic-skills save)" "Bash(dynamic-skills save *)"',
      "//" + v("REAL_HOME") + "/.codex/**",
      "//" + v("OPENCODE_GLOBAL_CONFIG") + "/**",
    ]) {
      expect(text, d).toContain(d);
    }
    expect(text).toContain("--settings");
    expect(text).toContain("--output-format json");
    expect(text).toContain("alias-write.txt");
    // The bare Read, Edit and Write grants are gone.
    expect(text).not.toMatch(/allowedTools "Bash\(dynamic-skills \*\)" Read Write Edit/);
  });

  it("logs every CLI call through a wrapper and reports shadowing (R19)", () => {
    const lib = read("scripts/live-smoke/lib.sh");
    expect(lib).toContain("cli-calls.log");
    expect(lib).toContain("SHADOWED");
    expect(lib).toContain("type -a dynamic-skills");
    expect(lib).toMatch(/exec %q %q "\$@"/);
  });

  it("re-checks AC 28 after the probes and prints the evidence files", () => {
    const lib = read("scripts/live-smoke/lib.sh");
    expect(lib).toContain('"AC 28 (after probes)" real');
    for (const f of ["assumptions.json", "evaluation.json", "session.json"])
      expect(lib).toContain(f);
    expect(lib).toContain("SMOKE_KEEP");
    expect(lib).toMatch(/gtimeout/);
    expect(lib).toContain("[progress]");
    expect(lib).toContain("find -L");
    expect(lib).toContain("opencode-config/skills");
  });

  it("seeds a default-ask bash rule and uses --command on OpenCode v1", () => {
    const text = read("scripts/live-smoke/opencode.sh");
    expect(text).toContain('{"permission":{"bash":{"*":"ask"}}}');
    expect(text).toContain("--command dynamic-skill-bootstrap");
    expect(text).toContain("--format json");
    expect(text).toContain("/.opencode/skills/*");
    expect(text).toContain("/.agents/skills/*");
  });

  it("uses structured output and an untrusted-repo notice on Codex, with the manual R32 procedure", () => {
    const text = read("scripts/live-smoke/codex.sh");
    expect(text).toContain("--json");
    expect(text).toContain("UNTRUSTED");
    expect(text).toContain("on-request");
    expect(text).toContain("grep -l");
  });

  it("AC 28 detects a change made through a symlinked skill root", () => {
    const dir = mkdtempSync(join(tmpdir(), "smoke-ac28-"));
    try {
      const home = join(dir, "home");
      const dots = join(dir, "dotfiles-skills");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(dots, "x"), { recursive: true });
      writeFileSync(join(dots, "x", "SKILL.md"), "one");
      symlinkSync(dots, join(home, ".claude", "skills"));
      const script = [
        "set -euo pipefail",
        `source ${JSON.stringify(join(ROOT, "scripts/live-smoke/lib.sh"))}`,
        `TMP=${JSON.stringify(dir)}; REPO=${JSON.stringify(join(dir, "repo"))}`,
        "OPENCODE_GLOBAL_SKILLS=$TMP/none; CODEX_HOME_REAL=$TMP/none",
        'mkdir -p "$REPO"',
        'real_skill_roots; snapshot_roots "$TMP/snap-real-before" "${REAL_ROOTS[@]}"',
        'repo_skill_roots; snapshot_roots "$TMP/snap-repo-before" "${REPO_ROOTS[@]}"',
        "ac28_check 'AC 28'",
        `echo two > ${JSON.stringify(join(dots, "x", "SKILL.md"))}`,
        "ac28_check 'AC 28'",
      ].join("\n");
      const r = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      expect(r.stderr).toBe("");
      const lines = r.stdout.trim().split("\n");
      expect(lines[0]).toMatch(/^AC 28: PASS/);
      expect(lines[1]).toMatch(/^AC 28: FAIL .*SKILL\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses versions exactly instead of matching substrings", () => {
    const script = `source ${JSON.stringify(join(ROOT, "scripts/live-smoke/lib.sh"))}; parse_version 'codex-cli 0.169.0 (abc)'; parse_version 'v12.3.0.1'; parse_version none`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["0.169.0", "12.3.0"]);
  });
});
