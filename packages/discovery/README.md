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
- **`isSecretPath(rel)`** (`secrets.ts`): true for `.env*`/`.envrc`/`.netrc` (case-insensitive), keys, certificates, SSH keys,
  `*.pfx`/`*.jks`, `credentials.json`, `secrets/**`, `.npmrc`, `.pypirc`.
- **`MANIFEST_DETECTORS`, `STRUCTURE_DETECTORS`, `ALL_DETECTORS`** (`detectors/`): runtime,
  package manager, framework, database (data tasks only), testing, monorepo and build
  detectors, plus language, CI, architecture and convention detectors.
- **`KNOWN_FRAMEWORKS`, `KNOWN_DATABASES`, `KNOWN_TEST_TOOLS`** (`known.ts`).

Evidence keys: `runtime.node`, `runtime.node.engines`, `runtime.python`, `package-manager`,
`framework.<name>`, `database.<name>`, `monorepo.{nx,turborepo,workspaces,pnpm-workspace}` (`workspaces` from package.json, `pnpm-workspace` from pnpm-workspace.yaml),
`testing.<name>`, `build.script.<name>`, `build.make.<target>`, `language.<name>` (top 5, `"<n> files"`),
`ci.github-actions`, `ci.gitlab`, `architecture.top-level-dirs`, `architecture.entrypoints`,
`conventions.readme` (first 10 README headings, untrusted), `conventions.contributing`,
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
