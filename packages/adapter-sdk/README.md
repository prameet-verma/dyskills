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
- Bundles: `bundleManifest(dir)`, `placeBundle({ srcDir, destRoot, name, mode, within, dryRun })`,
  `removePlacedBundle(path, manifestSha256)`, `findSaveConflicts({ name, manifestSha256, roots })`,
  `BundleLayoutError`, and `planSaveTargets({ harnesses, primary, readRoots })`.
- Analyst text: `ANALYST_AGENT_NAME`, `ANALYST_DESCRIPTION`, `ANALYST_INSTRUCTIONS`.
- `@dynamic-skills/adapter-sdk/testkit`: `defineAdapterCompatSuite(target)` (see below).

## Bundle placement

`placeBundle` copies a skill bundle to `<destRoot>/<name>` byte-identically and atomically: the copy
goes into `<destRoot>/.<name>.tmp-<8 hex>` (files 0644 / dirs 0755 for `save`, 0600 / 0700 for
`native`) and is `rename`d into place. It never overwrites and never throws for an environment
problem; it returns `action: "conflict"` with a `reason`:

- `outside project`: with `within` set, the realpath of `destRoot` is not inside it.
- `symlink`: the target is a symlink. `differs`: the target exists with another manifest (or is not
  a directory). `race`: the target appeared before `rename`; the temp copy is removed.
- `parent is a dangling symlink` / `parent is a symlink loop` / `parent is not a directory`: the
  `realpathOfPlanned` failures of the parent chain.

`name` must pass `SkillNameSchema`, else `BundleLayoutError` is thrown (as it is for a symlink or a
non-regular entry in the source bundle). A missing `destRoot` is created; `dryRun` creates nothing.
An equal existing bundle is `unchanged`. The manifest ignores modes and timestamps. `testHooks` on
`placeBundle` is an internal test seam. `removePlacedBundle` removes a bundle only when it is a plain
directory whose current manifest equals the given sha256. `findSaveConflicts` lists `<root>/<name>`
entries that differ or are not plain directories. `planSaveTargets` greedily picks the fewest primary
skill roots that every selected harness reads (a harness reads a root when some `ReadRoot` for that
directory lists it in `readBy`).

## Using the testkit

An adapter package adds one test file:

```ts
import { defineAdapterCompatSuite } from "@dynamic-skills/adapter-sdk/testkit";

defineAdapterCompatSuite({
  name: "<id>",
  adapter,
  fixtureHome, // absolute; copied to <tmp>/home per case
  versionOutput, // fake `<binary> --version` stdout
  scan, // lists the skills the harness would find: ({ repo, home, vars, etcDir }) => { skills }
  expect: {
    version,
    variant,
    questionTool,
    maxPerCall,
    maxOptions,
    multiSelect,
    nativeActivation,
    writesSessionHome,
  },
});
```

It registers 13 cases under `adapter compat: <name>` (version detection, byte-identical bootstrap,
idempotent init, dry run, preserved user config, committable project files, conflict on a different
bootstrap, real paths, byte-identical save, same-name conflict, structured questions, native root,
read-only analyst). Cases run in a tmp world with a fake probe and a session home reached through a
symlink alias. Native question calls are inspected generically: a call's size is
`call.questions.length` when present, and option labels are arrays of strings or `{ label }` objects.

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
- Reading results: `applyPlan` compares against its own internal preview, so treat ANY `conflict`
  entry in its result as a failed apply. The result and `PlanApplyError.applied` include `unchanged`
  entries; only `create`/`update` entries mean a write happened.
- Parent chains are resolved for every write, `within: null` included: a dangling symlink or a
  non-directory in the chain is a conflict ("parent is a dangling symlink", "parent is not a
  directory"). Configs nested deeper than 256 levels are a conflict ("too deeply nested").
- Hard links: `rename` replaces the directory entry, so an updated file that had other hard links is
  detached from them (they keep the old content).
- Before `rename` the target's inode, size and timestamps are compared with the preview (re-hashing
  only when they differ). The residual window is a concurrent edit landing between that check and
  `rename`, which is lost; it is never merged into.
- JSONC array appends are inserted item by item, so comments inside the array survive.
- `realpathOfPlanned` throws `ENOENT` (dangling symlink, or no ancestor), `ELOOP` (symlink loop) and
  `ENOTDIR` (a non-directory ancestor); callers map these to a conflict or an error.
- `applyPlan` accepts `testHooks` (`beforeWrite`, `afterCheck`, `beforeRename`), an internal test
  seam; never wire user input into it.
