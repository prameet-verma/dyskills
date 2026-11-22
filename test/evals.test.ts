import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

  it.each(SCRIPTS.filter((f) => !f.endsWith("lib.sh")))("%s uses strict mode", (rel) => {
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
      expect(text, f).toContain('"WebFetch" "WebSearch"');
      expect(text, f).toContain("Edit(//$HR/.claude/**)");
      expect(text, f).toContain("DYNAMIC_SKILLS_HOME");
      expect(text, f).toContain("DYNAMIC_SKILLS_HARNESS=claude-code");
    }
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
        content: [{ type: "tool_use", name: "Skill", input: { skill: "dynamic-skill-bootstrap" } }],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "dynamic-skills assess --mode auto" },
          },
          { type: "tool_use", name: "Bash", input: { command: "dynamic-skills activate" } },
        ],
      },
    },
    { type: "result", subtype: "success", total_cost_usd: 0.125, num_turns: 3 },
  ];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "evals-test-"));
    out = join(tmp, "out dir"); // a space on purpose: every path must be quoted
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    // Ignores its arguments except that it records them and answers the grader's json format differently.
    const fake = join(bin, "fake-claude");
    const lines = STREAM.map((o) => JSON.stringify(o)).join("\n");
    const verdict = JSON.stringify({
      result: JSON.stringify({ items: { a: true, b: false }, quality: 4, notes: "fine" }),
      total_cost_usd: 0.01,
    });
    writeFileSync(
      fake,
      `#!/bin/bash
printf '%s\\n' "$@" >>"${join(tmp, "claude-args.txt")}"
case "$*" in
  *"--output-format json"*) cat >/dev/null; printf '%s\\n' '${verdict}' ;;
  *) cat <<'STREAM'
${lines}
STREAM
  ;;
esac
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
    writeFileSync(
      join(suite, "checks.sh"),
      '#!/usr/bin/env bash\nprintf "has_prepared\\tpass\\nhas_nothing\\tfail\\n"\n',
    );

    env = {
      ...process.env,
      EVAL_OUT: out,
      CLAUDE_BIN: fake,
      EVAL_SUITES_DIR: suites,
    };
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Runs a harness script with the fake claude; returns trimmed stdout lines split by tab. */
  function run(script: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
    const r = spawnSync("bash", [join(EVALS, script), ...args], {
      encoding: "utf8",
      env: { ...env, ...extra },
      timeout: 120_000,
    });
    return { ...r, rows: r.stdout.trim().split("\n").filter(Boolean) };
  }

  const cols = (script: string): string[] => run(script, ["--header"]).stdout.trim().split("\t");

  it("run-invoke.sh records the invocation row and builds SKILL.md from the current body", () => {
    const r = run("run-invoke.sh", ["tiny", "v2-imperative", "t1", "fake-model", "1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.rows).toHaveLength(1);
    const row = Object.fromEntries(
      cols("run-invoke.sh").map((c, i) => [c, r.rows[0]?.split("\t")[i]]),
    );
    expect(row).toMatchObject({
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
    const args = readFileSync(join(tmp, "claude-args.txt"), "utf8");
    expect(args).toContain("--max-turns");
    expect(args).toContain("project,local");
    expect(args).not.toContain("--dangerously");
    // The template is a git repo with the baseline commit and the ignore entries.
    const tpl = join(out, "templates/tiny");
    expect(existsSync(join(tpl, "prepared"))).toBe(true);
    expect(readFileSync(join(tpl, ".gitignore"), "utf8")).toContain("node_modules");
  });

  it("run-full.sh (noskill) records the full row, checks and the hidden files", () => {
    const r = run("run-full.sh", ["tiny", "noskill", "t1", "fake-model", "2"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.rows).toHaveLength(1);
    const row = Object.fromEntries(
      cols("run-full.sh").map((c, i) => [c, r.rows[0]?.split("\t")[i]]),
    );
    expect(row).toMatchObject({
      suite: "tiny",
      cond: "noskill",
      task: "t1",
      rep: "2",
      invoked: "1",
      activated: "1",
      ds_calls: "2",
      last_sub: "activate",
      tests: "0",
      passed: "0",
      tsc: "n/a",
      checks_pass: "1",
      checks_total: "2",
      hidden_total: "0",
      cost: "0.1250",
      turns: "3",
      end: "success",
      model_id: "fake-model-1",
    });
    expect(Number(row.diff_lines)).toBeGreaterThanOrEqual(0);
    const runDir = join(out, "runs/tiny.noskill.t1.fake-model.2");
    expect(existsSync(join(runDir, "out.jsonl"))).toBe(true);
    expect(existsSync(join(runDir, "diff.patch"))).toBe(true);
    expect(readFileSync(join(runDir, "checks.tsv"), "utf8")).toContain("has_nothing\tfail");
    expect(existsSync(join(runDir, "repo/hidden.test.ts"))).toBe(true); // copied after the run
  });

  it("run-grid.sh writes a results file with a header, and grade-all.sh joins blind grades", () => {
    const jobs = join(tmp, "jobs.txt");
    writeFileSync(
      jobs,
      "# comment\ntiny noskill t1 fake-model 1\n\ntiny explicit t1 fake-model 1\ntiny noskill t2 fake-model 1\n",
    );
    const g = run("run-grid.sh", ["full", jobs, "2"], { EVAL_NAME: "grid-test" });
    expect(g.status, g.stderr).toBe(0);
    const results = join(out, "grid-test/results.tsv");
    const lines = readFileSync(results, "utf8").trim().split("\n");
    expect(lines[0]).toBe(cols("run-full.sh").join("\t"));
    expect(lines).toHaveLength(4);
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
    expect(graded.filter((x) => x === "1,2,4")).toHaveLength(2); // the two t1 runs; t2 has no rubric
    expect(graded.filter((x) => x === ",,")).toHaveLength(1);
    expect(a.stdout).toContain("tiny");
    expect(readFileSync(join(out, "grid-test/anon-map.tsv"), "utf8")).toMatch(/^g001\t/);
  });

  it("rejects a bad condition and a missing task without running claude", () => {
    expect(run("run-full.sh", ["tiny", "nope", "t1", "m", "1"]).status).not.toBe(0);
    expect(run("run-full.sh", ["tiny", "noskill", "zz", "m", "1"]).status).not.toBe(0);
    expect(run("run-invoke.sh", ["tiny", "nope", "t1", "m", "1"]).status).not.toBe(0);
  });
});
