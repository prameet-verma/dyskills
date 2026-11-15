import {
  DISCOVERY_CONCURRENCY,
  MAX_CONTEXT_REQUEST_ROUNDS,
  MAX_EXCERPT_CHARS,
  MAX_PACKET_TOKENS,
  mapConcurrent,
  type ContextPacket,
  type ContextRequest,
} from "@dynamic-skills/core";
import { readRealFile, resolveRepoPath } from "@dynamic-skills/discovery";
import { sanitizeEvidenceValue } from "@dynamic-skills/evidence-registry";
import { measurePacket } from "./build";
import { sanitizeExcerpt } from "./excerpt";

/** Why an enrichment request path was not added. */
export type EnrichRejection =
  "secret" | "outside-repo" | "excluded" | "missing" | "duplicate" | "over-budget" | "round-limit";

/** Result of {@link enrichContextPacket}. */
export interface EnrichResult {
  /** The enriched packet; the input object itself whenever nothing was added. */
  packet: ContextPacket;
  /** Normalised paths added, in request order. */
  added: string[];
  /** Rejected paths with reasons, in request order. */
  rejected: { path: string; reason: EnrichRejection }[];
  /** Whether this request consumed one of the MAX_CONTEXT_REQUEST_ROUNDS. */
  countsAsRound: boolean;
}

/**
 * Adds agent-requested files to a packet under the safe-read rules (PRD §6.7, FR-09).
 *
 * Checks per path, in order: path safety via `resolveRepoPath`, then duplicates (by normalised
 * path, so `./README.md` equals `README.md`), then read and the token budget. Never mutates
 * `packet`. A rejected-everything round-limit response does not count as a round.
 *
 * @param packet - Current packet.
 * @param request - Validated request.
 * @param ctx - Repo root, rounds already used and optional budget.
 * @returns The new packet, accepted and rejected paths, and whether a round was consumed.
 */
export async function enrichContextPacket(
  packet: ContextPacket,
  request: ContextRequest,
  ctx: { repo: string; roundsUsed: number; budgetTokens?: number },
): Promise<EnrichResult> {
  if (ctx.roundsUsed >= MAX_CONTEXT_REQUEST_ROUNDS) {
    return {
      packet,
      added: [],
      rejected: request.requests.map((r) => ({ path: r.path, reason: "round-limit" })),
      countsAsRound: false,
    };
  }
  const budget = ctx.budgetTokens ?? MAX_PACKET_TOKENS;
  // Seed with each existing entry's real path too, so a later request for the target of an
  // earlier symlink alias (or vice versa) is a duplicate.
  const known = new Set(packet.relevantFiles.map((f) => f.path));
  for (const f of packet.relevantFiles) {
    const r = await resolveRepoPath(ctx.repo, f.path);
    if (r.ok) known.add(r.realRel);
  }
  const rejected: EnrichResult["rejected"] = [];

  // Phase 1: path safety and duplicates, sequential and I/O-light, preserving request order.
  type Accepted = { index: number; rel: string; abs: string; reason: string };
  const accepted: Accepted[] = [];
  const outcome = new Map<number, EnrichRejection>();
  for (const [index, item] of request.requests.entries()) {
    const r = await resolveRepoPath(ctx.repo, item.path);
    if (!r.ok) outcome.set(index, r.reason);
    // Dedupe on the real path too, so a symlink or case alias of a known file is a duplicate.
    else if (known.has(r.rel) || known.has(r.realRel)) outcome.set(index, "duplicate");
    else {
      known.add(r.rel);
      known.add(r.realRel);
      accepted.push({ index, rel: r.rel, abs: r.abs, reason: item.reason });
    }
  }

  // Phase 2: bounded concurrent reads.
  const texts = await mapConcurrent(accepted, DISCOVERY_CONCURRENCY, async (a) => {
    return readRealFile(a.abs);
  });

  // Phase 3: assemble in request order, enforcing the budget file by file.
  const revision = packet.packetRevision + 1;
  let next: ContextPacket = packet;
  const added: string[] = [];
  const byIndex = new Map(accepted.map((a, i) => [a.index, { a, text: texts[i] ?? null }]));
  for (const [index, item] of request.requests.entries()) {
    const reason = outcome.get(index);
    if (reason) {
      rejected.push({ path: item.path, reason });
      continue;
    }
    const entry = byIndex.get(index);
    if (!entry || entry.text === null) {
      rejected.push({ path: item.path, reason: "missing" });
      continue;
    }
    const candidate: ContextPacket = {
      ...next,
      relevantFiles: [
        ...next.relevantFiles,
        {
          path: entry.a.rel,
          reason: sanitizeEvidenceValue(entry.a.reason),
          ...sanitizeExcerpt(entry.text, MAX_EXCERPT_CHARS),
          addedInRevision: revision,
        },
      ],
    };
    if (measurePacket(candidate).estimatedTokens > budget) {
      rejected.push({ path: item.path, reason: "over-budget" });
      continue;
    }
    next = candidate;
    added.push(entry.a.rel);
  }

  if (added.length === 0) return { packet, added, rejected, countsAsRound: true };
  const result: ContextPacket = { ...next, packetRevision: revision };
  result.size = measurePacket(result);
  return { packet: result, added, rejected, countsAsRound: true };
}
