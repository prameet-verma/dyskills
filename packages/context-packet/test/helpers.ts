import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContextPacket, SkillsScan } from "@dynamic-skills/core";
import {
  analyzeGaps,
  deriveRequirements,
  planSemanticProbes,
} from "@dynamic-skills/context-analyzer";
import { runDiscovery } from "@dynamic-skills/discovery";
import { buildContextPacket } from "../src/index";

/** Absolute path of a fixture repository under `fixtures/repos`. */
export const fixture = (name: string): string =>
  resolve(import.meta.dirname, "../../../fixtures/repos", name);

export const CACHING_TASK = "add caching to order reads";

export const EMPTY_SCAN: SkillsScan = {
  schemaVersion: "1",
  skills: [],
  instructionFiles: [],
  warnings: [],
};

/** Copies the TS fixture into a temp dir `<base>/repo`, leaving `<base>` free for outside files. */
export async function tmpRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ds-packet-"));
  const repo = join(base, "repo");
  await cp(fixture("ts-monorepo"), repo, { recursive: true });
  return repo;
}

export async function put(repo: string, rel: string, content: string): Promise<void> {
  await mkdir(join(repo, rel, ".."), { recursive: true });
  await writeFile(join(repo, rel), content);
}

/** Runs discovery, gaps and probes the way `discover` will, then builds the packet. */
export async function buildFor(
  repo: string,
  task: string,
  extra: Partial<Parameters<typeof buildContextPacket>[0]> = {},
): Promise<ContextPacket> {
  const d = await runDiscovery({ repo, task });
  const gaps = analyzeGaps(deriveRequirements(task), d.registry.list());
  const probes = planSemanticProbes(gaps, d.files);
  return buildContextPacket({
    task,
    repo,
    revision: "rev",
    evidence: d.registry.list(),
    files: d.files,
    gaps,
    probes,
    scan: EMPTY_SCAN,
    detectorsRun: d.detectorsRun,
    detectorErrors: d.errors,
    ...extra,
  });
}
