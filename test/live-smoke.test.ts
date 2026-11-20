import { spawnSync } from "node:child_process";
import { R19_RUNNER, joinContinuations } from "./r19";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
    const r = spawnSync("bash", ["-n", join(ROOT, rel)], { encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    if (rel !== "scripts/live-smoke/lib.sh") expect(read(rel)).toContain("set -euo pipefail");
  });

  it.each(SCRIPTS)("%s never uses a package runner for dynamic-skills (R19)", (rel) => {
    expect(joinContinuations(read(rel))).not.toMatch(R19_RUNNER);
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

  it("lib.sh records the R31 refusal and the 150 s timing", () => {
    const lib = read("scripts/live-smoke/lib.sh");
    expect(lib).toMatch(/dynamic-skills -V save/);
    expect(lib).toContain("R31");
    expect(lib).toContain("SMOKE_BUDGET_SECS=150");
    expect(lib).toContain("DEFAULT_BUDGET_MS");
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
        timeout: 60_000,
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
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 60_000 });
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["0.169.0", "12.3.0"]);
  });
});

/** Run a bash script text with a temp HOME and extra env; returns stdout, stderr and status. */
function bash(script: string, env: Record<string, string> = {}) {
  // Hermetic: drop every variable the scripts read that a developer may have exported.
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(base)) {
    if (/^(SMOKE_|DYNAMIC_SKILLS_)/.test(k)) delete base[k];
  }
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"])
    delete base[k];
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...base, ...env },
    timeout: 60_000,
  });
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

  describe("R41 wrapper (always on, jailed)", () => {
    const H = ["--harness", "claude-code"];
    /** Build the wrapper around a fake CLI and run it with the given args. */
    function wrapperRun(
      args: string[],
      opts: {
        cliBody?: string;
        sessions?: Record<string, string>;
        env?: Record<string, string>;
        cwd?: string;
      } = {},
    ) {
      const bin = join(dir, "bin");
      const repo = join(dir, "repo");
      const dsh = join(dir, "sessions-home");
      mkdirSync(bin, { recursive: true });
      mkdirSync(repo, { recursive: true });
      const repoReal = realpathSync(repo);
      const sessions = { S1: repoReal, S2: realpathSync(tmpdir()), ...opts.sessions };
      for (const [id, r] of Object.entries(sessions)) {
        mkdirSync(join(dsh, "sessions", id), { recursive: true });
        writeFileSync(join(dsh, "sessions", id, "session.json"), JSON.stringify({ id, repo: r }));
      }
      const cli = join(dir, "fake-cli.js");
      writeFileSync(
        cli,
        opts.cliBody ?? 'console.log("ran: " + process.argv.slice(2).join(" "));\n',
      );
      const log = join(dir, "calls.log");
      const jail = join(dir, "jail");
      const w = join(bin, "dynamic-skills");
      const r0 = bash(
        `${src("scripts/live-smoke/lib.sh")}; make_wrapper ${JSON.stringify(w)} "$(command -v node)" ${JSON.stringify(cli)} ${JSON.stringify(log)} claude-code ${JSON.stringify(jail)} ${JSON.stringify(repoReal)} ${JSON.stringify(dsh)}`,
      );
      expect(r0.stderr).toBe("");
      const env = {
        ...process.env,
        DYNAMIC_SKILLS_HOME: dsh,
        HOME: join(dir, "home"),
        ...opts.env,
      };
      mkdirSync(env.HOME, { recursive: true });
      const r = spawnSync(w, args, { encoding: "utf8", env, cwd: opts.cwd, timeout: 60_000 });
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      return {
        code: r.status ?? -1,
        out: r.stdout,
        err: r.stderr,
        calls,
        repoReal,
        jail,
        home: env.HOME,
      };
    }
    const S = ["--session", "S1"];
    const REASONS: Record<string, string> = {
      "init without --dry-run": "init is allowed only with --dry-run",
      "init hiding --dry-run as the value of --repo": "bad value for --repo",
      "init for another harness without --dry-run": "init is allowed only with --dry-run",
      "init --dry-run with a repo outside the workspace": "--repo is outside the workspace repo",
      "init --dry-run=1": "unknown option --dry-run for init",
      "save --scope personal": "save needs --scope",
      "save --scope=personal": "save needs --scope",
      "save hiding a scope inside --session": "bad value for --session",
      "save hiding a harness inside --session": "bad value for --session",
      "save with a repeated option": "repeated --session",
      "save with an unknown option": "unknown option --force for save",
      "save with --": "-- is not allowed",
      "save with a stray positional": "unexpected argument",
      "save with another harness": "must be exactly claude-code",
      "save with --harness=codex": "must be exactly claude-code",
      "save with a harness list": "must be exactly claude-code",
      "save without --scope": "save needs --scope",
      "save without --session": "valid --session",
      "save of a session whose repo is elsewhere": "not the workspace repo",
      "save of a session that does not exist": "not found",
      "save with a path-like session": "valid --session",
      "assess with a repo outside the workspace": "--repo is outside the workspace repo",
      "report with --repo=<outside>": "--repo is outside the workspace repo",
      "save with a repeated --scope": "repeated --scope",
      "save with a dash-prefixed value": "bad value for --scope",
      "init with a repeated --dry-run": "repeated --dry-run",
    };

    it.each([
      ["init without --dry-run", ["init", ...H, "--scope", "project", "--repo", "/x"]],
      [
        "init hiding --dry-run as the value of --repo",
        ["init", ...H, "--scope", "personal", "--repo", "--dry-run"],
      ],
      [
        "init for another harness without --dry-run",
        ["init", "--harness", "codex", "--scope", "personal"],
      ],
      [
        "init --dry-run with a repo outside the workspace",
        ["init", ...H, "--repo", "/", "--dry-run"],
      ],
      ["init --dry-run=1", ["init", ...H, "--dry-run=1"]],
      ["save --scope personal", ["save", ...S, "--scope", "personal", ...H]],
      ["save --scope=personal", ["save", ...S, "--scope=personal", ...H]],
      [
        "save hiding a scope inside --session",
        ["save", "--scope", "personal", "--session", "--scope=project", "--session", "S1"],
      ],
      [
        "save hiding a harness inside --session",
        ["save", "--scope", "project", "--session", "--harness=opencode", "--session", "S1"],
      ],
      ["save with a repeated option", ["save", ...S, ...S, "--scope", "project"]],
      ["save with an unknown option", ["save", ...S, "--scope", "project", "--force", "yes"]],
      ["save with --", ["save", ...S, "--scope", "project", "--"]],
      ["save with a stray positional", ["save", ...S, "--scope", "project", "extra"]],
      ["save with another harness", ["save", ...S, "--scope", "project", "--harness", "codex"]],
      ["save with --harness=codex", ["save", ...S, "--scope", "project", "--harness=codex"]],
      [
        "save with a harness list",
        ["save", ...S, "--scope", "project", "--harness", "claude-code,codex"],
      ],
      ["save without --scope", ["save", ...S, ...H]],
      ["save without --session", ["save", "--scope", "project", ...H]],
      [
        "save of a session whose repo is elsewhere",
        ["save", "--session", "S2", "--scope", "project", ...H],
      ],
      [
        "save of a session that does not exist",
        ["save", "--session", "nope", "--scope", "project", ...H],
      ],
      ["save with a path-like session", ["save", "--session", "../S1", "--scope", "project", ...H]],
      ["assess with a repo outside the workspace", ["assess", "--repo", "/"]],
      ["report with --repo=<outside>", ["report", "perf", "--repo=/"]],
      ["save with a repeated --scope", ["save", ...S, "--scope", "project", "--scope", "project"]],
      ["save with a dash-prefixed value", ["save", ...S, "--scope", "-project"]],
      ["init with a repeated --dry-run", ["init", ...H, "--dry-run", "--dry-run"]],
    ])("refuses %s with exit 2 and the reason", (n, args) => {
      const r = wrapperRun(args);
      expect(r.code).toBe(2);
      const reason = REASONS[n] as string;
      expect(r.err).toContain("refused: ");
      expect(r.err).toContain(reason);
      expect(r.calls).toContain(reason);
      expect(r.out).not.toContain("ran:");
      expect(r.calls).toMatch(/refused/);
    });

    it.each([
      [
        "init --dry-run",
        (r: string) => ["init", ...H, "--scope", "personal", "--repo", r, "--dry-run"],
      ],
      ["init --harness=x --dry-run", () => ["init", "--harness=codex", "--dry-run"]],
      ["save --scope project", () => ["save", ...S, "--scope", "project", ...H]],
      [
        "save with = forms",
        () => ["save", "--session=S1", "--scope=project", "--harness=claude-code"],
      ],
      [
        "save with the claude alias",
        () => ["save", ...S, "--scope", "project", "--harness", "claude"],
      ],
      [
        "save with an aliased list in any order",
        () => ["save", ...S, "--scope", "project", "--harness", "claude,claude-code"],
      ],
      ["save --scope ephemeral", () => ["save", ...S, "--scope", "ephemeral", ...H]],
      [
        "save --scope discard --dry-run",
        () => ["save", ...S, "--scope", "discard", ...H, "--dry-run"],
      ],
      ["report perf", () => ["report", "perf"]],
      ["assess with a repo inside", (r: string) => ["assess", "--repo", r]],
    ])("passes %s through and logs an allowed line", (_n, mk) => {
      mkdirSync(join(dir, "repo"), { recursive: true });
      const args = mk(realpathSync(join(dir, "repo")));
      const r = wrapperRun(args);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toContain("ran: " + args.join(" "));
      expect(r.calls.trim().split("\n")).toHaveLength(1);
      expect(r.calls).toMatch(/allowed/);
      expect(r.calls).not.toMatch(/refused/);
    });

    it("pins DYNAMIC_SKILLS_HOME and ignores CDPATH", () => {
      const body = 'console.log("DSH=" + process.env.DYNAMIC_SKILLS_HOME);';
      const r = wrapperRun(["report", "perf"], {
        cliBody: body,
        env: { DYNAMIC_SKILLS_HOME: "/elsewhere" },
      });
      expect(r.out).toContain("DSH=" + join(dir, "sessions-home"));
      const empty = join(dir, "cwd");
      mkdirSync(empty, { recursive: true });
      const c = wrapperRun(["assess", "--repo", "repo"], { env: { CDPATH: dir }, cwd: empty });
      expect(c.code).toBe(2);
      expect(c.err).toContain("--repo is outside the workspace repo");
    });

    it("guards with no special environment set (no opt-in variable)", () => {
      const r = wrapperRun(["save", ...S, "--scope", "personal", ...H]);
      expect(r.code).toBe(2);
    });

    it("runs init and save with every home and config root jailed inside the workspace", () => {
      const body = [
        'const fs = require("node:fs"); const path = require("node:path");',
        'fs.mkdirSync(path.join(process.env.HOME, ".claude"), { recursive: true });',
        'fs.writeFileSync(path.join(process.env.HOME, ".claude", "x"), "w");',
        'console.log(["HOME","CLAUDE_CONFIG_DIR","CODEX_HOME","XDG_CONFIG_HOME","OPENCODE_CONFIG_DIR","DYNAMIC_SKILLS_ETC_DIR","DYNAMIC_SKILLS_HOME"].map((k) => k + "=" + process.env[k]).join("\\n"));',
      ].join("\n");
      const r = wrapperRun(["save", ...S, "--scope", "project", ...H], { cliBody: body });
      expect(r.code).toBe(0);
      expect(existsSync(join(r.home, ".claude", "x"))).toBe(false);
      expect(existsSync(join(r.jail, "home", ".claude", "x"))).toBe(true);
      for (const k of [
        "HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "XDG_CONFIG_HOME",
        "OPENCODE_CONFIG_DIR",
        "DYNAMIC_SKILLS_ETC_DIR",
      ]) {
        expect(r.out, k).toMatch(
          new RegExp(`${k}=${r.jail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`),
        );
      }
      expect(r.out).toContain("DYNAMIC_SKILLS_HOME=" + join(dir, "sessions-home"));
    });

    it("does not jail other commands", () => {
      const r = wrapperRun(["report", "perf"], {
        cliBody: 'console.log("HOME=" + process.env.HOME);',
      });
      expect(r.out).toContain("HOME=" + join(dir, "home"));
    });

    it("has no opt-in variable and bypasses the guard only through a non-exported function", () => {
      const lib = code("scripts/live-smoke/lib.sh");
      for (const f of [
        "scripts/live-smoke/claude-code.sh",
        "scripts/live-smoke/codex.sh",
        "scripts/live-smoke/opencode.sh",
      ]) {
        expect(code(f)).not.toContain("SMOKE_AGENT");
      }
      expect(lib).not.toContain("SMOKE_AGENT");
      expect(lib).toMatch(/^dynamic-skills\(\) \{/m);
      expect(lib).not.toMatch(/export -f/);
      expect(lib).toContain("type -P");
      expect(lib).toContain("chmod a-w");
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
        for (const g of allow.filter((x) => /^(Read|Edit)\(/.test(x))) {
          expect(g).toMatch(/^(Read|Edit)\(\/\/.*(\/repo|\/sessions-home)\/\*\*\)$/);
          expect(g).not.toContain(dir + "/**");
        }
        expect([...allow, ...deny].filter((x) => x.startsWith("Write("))).toEqual([]);
        expect(allow.filter((x) => x.startsWith("Edit(")).length).toBe(2);
        const rel = (p: string) => "//" + p.slice(1);
        const home = join(dir, "home");
        const edits = [
          `${rel(join(dir, "repo"))}/.claude/settings*.json`,
          `${rel(home)}/.claude/**`,
          `${rel(home)}/.agents/**`,
          `${rel(join(home, ".codex"))}/**`,
          `${rel(join(home, ".config", "opencode", "skills"))}/**`,
          `${rel(join(home, ".config", "opencode"))}/**`,
          `${rel(join(dir, "repo"))}/.claude/skills/**`,
        ];
        for (const e of edits) expect(deny, e).toContain(`Edit(${e})`);
        expect(deny.filter((x) => x.startsWith("Edit("))).toHaveLength(7);
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

    it("has no Write(path) permission rule (Claude Code only matches Edit(path))", () => {
      expect(code("scripts/live-smoke/claude-code.sh")).not.toMatch(/Write\(/);
    });

    it("keeps stderr out of the JSON output file and parses past warning lines", () => {
      const sh = code("scripts/live-smoke/claude-code.sh");
      expect(sh).toContain('2>"${out%.txt}.stderr.txt"');
      expect(sh).not.toMatch(/>"\$out" 2>&1/);
      const f = join(dir, "probe.txt");
      writeFileSync(
        f,
        [
          "Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted",
          JSON.stringify({
            type: "result",
            permission_denials: [
              { tool_name: "Bash", tool_input: { command: "dynamic-skills init" } },
            ],
          }),
          "",
        ].join("\n"),
      );
      const r = bash(
        `${src("scripts/live-smoke/claude-code.sh")}\nharness_evidence ${JSON.stringify(f)}`,
      );
      expect(r.stdout).toContain("permission_denials: 1");
      expect(r.stdout).toContain("Bash");
      expect(r.stdout).not.toContain("not one JSON document");
      writeFileSync(f, "only a warning\n");
      const r2 = bash(
        `${src("scripts/live-smoke/claude-code.sh")}\nharness_evidence ${JSON.stringify(f)}`,
      );
      expect(r2.stdout).toContain("not one JSON document");
    });

    it.each(["main", "probe", "probe-consent"])(
      "%s: structured output and no user settings or plugins",
      (kind) => {
        const a = claudeArgs(kind);
        expect(a[a.indexOf("--output-format") + 1]).toBe("json");
        expect(a[a.indexOf("--setting-sources") + 1]).toBe("project,local");
      },
    );

    it("denies edits in a different CLAUDE_CONFIG_DIR", () => {
      const cfg = join(dir, "elsewhere", "cfg");
      mkdirSync(cfg, { recursive: true });
      const r = bash(
        `${setupEnv()}\nexport CLAUDE_CONFIG_DIR=${JSON.stringify(cfg)}\n${src("scripts/live-smoke/claude-code.sh")}\nclaude_args main`,
      );
      expect(lines(r)).toContain(`Edit(//${cfg.slice(1)}/**)`);
    });

    it("harness_reply prints the JSON result and the skills from the transcript", () => {
      const home = join(dir, "home");
      const repo = join(dir, "repo");
      mkdirSync(repo, { recursive: true });
      const slug = realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-");
      const proj = join(home, ".claude", "projects", slug);
      mkdirSync(proj, { recursive: true });
      const sid = "11111111-2222";
      const tool = (skill: string) =>
        JSON.stringify({
          message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] },
        });
      writeFileSync(
        join(proj, `${sid}.jsonl`),
        [tool("brainstorming"), "not json", tool("dynamic-skill-bootstrap")].join("\n"),
      );
      const out = join(dir, "main.txt");
      writeFileSync(
        out,
        JSON.stringify({ type: "result", result: "Done: used it.", session_id: sid }),
      );
      const run = (file: string) =>
        bash(
          `${setupEnv()}\nREPO_REAL=${JSON.stringify(realpathSync(repo))}\n${src("scripts/live-smoke/claude-code.sh")}\nharness_reply ${JSON.stringify(file)}`,
        );
      const r = run(out);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Done: used it.");
      expect(r.stdout).toContain(
        "Skills invoked (via the Skill tool): brainstorming, dynamic-skill-bootstrap",
      );
      // A warning line before the JSON document, and a slash invocation in the transcript.
      writeFileSync(
        join(proj, `${sid}.jsonl`),
        JSON.stringify({
          type: "user",
          message: { content: "<command-name>/dynamic-skill-bootstrap</command-name> x" },
        }),
      );
      writeFileSync(
        out,
        `warning line\n${JSON.stringify({ type: "result", result: "ok", session_id: sid })}\n`,
      );
      const r3 = run(out);
      expect(r3.stdout).toContain("slash: dynamic-skill-bootstrap");
      expect(readFileSync(join(dir, "main.reply.txt"), "utf8")).toBe("ok\n");
      writeFileSync(out, "plain text reply\n");
      const r2 = run(out);
      expect(r2.status).toBe(0);
      expect(r2.stdout).toContain("plain text reply");
      expect(r2.stdout).toContain(
        "Skills invoked (via the Skill tool): unknown (transcript not found)",
      );
    });

    it("scans the extracted reply, so an empty permission_denials is not a denied line", () => {
      const out = join(dir, "main.txt");
      const mk = (denials: unknown[]) =>
        JSON.stringify({ type: "result", result: "all fine", permission_denials: denials });
      const run = () =>
        bash(
          `${setupEnv()}\n${src("scripts/live-smoke/claude-code.sh")}\nharness_reply ${JSON.stringify(out)} >/dev/null\nscan ${JSON.stringify(join(dir, "main.reply.txt"))} Denied 'denied|permission|not allowed|requires approval'\nharness_evidence ${JSON.stringify(out)}`,
        );
      writeFileSync(out, mk([]));
      const r = run();
      expect(r.stdout).toContain("Denied: 0 matching line(s)");
      expect(r.stdout).toContain("permission_denials: 0");
      writeFileSync(
        out,
        mk([{ tool_name: "Bash", tool_input: { command: "dynamic-skills init" } }]),
      );
      const r2 = run();
      expect(r2.stdout).toContain("permission_denials: 1");
      expect(r2.stdout).toContain("dynamic-skills init");
      const sh = code("scripts/live-smoke/claude-code.sh");
      expect(sh).not.toMatch(/scan "\$TMP\/out\/main\.txt"/);
      expect(code("scripts/live-smoke/lib.sh")).toContain('harness_evidence "$TMP/out/main.txt"');
    });

    it("the checklist records the plugin isolation and the forced-skill caveat", () => {
      const sh = read("scripts/live-smoke/claude-code.sh");
      expect(sh).toContain("MUST use before any creative work");
      expect(sh).toContain("NOT loaded, on purpose");
    });
  });

  describe("AC 28 synced exclusion", () => {
    it("ignores only Claude Code's skills/synced subtree and says so", () => {
      const r = bash(
        [
          `export HOME=${JSON.stringify(join(dir, "home"))}`,
          src("scripts/live-smoke/lib.sh"),
          `REAL_HOME=$HOME; REPO=${JSON.stringify(join(dir, "repo"))}; TMP=${JSON.stringify(dir)}`,
          "OPENCODE_GLOBAL_SKILLS=$HOME/oc/skills; CODEX_HOME_REAL=$HOME/.codex",
          "mkdir -p $HOME/.claude/skills/synced/a_b $HOME/.claude/skills/mine",
          "echo x > $HOME/.claude/skills/mine/SKILL.md",
          'real_skill_roots; repo_skill_roots; SNAP_REAL_BEFORE="$(snapshot_roots "${REAL_ROOTS[@]}")"; SNAP_REPO_BEFORE=',
          "echo m > $HOME/.claude/skills/synced/a_b/.last-complete-round",
          'ac28_check "AC 28" real',
          "echo y > $HOME/.claude/skills/mine/other.md",
          'ac28_check "AC 28" real',
        ].join("\n"),
      );
      expect(code("scripts/live-smoke/lib.sh")).toContain("skills/synced/ subtree");
      expect(r.stdout).toContain("AC 28: PASS");
      expect(r.stdout).toMatch(/AC 28: FAIL .*other\.md/);
      expect(r.stdout).not.toMatch(/FAIL .*last-complete-round/);
    });

    /** Run an AC 28 scenario; MUTATE runs between the baseline and the check. */
    const ac28 = (mutate: string, extraEnv: Record<string, string> = {}) =>
      bash(
        [
          `export HOME=${JSON.stringify(join(dir, "home"))}`,
          src("scripts/live-smoke/lib.sh"),
          `REAL_HOME=$HOME; REPO=${JSON.stringify(join(dir, "repo"))}; TMP=${JSON.stringify(dir)}`,
          "OPENCODE_GLOBAL_SKILLS=$HOME/oc/skills; CODEX_HOME_REAL=$HOME/.codex",
          "mkdir -p $HOME/.claude/skills/synced/a_b $HOME/.claude/skills/synced-x",
          "echo a > $HOME/.claude/skills/synced/a_b/f.md; echo b > $HOME/.claude/skills/synced-x/f.md",
          'real_skill_roots; repo_skill_roots; SNAP_REAL_BEFORE="$(snapshot_roots "${REAL_ROOTS[@]}")"; SNAP_REPO_BEFORE=',
          mutate,
          'ac28_check "AC 28" real',
        ].join("\n"),
        extraEnv,
      );

    it("derives the exclusion from the same roots that real_skill_roots watches", () => {
      const lib = code("scripts/live-smoke/lib.sh");
      expect(lib).not.toMatch(/synced="\$\{CLAUDE_CONFIG_DIR/);
      expect(lib).toMatch(/synced="\$\(printf '%s\/synced.*CLAUDE_SKILLS_ROOTS/);
      const r = bash(
        `export HOME=${JSON.stringify(join(dir, "home"))}\n${src("scripts/live-smoke/lib.sh")}\nREAL_HOME=$HOME; OPENCODE_GLOBAL_SKILLS=/x; real_skill_roots; printf '%s\\n' "${"$"}{CLAUDE_SKILLS_ROOTS[@]}"; printf 'R:%s\\n' "${"$"}{REAL_ROOTS[@]}"`,
      );
      expect(r.stdout.split("\n")[0]).toBe(join(dir, "home", ".claude", "skills"));
      expect(r.stdout).toContain(`R:${join(dir, "home", ".claude", "skills")}`);
    });

    it("watches and excludes synced in a different CLAUDE_CONFIG_DIR too", () => {
      const cfg = join(dir, "cfg");
      const r = ac28(
        `mkdir -p ${cfg}/skills/synced/q; echo z > ${cfg}/skills/synced/q/m; echo n > ${cfg}/skills/new.md`,
        { CLAUDE_CONFIG_DIR: cfg },
      );
      // The cfg root did not exist at baseline, so only the new file outside synced shows.
      expect(r.stdout).toMatch(/AC 28: FAIL .*new\.md/);
      expect(r.stdout).not.toMatch(/FAIL .*synced\/q/);
    });

    it("passes when a file is removed from synced", () => {
      const r = ac28("rm $HOME/.claude/skills/synced/a_b/f.md");
      expect(r.stdout).toContain("AC 28: PASS");
    });

    it("fails on a change in a synced-x sibling", () => {
      const r = ac28("echo c > $HOME/.claude/skills/synced-x/f.md");
      expect(r.stdout).toMatch(/AC 28: FAIL .*synced-x\/f\.md/);
    });
  });

  describe("trust warnings", () => {
    it("counts 'has not been trusted' once", () => {
      const f = join(dir, "stderr.txt");
      writeFileSync(
        f,
        "Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted\n",
      );
      const r = bash(
        `${src("scripts/live-smoke/lib.sh")}\nscan ${JSON.stringify(f)} "Trust warnings" "$TRUST_RE"`,
      );
      expect(r.stdout).toContain("Trust warnings: 1 matching line(s)");
    });
  });

  describe("task and main output", () => {
    it("uses a concrete Nx task that the fixture supports and keeps the injection in the fixture", () => {
      const lib = read("scripts/live-smoke/lib.sh");
      expect(lib).not.toContain("distributed caching");
      const m = /^TASK="(.*)"$/m.exec(lib);
      expect(m?.[1]).toMatch(/Nx/);
      expect(m?.[1]).toContain("packages/orders");
      expect(readFileSync(join(ROOT, "fixtures/repos/ts-monorepo/README.md"), "utf8")).toContain(
        "Fixture repository for discovery tests.",
      );
    });

    it("prints the main run's stderr tail under its own heading", () => {
      expect(read("scripts/live-smoke/lib.sh")).toContain("agent stderr (last 20 lines");
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
        join(dir, "out") + "/*",
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

describe("fix round 3", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smoke-r3-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("exports OPENCODE_CONFIG_CONTENT to the harness process", () => {
    const shim = join(dir, "shim");
    mkdirSync(shim);
    writeFileSync(
      join(shim, "opencode"),
      '#!/usr/bin/env bash\necho "CONTENT=$OPENCODE_CONFIG_CONTENT"\n',
      { mode: 0o755 },
    );
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const script = [
      `export HOME=${JSON.stringify(join(dir, "home"))} PATH=${JSON.stringify(shim)}:$PATH`,
      `REAL_HOME=$HOME; TMP=${JSON.stringify(dir)}; REPO=${JSON.stringify(repo)}; DSH_REAL=$TMP/s; HARNESS_ID=opencode`,
      "OPENCODE_GLOBAL_CONFIG=$HOME/.config/opencode; CODEX_HOME_REAL=$HOME/.codex; MODE=main; VARIANT=v1; TIMEOUT_CMD=()",
      src("scripts/live-smoke/opencode.sh"),
      'harness_run "p" "$TMP/o.txt" main',
    ].join("\n");
    expect(bash(script).status).toBe(0);
    const out = readFileSync(join(dir, "o.txt"), "utf8");
    expect(out).toContain('"dynamic-skills init *":"deny"');
    expect(out).toContain('"dynamic-skills save *":"deny"');
  });

  it("smoke_main always runs the after-probe AC 28 check, even with probes skipped", () => {
    for (const skip of ["0", "1"]) {
      const script = [
        src("scripts/live-smoke/lib.sh"),
        "smoke_setup() { REPO=/r; TMP=/t; DYNAMIC_SKILLS_HOME=/h; TIMEOUT_CMD=(); }",
        "harness_version_check() { :; }; real_skill_roots() { REAL_ROOTS=(); }; repo_skill_roots() { REPO_ROOTS=(); }",
        "snapshot_roots() { :; }; harness_install() { :; }; harness_prompt() { echo p; }",
        "harness_run() { :; }; print_timing() { :; }; print_reports() { :; }; cli_calls_report() { :; }",
        'jail_report() { echo JAIL "$*"; }; r31_check() { echo R31; }; harness_checklist() { :; }',
        'harness_probes() { echo PROBES; }; ac28_check() { echo "AC28 $*"; }',
        `SMOKE_SKIP_PROBES=${skip}; smoke_main h b autonomous`,
      ].join("\n");
      const r = bash(script);
      const out = r.stdout.split("\n");
      const after = out.indexOf("AC28 AC 28 (after probes) real");
      expect(after, skip).toBeGreaterThan(out.indexOf("AC28 AC 28"));
      if (skip === "0") expect(out.indexOf("PROBES")).toBeLessThan(after);
      else expect(out).not.toContain("PROBES");
      expect(out.some((l) => l.startsWith("JAIL"))).toBe(true);
    }
  });

  it("reports the jail contents as evidence and SHADOWED on zero logged calls", () => {
    const jail = join(dir, "jail", "home", ".claude");
    mkdirSync(jail, { recursive: true });
    writeFileSync(join(jail, "settings.json"), "{}");
    const r = bash(
      `${src("scripts/live-smoke/lib.sh")}; JAIL=${JSON.stringify(join(dir, "jail"))}; jail_report "main run"`,
    );
    expect(r.stdout).toMatch(
      /JAIL \(main run\): the agent attempted a personal write.*settings\.json/,
    );
    const empty = bash(
      `${src("scripts/live-smoke/lib.sh")}; mkdir -p ${JSON.stringify(join(dir, "j2"))}; JAIL=${JSON.stringify(join(dir, "j2"))}; jail_report x`,
    );
    expect(empty.stdout).toMatch(/JAIL \(x\): clean/);
    const dsh = join(dir, "dsh");
    mkdirSync(join(dsh, "sessions", "S1"), { recursive: true });
    const sh = bash(
      `${src("scripts/live-smoke/lib.sh")}; DYNAMIC_SKILLS_HOME=${JSON.stringify(dsh)}; CALLS_LOG=${JSON.stringify(join(dir, "none.log"))}; cli_calls_report`,
    );
    expect(sh.stdout).toContain("SHADOWED");
  });

  it("skips save probes unless the newest session belongs to the workspace repo", () => {
    const dsh = join(dir, "dsh");
    mkdirSync(join(dsh, "sessions", "S1"), { recursive: true });
    writeFileSync(
      join(dsh, "sessions", "S1", "session.json"),
      JSON.stringify({ repo: "/elsewhere" }),
    );
    const run = (repo: string) =>
      bash(
        `${src("scripts/live-smoke/lib.sh")}; DYNAMIC_SKILLS_HOME=${JSON.stringify(dsh)}; REPO_REAL=${JSON.stringify(repo)}; probe_save_ok && echo OK || echo SKIP`,
      ).stdout.trim();
    expect(run(dir)).toBe("SKIP");
    writeFileSync(
      join(dsh, "sessions", "S1", "session.json"),
      JSON.stringify({ repo: realpathSync(dir) }),
    );
    expect(run(realpathSync(dir))).toBe("OK");
  });

  it("documents the layers per harness, the unverified -a flag and the writable log", () => {
    const claude = read("scripts/live-smoke/claude-code.sh");
    const codex = read("scripts/live-smoke/codex.sh");
    const oc = read("scripts/live-smoke/opencode.sh");
    expect(claude).toMatch(/absolute .*dist\/index\.js.*denied/is);
    expect(oc).toMatch(/absolute .*dist\/index\.js.*ask/is);
    expect(codex).toMatch(/absolute .*dist\/index\.js.*sandbox/is);
    expect(codex).toMatch(/on-request.*UNVERIFIED/is);
    expect(codex).toMatch(/can write cli-calls\.log/i);
    expect(oc).toMatch(/v2.*edit tool.*outside the denied roots/is);
  });
});

describe("fix round 4", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smoke-r4-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("aborts on a global dynamic-skills unless SMOKE_ALLOW_GLOBAL=1", () => {
    const shim = join(dir, "shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "dynamic-skills"), "#!/bin/sh\n", { mode: 0o755 });
    const run = (env: Record<string, string>) =>
      bash(`${src("scripts/live-smoke/lib.sh")}; check_no_global_install`, {
        PATH: `${shim}:${process.env.PATH}`,
        ...env,
      });
    const refused = run({ SMOKE_ALLOW_GLOBAL: "" });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(join(shim, "dynamic-skills"));
    expect(run({ SMOKE_ALLOW_GLOBAL: "1" }).status).toBe(0);
    expect(code("scripts/live-smoke/lib.sh")).toMatch(/^\s*check_no_global_install$/m);
  });

  it("prints each probe's wrapper log lines so a guard refusal is not read as a harness denial", () => {
    const log = join(dir, "calls.log");
    writeFileSync(log, "1 old allowed\n");
    const script = [
      src("scripts/live-smoke/lib.sh"),
      `TMP=${JSON.stringify(dir)}; CALLS_LOG=${JSON.stringify(log)}; mkdir -p "$TMP/out"`,
      `harness_run() { echo '2 save refused: save needs --scope' >>"$CALLS_LOG"; return 0; }`,
      "harness_evidence() { :; }; scan() { :; }",
      'probe p1 "prompt"',
    ].join("\n");
    const out = bash(script).stdout;
    expect(out).toContain("live smoke guard");
    expect(out).toContain("2 save refused: save needs --scope");
    expect(out).not.toContain("1 old allowed");
  });

  it("notes that the jailed HOME hides real save conflicts", () => {
    const lib = read("scripts/live-smoke/lib.sh");
    expect(lib).toContain("SAVE_CONFLICT");
    expect(code("scripts/live-smoke/lib.sh")).toMatch(/^\s*jail_note$/m);
  });

  it.each(HARNESSES)("%s.sh gates its save probes on probe_save_ok", (id) => {
    expect(code(`scripts/live-smoke/${id}.sh`)).toContain("probe_save_ok");
  });

  it("OpenCode runs d6-init outside the probe_save_ok gate", () => {
    const text = code("scripts/live-smoke/opencode.sh");
    const gate = text.indexOf("probe_save_ok");
    const fi = text.indexOf("\n  fi\n", gate);
    const init = text.indexOf("probe d6-init");
    expect(init).toBeGreaterThan(-1);
    expect(init < gate || init > fi).toBe(true);
  });

  it("Codex states that the agent can write cli-calls.log", () => {
    const text = read("scripts/live-smoke/codex.sh");
    expect(text).toMatch(/the agent can write cli-calls\.log/);
    expect(text).toContain("TMPDIR");
  });
});
