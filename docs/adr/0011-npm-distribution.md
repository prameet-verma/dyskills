# 0011. Distribution as the unscoped npm package and deferred save features

## Status

Accepted. Publishing itself is still a human step, and the license and repository URL are pending.

## Context

Harness permission rules match the command text, so a package runner cannot be allowed safely
(R19). Phase 2 also introduces `save`, which raises the question of augmentations and freshness
(synthesis decisions D1 and D8; risk 13).

## Decision

- The CLI is the unscoped npm package `dynamic-skills`, installed globally with
  `npm i -g dynamic-skills`. The installer is `dynamic-skills init`. Skills, scripts, adapters and
  docs call the bare `dynamic-skills` binary and never a package runner; `test/docs.test.ts`
  enforces this.
- Workspace packages stay private. The CLI tarball must carry the bootstrap skill and no
  `workspace:` or `@dynamic-skills/*` runtime dependency; `scripts/check-release.ts` checks this.
- A tag push `v<major>.<minor>.<patch>` runs the release workflow in the `npm` environment, with
  required reviewers; a manual run can only dry-run. The semver policy and checklist are in
  [releasing.md](../releasing.md): before 1.0 a breaking change bumps the minor, and any
  `CONTRACT_VERSION` bump is breaking.
- D8: saving an augmentation is not supported in Phase 2 (`SAVE_UNSUPPORTED`). Skills saved in
  Phase 2 carry no context fingerprint, so freshness checks before reuse (AC 26) arrive in
  Phase 3, which treats them as needing a relevance check.

## Consequences

- Allow rules match `dynamic-skills` exactly, on every harness.
- Nothing can be published until a human chooses a license and a repository URL.
- Users cannot persist a `partial` augmentation yet; they save the generated skill or keep the
  session only.
- The public API (commands, flags, stdout fields, exit and error codes, schemas, installed files)
  is versioned deliberately.
