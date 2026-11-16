# @dynamic-skills/discovery

Task-directed, parallel discovery of facts about a repository. Detectors read manifests,
lockfiles and config files, and report observations (with source and confidence) that the
runner merges into an `EvidenceRegistry`. Secret files are never indexed or read, and a
failing detector never stops the others.

## API

- **`runDiscovery({ repo, task, detectors?, concurrency?, signal? })`** (`runner.ts`): builds
  the file index, selects detectors for the task, runs them with bounded concurrency
  (default 4) and returns `{ registry, files, detectorsRun, durations, errors }`.
- **`selectDetectors(task, detectors)`**: keeps detectors that are `always` or whose
  `keywords` match the task.
- **`buildFileIndex(repo, { maxFiles?, maxDepth?, signal? })`** (`file-index.ts`): deterministic
  breadth-first listing, skipping dependency/build directories and secret paths.
- **`resolveRepoPath(repo, rel)`** and **`createRepoReader(repo)`** (`safe-read.ts`): sandboxed
  reads. Rejects secret paths, `SKIPPED_DIRS` segments and anything outside the repository,
  re-checking the real path after symlink resolution; returns `ok` or a reason
  (`secret`, `outside-repo`, `excluded`, `missing`). Files over 1 MB are `missing`.
- **`readRealFile(abs)`** (`safe-read.ts`): reads one already-resolved file through a single
  non-blocking handle; `null` for a non-regular file (FIFOs included), a file over 1 MB or an
  unreadable one. It never throws or blocks.
- **`readRegularFile(abs, maxBytes?)`** (`safe-read.ts`): the same single-handle read with a
  caller-chosen cap, returning `{ ok: true, text }` or `{ ok: false, reason }` (`missing`,
  `not-a-file`, `too-large`, `unreadable`) so callers can warn about what they skipped. Used by
  the bootstrapper's skills scan. Both readers are thin wrappers over core's `readSafeFile`.
- **`SKIPPED_DIRS`**, and `RepoFileIndex.depthLimited` (true when directories at `maxDepth`
  were not walked).
- **`isSecretPath(rel)`** (`secrets.ts`): true (case-insensitive) for `.env*`/`.envrc`/`.netrc`,
  keys, certificates, SSH keys, `*.pfx`/`*.jks`/`*.keystore`, `credentials.json`, `.npmrc`,
  `.pypirc`, `*.tfvars`(`.json`), `*.tfstate`(`.backup`), `.git-credentials`, `kubeconfig`,
  `.htpasswd`, `.pgpass`, `.docker/config.json`, `.kube/config`, a bare `secrets` or `.secrets`
  file, and anything under a `secrets/`, `.secrets/` or `.aws/` directory. `secrets.*` fails
  closed: every such basename is secret unless its last segment is a plain source extension
  (`ts`, `py`, `go`, `rs`, ...) and no segment is a config, data or encryption marker (`json`,
  `yaml`, `env`, `enc`, `sops`, `gpg`, ...). So `secrets.ts` and `secrets.test.ts` are indexed,
  while `secrets.yaml.bak`, `secrets.ts.enc`, `secrets.sh` and `secrets.` are not. Matching is
  linear: set lookups over the basename segments.
- **`MANIFEST_DETECTORS`, `STRUCTURE_DETECTORS`, `ALL_DETECTORS`** (`detectors/`): runtime,
  package manager, framework, database (data tasks only), testing, monorepo and build
  detectors, plus language, CI, architecture and convention detectors.
- **`KNOWN_FRAMEWORKS`, `KNOWN_DATABASES`, `KNOWN_TEST_TOOLS`** (`known.ts`).

Evidence keys: `runtime.node`, `runtime.node.engines`, `runtime.python`, `package-manager`,
`framework.<name>`, `database.<name>`, `monorepo.{nx,turborepo,workspaces,pnpm-workspace}` (`workspaces` from package.json, `pnpm-workspace` from pnpm-workspace.yaml),
`testing.<name>`, `build.script.<name>`, `build.make.<target>`, `language.<name>` (top 5, `"<n> files"`),
`ci.github-actions`, `ci.gitlab`, `architecture.top-level-dirs`, `architecture.entrypoints` (at most `MAX_ENTRYPOINTS` = 20, sorted by path),
`conventions.readme` (first 10 headings of `readme.md`, matched case-insensitively; untrusted), `conventions.contributing`,
`conventions.adr`, `conventions.agents-md`, `conventions.claude-md` (the last two are path only).

## Example

```ts
import { runDiscovery } from "@dynamic-skills/discovery";

const { registry, errors } = await runDiscovery({ repo: ".", task: "add vitest tests" });
registry.get("package-manager"); // { value: "pnpm", confidence: "verified", ... }
```

## PRD sections implemented

§6.1 (discovery), §7 (untrusted content, secret exclusion), §10.2 (parallel, task-directed
discovery).
