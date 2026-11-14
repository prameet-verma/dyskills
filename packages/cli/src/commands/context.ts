import { EvidenceRegistry } from "@dynamic-skills/evidence-registry";
import { consolidateAnalysis } from "@dynamic-skills/context-analyzer";
import { enrichContextPacket } from "@dynamic-skills/context-packet";
import {
  ContextAnalysisResultSchema,
  ContextPacketSchema,
  ContextRequestSchema,
  MAX_ANALYSIS_SUBMISSIONS,
  MAX_CONTEXT_REQUEST_ROUNDS,
  SlaClock,
} from "@dynamic-skills/core";
import { buildFileIndex } from "@dynamic-skills/discovery";
import {
  CliError,
  parseDocument,
  readEvidence,
  readInputFile,
  requireArtifactJson,
  toJson,
  writeEvidence,
} from "../io";
import type { SessionCommandDef } from "./types";

/**
 * `context request`: the agent asks for specific extra repository files (PRD §6.7, FR-13). Files
 * go through the safe-read rules in `enrichContextPacket`; only a request that consumed a round
 * is counted against the budgets.
 */
export const contextRequestCommand: SessionCommandDef = {
  name: "context request",
  kind: "session",
  description: "Request additional repository files for the Context Packet.",
  options: [{ flags: "--file <path>", description: "Context request JSON.", required: true }],
  step: "context-request",
  stage: null,
  async run({ store, state, opts, cwd }) {
    const request = parseDocument(
      ContextRequestSchema,
      await readInputFile(cwd, String(opts.file)),
    );
    const packet = await requireArtifactJson(
      store,
      state.id,
      "context-packet.json",
      ContextPacketSchema,
    );
    const result = await enrichContextPacket(packet, request, {
      repo: state.repo,
      roundsUsed: state.metrics.contextRequestRounds,
    });
    const next = ContextPacketSchema.parse(result.packet);
    const packetPath = await store.writeArtifact(state.id, "context-packet.json", toJson(next));
    if (result.countsAsRound) {
      const m = state.metrics;
      m.contextRequestRounds += 1;
      m.contextRequests += result.added.length;
      m.parallelOps += result.added.length;
      m.llmInteractions += 1; // PRD §6.7, FR-13: a request is an LLM interaction.
      m.packetTokens = next.size.estimatedTokens;
    }
    return {
      data: {
        packetPath,
        packetRevision: next.packetRevision,
        added: result.added,
        rejected: result.rejected,
        roundsRemaining: Math.max(
          0,
          MAX_CONTEXT_REQUEST_ROUNDS - state.metrics.contextRequestRounds,
        ),
      },
    };
  },
};

/**
 * `context submit`: the agent's complete analysis of the packet (PRD §6.5, §6.6, FR-09..FR-11).
 * Each accepted submission replaces the previous one: agentic evidence, `not-asked` assumptions
 * and `unknown.*` requirements are dropped and rebuilt, so a corrected analysis cannot leave stale
 * conflicts or duplicate assumptions behind.
 */
export const contextSubmitCommand: SessionCommandDef = {
  name: "context submit",
  kind: "session",
  description: "Submit the Context Analysis Result.",
  options: [{ flags: "--file <path>", description: "Context analysis JSON.", required: true }],
  step: "context-submit",
  stage: null,
  async run({ store, state, opts, cwd, now }) {
    const m = state.metrics;
    if (m.analysisSubmissions >= MAX_ANALYSIS_SUBMISSIONS) {
      throw new CliError(
        "ANALYSIS_LIMIT",
        `At most ${MAX_ANALYSIS_SUBMISSIONS} analyses are accepted per session.`,
      );
    }
    const result = parseDocument(
      ContextAnalysisResultSchema,
      await readInputFile(cwd, String(opts.file)),
    );
    const packet = await requireArtifactJson(
      store,
      state.id,
      "context-packet.json",
      ContextPacketSchema,
    );
    if (result.analysedPacketRevision > packet.packetRevision) {
      throw new CliError("SCHEMA_INVALID", "The analysis names an unknown packet revision.", {
        issues: [{ path: "analysedPacketRevision", message: "unknown packet revision" }],
      });
    }
    const files = await buildFileIndex(state.repo);

    // Replace, not accumulate: keep only evidence the agent did not author.
    const kept = (await readEvidence(store, state.id)).filter(
      (e) => e.origin !== "agentic" && !e.key.startsWith("agentic."),
    );
    const registry = EvidenceRegistry.fromJSON(kept);
    const assumptions = state.assumptions.filter((a) => a.status !== "not-asked");
    const requirements = state.requirements.filter((r) => !r.id.startsWith("unknown."));
    const out = consolidateAnalysis({
      result,
      registry,
      packet,
      files,
      requirements,
      assumptions,
      revision: state.revision,
    });
    const warnings = [...out.warnings];
    if (result.analysedPacketRevision < packet.packetRevision) {
      warnings.push(
        `analysis based on packet revision ${result.analysedPacketRevision} of ${packet.packetRevision}`,
      );
    }

    await store.writeArtifact(state.id, "context-analysis.json", toJson(out.normalised));
    await writeEvidence(store, state.id, registry.toJSON());
    state.requirements = out.requirements;
    state.assumptions = [...assumptions, ...out.assumptions];
    state.gaps = out.gaps;
    m.analysisSubmissions += 1;
    m.llmInteractions += 1;
    // PRD §10.8: analysis time is active time since discovery ended (human waits excluded).
    m.stageMs.analysis =
      SlaClock.from(state.sla).activeMs(now()) - (m.analysisStartedAtActiveMs ?? 0);
    return {
      data: {
        evidenceAdded: out.evidenceAdded,
        downgraded: out.downgraded,
        assumptions: out.assumptions.map((a) => a.questionId),
        unknowns: out.requirements.filter((r) => r.id.startsWith("unknown.")).map((r) => r.id),
        conflicts: registry.list({ confidence: "conflicting" }).map((e) => e.key),
        gaps: out.gaps,
        inspectGapsRemaining: out.gaps.filter((g) => g.resolution === "inspect").length,
        submissionsRemaining: MAX_ANALYSIS_SUBMISSIONS - m.analysisSubmissions,
        warnings,
      },
    };
  },
};
