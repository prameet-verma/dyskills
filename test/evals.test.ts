import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { R19_RUNNER, joinContinuations } from "./r19";

const ROOT = resolve(import.meta.dirname, "..");
const EVALS = join(ROOT, "scripts/evals");

/** Every file under a directory, as repo-relative paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(relative(ROOT, p));
  }
  return out.sort();
}

const FILES = walk(EVALS);
const SCRIPTS = FILES.filter((f) => f.endsWith(".sh"));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("eval harness layout", () => {
  it("has the fixed contract files", () => {
    for (const f of [
      "README.md",
      "lib.sh",
      "make-template.sh",
      "run-full.sh",
      "run-invoke.sh",
      "run-grid.sh",
      "grade.sh",
      "grade-all.sh",
      "variants/v0-current.txt",
      "variants/v1-project.txt",
      "variants/v2-imperative.txt",
      "variants/v3-outcome.txt",
    ]) {
      expect(existsSync(join(EVALS, f)), f).toBe(true);
    }
  });

  it.each(SCRIPTS)("%s passes bash -n", (rel) => {
    const r = spawnSync("bash", ["-n", join(ROOT, rel)], { encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  // Suite checks.sh scripts are exempt: they branch on grep's exit status for every check, which
  // `set -e` would turn into an abort; they validate their own arguments and exit 2 on bad input.
  const STRICT = SCRIPTS.filter(
    (f) => !f.endsWith("lib.sh") && !/\/suites\/[^/]+\/checks\.sh$/.test(f),
  );
  it.each(STRICT)("%s uses strict mode", (rel) => {
    expect(read(rel)).toContain("set -euo pipefail");
  });

  it.each(FILES)("%s has no permission-bypass flag, personal path or package runner", (rel) => {
    const text = read(rel);
    for (const bad of [
      "--dangerously",
      "--yolo",
      "skip-permissions",
      "bypassPermissions",
      "bypass-approvals",
      "--full-auto",
      "--permission-mode",
    ]) {
      expect(text, bad).not.toContain(bad);
    }
    expect(text).not.toContain("/Users/");
    expect(joinContinuations(text)).not.toMatch(R19_RUNNER);
  });

  it("keeps the safety model in the headless runs", () => {
    for (const f of ["run-full.sh", "run-invoke.sh", "grade.sh"]) {
      const text = read(`scripts/evals/${f}`);
      expect(text, f).toContain("--setting-sources project,local");
    }
    for (const f of ["run-full.sh", "run-invoke.sh"]) {
      const text = read(`scripts/evals/${f}`);
      expect(text, f).toContain('build_deny "$W"');
      expect(text, f).toContain("DYNAMIC_SKILLS_HOME");
      expect(text, f).toContain("DYNAMIC_SKILLS_HARNESS=claude-code");
      expect(text, f).toContain("NX_DAEMON=false");
    }
    const lib = read("scripts/evals/lib.sh");
    for (const d of [
      "WebFetch",
      "WebSearch",
      "Bash(dynamic-skills init *)",
      "Bash(dynamic-skills save *)",
    ]) {
      expect(lib, d).toContain(d);
    }
    expect(lib).toContain("core.hooksPath=/dev/null");
    expect(lib).toContain("setpgrp");
    expect(read("scripts/evals/run-invoke.sh")).toContain("--max-turns 4");
    expect(read("scripts/evals/grade.sh")).toContain('--tools ""');
  });
});

describe("suites/orders-stub", () => {
  const S = "scripts/evals/suites/orders-stub";

  it("follows the suite contract", () => {
    const fixture = read(`${S}/fixture`).trim();
    expect(fixture).toBe("fixtures/repos/ts-monorepo");
    expect(existsSync(join(ROOT, fixture))).toBe(true);
    expect(statSync(join(ROOT, S, "prepare.sh")).mode & 0o111).not.toBe(0);
    const prepare = read(`${S}/prepare.sh`);
    expect(prepare).toContain("2.1.9");
    expect(prepare).toContain("19.8.14");
    expect(prepare).toContain("5.6.3");
    expect(prepare).toContain("pnpm install --no-frozen-lockfile");
    for (const t of ["t1", "t2", "t3", "b1", "b2", "b3", "b4"]) {
      expect(read(`${S}/tasks/${t}.txt`).trim().length, t).toBeGreaterThan(20);
    }
    for (const t of ["t1", "t2"]) {
      expect(read(`${S}/rubrics/${t}.txt`), t).toMatch(/Rubric items/);
    }
  });

  it("has a variant file per description and a v0 equal to the shipped description", () => {
    const shipped = /^description: (.*)$/m.exec(
      read("skills/dynamic-skill-bootstrap/SKILL.md"),
    )?.[1];
    expect(shipped).toBeTruthy();
    for (const v of ["v0-current", "v1-project", "v2-imperative", "v3-outcome"]) {
      const text = read(`scripts/evals/variants/${v}.txt`);
      expect(text.trim().split("\n")).toHaveLength(1);
      expect(text.trim().length).toBeGreaterThan(50);
    }
    expect(read("scripts/evals/variants/v0-current.txt").trim()).toBe(shipped);
  });
});

describe("fake-claude end to end", () => {
  let tmp: string;
  let out: string;
  let root: string;
  let env: NodeJS.ProcessEnv;

  const STREAM = [
    {
      type: "system",
      subtype: "init",
      model: "fake-model-1",
      skills: [{ name: "dynamic-skill-bootstrap" }],
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "s1",
            name: "Skill",
            input: { skill: "dynamic-skill-bootstrap" },
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "c1",
            name: "Bash",
            input: { command: "dynamic-skills assess --mode auto" },
          },
          {
            type: "tool_use",
            id: "c2",
            name: "Bash",
            input: { command: "dynamic-skills activate" },
          },
          { type: "tool_use", id: "c3", name: "Bash", input: { command: "dynamic-skills status" } },
          {
            type: "tool_use",
            id: "c4",
            name: "Bash",
            input: { command: "dynamic-skills-extra go" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: '{"ok":true,"skillPath":"/runs/rbac-permissions-denied/was blocked/SKILL.md"}',
          },
          {
            type: "tool_result",
            tool_use_id: "c2",
            content: [{ type: "text", text: '{"ok": true}' }],
          },
          { type: "tool_result", tool_use_id: "c3", is_error: true, content: "permission denied" },
          { type: "tool_result", tool_use_id: "c4", content: '{"ok":true}' },
        ],
      },
    },
    { type: "result", subtype: "success", total_cost_usd: 0.125, num_turns: 3 },
  ];

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "evals-test-")));
    out = join(tmp, "out dir"); // a space on purpose: every path must be quoted
    const bin = join(tmp, "bin");
    mkdirSync(bin);

    // A stand-in repository root: the built CLI is stubbed (CI runs the tests before the build) and the
    // skills directory is the real one.
    root = join(tmp, "root");
    mkdirSync(join(root, "packages/cli/dist"), { recursive: true });
    cpSync(join(ROOT, "skills"), join(root, "skills"), { recursive: true });
    writeFileSync(
      join(root, "packages/cli/dist/index.js"),
      `const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
if (a[0] === "init") {
  const repo = a[a.indexOf("--repo") + 1];
  fs.cpSync(${JSON.stringify(join(root, "skills/dynamic-skill-bootstrap"))}, path.join(repo, ".claude/skills/dynamic-skill-bootstrap"), { recursive: true });
  console.log('{"ok":true}');
}
`,
    );

    // The stub client: logs its argv per mode, optionally edits the repo, answers the grader differently.
    const fake = join(bin, "fake-claude");
    const lines = STREAM.map((o) => JSON.stringify(o)).join("\n");
    const verdict = JSON.stringify({
      result: JSON.stringify({ items: { a: true, b: false }, quality: 4, notes: "fine" }),
      total_cost_usd: 0.01,
    });
    writeFileSync(
      fake,
      `#!/bin/bash
mode=run
case "$*" in *"--output-format json"*) mode=grade ;; esac
{ echo "--- $mode"; printf '%s\\n' "$@"; } >>"${tmp}/claude-args-$mode-$$.txt"
if [ "$mode" = grade ]; then
  cat >"${tmp}/grader-prompt-$$.txt"
  printf '%s\\n' '${verdict}'
  exit 0
fi
if [ -n "\${FAKE_COMMIT:-}" ]; then
  echo 'export const c = 1' >committed.ts
  git add committed.ts
  git -c user.name=agent -c user.email=agent@example.invalid commit -q -m "agent work"
fi
if [ -n "\${FAKE_EDIT:-}" ]; then
  echo more >>pnpm-lock.yaml
  mkdir -p node_modules/p && echo x >node_modules/p/i.js
  echo 'export const a = 1' >new.ts
  echo '{}' >tsconfig.tsbuildinfo
fi
cat <<'STREAM'
${lines}
STREAM
`,
    );
    chmodSync(fake, 0o755);

    const suites = join(tmp, "suites");
    const suite = join(suites, "tiny");
    mkdirSync(join(suite, "tasks"), { recursive: true });
    mkdirSync(join(suite, "rubrics"));
    mkdirSync(join(suite, "hidden/t1"), { recursive: true });
    const fixture = join(tmp, "fixture-repo");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "hello.txt"), "hello\n");
    writeFileSync(join(fixture, "pnpm-lock.yaml"), "lock\n");
    // A vitest that loads nothing and fails: tests 0 with a non-zero exit scores 0.
    mkdirSync(join(fixture, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(fixture, "node_modules/.bin/vitest"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(fixture, "node_modules/.bin/vitest"), 0o755);
    writeFileSync(join(suite, "fixture"), `${fixture}\n`);
    writeFileSync(join(suite, "prepare.sh"), '#!/usr/bin/env bash\ntouch "$1/prepared"\n');
    chmodSync(join(suite, "prepare.sh"), 0o755);
    writeFileSync(join(suite, "tasks/t1.txt"), "Do the tiny task.\n");
    writeFileSync(join(suite, "tasks/t2.txt"), "Do the other tiny task.\n");
    writeFileSync(
      join(suite, "rubrics/t1.txt"),
      "Rubric items (each true or false):\n1 a: a\n2 b: b\n",
    );
    writeFileSync(join(suite, "hidden/t1/hidden.test.ts"), "// hidden\n");
    // The tree must be exactly as the agent left it: nothing staged, changes visible through git.
    writeFileSync(
      join(suite, "checks.sh"),
      `#!/usr/bin/env bash
cd "$1"
chk() { if "$@"; then printf '%s\\tpass\\n' "$name"; else printf '%s\\tfail\\n' "$name"; fi; }
name=has_prepared; chk test -f prepared
name=staged_clean; chk git diff --cached --quiet
name=sees_new; chk bash -c '{ git diff --name-only HEAD; git ls-files --others --exclude-standard; } | grep -qx new.ts'
`,
    );
    chmodSync(join(suite, "checks.sh"), 0o755);

    // A suite whose fixture has no vitest at all: "no data", not a zero.
    const bare = join(suites, "bare");
    mkdirSync(join(bare, "tasks"), { recursive: true });
    mkdirSync(join(bare, "rubrics"));
    mkdirSync(join(bare, "hidden/t1"), { recursive: true });
    const bareFixture = join(tmp, "bare-fixture");
    mkdirSync(bareFixture);
    writeFileSync(join(bareFixture, "a.txt"), "a\n");
    writeFileSync(join(bare, "fixture"), `${bareFixture}\n`);
    writeFileSync(join(bare, "prepare.sh"), "#!/usr/bin/env bash\ntrue\n");
    chmodSync(join(bare, "prepare.sh"), 0o755);
    writeFileSync(join(bare, "tasks/t1.txt"), "Bare task.\n");
    writeFileSync(join(bare, "rubrics/t1.txt"), "Rubric items (each true or false):\n1 a: a\n");
    writeFileSync(join(bare, "hidden/t1/h.test.ts"), "// hidden\n");

    env = {
      ...process.env,
      EVAL_OUT: out,
      CLAUDE_BIN: fake,
      EVAL_SUITES_DIR: suites,
      EVAL_REPO_ROOT: root,
    };
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Runs a harness script with the fake claude; returns trimmed stdout lines. */
  function run(script: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
    const r = spawnSync("bash", [join(EVALS, script), ...args], {
      encoding: "utf8",
      env: { ...env, ...extra },
      timeout: 120_000,
    });
    return { ...r, rows: r.stdout.trim().split("\n").filter(Boolean) };
  }

  const cols = (script: string): string[] => run(script, ["--header"]).stdout.trim().split("\t");
  const asRow = (script: string, line: string | undefined): Record<string, string | undefined> =>
    Object.fromEntries(cols(script).map((c, i) => [c, line?.split("\t")[i]]));
  /** The argv of every stub invocation in a mode, one string per invocation. */
  const argvFiles = (mode: string): string[] =>
    readdirSync(tmp)
      .filter((f) => f.startsWith(`claude-args-${mode}-`))
      .map((f) => readFileSync(join(tmp, f), "utf8"));
  const argv = (mode: string): string[] => argvFiles(mode).flatMap((t) => t.split("\n"));

  it("has the documented column order", () => {
    expect(cols("run-full.sh").join(" ")).toBe(
      "suite cond task model rep invoked activated ds_calls bootstrap_used last_sub tests passed tests_rc " +
        "tests_failed_suites tsc checks_pass checks_total hidden_pass hidden_total hidden_rc " +
        "hidden_failed_suites cost secs turns end diff_lines model_id",
    );
  });

  it("run-invoke.sh records the invocation row and builds SKILL.md from the current body", () => {
    const r = run("run-invoke.sh", ["tiny", "v2-imperative", "t1", "fake-model", "1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.rows).toHaveLength(1);
    expect(asRow("run-invoke.sh", r.rows[0])).toMatchObject({
      suite: "tiny",
      variant: "v2-imperative",
      task: "t1",
      model: "fake-model",
      rep: "1",
      invoked: "1",
      listed: "1",
      first_tool: "Skill:dynamic-skill-bootstrap",
      turns: "3",
      cost: "0.1250",
      end: "success",
      model_id: "fake-model-1",
    });
    const args = argv("run");
    expect(args).toContain("--max-turns");
    expect(args).toContain("project,local");
    // The template is a git repo with the baseline commit and the ignore entries.
    const tpl = join(out, "templates/tiny");
    expect(existsSync(join(tpl, "prepared"))).toBe(true);
    expect(readFileSync(join(tpl, ".gitignore"), "utf8")).toContain("node_modules");
    expect(readFileSync(join(tpl, ".git/eval-template-ready"), "utf8").trim()).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("rebuilds a stale template when the fixture changes", () => {
    const fixture = readFileSync(join(tmp, "suites/tiny/fixture"), "utf8").trim();
    writeFileSync(join(fixture, "hello.txt"), "hello again\n");
    const r = run("make-template.sh", ["tiny"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("template built");
    expect(readFileSync(join(out, "templates/tiny/hello.txt"), "utf8")).toBe("hello again\n");
    expect(run("make-template.sh", ["tiny"]).stderr).toContain("template ready");
  });

  it("run-full.sh (noskill) records the row, passes the safety flags and leaves the tree untouched for checks", () => {
    const r = run("run-full.sh", ["tiny", "noskill", "t1", "fake-model", "2"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.rows).toHaveLength(1);
    expect(asRow("run-full.sh", r.rows[0])).toMatchObject({
      suite: "tiny",
      cond: "noskill",
      task: "t1",
      rep: "2",
      invoked: "1",
      activated: "1",
      ds_calls: "2", // the denied status call and the dynamic-skills-extra command do not count
      bootstrap_used: "1",
      last_sub: "activate",
      tests: "0",
      passed: "0",
      tests_rc: "1", // vitest loaded nothing and failed
      tests_failed_suites: "0",
      tsc: "n/a",
      checks_pass: "2",
      checks_total: "3",
      hidden_pass: "0",
      hidden_total: "0",
      hidden_rc: "1",
      cost: "0.1250",
      turns: "3",
      end: "success",
      model_id: "fake-model-1",
    });
    const runDir = join(out, "runs/tiny.noskill.t1.fake-model.2");
    expect(readFileSync(join(runDir, "checks.tsv"), "utf8")).toContain("staged_clean\tpass");
    expect(existsSync(join(runDir, "repo/hidden.test.ts"))).toBe(true); // copied after the run
    // The stub logged every allow and deny element.
    const args = argv("run");
    const home = realpathSync(homedir()).slice(1);
    for (const want of [
      "--setting-sources",
      "Read",
      "Bash(pnpm *)",
      "Bash(dynamic-skills *)",
      `Edit(//${runDir.slice(1)}/**)`,
      "WebFetch",
      "WebSearch",
      "Bash(dynamic-skills init)",
      "Bash(dynamic-skills init *)",
      "Bash(dynamic-skills save)",
      "Bash(dynamic-skills save *)",
      `Edit(//${home}/.claude/**)`,
      `Edit(//${home}/.agents/**)`,
      `Edit(//${home}/.config/**)`,
      `Edit(//${runDir.slice(1)}/repo/.claude/**)`,
      `Read(//${root.slice(1)}/scripts/evals/**)`,
      "--allowed-tools",
      "--disallowed-tools",
      "Do the tiny task.",
    ]) {
      expect(args, want).toContain(want);
    }
    expect(args.some((l) => /dangerously|bypass/i.test(l))).toBe(false);
  });

  it("keeps the diff clean of lockfiles and build artefacts and runs checks on the agent's tree", () => {
    const r = run("run-full.sh", ["tiny", "noskill", "t2", "fake-model", "3"], { FAKE_EDIT: "1" });
    expect(r.status, r.stderr).toBe(0);
    const row = asRow("run-full.sh", r.rows[0]);
    expect(row).toMatchObject({
      checks_pass: "3",
      checks_total: "3",
      hidden_pass: "-",
      hidden_total: "-",
    });
    const diff = readFileSync(join(out, "runs/tiny.noskill.t2.fake-model.3/diff.patch"), "utf8");
    expect(diff).toContain("new.ts");
    expect(diff).not.toContain("pnpm-lock.yaml");
    expect(diff).not.toContain("tsbuildinfo");
    expect(diff).not.toContain("node_modules");
  });

  it("diffs against the eval-baseline tag, so an agent's own commits still show", () => {
    const r = run("run-full.sh", ["tiny", "noskill", "t2", "fake-model", "4"], {
      FAKE_COMMIT: "1",
    });
    expect(r.status, r.stderr).toBe(0);
    const runDir = join(out, "runs/tiny.noskill.t2.fake-model.4");
    expect(readFileSync(join(runDir, "diff.patch"), "utf8")).toContain("committed.ts");
    const tag = spawnSync(
      "git",
      ["-C", join(runDir, "repo"), "rev-parse", "--verify", "eval-baseline"],
      {
        encoding: "utf8",
      },
    );
    expect(tag.status).toBe(0);
  });

  it("run-full.sh (explicit) prefixes the prompt and installs the skill from the stub CLI", () => {
    const r = run("run-full.sh", ["tiny", "explicit", "t1", "fake-model", "1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(argv("run")).toContain("/dynamic-skill-bootstrap Do the tiny task.");
    const skill = join(
      out,
      "runs/tiny.explicit.t1.fake-model.1/repo/.claude/skills/dynamic-skill-bootstrap/SKILL.md",
    );
    expect(existsSync(skill)).toBe(true);
  });

  it("run-grid.sh writes a results file, tolerates CRLF, and grade-all.sh joins blind grades", () => {
    const jobs = join(tmp, "jobs.txt");
    writeFileSync(
      jobs,
      "# comment\r\ntiny   noskill t1 fake-model 1\r\n\r\ntiny explicit t1 fake-model 1\r\ntiny noskill t2 fake-model 1\r\nbare noskill t1 fake-model 1\r\n",
    );
    const g = run("run-grid.sh", ["full", jobs, "2"], { EVAL_NAME: "grid-test" });
    expect(g.status, g.stderr).toBe(0);
    const results = join(out, "grid-test/results.tsv");
    const lines = readFileSync(results, "utf8").trim().split("\n");
    expect(lines[0]).toBe(cols("run-full.sh").join("\t"));
    expect(lines).toHaveLength(5);
    expect(existsSync(join(out, "grid-test/runs/tiny.explicit.t1.fake-model.1/diff.patch"))).toBe(
      true,
    );

    const a = run("grade-all.sh", [results, "2"], { EVAL_GRADER_MODEL: "fake-grader" });
    expect(a.status, a.stderr).toBe(0);
    const joined = readFileSync(join(out, "grid-test/joined.tsv"), "utf8")
      .split("\n")
      .filter(Boolean);
    const head = joined[0]?.split("\t") ?? [];
    expect(head.slice(-3)).toEqual(["rubric_pass", "rubric_total", "quality"]);
    const graded = joined.slice(1).map((l) => l.split("\t").slice(-3).join(","));
    expect(graded.filter((x) => x === "1,2,4")).toHaveLength(3); // bare t1 has a rubric too
    expect(graded.filter((x) => x === ",,")).toHaveLength(1);
    expect(readFileSync(join(out, "grid-test/anon-map.tsv"), "utf8")).toMatch(/^g001\t/);

    // Summary: tests that never loaded score 0, not "no data"; no hidden tests for t2 stays "-".
    const sum = readFileSync(join(out, "grid-test/summary.tsv"), "utf8").trim().split("\n");
    const sh = sum[0]?.split("\t") ?? [];
    const byKey = Object.fromEntries(
      sum.slice(1).map((l) => {
        const f = l.split("\t");
        return [`${f[0]}.${f[1]}.${f[3]}`, Object.fromEntries(sh.map((c, i) => [c, f[i]]))];
      }),
    );
    expect(byKey["tiny.t1.noskill"]).toMatchObject({
      bootstrap_used: "1.00",
      tests_pass: "0.00",
      hidden_pass: "0.00",
    });
    expect(byKey["tiny.t2.noskill"]).toMatchObject({ tests_pass: "0.00", hidden_pass: "-" });
    expect(byKey["bare.t1.noskill"]).toMatchObject({ tests_pass: "-", hidden_pass: "-" }); // vitest missing: no data
    expect(a.stdout).toContain("tiny");

    // The grader got the tools-off flags and a prompt that names no condition.
    expect(argvFiles("grade").length).toBeGreaterThanOrEqual(2);
    for (const a of argvFiles("grade")) expect(a).toContain("--tools\n\n--output-format\njson");
    const prompts = readdirSync(tmp).filter((f) => f.startsWith("grader-prompt-"));
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    for (const p of prompts) {
      const text = readFileSync(join(tmp, p), "utf8");
      expect(text).toContain("Rubric items");
      expect(text).not.toMatch(/noskill|explicit|variant|v0|v2|dynamic-skill/i);
    }
  });

  it("run-grid.sh exits non-zero when a job produced no row", () => {
    const jobs = join(tmp, "jobs-bad.txt");
    writeFileSync(jobs, "tiny noskill t1 fake-model 9\ntiny nope t1 fake-model 9\n");
    const g = run("run-grid.sh", ["full", jobs, "2"], { EVAL_NAME: "grid-bad" });
    expect(g.status).not.toBe(0);
    expect(readFileSync(join(out, "grid-bad/results.tsv"), "utf8").trim().split("\n")).toHaveLength(
      2,
    );
  });

  it("kills the client's whole process group when the harness is interrupted", async () => {
    const hang = join(tmp, "bin/fake-hang");
    writeFileSync(
      hang,
      `#!/bin/bash
echo $$ >"${tmp}/hang-pid"
sleep 300 &
echo $! >"${tmp}/hang-child"
wait
`,
    );
    chmodSync(hang, 0o755);
    // Its own process group, like a terminal's foreground group: Ctrl-C reaches the harness and the
    // timeout wrapper, not the client (which the wrapper moved to a separate group).
    const h = spawn(
      "bash",
      [join(EVALS, "run-invoke.sh"), "tiny", "v0-current", "t1", "fake-model", "8"],
      {
        env: { ...env, CLAUDE_BIN: hang },
        detached: true,
        stdio: "ignore",
      },
    );
    const exited = new Promise<void>((res) => h.on("exit", () => res()));
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 200 && !existsSync(join(tmp, "hang-child")); i++) await sleep(100);
    const pids = ["hang-pid", "hang-child"].map((f) =>
      Number(readFileSync(join(tmp, f), "utf8").trim()),
    );
    expect(pids.every(alive)).toBe(true);
    process.kill(-(h.pid ?? 0), "SIGINT");
    await exited;
    for (let i = 0; i < 80 && pids.some(alive); i++) await sleep(100);
    expect(pids.map(alive)).toEqual([false, false]);
  });

  it("refuses an EVAL_OUT under scripts/evals", () => {
    const r = run("run-full.sh", ["--header"], { EVAL_OUT: join(EVALS, "out-guard-test") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("must not be under");
    expect(existsSync(join(EVALS, "out-guard-test"))).toBe(false);
  });

  it("rejects a bad condition and a missing task without running claude", () => {
    expect(run("run-full.sh", ["tiny", "nope", "t1", "m", "1"]).status).not.toBe(0);
    expect(run("run-full.sh", ["tiny", "noskill", "zz", "m", "1"]).status).not.toBe(0);
    expect(run("run-invoke.sh", ["tiny", "nope", "t1", "m", "1"]).status).not.toBe(0);
  });
});
