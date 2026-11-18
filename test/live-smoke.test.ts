import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = [
  "scripts/live-smoke.sh",
  "scripts/live-smoke/lib.sh",
  "scripts/live-smoke/claude-code.sh",
  "scripts/live-smoke/codex.sh",
  "scripts/live-smoke/opencode.sh",
];
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
    expect(lib).toContain("WARNING: neither timeout nor gtimeout");
  });

  it("uses structured output and an untrusted-repo notice on Codex, with the manual R32 procedure", () => {
    const text = read("scripts/live-smoke/codex.sh");
    expect(text).toContain("--json");
    expect(text).toContain("UNTRUSTED");
    expect(text).toContain("on-request");
    expect(text).toContain("grep -l");
  });

  it("parses versions exactly instead of matching substrings", () => {
    const script = `source ${JSON.stringify(join(ROOT, "scripts/live-smoke/lib.sh"))}; parse_version 'codex-cli 0.169.0 (abc)'; parse_version 'v12.3.0.1'; parse_version none`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["0.169.0", "12.3.0"]);
  });
});

/** Run a bash script text with a temp HOME and extra env; returns stdout, stderr and status. */
function bash(script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
}
const src = (rel: string): string => `source ${JSON.stringify(join(ROOT, rel))}`;

describe("fix round 2", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smoke-r2-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Environment the harness scripts expect after smoke_setup. */
  function setupEnv(): string {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    return [
      `export HOME=${JSON.stringify(home)}`,
      `REAL_HOME=${JSON.stringify(home)}`,
      `TMP=${JSON.stringify(dir)}; TMP_REAL=$TMP; REPO=$TMP/repo; REPO_REAL=$REPO`,
      `DYNAMIC_SKILLS_HOME=$TMP/sessions-home; DSH_REAL=$DYNAMIC_SKILLS_HOME; BIN=$TMP/bin`,
      `OPENCODE_GLOBAL_CONFIG=$HOME/.config/opencode; OPENCODE_GLOBAL_SKILLS=$OPENCODE_GLOBAL_CONFIG/skills`,
      `CODEX_HOME_REAL=$HOME/.codex; HARNESS_ID=claude-code; CONSENT_SESSION=sess1; NATIVE=0; MODE=main`,
    ].join("\n");
  }

  function lines(r: { stdout: string; stderr: string; status: number | null }): string[] {
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    return r.stdout.split("\n").filter((l) => l !== "");
  }

  describe("R41 wrapper", () => {
    function wrapperRun(
      args: string[],
      agent: boolean,
    ): { code: number; out: string; calls: string } {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      const cli = join(dir, "fake-cli.js");
      writeFileSync(cli, 'console.log("ran: " + process.argv.slice(2).join(" "));\n');
      const log = join(dir, "calls.log");
      const w = join(bin, "dynamic-skills");
      const r0 = bash(
        `${src("scripts/live-smoke/lib.sh")}; make_wrapper ${JSON.stringify(w)} "$(command -v node)" ${JSON.stringify(cli)} ${JSON.stringify(log)} claude-code`,
      );
      expect(r0.stderr).toBe("");
      const env: Record<string, string> = agent ? { SMOKE_AGENT: "1" } : {};
      const r = spawnSync(w, args, {
        encoding: "utf8",
        env: { ...process.env, ...env, SMOKE_AGENT: agent ? "1" : "" },
      });
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      return { code: r.status ?? -1, out: r.stdout, calls };
    }
    const H = ["--harness", "claude-code"];

    it.each([
      ["init without --dry-run", ["init", ...H, "--scope", "project", "--repo", "/x"]],
      [
        "init for another harness without --dry-run",
        ["init", "--harness", "codex", "--scope", "personal"],
      ],
      ["save --scope personal", ["save", "--session", "s", "--scope", "personal", ...H]],
      ["save --scope=personal", ["save", "--session", "s", "--scope=personal", ...H]],
      [
        "save with another harness",
        ["save", "--session", "s", "--scope", "project", "--harness", "codex"],
      ],
      [
        "save with --harness=codex",
        ["save", "--session", "s", "--scope", "project", "--harness=codex"],
      ],
      [
        "save with a harness list",
        ["save", "--session", "s", "--scope", "project", "--harness", "claude-code,codex"],
      ],
      ["save without --scope", ["save", "--session", "s", ...H]],
    ])("refuses %s under SMOKE_AGENT=1 with exit 2 and a log line", (_n, args) => {
      const r = wrapperRun(args, true);
      expect(r.code).toBe(2);
      expect(r.out).not.toContain("ran:");
      expect(r.calls).toMatch(/refused/);
    });

    it.each([
      ["init --dry-run", ["init", ...H, "--scope", "personal", "--dry-run"]],
      ["save --scope project", ["save", "--session", "s", "--scope", "project", ...H]],
      [
        "save --scope=project",
        ["save", "--session", "s", "--scope=project", "--harness=claude-code"],
      ],
      ["save --scope ephemeral", ["save", "--session", "s", "--scope", "ephemeral", ...H]],
      ["save --scope discard", ["save", "--session", "s", "--scope", "discard", ...H]],
      ["report perf", ["report", "perf"]],
    ])("passes %s through under SMOKE_AGENT=1 and logs it", (_n, args) => {
      const r = wrapperRun(args, true);
      expect(r.code).toBe(0);
      expect(r.out).toContain("ran: " + args.join(" "));
      expect(r.calls.trim().split("\n")).toHaveLength(1);
      expect(r.calls).not.toMatch(/refused/);
    });

    it("guards nothing and logs nothing without SMOKE_AGENT", () => {
      const r = wrapperRun(["save", "--session", "s", "--scope", "personal", ...H], false);
      expect(r.code).toBe(0);
      expect(r.out).toContain("ran: save");
      expect(r.calls).toBe("");
    });

    it("sets SMOKE_AGENT only around the agent run and makes the wrapper read-only", () => {
      const lib = code("scripts/live-smoke/lib.sh");
      expect(lib).toMatch(/export SMOKE_AGENT=1/);
      expect(lib).toContain("chmod a-w");
      expect(lib).not.toMatch(/^export SMOKE_AGENT/m);
    });
  });

  describe("Claude Code arguments", () => {
    function claudeArgs(kind: string): string[] {
      const r = bash(
        `${setupEnv()}\n${src("scripts/live-smoke/claude-code.sh")}\nclaude_args ${kind}`,
      );
      return lines(r);
    }
    /** The values after one flag, up to the next flag. */
    function after(args: string[], flag: string): string[] {
      const i = args.indexOf(flag);
      expect(i, flag).toBeGreaterThanOrEqual(0);
      const out: string[] = [];
      for (const a of args.slice(i + 1)) {
        if (a.startsWith("--")) break;
        out.push(a);
      }
      return out;
    }

    it.each(["main", "probe", "probe-consent"])(
      "%s: init denied, no bare or broad file grants",
      (kind) => {
        const a = claudeArgs(kind);
        const allow = after(a, "--allowedTools");
        const deny = after(a, "--disallowedTools");
        expect(deny).toContain("Bash(dynamic-skills init)");
        expect(deny).toContain("Bash(dynamic-skills init *)");
        for (const t of ["Edit", "Write", "Read", "Glob", "Grep"]) expect(allow).not.toContain(t);
        for (const g of allow.filter((x) => /^(Read|Edit|Write)\(/.test(x))) {
          expect(g).toMatch(/^(Read|Edit|Write)\(\/\/.*(\/repo|\/sessions-home)\/\*\*\)$/);
          expect(g).not.toContain(dir + "/**");
        }
        for (const t of ["Edit", "Write"]) {
          expect(allow.filter((x) => x.startsWith(t + "(")).length).toBe(2);
          expect(deny).toContain(`${t}(//${join(dir, "repo").slice(1)}/.claude/settings*.json)`);
          expect(deny).toContain(`${t}(//${join(dir, "home", ".codex").slice(1)}/**)`);
        }
      },
    );

    it.each(["main", "probe"])("%s: broad allow kept and save denied", (kind) => {
      const a = claudeArgs(kind);
      expect(after(a, "--allowedTools")).toContain("Bash(dynamic-skills *)");
      const deny = after(a, "--disallowedTools");
      expect(deny).toContain("Bash(dynamic-skills save)");
      expect(deny).toContain("Bash(dynamic-skills save *)");
      expect(a).not.toContain("--settings");
    });

    it("probe-consent: allows only the exact save command", () => {
      const a = claudeArgs("probe-consent");
      const allow = after(a, "--allowedTools");
      expect(allow).not.toContain("Bash(dynamic-skills *)");
      expect(allow).toContain(
        "Bash(dynamic-skills save --session sess1 --scope project --harness claude-code)",
      );
      expect(allow.filter((x) => x.startsWith("Bash("))).toHaveLength(1);
      expect(after(a, "--disallowedTools")).not.toContain("Bash(dynamic-skills save *)");
    });

    it("structured output for probes only", () => {
      expect(claudeArgs("main")).not.toContain("--output-format");
      expect(claudeArgs("probe")).toContain("--output-format");
    });
  });

  describe("OpenCode config", () => {
    const run = (fn: string) =>
      lines(
        bash(
          `${setupEnv()}\nHARNESS_ID=opencode; OPENCODE_CONFIG_DIR=$TMP/opencode-config\n${src("scripts/live-smoke/opencode.sh")}\n${fn}`,
        ),
      );

    it("seeds the config file with ask-all bash and every edit deny", () => {
      const seed = JSON.parse(run("oc_seed").join("\n"));
      expect(seed.permission.bash).toEqual({ "*": "ask" });
      const edit = Object.keys(seed.permission.edit);
      for (const p of [
        join(dir, "home", ".claude") + "/*",
        join(dir, "home", ".agents") + "/*",
        join(dir, "home", ".config", "opencode") + "/*",
        join(dir, "home", ".codex") + "/*",
        join(dir, "repo", ".opencode", "skills") + "/*",
        join(dir, "repo", ".agents", "skills") + "/*",
        join(dir, "bin") + "/*",
        join(dir, "opencode-config") + "/*",
        join(dir, "repo", "opencode.json") + "*",
        join(dir, "repo", ".opencode", "opencode.json") + "*",
      ]) {
        expect(edit, p).toContain(p);
        expect(seed.permission.edit[p]).toBe("deny");
      }
    });

    it("main-run env content denies init and save; probes do not", () => {
      const main = JSON.parse(run("oc_content main").join("\n"));
      expect(main.permission.bash["dynamic-skills init *"]).toBe("deny");
      expect(main.permission.bash["dynamic-skills save *"]).toBe("deny");
      expect(main.permission.edit).toBeUndefined();
      const probe = JSON.parse(run("oc_content probe").join("\n"));
      expect(probe.permission?.bash).toBeUndefined();
    });
  });

  it("Codex ignores user rules in every exec call", () => {
    for (const kind of ["main", "probe"]) {
      const a = lines(
        bash(
          `${setupEnv()}\nHARNESS_ID=codex\n${src("scripts/live-smoke/codex.sh")}\ncodex_args ${kind}`,
        ),
      );
      expect(a).toContain("--ignore-rules");
      expect(a).toContain("workspace-write");
    }
  });

  it("runs the after-probe AC 28 check after the probes (comment-stripped code)", () => {
    const lib = code("scripts/live-smoke/lib.sh");
    const probes = lib.indexOf("harness_probes\n");
    const after = lib.indexOf('ac28_check "AC 28 (after probes)" real');
    expect(probes).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(probes);
    expect(lib).not.toContain("snap-real-before");
  });

  it("AC 28 keeps baselines in variables and sees changes behind symlinked roots and files", () => {
    const home = join(dir, "home");
    const dots = join(dir, "dotfiles-skills");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(dots, "x"), { recursive: true });
    writeFileSync(join(dots, "x", "SKILL.md"), "one");
    writeFileSync(join(dir, "real.md"), "a");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    symlinkSync(join(dir, "real.md"), join(home, ".agents", "skills", "linked.md"));
    symlinkSync(dots, join(home, ".claude", "skills"));
    const script = [
      "set -euo pipefail",
      `export HOME=${JSON.stringify(home)}`,
      src("scripts/live-smoke/lib.sh"),
      `TMP=${JSON.stringify(dir)}; REPO=$TMP/repo; mkdir -p "$REPO"`,
      "OPENCODE_GLOBAL_SKILLS=$TMP/none; CODEX_HOME_REAL=$TMP/none",
      'real_skill_roots; SNAP_REAL_BEFORE="$(snapshot_roots "${REAL_ROOTS[@]}")"',
      'repo_skill_roots; SNAP_REPO_BEFORE="$(snapshot_roots "${REPO_ROOTS[@]}")"',
      "ac28_check 'AC 28'",
      `echo two > ${JSON.stringify(join(dots, "x", "SKILL.md"))}`,
      "ac28_check 'AC 28'",
      `echo two > ${JSON.stringify(join(dir, "real.md"))}`,
      `echo one > ${JSON.stringify(join(dots, "x", "SKILL.md"))}`,
      "ac28_check 'AC 28' real",
    ].join("\n");
    const out = lines(bash(script));
    expect(out[0]).toMatch(/^AC 28: PASS/);
    expect(out[1]).toMatch(/^AC 28: FAIL .*SKILL\.md/);
    expect(out[2]).toMatch(/^AC 28: FAIL .*linked\.md/);
  });

  it("SMOKE_KEEP copies once without out/out nesting and the cleanup removes the workspace", () => {
    const keep = join(dir, "keep");
    const tmp = join(dir, "ws");
    mkdirSync(join(tmp, "out"), { recursive: true });
    mkdirSync(join(tmp, "sessions-home", "sessions", "s1"), { recursive: true });
    writeFileSync(join(tmp, "out", "main.txt"), "x");
    const r = bash(
      `${src("scripts/live-smoke/lib.sh")}; TMP=${JSON.stringify(tmp)}; DYNAMIC_SKILLS_HOME=$TMP/sessions-home; SMOKE_KEEP=${JSON.stringify(keep)}; smoke_cleanup; smoke_cleanup; test ! -e "$TMP"`,
    );
    expect(r.status).toBe(0);
    expect(readFileSync(join(keep, "out", "main.txt"), "utf8")).toBe("x");
    expect(() => readFileSync(join(keep, "out", "out", "main.txt"))).toThrow();
    expect(lines(bash("true")).length).toBe(0);
  });

  it("prints session and evaluation fields that exist in the schemas", () => {
    const lib = read("scripts/live-smoke/lib.sh");
    for (const f of ["overall", "activatable", "completedSteps", "outcome"])
      expect(lib).toContain(f);
    expect(lib).not.toContain("lastStep");
    expect(lib).not.toContain("read -r -a");
  });
});
