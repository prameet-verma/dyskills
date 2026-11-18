import { resolve } from "node:path";
import { applyPlan, PlanApplyError, previewPlan, verifyInstall } from "@dynamic-skills/adapter-sdk";
import type {
  AppliedWrite,
  Detection,
  HostEnv,
  InstallPlan,
  VerifyReport,
} from "@dynamic-skills/adapter-sdk";
import type { Harness } from "@dynamic-skills/core";
import {
  ADAPTERS,
  ALLOW_RULE_OPTION,
  HARNESS_IDS,
  allowRuleRequested,
  harnessOptionSpec,
  parseHarnessList,
} from "../adapters";
import { resolveBootstrapSkill } from "../assets";
import { buildHostEnv } from "../host";
import { CliError } from "../io";
import type { GlobalCommandDef } from "./types";

/** One harness's entry in the `init` report. */
interface HarnessReport {
  harness: Harness;
  detection: Detection;
  writes: AppliedWrite[];
  notes: string[];
  warnings: string[];
  verify: VerifyReport | null;
}

/** A harness with its plan, before anything is written. */
interface Planned {
  harness: Harness;
  detection: Detection;
  plan: InstallPlan;
  notes: string[];
}

const NOT_NATIVE = "Native activation is not supported; activation reads the skill into context.";

const count = (writes: AppliedWrite[], action: AppliedWrite["action"]): number =>
  writes.filter((w) => w.action === action).length;

/** Create and update entries only: `unchanged` writes nothing and is not counted as applied. */
const appliedCount = (writes: AppliedWrite[]): number =>
  count(writes, "create") + count(writes, "update");

function reportOf(
  p: Planned,
  writes: AppliedWrite[],
  warnings: string[],
  verify: VerifyReport | null,
): HarnessReport {
  return {
    harness: p.harness,
    detection: p.detection,
    writes,
    notes: p.notes,
    warnings,
    verify,
  };
}

function summaryLine(r: HarnessReport): string {
  const version = r.detection.installed
    ? (r.detection.version ?? "unknown version")
    : "not detected";
  const failed = r.verify !== null && !r.verify.ok ? ", verification failed" : "";
  return `${r.harness} ${version}: ${count(r.writes, "create")} created, ${count(r.writes, "update")} updated, ${count(r.writes, "unchanged")} unchanged, ${count(r.writes, "conflict")} conflicts${failed}`;
}

/** What to do about a conflict, appended to the `INIT_CONFLICT` message. */
function conflictAdvice(reports: HarnessReport[]): string {
  const conflicts = reports.flatMap((r) =>
    r.writes
      .filter((w) => w.action === "conflict")
      .map((w) => `${w.path}: ${w.reason ?? "conflict"}`),
  );
  const parts = [`No harness file was written. Conflicts: ${conflicts.join("; ")}.`];
  if (conflicts.some((c) => c.includes("env.DYNAMIC_SKILLS_HOME"))) {
    parts.push(
      "The settings already pin a different DYNAMIC_SKILLS_HOME at env.DYNAMIC_SKILLS_HOME; init never overwrites it, so edit or remove that key by hand, or keep using the session home it names, then run init again.",
    );
  }
  parts.push(
    "--force replaces only differing installer files; it never overwrites merged configuration, invalid JSON or symlinks.",
  );
  return parts.join(" ");
}

/**
 * `init`: installs the bootstrap skill, the consent rules and any host configuration for each
 * selected harness. Every harness is previewed first and nothing is written when any of them
 * conflicts; `--dry-run` previews and stops. Writes go through the adapter SDK executor
 * (idempotent, atomic, symlink-safe). Verification failures are reported, not errors.
 */
export const initCommand: GlobalCommandDef = {
  name: "init",
  kind: "global",
  description: "Install the bootstrap skill and consent rules into one or more harnesses.",
  options: [
    harnessOptionSpec("Harnesses to install into (default: every detected one)."),
    {
      flags: "--scope <scope>",
      description: "Where to install.",
      choices: ["project", "personal"],
      default: "personal",
    },
    { flags: "--repo <path>", description: "Repository for project scope (default: cwd)." },
    { flags: "--dry-run", description: "Report what would change and write nothing." },
    { flags: "--force", description: "Replace differing installer files (never merged config)." },
    { flags: "--native", description: "Also set up native skill placement where supported." },
    ALLOW_RULE_OPTION,
  ],
  step: null,
  stage: null,
  async run({ home, opts, cwd, userHome, vars, probe, etcDir }) {
    const dryRun = opts.dryRun === true;
    const force = opts.force === true;
    const native = opts.native === true;
    const allowRule = allowRuleRequested(opts);
    const scope = opts.scope === "project" ? "project" : "personal";
    const explicit = typeof opts.harness === "string" ? parseHarnessList(opts.harness) : null;

    const env: HostEnv = await buildHostEnv({
      repo: resolve(cwd, typeof opts.repo === "string" ? opts.repo : "."),
      userHome,
      home,
      vars,
      probe,
      etcDir,
      dryRun,
    });
    const bootstrap = await resolveBootstrapSkill();

    const detections = new Map<Harness, Detection>();
    for (const id of explicit ?? HARNESS_IDS) {
      detections.set(id, await ADAPTERS[id].detect(env));
    }
    const chosen = explicit ?? HARNESS_IDS.filter((id) => detections.get(id)?.installed === true);
    if (chosen.length === 0) {
      throw new CliError(
        "HARNESS_NOT_DETECTED",
        "No supported harness was detected; name one with --harness.",
      );
    }

    const planned: Planned[] = [];
    for (const id of chosen) {
      const adapter = ADAPTERS[id];
      const detection = detections.get(id) as Detection;
      const plan = await adapter.planInstall(env, detection, {
        scope,
        native,
        allowRule,
        bootstrapSkill: bootstrap.bytes,
      });
      const notes = [...plan.notes];
      if (explicit !== null && !detection.installed) notes.unshift(`${id} not detected`);
      if (native && !adapter.nativeActivation) notes.push(NOT_NATIVE);
      planned.push({ harness: id, detection, plan, notes });
    }

    const previews: AppliedWrite[][] = [];
    for (const p of planned) previews.push(await previewPlan(p.plan, { force }));
    const gitWarnings = await Promise.all(planned.map((p) => ignoreWarnings(p.plan, probe)));

    if (previews.some((w) => w.some((x) => x.action === "conflict"))) {
      const reports = planned.map((p, i) => reportOf(p, previews[i] as AppliedWrite[], [], null));
      throw new CliError("INIT_CONFLICT", conflictAdvice(reports), {
        reason: "conflict",
        harnesses: reports,
      });
    }

    if (dryRun) {
      const reports = planned.map((p, i) =>
        reportOf(p, previews[i] as AppliedWrite[], gitWarnings[i] as string[], null),
      );
      return {
        data: { dryRun: true, scope, sessionHome: env.sessionHome, harnesses: reports },
        summary: reports.map(summaryLine).join("\n"),
      };
    }

    const results: AppliedWrite[][] = [];
    for (let k = 0; k < planned.length; k++) {
      const p = planned[k] as Planned;
      let writes: AppliedWrite[];
      try {
        // Never pass `testHooks`: they are an internal test seam.
        writes = await applyPlan(p.plan, { dryRun: false, force });
      } catch (e) {
        if (!(e instanceof PlanApplyError)) throw e;
        results.push(e.applied);
        throw applyFailed(planned, results, e.message);
      }
      results.push(writes);
      if (writes.some((w) => w.action === "conflict")) {
        throw applyFailed(planned, results, "a target changed after the preview");
      }
    }

    const reports: HarnessReport[] = [];
    for (let k = 0; k < planned.length; k++) {
      const p = planned[k] as Planned;
      const verify = await verifyInstall(p.plan, probe);
      reports.push(reportOf(p, results[k] as AppliedWrite[], gitWarnings[k] as string[], verify));
    }
    return {
      data: { dryRun: false, scope, sessionHome: env.sessionHome, harnesses: reports },
      summary: reports.map(summaryLine).join("\n"),
    };
  },
};

/** The `apply-failed` error: what was written for harnesses `1..k`; no installer file is rolled back. */
function applyFailed(planned: Planned[], results: AppliedWrite[][], why: string): CliError {
  const reports = results.map((w, i) => reportOf(planned[i] as Planned, w, [], null));
  const applied = reports.reduce((n, r) => n + appliedCount(r.writes), 0);
  const last = planned[results.length - 1] as Planned;
  return new CliError(
    "INIT_CONFLICT",
    `Install stopped at ${last.harness} (${why}); ${applied} write(s) applied so far (including ${last.harness}) and not rolled back. Fix the cause and run init again; it is idempotent.`,
    { reason: "apply-failed", harnesses: reports },
  );
}

/** Warnings for planned writes that must stay out of version control but are not ignored. */
async function ignoreWarnings(plan: InstallPlan, probe: HostEnvProbe): Promise<string[]> {
  const out: string[] = [];
  for (const w of plan.writes) {
    if (w.mustBeIgnored !== true) continue;
    const r = await probe.run("git", [
      // A repository can configure code to run (`core.fsmonitor`); never let a project do that.
      "-c",
      "core.fsmonitor=false",
      "-C",
      plan.projectRoot,
      "check-ignore",
      "-q",
      w.path,
    ]);
    // Exit 1 means "not ignored"; 128 (not a repository) and a missing git say nothing.
    if (r.code === 1) out.push(`${w.path} is not ignored by git; keep it out of version control`);
  }
  return out;
}

type HostEnvProbe = HostEnv["probe"];
