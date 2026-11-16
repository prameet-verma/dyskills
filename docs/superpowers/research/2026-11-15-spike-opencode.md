# Phase 2 spike: OpenCode

Date: 2026-11-15. Scope: OpenCode only (repo `anomalyco/opencode`, formerly `sst/opencode`). All sources were retrieved on 2026-11-15. Citation keys such as [D1] point to the Sources list at the end. "Source" means I read the tagged source code; **inferred** means I reasoned from it and did not read it stated anywhere.

> **Critical context: two live product lines.** OpenCode 2 (v2.3.0, 2026-11-13; npm `@opencode/cli` `latest` = 2.3.0; installed with `curl …/v2/install` or `brew install anomalyco/tap/opencode-v2`) and OpenCode 1 (v1.19.5, GitHub "Latest", npm `opencode-ai` `latest` = 1.19.5) are both distributed [R1][R3][R5][D15]. The classic installer `opencode.ai/install` **refuses** to install 2.x and points to `/v2/install` [R4]. `opencode.ai/docs` documents V2 (`/v2/docs` redirects there), and V1 docs live at `opencode.ai/v1/docs` [D1][V1a]. Config keys, plugin APIs, tool names and mid-session behaviour differ between the lines, so the adapter must handle both.

## Summary

- **(a) Native mid-session activation.** ✅ **V2:** skill directories and config are file-watched (100 ms debounce). A new `SKILL.md` is registered live, and the model is told "New skills are available…" at the next step, so it can call `skill({id})` without a restart [S1][S4][S5]. ❌ **V1:** the skill list is cached per instance with no watcher or documented reload [T1]. The fallback is Phase 1 behaviour: read the content into context.
- **(b) Read-only delegation.** ✅ Both lines support custom subagents with their own prompt, model and permissions (`edit`/`shell` denied) [D2][V1b]. ⚠️ No native structured or JSON output: the subagent's final text is returned to the parent. ⚠️ Since v2.3.0, V2 subagents **always run in the background**, so the parent must wait for a `<subagent>` message [R1][S10].
- **(c) Structured questions.** ✅ The `question` tool takes 1..N questions, each with a header, options, optional `multiple`, and an always-available free-text answer [D9][S8]. ⚠️ In `opencode run`, V1 denies the tool outright and V2 cancels each question with "make reasonable assumptions" feedback [T3][S9].
- **Install surface.** Plain files: `SKILL.md`, a markdown agent, and an `opencode.json(c)` permission merge. These are committable at project level. No plugin is required for the baseline.
- **Biggest risk.** V1 **hard-fails** on V2-native `permissions` keys [T6]. `init` must write V1-style `permission` objects, which V2 auto-migrates [S11].

## Findings

### 1. Skill support
- **Agent Skills support: yes, on both lines** [D1][V1a]. The model loads skills through a native `skill` tool.
- **Paths, V2** [D1][S1][S4]:

  | Scope | Paths |
  |---|---|
  | Project | `.opencode/skills/` (the singular `skill/` is also scanned [S1]) |
  | Project compatibility | `.claude/skills/`, `.agents/skills/` |
  | Global | `~/.config/opencode/skills/`, where `~/.config` is `$XDG_CONFIG_HOME`; `OPENCODE_CONFIG_DIR` overrides it [S13] |
  | Global compatibility | `~/.claude/skills/`, `~/.agents/skills/` |
  | Extra | a `skills: [...]` array in config: paths or HTTP catalogs [D1] |

  - Layout: a directory with `SKILL.md` is one skill, and a root-level `*.md` in a skills directory is also a skill. Hidden directories and `node_modules` are skipped. The scan stops 6 levels deep and does not descend below a directory that has a `SKILL.md` [D1][S2].
  - The ID is the **directory name** (case-sensitive). Frontmatter `name` is only a display label [D1][S3].
  - Precedence, lowest to highest: built-in, `.claude`, `.agents`, global OpenCode, project `.opencode`, `skills` config [D1].
- **Paths, V1** [V1a][T1]: the same three project and three global locations. The project walk goes up from the cwd **to the git worktree** [V1a].
  - Glob patterns: `{skill,skills}/**/SKILL.md` under config dirs, `skills/**/SKILL.md` under `.claude`/`.agents` [T1].
  - Keyed by frontmatter **`name`**: the later duplicate wins, with a warning [T1].
  - Plugins have no skill-shipping hook on V1. On V2 a plugin can add skills with `ctx.skill.transform(e => e.add({id,name,description,path,content}))` [D6].
- **Monorepo walk ambiguity.** The V2 skills page says the walk goes "up to the project root" [D1]. The V2 config page says "to the filesystem root" [D11], and the source walks to the filesystem root with no stop [S7]. Behaviour differs between V1 and V2 for repos nested inside other directories that hold `.opencode`, `.claude` or `.agents`.
- **Frontmatter, V2.**
  - Recognised fields: `name`, `description`, `metadata.opencode/autoinvoke` and `disable-model-invocation`.
  - "All frontmatter is optional at runtime." A skill without a `description` is not advertised.
  - Name regex, length and name/directory match are **not enforced**.
  - `license` and `compatibility` are accepted and not interpreted [D1][S3].
  - Unknown fields are ignored: Effect `Schema.Struct` default (**inferred** from [S3]; the docs do not address it).
- **Frontmatter, V1.**
  - The docs require `name` (1–64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`, must match the directory) and `description` (1–1024). `license`, `compatibility` and `metadata` are optional, and "Unknown frontmatter fields are ignored" [V1a].
  - Source: a file without a string `name` is silently skipped. `NameMismatchError` is defined but never raised, so the name/directory match is not enforced in code [T1].
- **PRD §11.3 row (`.opencode/skills/` and `~/.config/opencode/skills/`): correct for both lines.** Gaps are listed under Discrepancies.

### 2. Mid-session activation
- **V2: native.**
  - `ConfigSkillPlugin` and `ConfigCompatibilityPlugin` subscribe to file watchers on every skill root (they also watch the first missing ancestor, so a not-yet-existing `.opencode/skills/` is picked up). They debounce for 100 ms, rescan and call `ctx.skill.reload()` [S1][S4].
  - Config files are watched too, so new `.claude` or `.agents` roots and `skills` entries reload live [S7]. The plugins page also says "Changes under watched config directories reload automatically" [D4].
  - The available-skills list is a session instruction rendered as diffs ("New skills are available in addition to those previously listed: …", "…no longer available and must not be used") [S5]. Plugin instruction changes "are announced at the next step boundary without queuing a turn" [D6].
  - The `skill` tool resolves the ID against the live registry at call time [S6].
  - **Docs gap:** the skills page "doesn't document reload or restart behaviour for local skills" [D1]. This behaviour is read from source.
- **V1: not native.**
  - Discovery and state are held in `InstanceState` (a `ScopedCache`). It is invalidated only on instance disposal: restart, or `POST /instance/dispose`, which the TUI calls after actions such as provider or org changes [T1]. No watcher, no reload command, nothing documented.
  - Both the `skill` tool and the skill slash commands read that cache [T1][T2]. A `SKILL.md` written mid-session is invisible to `skill()`. The supported way is to read the file content into context, which is the Phase 1 behaviour.
  - A V1 plugin could inject content through `experimental.chat.system.transform` [T7]. **Inferred**, untested.

### 3. Autonomous and explicit invocation
- **Autonomous.** The model sees an `<available_skills>` list (ID, name, description) and calls `skill({ id })` on V2 or `skill({ name })` on V1 [S5][S6][V1a].
  - Opt out with `metadata.opencode/autoinvoke: false` or `disable-model-invocation: true` on V2 [D1].
  - Visibility is governed by the `skill` permission: `deny` hides the skill [D1][V1a].
- **Hooks that can make the bootstrap skill "considered":**
  - **V2** [D6][D8]:
    - `ctx.session.instructions.entry.put({sessionID,key,value})` adds a keyed session instruction. It survives compaction, does not break the prompt cache, and is announced at the next step [R2].
    - `ctx.session.hook("context", e => …e.system…)` is the system and messages transform.
    - `ctx.session.hook("prompt", …)` sees the draft prompt, including `prompt.skills`.
    - All live in a server plugin (`Plugin.define({id, setup(ctx)})`) under `.opencode/plugins/` or the `plugins` config [D4][D5].
  - **V1** [T7][V1d]:
    - `"experimental.chat.system.transform"(input:{sessionID?,model}, output:{system:string[]})`
    - `"chat.message"`, `"tool.execute.before/after"`, and the `event` hook (`session.created`, `session.idle`, …).
  - **Both:** a line in `AGENTS.md` or an `instructions` entry is read at start [D13]. Re-reading mid-session is undocumented.
- **Explicit invocation.**
  - V2: the user types `@skill-id` in the prompt [D1].
  - V1: every skill is registered as a slash command `/<name>`, whose template is the skill body plus its base directory. The docs are silent; this is read from source [T2].
  - Both: a custom command file `.opencode/commands/<name>.md` (`$ARGUMENTS`, `description`, `agent`, `model`) works on both lines [D12][V1g].

### 4. Native question UI
- **Tool `question`.**
  - Input: `questions[]` (non-empty in V2). Each question has `question`, `header` ("max 30 chars", description only), `options[]` of `{label ("1-5 words"), description}`, and an optional `multiple` [S8][T4].
  - "A free-form answer is always available": a "Type your own answer" option is added automatically [D9][S8].
  - The answer comes back as `answers: string[][]`.
  - **No documented or enforced cap** on the number of questions or options [D9][S8].
  - Dismissal cancels the question [D9].
- **Permission.** The `question` action is allowed for `build` and `plan`, and denied for `general` [D3].
  - A custom subagent gets the base policy (`*`: allow), so it *can* call `question` (**inferred** from [D3]).
  - Whether a child-session question renders in the TUI is undocumented.
- **Non-interactive mode.**
  - V1 `opencode run` adds `question: deny` rules unless `--interactive/-i` [T3]. The tool also exists only when `OPENCODE_CLIENT` is app, cli or desktop, or `OPENCODE_ENABLE_QUESTION_TOOL` is set [T4].
  - V2 `run` auto-cancels question forms with: "This non-interactive run cannot ask the user questions … make reasonable assumptions and state them." [S9]. This matches PRD §10.6.

### 5. Subagent delegation
- **Tool.**
  - V2: `subagent({agent, description, prompt, model?, sessionID?})`. Only agents with `mode: subagent` or `all` qualify, the default nesting depth is 1, and it is gated by the `subagent` permission [D2][D9][S10].
  - Since v2.3.0 V2 subagents **always run in the background** and report through a `<subagent sessionID state description>…final text…</subagent>` message to the parent [R1][S10].
  - V1: `task({subagent_type, description, prompt, task_id?, background?})` returns the subagent's single final message [T8]. Users can also invoke it with `@agent` [V1b].
- **Definition: markdown with frontmatter, where the body is the prompt.**
  - Locations: `.opencode/agents/<id>.md` (project) and `~/.config/opencode/agents/<id>.md` (global), or JSON under `agents` (V2) / `agent` (V1) [D2][V1b].
  - Options: `description`, `mode`, `model` (`provider/model[#variant]`), `steps`, `hidden`, and permissions [D2][V1b].
- **Cross-version agent file.** V2 detects a markdown agent with only legacy keys (`permission`, `tools`, `temperature`, …) and migrates it [S12]. **One V1-style agent file therefore works on both lines.**
- **Structured output: none native** [D2]. The parent receives text. JSON-only output has to be requested in the prompt and parsed by the root.
- **Fit for "context analysis".** Good on both lines: read, glob and grep allowed, everything else denied.
  - **Caveat:** the packet lives under `$DYNAMIC_SKILLS_HOME` (OS tmpdir), outside the project.
  - V1 defaults `external_directory` to **ask** [V1c]. V2 defaults it to allow [D3].
  - On V1 a read-only subagent therefore needs an `external_directory` allow for that directory; the resource is `<dir>/*` [T9].

### 6. Shell and permissions
- **Defaults.** Shell is allowed by default on both lines (V2 base `*`/`*`: allow; V1 "Most permissions default to allow") [D3][V1c]. Prompts appear only under restrictive user policies.
- **Approval replies:** `once`, `always`, `reject` [D3][V1c].
  - On V2, `always` saves project-scoped allow rules for command prefixes [D3].
  - On V1, `always` lasts "for the rest of the session" [V1c].
- **Config syntax.**
  - V1: an object under `permission`. Pattern keys are evaluated in order and the last match wins:
    `{"permission":{"bash":{"*":"ask","dynamic-skills *":"allow"}}}` [V1c]
  - V2 native: an ordered array:
    `{"permissions":[{"action":"shell","resource":"dynamic-skills *","effect":"allow"}]}` [D3]
  - V2 migrates V1 `permission` (`bash`→`shell`, `task`→`subagent`) and puts it **before** native rules [S11].
  - **V1 throws `ConfigInvalidError` on a V2 `permissions` key:** "V2 permissions are not supported by OpenCode V1" [T6]. **Write the V1 form.**
- **Scopes.** Project: `opencode.json(c)` or `.opencode/opencode.json(c)`. User: `~/.config/opencode/opencode.json(c)` [D11][T10]. On V2 a `.opencode` config overrides a direct one [D11].
- **Glob matching.**
  - `*` matches zero or more characters including `/`, `?` matches exactly one, and the whole string must match.
  - A trailing `" *"` also matches the bare command, so `dynamic-skills *` matches `dynamic-skills` [D3][T5].
- **Compound commands.**
  - V2: a built-in Bash/Zsh/sh/PowerShell scanner checks each subcommand and each `cd` target. Unparseable or dynamic syntax produces a scanner error rather than running [D3].
  - V1: a tree-sitter parse checks each command node, and `cd` is handled as a directory check [T5].
  - So `dynamic-skills x | jq` also needs `jq` allowed.
- **Headless.**
  - `opencode run "<msg>"` with `--format json`, `--agent`, `-m provider/model[#variant]`, `-s/--session`, `-c`, `-f file`, `--auto` ("auto-approve permissions that are not explicitly denied"); `--dangerously-skip-permissions` and `--yolo` are hidden [S9][T3].
  - Without `--auto`, permission asks are rejected [S9][T3].
  - V1 also has `--attach`, `--command` and `--interactive` [T3].

### 7. Installation and registration
- **Idiomatic third-party channels.**
  1. Plain files in `.opencode/{skills,agents,commands}/` or the global equivalents.
  2. Plugins: npm packages or local directories listed in `plugins` (V2) / `plugin` (V1), or auto-loaded from `.opencode/plugins/`. Managed with `opencode plugin add|list|remove` [D4][V1d].
     - **V1 plugin code does not run on V2** [D8]: the plugin packages differ (`@opencode-ai/plugin` vs `@opencode/plugin`).
  3. MCP servers under `mcp.servers` [D14]. MCP prompts become `/<server>:<prompt>` commands, but MCP servers do not provide skills [D14].
- **Committable.** Yes: `.opencode/` and `opencode.json(c)` are project config by design [D11]. One exception: an absolute tmpdir path in an `external_directory` rule is machine-specific and belongs in user config.

### 8. Status display
- **Text.** Shell tool output (stdout and stderr) reaches the model, which relays it. This works everywhere.
- **V1 plugin:** `client.tui.showToast({ body: { message, variant } })`, a transient toast [V1f].
- **V2 TUI plugin** (the `./tui` export, configured in `cli.json`):
  - transient: `context.ui.toast.show({title,message,variant,duration})`
  - **persistent:** `context.ui.slot({ append: "prompt.footer.status" | "home.footer.status" | "sidebar.content", render })` [D7][D4]
- A persistent PRD §10.5 block is therefore possible only on V2, and only with a TUI plugin that sources state from the CLI. It is not possible in `run` mode.

### 9. Portability constraints (AC 20)
- Nothing *rejects* a standard bundle. Unknown fields are ignored on both lines [V1a][S3].
- **Constraints for a byte-identical bundle that behaves the same everywhere:**
  1. Frontmatter `name` must be present (V1 skips a skill without it [T1]) and equal to the directory name (V1 keys by `name`, V2 by directory [S3][T1]).
  2. `description` must be present (otherwise the skill is not advertised).
  3. No `disable-model-invocation` or `metadata.opencode/autoinvoke`, unless the same semantics are intended everywhere: V2 honours both [D1].
  4. No extra `*.md` at the skills-root level (V2 treats it as a skill), no nested `SKILL.md` inside a bundle (V1 globs `**/SKILL.md`, V2 stops descending), and no dot-prefixed skill directories (V2 skips them) [S2][T1].
- These are placement and metadata rules, not content rules. Byte-identical files remain possible.

## Adapter implications (OpenCode)

- **Version detection.** `opencode --version` gives major 1 or 2 (**inferred** that this flag exists on both). Emit only V1-syntax config, which V2 migrates.
- **`init --harness opencode`** (idempotent: deep-merge JSONC, write only when content differs, never reorder user keys).
  1. **Bootstrap skill.** Copy `dynamic-skill-bootstrap/SKILL.md` byte-identical to `.opencode/skills/dynamic-skill-bootstrap/` (project), or to `$OPENCODE_CONFIG_DIR|$XDG_CONFIG_HOME/opencode/skills/…` (personal).
  2. **Analyst agent.** Write `.opencode/agents/dynamic-skills-context-analyst.md`. Do not set `hidden`: on V2 it removes the agent from the subagent catalog [D2].
     ```yaml
     ---
     description: Read-only Dynamic Skills context analyst. Reads a Context Packet and returns one JSON object valid for the given schema; no prose.
     mode: subagent
     steps: 30
     permission:
       "*": deny
       read: allow
       glob: allow
       grep: allow
       list: allow
     ---
     <analyst prompt: untrusted-data rule, JSON-only output, observed/inferred labelling>
     ```
  3. **Permissions.** Merge into `.opencode/opencode.jsonc` (project):
     ```jsonc
     { "permission": { "bash": { "dynamic-skills *": "allow" } } }
     ```
     Merge into `~/.config/opencode/opencode.jsonc` (personal):
     ```jsonc
     { "permission": {
         "bash": { "dynamic-skills *": "allow" },
         "external_directory": { "<realpath DYNAMIC_SKILLS_HOME>/*": "allow" },
         "edit": { "<realpath DYNAMIC_SKILLS_HOME>/*": "allow" } } }
     ```
     The `edit` rule lets the root write `--file` documents and the bundle into the session directory.
  4. **Optional explicit trigger.** `.opencode/commands/dynamic-skills.md`, whose body is "Use the dynamic-skill-bootstrap skill for: $ARGUMENTS". Do not name it `dynamic-skill-bootstrap`: on V1 that clashes with the skill's own slash command.
  5. **Verify.** Run `opencode debug paths` (V2) [D10] and check that the files exist. Live verification would need `opencode run` (**inferred**).
- **Activation.**
  - Baseline on both lines: the Phase 1 contract, where the agent reads `loadOrder` files. This writes nothing permanent and satisfies AC 28.
  - V2 native option A: a Dynamic Skills V2 server plugin that, on a custom tool call (`ctx.tool.transform`), registers the evaluated bundle with `ctx.skill.transform(add)` and `ctx.skill.reload()`, or pins it per session with `ctx.session.instructions.entry.put`. This is session-scoped and survives compaction [D6][R2].
  - V2 native option B: a `skills` config entry pointing at `$DYNAMIC_SKILLS_HOME/active/`. It is watched and live, but visible to every session (**inferred**).
- **Delegation.** The root calls `subagent`/`task` with `agent: dynamic-skills-context-analyst` and a prompt containing `packetPath` and the schema path. It parses the JSON from the final text, writes the file, and runs `dynamic-skills context submit`. On V2 the root must yield until the `<subagent>` message arrives [S10].
- **Questions.** Map each clarification question to a `question` entry: `header` at most 30 chars, `options` from the choices embedded in the text, and free text is automatic. In `run` mode, treat cancellation as `declined` with an assumption.
- **Status.** Text relay in the baseline. V2 TUI-plugin footer slot as a later enhancement.
- **`save`.**
  - `project` → `<repo>/.opencode/skills/<name>/`
  - `personal` → `${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/opencode}/skills/<name>/`
  - `ephemeral` → nothing written
  - `discard` → `clean`
  - Refuse to overwrite a different existing skill with the same ID. Also check `.claude/skills` and `.agents/skills` (`.claude/skills` only when `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` is unset [T1]), because OpenCode reads them and the ID would shadow.
  - V2 picks up the saved skill live; V1 needs a restart.

## Discrepancies

- **PRD §11.3.** The paths are right. Missing from the row:
  - OpenCode also reads `.claude/skills` and `.agents/skills`, project and global, so saves for other harnesses become visible in OpenCode and can collide.
  - The singular `skill/` directory.
  - XDG / `OPENCODE_CONFIG_DIR` resolution of `~/.config/opencode`.
  - Different walk-up limits: V1 stops at the git worktree, V2 goes to the filesystem root.
- **PRD §14 / §11.1 "harness restart must not be the normal activation strategy".** Achievable natively only on V2. V1 requires the content-in-context fallback.
- **PRD §20 and roadmap Phase 2 use `npx dynamic-skills init`.** This conflicts with the bare-binary rule, and the permission rule must target `dynamic-skills *`, not `npx …`.
- **Roadmap Phase 2** assumes "three harnesses". OpenCode is effectively two (V1 and V2), with incompatible plugin APIs and config keys. The compatibility suite needs both.
- **Roadmap "native current-session activation" and "native question UI".** Questions are unavailable in `opencode run` (V1 deny, V2 auto-cancel), so the e2e gate cannot exercise them headlessly.

## Open questions and risks

1. How long will V1 be supported, and which line should be the default target? Nothing official was found; `opencode upgrade --major` exists [R4].
2. **macOS tmpdir realpath.** `/var` vs `/private/var` in `external_directory` rules: V2 canonicalizes [D3]; V1 behaviour is unverified.
3. **V1 config merge.** If the user has `"bash": "ask"` (a string), merging our object may replace or conflict (**inferred**). Needs a merge test.
4. **V2 background subagents and the SLA.** Wait time counts against 60 s. It is unclear whether `opencode run` waits for background children before exiting.
5. **Questions from subagents.** Whether child-session question forms render in the TUI is undocumented.
6. **V2 duplicate skill IDs** silently shadow by precedence. A project `.opencode` copy beats `.claude` and `.agents` copies.
7. **Source-derived behaviour** (watchers, V1 caching, the legacy-agent migration) is undocumented and may change. Pin tested versions: v1.19.5 and v2.3.0.

## Sources (all retrieved 2026-11-15)

**V2 documentation**

- [D1] https://opencode.ai/docs/skills/
- [D2] https://opencode.ai/docs/agents/
- [D3] https://opencode.ai/docs/permissions/
- [D4] https://opencode.ai/docs/plugins/
- [D5] https://opencode.ai/docs/build/plugins/
- [D6] https://opencode.ai/docs/build/plugins/server/
- [D7] https://opencode.ai/docs/build/plugins/cli/
- [D8] https://opencode.ai/docs/build/plugins/migrate-v1/
- [D9] https://opencode.ai/docs/tools/
- [D10] https://opencode.ai/docs/cli/
- [D11] https://opencode.ai/docs/config/
- [D12] https://opencode.ai/docs/commands/
- [D13] https://opencode.ai/docs/rules/
- [D14] https://opencode.ai/docs/mcp-servers/
- [D15] https://opencode.ai/docs/

**V1 documentation**

- [V1a] https://opencode.ai/v1/docs/skills/
- [V1b] https://opencode.ai/v1/docs/agents/
- [V1c] https://opencode.ai/v1/docs/permissions/
- [V1d] https://opencode.ai/v1/docs/plugins/
- [V1f] https://opencode.ai/v1/docs/sdk/
- [V1g] https://opencode.ai/v1/docs/commands/

**Releases and distribution**

- [R1] https://github.com/anomalyco/opencode/releases/tag/v2.3.0
- [R2] https://github.com/anomalyco/opencode/releases/tag/v2.2.0
- [R3] https://github.com/anomalyco/opencode/releases/tag/v1.19.5
- [R4] https://opencode.ai/install (installer script, lines 68–77)
- [R5] https://www.npmjs.com/package/opencode-ai and https://www.npmjs.com/package/@opencode/cli (dist-tags)

**V2 source, tag v2.3.0** (`https://github.com/anomalyco/opencode/blob/v2.3.0/`)

- [S1] `packages/core/src/config/plugin/skill.ts`
- [S2] `packages/core/src/config/plugin/skill-scan.ts`
- [S3] `packages/core/src/config/plugin/skill-file.ts`
- [S4] `packages/core/src/config/plugin/compatibility.ts`
- [S5] `packages/core/src/skill/instructions.ts`
- [S6] `packages/core/src/tool/plugin/skill.ts`
- [S7] `packages/core/src/config.ts` and `packages/core/src/config/discovery.ts`
- [S8] `packages/core/src/tool/plugin/question.ts` and `packages/schema/src/question.ts`
- [S9] `packages/cli/src/run/noninteractive.ts` and `packages/cli/src/commands/commands.ts`
- [S10] `packages/core/src/tool/plugin/subagent.ts` and `packages/core/src/session/subagent-completion.ts`
- [S11] `packages/core/src/config/normalize.ts` and `packages/core/src/v1/config/migrate.ts`
- [S12] `packages/core/src/config/plugin/agent.ts`
- [S13] `packages/util/src/global.ts`

**V1 source, tag v1.19.5** (`https://github.com/anomalyco/opencode/blob/v1.19.5/`)

- [T1] `packages/opencode/src/skill/index.ts`
- [T2] `packages/opencode/src/command/index.ts`
- [T3] `packages/opencode/src/cli/cmd/run.ts`
- [T4] `packages/opencode/src/tool/registry.ts`, `packages/opencode/src/tool/question.ts` and `packages/schema/src/v1/question.ts`
- [T5] `packages/opencode/src/tool/shell.ts` and `packages/core/src/util/wildcard.ts`
- [T6] `packages/opencode/src/config/v2-compat.ts`
- [T7] `packages/plugin/src/index.ts`
- [T8] `packages/opencode/src/tool/task.ts` and `task.txt`
- [T9] `packages/opencode/src/tool/external-directory.ts`
- [T10] `packages/opencode/src/config/config.ts`
