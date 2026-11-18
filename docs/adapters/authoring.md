# Writing a harness adapter

An adapter teaches Dynamic Skills one harness: where it keeps skills, how to install the bootstrap
skill and permission rules, how its question tool works and which versions were tested. An adapter
is a pure planner. It describes writes; `@dynamic-skills/adapter-sdk` performs them. Background is
in [ADR 0007](../adr/0007-harness-adapter-interface.md) and the
[architecture](../architecture.md#adapter-layer). The existing adapters are the best examples:
[Claude Code](../../adapters/claude-code/README.md), [Codex](../../adapters/codex/README.md) and
[OpenCode](../../adapters/opencode/README.md). The SDK API is in its
[README](../../packages/adapter-sdk/README.md).

## 1. Create the package

Add `adapters/<id>/` with a `package.json` named `@dynamic-skills/adapter-<id>`, `"private": true`,
`"type": "module"` and `"exports": { ".": "./src/index.ts" }`. Dependencies are limited to
`@dynamic-skills/core`, `@dynamic-skills/adapter-sdk` and `@dynamic-skills/bootstrapper`, plus any
third-party parser you need. Add a README with an `## API` section. The `Harness` enum in
`packages/core/src/schemas.ts` gains the new id, and the root registry (below) gains its skill
directories. After extending `HarnessSchema`, run `pnpm gen:schemas`; the schema test fails on
drift. Add the adapter to `devDependencies` in `packages/cli/package.json` (tsup bundles it), and
add any third-party runtime import of the adapter to the CLI's `dependencies`, because tsup keeps
those external. Harness names may appear only in `adapters/*`, the CLI's `adapters.ts`, the
bootstrapper's `roots.ts`, the `Harness` enum, the portability patterns, `scripts/live-smoke*`,
docs, fixtures and tests; the SDK, the core
packages and every generated skill stay neutral.

## 2. Implement `HarnessAdapter`

The interface lives in `packages/adapter-sdk/src/types.ts`.

| Member                        | What it does                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `binary`                | Harness id and executable name.                                                                                                                                                                                                                                                                                                                                              |
| `testedVersions`              | The versions you ran the compat suite against (export them as `<ID>_TESTED_VERSIONS`).                                                                                                                                                                                                                                                                                       |
| `nativeActivation`            | `true` only if the harness watches a non-permanent location the user chooses (today: Claude Code).                                                                                                                                                                                                                                                                           |
| `delegation`                  | The analyst agent name and whether read-only is `enforced` by the harness or only `instructed`.                                                                                                                                                                                                                                                                              |
| `detect(env)`                 | Uses `env.probe` to find the binary and parse `--version`. Reports `installed`, `version`, `variant`, `tested` and warnings. Never throws.                                                                                                                                                                                                                                   |
| `planInstall(env, det, opts)` | Returns an `InstallPlan`: ordered `PlannedWrite`s, notes and `VerifyCommand`s. It must plan a `file` write of `opts.bootstrapSkill` at `<scope root>/dynamic-skill-bootstrap/SKILL.md`, in a root the harness reads, and exactly one agent file whose text contains the SDK's `ANALYST_INSTRUCTIONS` (the adapter wraps it in its own format); the compat suite checks both. |
| `skillRoot(env, scope)`       | The directory `save` writes to for `project` or `personal`.                                                                                                                                                                                                                                                                                                                  |
| `readRoots(env)`              | Every directory the harness reads skills from, built from the bootstrapper's registry.                                                                                                                                                                                                                                                                                       |
| `questions(questions)`        | Pure mapping onto the native question tool.                                                                                                                                                                                                                                                                                                                                  |
| `nativeSessionRoot(env)`      | The skills directory the harness lists, inside the session home (Claude Code: `<sessionHome>/native/claude-code/.claude/skills`), or `null` unless `DYNAMIC_SKILLS_NATIVE` is `"1"`.                                                                                                                                                                                         |
| `saveNotes(detection)`        | Text shown after a save (restart requirements, trust prompts).                                                                                                                                                                                                                                                                                                               |

`HostEnv` carries realpaths only (`projectRoot`, `userHome`, `sessionHome`, `etcDir`), the visible
environment variables and the probe. Honour only absolute override variables (for example a config
directory variable) and ignore relative ones.

### Questions

`questions()` receives `NativeQuestionInput[]` (`id`, `text`, optional `options` and `multiSelect`)
and returns a `NativeQuestionPlan`:

- `tool`: the native tool name;
- `calls`: the payloads, chunked to the tool's limits, in input order;
- `textOnly`: ids of questions the tool cannot carry (no options, too few or too many options,
  `multiSelect` on a single-select tool, a repeated text). Never drop or truncate an option; send the
  question as text instead;
- `idMap`: native id (or header, or text, whatever the tool echoes back) to question id. Use a
  null-prototype object so a hostile id cannot reach `Object.prototype`;
- `notes`: where the tool is unavailable (headless runs, subagents, Codex outside Plan mode).

Every question must be asked exactly once, natively or as text.

### Native activation

Return `nativeActivation: true` and a `nativeSessionRoot` only if the harness lists skills from a
directory that is not a permanent skill location. The CLI places an evaluated skill there at
`activate`, inside the realpath session home (restricted to `native/`) and only when the user opted
in ([ADR 0008](../adr/0008-read-first-activation.md)). `nativeSessionRoot` returns the skills
directory the harness lists, `<sessionHome>/native/<id>/<harness-listed path>`, and the CLI uses it
as the destination of `placeBundle`. It returns `null` unless `DYNAMIC_SKILLS_NATIVE === "1"` (the
compat suite requires that `null`). `init --native` sets that variable and pre-creates the
directory with a `dir` write whose `within` is the session home. Placement also needs
`DYNAMIC_SKILLS_HARNESS` to name the harness, because the CLI learns the current harness only from
`--harness` or that variable. Reading `loadOrder` into context is the default
on every harness and needs nothing from the adapter. Never plan a write of an ephemeral skill into a
permanent directory.

## 3. Register it

Add the adapter to `ADAPTERS` and `HARNESS_IDS` in `packages/cli/src/adapters.ts`. That file is the
composition root: `init`, `save`, `activate` and `clarify ask` all find the adapter through it. Add
the harness's skill directories to `packages/bootstrapper/src/roots.ts`, the single root registry:
`readRoots`, the skill scan and the save-collision check all read it, so a saved skill never
shadows another one the harness can see. Handle `allowRule` only if your harness needs an allow
rule outside its sandbox; other adapters ignore it. A new harness that needs it reuses the
`--codex-allow-rule` flag or must add its own flag in `adapters.ts`. Live smoke scripts live in
`scripts/live-smoke/<harness>.sh` (dispatcher: `scripts/live-smoke.sh <harness>`).

## 4. Write discipline

Everything outside the session home is a `PlannedWrite`:

- Kinds: `file` (bytes), `dir`, `json-merge` and `jsonc-merge` (a patch merged into user config).
  Prefer plain files over plugins, hooks and MCP.
- Declare `within`: the project root for project files, the session home for native directories,
  `null` for personal files. The SDK follows a symlinked parent only for `null`.
- Mark `committable: true` only for content with no absolute machine path. Put machine paths
  (session home rules, environment) in an untracked or personal file, and set `mustBeIgnored`.
- Every path put in a config is a `realpath`.
- Merges keep every user key and comment; a scalar conflict is reported, never overwritten. Use
  `promote` only where a documented scalar (such as `"ask"`) can safely become an object.
- Never touch user-owned slots: status lines, hooks, plugins, default rules files or instruction
  files.
- A planner may read harness config and stat directories (for example Claude Code's `agents/`
  directory) but writes nothing. The executor is idempotent
  (byte-equal is `unchanged`), atomic, all-or-nothing on conflicts, and `--force` applies to `file`
  writes only.

## 5. Consent rules

`init` must make the harness ask before `dynamic-skills save` and `dynamic-skills init` run, even
when `dynamic-skills` is allowed in general ([ADR 0007](../adr/0007-harness-adapter-interface.md)).
Use the harness's own precedence: an `ask` that beats `allow`, a `prompt` rule where the strictest
decision wins, or an ask entry placed after the allow where the last match wins. Then:

- match the bare `dynamic-skills` binary, never a package runner;
- state in the README how a headless run saves (run `dynamic-skills save` in a terminal, or remove
  the rule, or append a more specific allow), using a distinct key so re-running `init` is unchanged;
- document what the rules cannot catch (for example quoted subcommands where the harness matches
  raw text);
- add a plan note when the user's config already defeats the rule, instead of failing.

## 6. Test with the compat suite

Create a fixture home under `fixtures/harness-homes/<target>/home` (one directory per tested
version line) and one test file:

```ts
import { join } from "node:path";
import { scanExistingSkills } from "@dynamic-skills/bootstrapper";
import { REPO_ROOT, defineAdapterCompatSuite } from "@dynamic-skills/adapter-sdk/testkit";
import { adapter } from "../src/index"; // your HarnessAdapter

defineAdapterCompatSuite({
  name: "<id>",
  adapter,
  fixtureHome: join(REPO_ROOT, "fixtures/harness-homes/<target>/home"), // copied per case
  versionOutput, // fake `<binary> --version` stdout
  vars, // optional environment for the fake host
  scan: scanExistingSkills, // ({ repo, home, vars, etcDir }) => the skills the harness would find
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

The suite runs 13 cases: version detection, byte-identical bootstrap, idempotent init, dry run,
preserved user config, committable project files, conflict on a different bootstrap, real paths,
byte-identical save, same-name conflict, structured questions, native root and read-only analyst.
It uses a fake probe and a session home reached through a symlink, so it needs no real binary. Add
your own tests for the config shapes unique to the harness: comments and trailing commas, scalar
values, invalid JSON, a user `deny`, a symlinked config directory.

For your own tests, the testkit also exports `fakeProbe`, `makeWorld` and `readBootstrap`. Tests
never run real harness binaries. Detection goes through `HostProbe`; end-to-end tests put
generated fake executables on `PATH`.

## 7. Pin tested versions

Run the compat suite and, where you can, the live smoke script against the exact version. Export it
as `<ID>_TESTED_VERSIONS` and return it as `testedVersions`. Detection of any other version reports
`tested: false` with a warning; it does not fail. If a harness has incompatible lines, return a
`variant` from `detect` and add one compat target per line, as the OpenCode adapter does
([ADR 0009](../adr/0009-opencode-dual-line.md)). Record behaviour you read from source rather than
documentation as a comment next to the code, because it may change.

## Checklist

1. Package, README with `## API`, `Harness` enum entry.
2. `HarnessAdapter` implemented as a pure planner; questions never drop an option.
3. Registered in `adapters.ts` and `roots.ts`.
4. Compat suite green on every target; own tests for config shapes.
5. Consent rules written, documented, and tested against the harness's precedence.
6. Tested versions pinned; `pnpm check` and `pnpm build` pass.
