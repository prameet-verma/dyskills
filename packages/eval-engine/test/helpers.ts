import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ContextAnalysisResultSchema,
  type Assumption,
  type Evidence,
  type ExistingSkill,
  type Gap,
  type SmokeEval,
} from "@dynamic-skills/core";
import {
  consolidateAnalysis,
  deriveRequirements,
  planSemanticProbes,
  recomputeGaps,
} from "@dynamic-skills/context-analyzer";
import { buildContextPacket } from "@dynamic-skills/context-packet";
import { runDiscovery } from "@dynamic-skills/discovery";
import { loadSmokeEval, parseSkillBundle } from "@dynamic-skills/skill-compiler";
import type { EvalContext } from "../src/index";

/** Repository root of the monorepo under test. */
export const ROOT = resolve(import.meta.dirname, "../../..");
/** PRD §5.2 example task. */
export const CACHING_TASK =
  "Implement a distributed caching strategy for the order-processing service.";

const NEW_SKILL = resolve(ROOT, "fixtures/skills/valid/order-cache-specialist");
const AUG_SKILL = resolve(ROOT, "fixtures/skills/augmentation/order-caching-augment");
const BASE_SKILL = resolve(ROOT, "fixtures/skills/augmentation-base/order-caching/SKILL.md");
const REPO = resolve(ROOT, "fixtures/repos/ts-monorepo");

/** Raw golden new-skill `SKILL.md`. */
export const GOLDEN_RAW = readFileSync(resolve(NEW_SKILL, "SKILL.md"), "utf8");
/** Raw golden augmentation `SKILL.md`. */
export const GOLDEN_AUGMENT_RAW = readFileSync(resolve(AUG_SKILL, "SKILL.md"), "utf8");
/** sha256 of the augmentation base fixture. */
export const BASE_SHA = createHash("sha256").update(readFileSync(BASE_SKILL)).digest("hex");

const tmpRoots: string[] = [];
process.on("exit", () => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

interface Discovered {
  evidence: Evidence[];
  analysed: { evidence: Evidence[]; gaps: Gap[]; assumptions: Assumption[] };
  gaps: Gap[];
}
let cache: Promise<Discovered> | undefined;

/** Runs discovery (and the analysis consolidation) once per process. */
function discover(): Promise<Discovered> {
  cache ??= (async () => {
    const d = await runDiscovery({ repo: REPO, task: CACHING_TASK });
    const requirements = deriveRequirements(CACHING_TASK);
    const evidence = d.registry.list();
    const gaps = recomputeGaps(requirements, evidence, false);
    const packet = await buildContextPacket({
      task: CACHING_TASK,
      repo: REPO,
      revision: "fixture",
      evidence,
      files: d.files,
      gaps,
      probes: planSemanticProbes(gaps, d.files),
      scan: { schemaVersion: "1", skills: [], instructionFiles: [], warnings: [] },
      detectorsRun: d.detectorsRun,
      detectorErrors: d.errors,
    });
    const result = ContextAnalysisResultSchema.parse(
      JSON.parse(readFileSync(resolve(ROOT, "fixtures/analysis/ts-monorepo-caching.json"), "utf8")),
    );
    const out = consolidateAnalysis({
      result,
      registry: d.registry,
      packet,
      files: d.files,
      requirements,
      assumptions: [],
      revision: "fixture",
    });
    return {
      evidence,
      gaps,
      analysed: { evidence: d.registry.list(), gaps: out.gaps, assumptions: out.assumptions },
    };
  })();
  return cache;
}

/** Overrides accepted by {@link makeContext}. */
export interface ContextOverrides {
  raw?: string;
  evidence?: Evidence[];
  assumptions?: Assumption[];
  gaps?: Gap[];
  existingSkills?: ExistingSkill[];
  smokeEval?: SmokeEval | null;
  withAnalysis?: boolean;
  augmentation?: boolean;
  /** Extra files written next to a custom `raw` SKILL.md, keyed by skill-relative path. */
  files?: Record<string, string>;
}

/**
 * Builds an {@link EvalContext}. Async (the brief's signature is sync) because discovery and the
 * bundle parser are async. The skill comes from `raw` (default: the golden fixture, or the golden
 * augmentation when `augmentation` is true); a custom `raw` is written to a temp directory named
 * after its `name:` so the spec eval's name = directory rule holds unless a test breaks it.
 */
export async function makeContext(o: ContextOverrides = {}): Promise<EvalContext> {
  const augmentation = o.augmentation === true;
  const withAnalysis = o.withAnalysis === true || augmentation;
  let dir = augmentation ? AUG_SKILL : NEW_SKILL;
  if (o.raw !== undefined) {
    const root = mkdtempSync(join(tmpdir(), "eval-engine-"));
    tmpRoots.push(root);
    const name = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(o.raw)?.[1] ?? "skill";
    dir = join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), o.raw);
    for (const [rel, text] of Object.entries(o.files ?? {})) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  }
  const skill = await parseSkillBundle(resolve(dir, ".."));
  const found = await discover();
  const base = withAnalysis
    ? found.analysed
    : { evidence: found.evidence, gaps: found.gaps, assumptions: [] };
  return {
    task: CACHING_TASK,
    skill,
    evidence: o.evidence ?? base.evidence,
    assumptions: o.assumptions ?? base.assumptions,
    gaps: o.gaps ?? base.gaps,
    existingSkills: o.existingSkills ?? [],
    instructionTexts: [],
    smokeEval:
      o.smokeEval === undefined
        ? await loadSmokeEval(resolve(ROOT, "fixtures/skills/smoke.json"))
        : o.smokeEval,
    augmentation: augmentation
      ? {
          baseName: "order-caching",
          baseSha256: BASE_SHA,
          currentBaseSha256: BASE_SHA,
          baseBody: readFileSync(BASE_SKILL, "utf8"),
        }
      : null,
  };
}
