# @dynamic-skills/context-analyzer

Works out what context a task needs, which of it discovery has already verified, and what
remains: facts to look up in the repository (semantic probes) or questions only the user can
answer. Pure functions; no I/O.

## API

- **`deriveRequirements(task)`** (`requirements.ts`): baseline requirements (`language`,
  `runtime`, `package-manager`, `testing`, `build`) plus keyword-triggered ones (`database`,
  `ci`, `monorepo`, `architecture`, `conventions`, and human-only `migration-policy` and
  `business-rules`).
- **`analyzeGaps(reqs, evidence)`** (`gaps.ts`): classifies each requirement as `verified`,
  `needs-investigation`, `missing` or `conflicting`, with a resolution of `none`, `inspect` or
  `ask`. Human-only requirements are answered only by evidence keyed `user.<requirement id>`.
- **`planSemanticProbes(gaps, files)`** (`probes.ts`): one `SemanticProbe` per `inspect` gap,
  with at most 5 suggested files drawn from the file index (well-known manifests, lockfiles,
  config and docs per category; shallowest paths first).

- **`consolidateAnalysis({ result, registry, packet, files, requirements, assumptions, revision })`**
  (`consolidate.ts`): merges an agent's Context Analysis Result into the registry (`agentic.*`
  evidence; `observed` claims without a resolvable source are downgraded to `inferred`),
  conflicts, `analysis-<n>` assumptions and `unknown.*` human-only requirements, then
  recomputes gaps.
- **`recomputeGaps(requirements, evidence, analysed)`**: `analyzeGaps`, and once analysed every
  residual `inspect` becomes `ask` (material conflict) or `none`, so the request/submit loop ends.
- **`slugify(text, max?)`**: stable identifier fragments.

## Example

```ts
import {
  analyzeGaps,
  deriveRequirements,
  planSemanticProbes,
} from "@dynamic-skills/context-analyzer";

const gaps = analyzeGaps(deriveRequirements(task), registry.list());
const probes = planSemanticProbes(gaps, files);
```

## PRD sections implemented

§6.3, §6.6, §7, FR-10..12, FR-15 (context requirements, gap analysis, semantic probes, evidence consolidation).
