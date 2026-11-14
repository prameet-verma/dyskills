import {
  analyzeGaps,
  deriveRequirements,
  planSemanticProbes,
} from "@dynamic-skills/context-analyzer";
import { buildContextPacket } from "@dynamic-skills/context-packet";
import {
  ContextPacketSchema,
  SkillsScanSchema,
  SlaClock,
  generateSchemas,
} from "@dynamic-skills/core";
import { runDiscovery } from "@dynamic-skills/discovery";
import { join } from "node:path";
import { requireArtifactJson, toJson, writeEvidence } from "../io";
import type { SessionCommandDef } from "./types";

/** Input contracts the agent needs as JSON Schema files, by output key (PRD §6.6, §13.2). */
const AGENT_SCHEMAS = {
  analysis: "context-analysis-result",
  request: "context-request",
  sufficiency: "skill-sufficiency-assessment",
  clarificationRequest: "clarification-request",
  clarificationResponse: "clarification-response",
} as const;

/**
 * `discover`: runs task-directed programmatic discovery, derives requirements and gaps, plans
 * semantic probes and builds the validated Context Packet for the analysis agent (PRD §6.1-§6.4,
 * §10.2). Also writes the input JSON Schemas the agent must follow. Starts the analysis stage
 * clock (`analysisStartedAtActiveMs`, PRD §10.8).
 */
export const discoverCommand: SessionCommandDef = {
  name: "discover",
  kind: "session",
  description: "Run programmatic discovery and build the Context Packet.",
  options: [],
  step: "discover",
  stage: "discovery",
  async run({ store, state, now }) {
    const scan = await requireArtifactJson(store, state.id, "skills-scan.json", SkillsScanSchema);
    const discovery = await runDiscovery({ repo: state.repo, task: state.task });
    const evidence = discovery.registry.toJSON();
    const requirements = deriveRequirements(state.task);
    const gaps = analyzeGaps(requirements, evidence);
    const probes = planSemanticProbes(gaps, discovery.files);
    const built = await buildContextPacket({
      task: state.task,
      repo: state.repo,
      revision: state.revision,
      evidence,
      files: discovery.files,
      gaps,
      probes,
      scan,
      detectorsRun: discovery.detectorsRun,
      detectorErrors: discovery.errors,
    });
    const packet = ContextPacketSchema.parse(built);

    const schemas = generateSchemas();
    const schemaPaths: Record<string, string> = {};
    for (const [key, name] of Object.entries(AGENT_SCHEMAS)) {
      const file = `${name}.schema.json`;
      schemaPaths[key] = await store.writeArtifact(
        state.id,
        join("schemas", file),
        toJson(schemas[file]),
      );
    }
    const packetPath = await store.writeArtifact(state.id, "context-packet.json", toJson(packet));
    await writeEvidence(store, state.id, evidence);

    state.requirements = requirements;
    state.gaps = gaps;
    state.status = "discovering";
    state.metrics.packetTokens = packet.size.estimatedTokens;
    state.metrics.parallelOps += discovery.detectorsRun.length;
    state.metrics.analysisStartedAtActiveMs = SlaClock.from(state.sla).activeMs(now());
    return {
      data: {
        packetPath,
        packetRevision: packet.packetRevision,
        packetTokens: packet.size.estimatedTokens,
        schemaPaths,
        evidenceCount: evidence.length,
        gaps,
        semanticProbes: probes,
        errors: discovery.errors,
        truncated: discovery.files.truncated || packet.limitations.excerptsDropped.length > 0,
      },
    };
  },
};
