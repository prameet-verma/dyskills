# @dynamic-skills/context-packet

Builds the Context Packet: the bounded, untrusted, secret-free view of a repository that the
analysis agent reads. Also enriches a packet with extra files the agent requests, using only
safe, bounded repository reads.

## API

- **`buildContextPacket(input)`** (`build.ts`): assembles a schema-valid packet from evidence,
  the file index, gaps, probes and the skills scan. Reads probe and entrypoint files with
  bounded concurrency and drops excerpts from the end until the token budget fits.
- **`enrichContextPacket(packet, request, ctx)`** (`enrich.ts`): adds requested files, rejecting
  secret, outside-repo, excluded, missing, duplicate, over-budget and round-limit paths. Never
  mutates its input.
- **`measurePacket(packet)`**: serialised size and estimated tokens (excluding `size` itself).
- **`sanitizeExcerpt(raw, maxChars)`** (`excerpt.ts`): redacts secrets, normalises line endings,
  strips control characters and truncates.
- **`PACKET_NOTICE`, `SECRET_POLICY`**: fixed strings carried in every packet.
- **`projectTechnology`, `projectDependencies`, `projectList`, `projectConfiguration`**
  (`project.ts`): pure projections of evidence and the file index.

## Example

```ts
import { buildContextPacket, enrichContextPacket } from "@dynamic-skills/context-packet";

const packet = await buildContextPacket({
  task,
  repo,
  revision,
  evidence,
  files,
  gaps,
  probes,
  scan,
  detectorsRun,
  detectorErrors,
});
const {
  packet: next,
  added,
  rejected,
} = await enrichContextPacket(packet, request, { repo, roundsUsed: 0 });
```

## PRD sections implemented

§6.4, §6.7, §7, FR-08, FR-09, FR-13.
