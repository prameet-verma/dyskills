import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { assessCoverage, scanExistingSkills } from "@dynamic-skills/bootstrapper";
import { BOOTSTRAP_SKILL_NAME, CONTRACT_VERSION, InvocationModeSchema } from "@dynamic-skills/core";
import type { SkillsScan } from "@dynamic-skills/core";
import { getRepoRevision } from "@dynamic-skills/evidence-registry";
import { CliError, toJson } from "../io";
import type { CreateCommandDef } from "./types";

/** Reads `DYNAMIC_SKILLS_BUDGET_MS`; unset means the default budget. */
function budgetFromEnv(vars: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = vars.DYNAMIC_SKILLS_BUDGET_MS;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError("USAGE", "DYNAMIC_SKILLS_BUDGET_MS must be a positive integer.");
  }
  return n;
}

/**
 * `assess`: creates the session, scans existing skills and applies the invocation-mode gate
 * (PRD §5.4, §5.5). Candidates are ranked hints only; reuse is decided after analysis by
 * `sufficiency submit`. `--repo` is resolved to an absolute path here because base-skill matching
 * later is an exact string comparison against the scanned absolute paths (Ruling R9).
 */
export const assessCommand: CreateCommandDef = {
  name: "assess",
  kind: "create",
  description: "Start a session: scan existing skills and decide whether to continue.",
  options: [
    { flags: "--task <text>", description: "The task the user wants to perform.", required: true },
    { flags: "--repo <path>", description: "Repository root (default: current directory)." },
    {
      flags: "--mode <mode>",
      description: "Invocation mode.",
      choices: ["auto", "suggest", "manual"],
      default: "auto",
    },
    { flags: "--explicit", description: "The user explicitly asked for a new skill." },
  ],
  step: "assess",
  stage: "assessment",
  async run(ctx) {
    const task = String(ctx.opts.task ?? "").trim();
    if (task === "") throw new CliError("USAGE", "--task must not be empty.");
    const mode = InvocationModeSchema.parse(ctx.opts.mode ?? "auto");
    const explicit = ctx.opts.explicit === true;
    const repo = resolve(ctx.cwd, typeof ctx.opts.repo === "string" ? ctx.opts.repo : ".");
    const info = await stat(repo).catch(() => null);
    if (!info?.isDirectory()) throw new CliError("USAGE", "--repo is not a directory.");
    const budgetMs = budgetFromEnv(ctx.vars);

    const scanned = await scanExistingSkills({
      repo,
      home: ctx.userHome,
      vars: ctx.vars,
      etcDir: ctx.etcDir,
    });
    const skills = scanned.skills
      .filter((s) => s.name !== BOOTSTRAP_SKILL_NAME)
      .map((s) => ({ name: s.name, description: s.description, scope: s.scope, path: s.path }));
    // Controller carry 2: instruction files are stored repo-relative, skill paths stay absolute.
    const instructionFiles = scanned.instructionFiles.map((p) => relative(repo, p));
    const scan: SkillsScan = {
      schemaVersion: CONTRACT_VERSION,
      skills,
      instructionFiles,
      warnings: scanned.warnings,
    };
    const coverage = assessCoverage(task, scanned.skills, { explicit, mode });
    const revision = await getRepoRevision(repo);

    const state = await ctx.store.create({
      task,
      mode,
      explicit,
      repo,
      revision,
      budgetMs,
      now: ctx.now(),
    });
    try {
      await ctx.store.writeArtifact(state.id, "skills-scan.json", toJson(scan));
    } catch (e) {
      await ctx.store.remove(state.id);
      throw e;
    }
    // PRD §5.4 Manual: nothing to do unless the user explicitly asked.
    const none = coverage.recommendation === "none";
    if (none) {
      state.status = "completed";
      state.metrics.outcome = "skipped";
    }
    return {
      state,
      writeReports: none,
      data: {
        sessionId: state.id,
        recommendation: coverage.recommendation,
        candidates: coverage.candidates,
        skills: skills.map((s) => ({ name: s.name, scope: s.scope, path: s.path })),
        reason: coverage.reason,
        instructionFiles,
        warnings: scanned.warnings,
      },
    };
  },
};
