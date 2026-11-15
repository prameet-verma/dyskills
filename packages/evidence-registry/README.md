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
  `add` accepts `origin` (`programmatic` default, `agentic`, `user`; the first entry's origin is
  kept on merge, and `toJSON` includes it) and `conflicts` (sanitised, used only when a fresh
  entry is added as `conflicting`).
- **`sanitizeEvidenceValue(raw)`** (`sanitize.ts`): redacts GitHub tokens, `sk-` keys, AWS
  access keys and private-key headers, collapses whitespace, replaces `<` `>` with `‹` `›`
  and truncates to 500 characters.
- **`redactSecrets(raw)`** (`sanitize.ts`): the secret redaction step alone, with no whitespace or
  bracket changes (used for code excerpts). `sanitizeEvidenceValue` calls it first.
- **`getRepoRevision(repo)`** (`revision.ts`): `git rev-parse HEAD`, or `"untracked"`.
- **`fingerprintFile(absPath, maxBytes?)`** (`revision.ts`): sha256 hex of a file, read through
  core's `readSafeFile` (regular files only, capped at `MAX_BASE_FILE_BYTES` unless `maxBytes` is
  given). It throws on a missing, non-regular, oversize or unreadable file.

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

§7 (evidence and confidence, untrusted-content handling, provenance and revision), §6.6 (evidence classification).
