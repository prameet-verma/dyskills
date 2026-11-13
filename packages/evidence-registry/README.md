# @dynamic-skills/evidence-registry

Provenance-tracking store for facts discovered about a repository. Every entry records its
source, confidence and the repository revision it was observed at; disagreeing sources are
recorded as conflicts instead of being silently resolved. All values are sanitised so
repository content cannot leak secrets or break out of the fenced evidence block.

## API

- **`EvidenceRegistry`** (`registry.ts`): `add`, `get`, `list(filter?)`, `isVerified`,
  `toJSON`, `EvidenceRegistry.fromJSON`. Identical observations merge (strongest confidence
  wins: verified > inferred > assumed; first source kept). A different value for a key makes
  it `conflicting`, with `conflicts` listing `"<value> (<source>)"` for each observation.
- **`sanitizeEvidenceValue(raw)`** (`sanitize.ts`): redacts GitHub tokens, `sk-` keys, AWS
  access keys and private-key headers, collapses whitespace, replaces `<` `>` with `‹` `›`
  and truncates to 500 characters.
- **`getRepoRevision(repo)`** (`revision.ts`): `git rev-parse HEAD`, or `"untracked"`.
- **`fingerprintFile(absPath)`** (`revision.ts`): sha256 hex of a file.

## Example

```ts
import { EvidenceRegistry, getRepoRevision } from "@dynamic-skills/evidence-registry";

const registry = new EvidenceRegistry();
registry.add({
  key: "package-manager",
  value: "pnpm",
  category: "package-manager",
  source: "pnpm-lock.yaml",
  confidence: "verified",
  revision: await getRepoRevision("."),
});
registry.isVerified("package-manager"); // true
```

## PRD sections implemented

§6.4 (evidence and confidence, untrusted-content handling), §6.5 (provenance and revision).
