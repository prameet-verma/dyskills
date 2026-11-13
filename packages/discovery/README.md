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
- **`buildFileIndex(repo, { maxFiles?, maxDepth? })`** (`file-index.ts`): deterministic
  breadth-first listing, skipping dependency/build directories and secret paths.
- **`isSecretPath(rel)`** (`secrets.ts`): true for `.env*`, keys, certificates, SSH keys,
  `credentials.json`, `secrets/**`, `.npmrc`, `.pypirc`.
- **`MANIFEST_DETECTORS`, `ALL_DETECTORS`** (`detectors/`): runtime, package manager,
  framework, database (data tasks only), testing, monorepo and build detectors.
- **`KNOWN_FRAMEWORKS`, `KNOWN_DATABASES`, `KNOWN_TEST_TOOLS`** (`known.ts`).

Evidence keys: `runtime.node`, `runtime.node.engines`, `runtime.python`, `package-manager`,
`framework.<name>`, `database.<name>`, `monorepo.{nx,turborepo,workspaces}`,
`testing.<name>`, `build.script.<name>`, `build.make.<target>`.

## Example

```ts
import { runDiscovery } from "@dynamic-skills/discovery";

const { registry, errors } = await runDiscovery({ repo: ".", task: "add vitest tests" });
registry.get("package-manager"); // { value: "pnpm", confidence: "verified", ... }
```

## PRD sections implemented

§6.1 (discovery), §6.4 (untrusted content, secret exclusion), §9.7 (parallel, task-directed
discovery).
