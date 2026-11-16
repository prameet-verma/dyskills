# @dynamic-skills/adapter-sdk

The contract every harness adapter implements, plus the single executor for every write outside the
session home (`init` and `save`). It names no harness; it only uses core's `Harness` type.

## API

- Types: `HarnessAdapter`, `HostEnv`, `HostProbe`, `Detection`, `PlannedWrite`, `InstallPlan`,
  `InstallOptions`, `VerifyCommand`, `AppliedWrite`, `WriteAction`, `VerifyReport`, `ReadRoot`,
  `NativeQuestionInput`, `NativeQuestionPlan`, `BundleManifest`, `JsonValue`, `JsonObject`,
  `InstallScope`.
- `createHostProbe(vars)`: `which` scans `vars.PATH` for an executable regular file (no shell);
  `run` uses `execFile` (5 s timeout, 64 KiB cap) and never throws (spawn error is `code: -1`).
- `parseVersion(text)`, `compareVersions(a, b)`.
- `realpathEnsured(dir, mode = 0o700)`, `realpathOfPlanned(path)` (creates nothing),
  `isInside(child, parent)`.
- `mergeJson(current, patch, { promote? })`: recursive object merge, array union, scalar conflicts
  reported (the existing value is kept), opt-in scalar-to-object promotion. No force option.
- `previewPlan(plan, { force })`, `applyPlan(plan, { dryRun, force })`, `PlanApplyError`.
- `verifyInstall(plan, probe)`.
- `./testkit` (shared adapter conformance cases) is added by a later task.

## Write discipline

- Idempotent: byte-equal files and already-merged configs are `unchanged`; strict JSON and JSONC
  merges are idempotent.
- All-or-nothing on conflicts: if any write conflicts, none is applied. `force` applies only to a
  differing `file` write, never to merge conflicts, invalid JSON/JSONC or a symlink at the target.
- Containment: each write declares `within`; the realpath of its parent must lie inside the realpath
  of that root. Symlinked parents are followed only when `within` is null (personal scope).
- TOCTOU: every create/update re-reads its target; any change since the preview is a conflict
  ("changed since preview") and stops the apply.
- Atomic: files go through a temp file in the same directory and `rename`; an existing file's mode is
  kept (new files 0644, new directories 0755, `dir` writes 0700).
- Partial failure: an I/O error throws `PlanApplyError` whose `applied` lists writes already made.
- `dryRun` creates nothing, not even parent directories.
