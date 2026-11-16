# Phase 2 spike: OpenAI Codex CLI

Harness: OpenAI Codex CLI (`codex`). Researched on 2026-11-15 against the official docs and the
`openai/codex` repository. Docs: `developers.openai.com/codex/*` now 308-redirects to
`learn.chatgpt.com/docs/*`, and every page has a Markdown version at `<url>.md`. Source: `main` at
commit `5cb38e7` (2026-11-15). The latest stable release is `rust-v0.169.0` (2026-11-13).

`codex` is not installed on this machine, so **nothing below was tested by running it**. Claims
come from the docs, or from source code where the docs are silent. Source-only claims are marked
**[src]**. Conclusions I drew myself, from reading either docs or source, are marked **inferred**.
Source links are abbreviated as `S/<path>`, meaning
`https://github.com/openai/codex/blob/5cb38e79842a0e0a6dca5bb97874163e8ee50129/<path>`. The
Sources section lists every page in full.

## Summary

- **(a) Native mid-session activation: ⚠️**
  - Codex's own way to "activate" a skill is for the model to open and read `SKILL.md`. That is
    exactly the Phase 1 fallback, so `activate` plus reading `loadOrder` is already the native
    path.
  - Codex does notice a skill placed in a discovery root mid-session ("detects skill changes
    automatically; if an update doesn't appear, restart"). In source, a file watcher (10 s
    throttle) clears the cache, and the catalog is rebuilt for every model sampling step **[src]**.
  - There is no ephemeral or temporary root. Placing a skill therefore means writing to a
    permanent directory, which conflicts with AC 28.
  - `.agents/` is read-only inside the default sandbox when the directory exists.
- **(b) Read-only delegation: ⚠️**
  - Subagents (`spawn_agent`) and custom agents (`.codex/agents/*.toml`, each with its own
    `developer_instructions` and model) are native.
  - However, "Subagents inherit the parent turn's current sandbox and approval settings … A custom
    agent file can't replace those settings." Read-only behaviour is therefore enforced only by
    instructions.
  - There is no output-schema parameter **[src]**. The JSON contract relies on the prompt plus the
    CLI's `SCHEMA_INVALID` loop.
- **(c) Structured questions: ⚠️**
  - `request_user_input` exists: 1–3 questions, each with 2–3 mutually exclusive options, plus an
    automatic free-text "Other". It is single-select only.
  - It works only in **Plan** collaboration mode, unless the under-development feature
    `default_mode_request_user_input` is enabled. It is root-thread only and is refused in
    `codex exec` **[src]**.
  - It is not documented on the official docs site.
  - In Default mode the fallback is to ask in plain text and end the turn.
- **Other findings:**
  - Hooks exist (`SessionStart`, `UserPromptSubmit`, …) but must be trusted by the user before
    they run.
  - Pre-authorisation is a Starlark `prefix_rule` in a `rules/*.rules` file. An `allow` rule also
    bypasses the sandbox.
  - The status line accepts only built-in items, so the status block must be text.

## Findings

### 1. Skill support

**Format.**
- Skills follow the open Agent Skills standard: a directory with `SKILL.md` that "must include
  `name` and `description`", plus optional `scripts/`, `references/`, `assets/` and
  `agents/openai.yaml` [build-skills].
- In source, the parser honours only:
  - `name`: optional, defaults to the directory name, at most 64 characters;
  - `description`: required and non-empty, with whitespace collapsed to one line for display;
  - `metadata.short-description`.
- The frontmatter struct has no `deny_unknown_fields`, so **unknown keys are ignored, not
  rejected** **[src]** [S/codex-rs/skills/src/parser.rs].
- There is a YAML repair pass for unquoted values that contain `: ` **[src]**.
- No check that `name` matches the directory name was found **[src, inferred from the parser and
  loader]**.

**Codex-specific metadata** lives in the separate `agents/openai.yaml`, not in frontmatter:
- `interface.*`;
- `policy.allow_implicit_invocation` (default `true`);
- `dependencies.tools` [build-skills].

**Discovery paths (documented)** [build-skills]:

| Scope | Path |
|---|---|
| REPO | `$CWD/.agents/skills`, every `.agents/skills` from CWD up to the repo root, `$REPO_ROOT/.agents/skills` |
| USER | `$HOME/.agents/skills` |
| ADMIN | `/etc/codex/skills` |
| SYSTEM | bundled (`skill-creator`, `skill-installer`) |

- Symlinked skill folders are followed.
- Skills with the same name are not merged: "both can appear in skill selectors".

**Additional roots found in source but not in the docs** [S/codex-rs/ext/skills/src/host_roots.rs]
**[src]**:
- `$CODEX_HOME/skills` (normally `~/.codex/skills`), commented "Deprecated user skills location …
  kept for backward compatibility";
- `<project>/.codex/skills`. It comes from the project config layer, so it loads only for trusted
  projects (**inferred**);
- plugin skill roots;
- runtime "extra roots", settable only through the app-server API (`skills/extraRoots/set`), not
  from config or the shell.

**Repo-root and scan rules [src]:**
- The repo root is found with project-root markers (default `.git`).
- Only `.agents/skills` directories that already exist are added.
- The scan is recursive to depth 6, skips hidden directories, and is capped at 2000 directories
  per root [S/codex-rs/ext/skills/src/loader/mod.rs].
- Codex does **not** read `.claude/skills`. `/import` copies a Claude Code setup instead [import].

**Plugins.** Plugins ship skills under `skills/<name>/SKILL.md`, with a `plugin.json` (portable)
or `.codex-plugin/plugin.json` manifest. They are installed from marketplaces:
- `$REPO_ROOT/.agents/plugins/marketplace.json`;
- `~/.agents/plugins/marketplace.json`;
- `codex plugin marketplace add …` / `codex plugin add`.

Plugin skills become available "when you start a new chat or CLI session after installation"
[dev-plugins] [plugins].

**Token budget.** The initial skill catalog (name, description, path) uses at most 2% of the
context window, or 8,000 characters. When there are many skills, descriptions are shortened first
and skills may be omitted. `skills.max_context_tokens` raises the budget to at most 10,000 tokens
[build-skills] [config-ref].

**Enable and disable.** Use `[[skills.config]]` with `path` or `name` plus `enabled`; the last
matching entry wins. `[skills.bundled] enabled=false` turns off bundled skills. Docs say to restart
after changing config [build-skills].

**Relationship to `AGENTS.md`.**
- `AGENTS.md` is loaded up front, once per run.
- The chain is: global `~/.codex/AGENTS.override.md` or `AGENTS.md`, then one file per directory
  from the project root down to the CWD (`AGENTS.override.md`, then `AGENTS.md`, then
  `project_doc_fallback_filenames`).
- The chain is capped at 32 KiB [agents-md].
- Skills are progressive: only their metadata is visible until the skill is selected [customization].

**Compared with PRD §11.3** (Codex row: `.agents/skills/` and `~/.agents/skills/`):
- The row is **correct** for the documented primary paths.
- It omits:
  - the nested CWD→root `.agents/skills` directories;
  - `/etc/codex/skills`;
  - the deprecated `~/.codex/skills`;
  - the undocumented `.codex/skills`;
  - plugin and system skills.
- PRD §23's link `developers.openai.com/codex/skills` now redirects to
  `learn.chatgpt.com/docs/build-skills`.

### 2. Mid-session activation

**Docs.** "Codex detects skill changes automatically. If an update doesn't appear, restart Codex."
The same wording applies to `$skill-installer` [build-skills]. Config changes (`skills.config`) and
plugins need a restart or a new session [build-skills] [plugins].

**Source [src]:**
- The TUI and `codex exec` both embed an in-process app-server [S/codex-rs/tui/src/lib.rs].
- The app-server runs a `SkillsWatcher` that recursively watches the non-plugin, non-system
  roots. On a change it clears the skills cache and emits `SkillsChanged`, throttled to 10 s
  [S/codex-rs/app-server/src/skills_watcher.rs].
- Missing paths are watched through their nearest existing ancestor
  [S/codex-rs/file-watcher/src/lib.rs].
- Repo `.agents/skills` directories that do not exist are not roots at all. However, roots are
  re-resolved on every snapshot and the cache is keyed by the root set, so a newly created
  `.agents/skills` changes the key and forces a rescan [S/codex-rs/ext/skills/src/host_service.rs]
  (**inferred**).
- The catalog is contributed as a "World State" section for **each model sampling step**
  [S/codex-rs/ext/extension-api/src/contributors/world_state.rs]. Changes are re-emitted, as a
  full listing by default or as "Added or updated skills" deltas behind the off-by-default
  `skill_catalog_deltas` feature [S/codex-rs/ext/skills/src/catalog_delta.rs]
  [S/codex-rs/features/src/lib.rs].
- **Conclusion (inferred):** a skill written into an existing root becomes visible to the model
  within about 10 s, at the next sampling step, without a restart.
- This should be confirmed empirically, because the docs hedge with "restart if it doesn't
  appear".

**Supported way to use new instructions now.**
- The model reads the file. Codex's own skill instructions say: "After deciding to use a skill,
  the main agent must … open and read its `SKILL.md` completely before taking task actions"
  [S/codex-rs/ext/skills/src/catalog_prompt.rs].
- A skill's location only governs whether it is *listed*. Reading a `SKILL.md` from the
  dynamic-skills session directory is functionally the same activation.
- The same prompt says "Do not carry skills across turns unless re-mentioned", and "Do not
  delegate reading … skill instructions to a subagent".

### 3. Autonomous and explicit invocation

**Implicit invocation.**
- The model chooses a skill "when your task matches the skill `description`", so the docs advise
  front-loading trigger words [build-skills].
- The injected rule is "If the user names a skill (with `$SkillName` or plain text) OR the task
  clearly matches a skill's description … you must use that skill for that turn"
  [S/…/catalog_prompt.rs].
- Implicit invocation can be disabled per skill only through
  `agents/openai.yaml` → `policy.allow_implicit_invocation: false` [build-skills].

**Explicit invocation.** The user types `$skill-name`, or picks one with `/skills`, which "inserts
the selected skill context" [build-skills] [cli-commands].

**Hooks** [hooks]:
- **Locations:**
  - `~/.codex/hooks.json`;
  - inline `[hooks]` in `~/.codex/config.toml`;
  - `<repo>/.codex/hooks.json` or `config.toml`, trusted projects only;
  - plugin `hooks/hooks.json`.
- **Events:** `SessionStart` (matcher `startup|resume|clear|compact|fork`), `UserPromptSubmit`
  (no matcher; stdout or `additionalContext` is added as developer context; can block),
  `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SubagentStart` / `SubagentStop`,
  `PreModelRequest` / `PostModelRequest`, `PreCompact` / `PostCompact`, `Stop`, `Interrupt`,
  `SessionEnd`.
- **Handlers:** `command` and `mcp_tool` run; `prompt` and `agent` handlers are parsed but
  skipped.
- **Trust:** hooks are enabled by default (`[features] hooks = false` turns them off). **Every
  non-managed hook must be reviewed and trusted in `/hooks`**, and trust is recorded against the
  hook's hash. In source, trust is stored as `[hooks.state."<key>"] trusted_hash` [src]
  [S/codex-rs/config/src/hook_config.rs].
- **Bypass:** `--dangerously-bypass-hook-trust` skips trust for a single invocation.
- **Output limit:** `additionalContext` is capped at about 2,500 tokens by default.
- **`notify`:** a top-level config array whose command receives JSON on notification, typically
  turn completion [config-ref].

**Assessment.** Hooks are not required for the bootstrap to be considered, because the skill
catalog is already in context every step. A `UserPromptSubmit` hook could inject a short "consider
`$dynamic-skill-bootstrap`" reminder (**inferred**), at the cost of per-turn context and a trust
prompt.

### 4. Native question UI

**`request_user_input`** **[src]** [S/codex-rs/core/src/tools/handlers/request_user_input_spec.rs]:
- **Shape:** `questions[]` with `id` (snake_case), `header` (12 characters or fewer), `question`
  (one sentence) and `options[]` of `{label (1–5 words), description}`.
- **Limits:**
  - "Prefer 1 and do not exceed 3" questions;
  - "2–3 mutually exclusive choices", with the client adding a free-form "Other";
  - every question **must** have non-empty options, so there are no text-only questions;
  - no multi-select.
- **Mode:** available only in modes where `allows_request_user_input()` is true, which means
  `Plan` only, unless the feature `default_mode_request_user_input` (stage UnderDevelopment,
  default off) is on [S/codex-rs/tools/src/tool_config.rs] [S/codex-rs/protocol/src/config_types.rs]
  [S/codex-rs/features/src/lib.rs].
- **Subagents:** refused: "request_user_input can only be used by the root thread"
  [S/…/request_user_input.rs].
- **Headless:** `codex exec` rejects it: "request_user_input is not supported in exec mode"
  [S/codex-rs/exec/src/lib.rs].
- **Docs:** the docs only say Plan mode can "ask clarifying questions" [best-practices], and
  describe the tool nowhere.

**MCP elicitation.** It is referenced in the hooks docs [hooks]. It is an alternative only if
dynamic-skills became an MCP server (out of scope).

### 5. Subagent delegation

**Spawning** [subagents]:
- Native and on by default (`[agents] enabled`, `max_concurrent_threads_per_session`).
- Codex spawns subagents "after a direct request or applicable project or skill instruction". The
  bootstrap's step 3 wording qualifies.
- Built-in agent types are `default`, `worker` and `explorer`.

**Custom agents.**
- One TOML file per agent in `~/.codex/agents/` (personal) or `.codex/agents/` (project).
- Required fields: `name`, `description`, `developer_instructions`.
- Optional fields:
  - `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`;
  - capability switches `features.shell_tool|apps|plugins|memories|request_permissions_tool = false`;
  - `[[skills.config]]`, `skills.include_instructions`.
- **`sandbox_mode`, `approval_policy`, `model_provider` and `mcp_servers` in an agent file are
  ignored.** "Custom agent instructions can ask an agent to avoid edits, but they don't create a
  separate read-only sandbox" [subagents].

**Tool parameters.** `spawn_agent` accepts `message`, `items`, `agent_type`, `fork_context` (v1) or
`fork_turns` (v2), `model` and `reasoning_effort`. There is **no output schema**; the parent gets
the agent's final message via `wait_agent` **[src]**
[S/codex-rs/core/src/tools/handlers/multi_agents_spec.rs].

**Approvals.** Approval prompts from subagents surface in the TUI. In non-interactive runs they
fail back to the parent [subagents].

**Fit for a read-only context analyst:**
- Good for isolating context, choosing the model and pinning instructions.
- Weak on enforcement:
  - read-only depends on the parent session's sandbox;
  - disabling `shell_tool` would also remove file reading (**inferred**: in Codex, reading is
    done through shell commands);
  - JSON output is by instruction only, validated by `context submit`.
- Alternative (**inferred**): shell out to `codex exec --sandbox read-only --ephemeral
  --output-schema <analysis.json> -o <file>`, which gives a real read-only sandbox and enforced
  JSON. However:
  - it needs network approval from inside a `workspace-write` sandbox;
  - it is a nested process, so it is slower;
  - OpenAI structured-output schemas need `additionalProperties:false` and all properties
    required, which may not accept our schemas as they are [non-interactive].

### 6. Shell, sandbox and approvals

**Modes** [approvals]:
- `sandbox_mode`: `read-only`, `workspace-write` or `danger-full-access`.
- `approval_policy`: `on-request`, `never` or `{ granular = … }`. `untrusted` has been retired.
- Default for git repositories: workspace-write with on-request.
- `codex exec` defaults to a **read-only** sandbox [non-interactive].
- Inside workspace-write, `<root>/.git`, **`<root>/.agents`** and `<root>/.codex` are read-only
  when they exist.
- Network is off in workspace-write by default.

**Temp directory.** "The workspace includes the current directory and temporary directories like
`/tmp`" [approvals]. `$TMPDIR` is writable unless `sandbox_workspace_write.exclude_tmpdir_env_var`
is set (likewise `exclude_slash_tmp`) [config-ref]. So
`<os tmpdir>/dynamic-skills-<uid>/sessions/…` is writable under workspace-write, but **not** under
read-only.

**Pre-authorisation through rules** [rules]:
- Starlark files under `rules/` next to any active config layer: `~/.codex/rules/*.rules` (user)
  or `<repo>/.codex/rules/*.rules` (trusted projects only).
- Loaded at startup; restart after adding a rule.
- Adding a command to the allow list in the TUI writes to `~/.codex/rules/default.rules`.
- Example:

```python
prefix_rule(pattern = ["dynamic-skills"], decision = "allow",
            justification = "Dynamic Skills deterministic CLI",
            match = ["dynamic-skills assess --task x"], not_match = ["npx dynamic-skills init"])
```

- **Decisions:** `allow` runs the command "outside the sandbox without prompting". In source,
  sandbox bypass applies only when every parsed segment is allow-listed
  [S/codex-rs/core/src/exec_policy.rs]. `prompt` and `forbidden` are the other options; the
  strictest decision wins.
- **Testing:** `codex execpolicy check --rules <file> -- <cmd>`.

**Compound commands.**
- `bash|zsh|sh -lc` scripts made only of plain words joined by `&&`, `||`, `;` or `|` are split
  with tree-sitter, and each part is checked.
- Redirection, `$(…)`, `$VAR`, `VAR=…`, globs or control flow mean the whole script is matched as
  one `["bash","-lc","…"]`, so a `dynamic-skills` prefix rule will **not** match.
- The bootstrap should therefore issue bare `dynamic-skills …` commands, with documents passed
  through `--file`, and no pipes into unknown tools or redirects.
- Plain quoted arguments are treated as words (**inferred**).

**Headless.**
- `codex exec [--sandbox workspace-write] [--json] [--output-schema f] [-o f] [--ephemeral]
  [--ignore-rules] [--ignore-user-config] [--skip-git-repo-check]`, plus `codex exec resume`.
- `--full-auto` has been removed; use `--approve-for-me` [non-interactive].
- Approvals cannot surface in exec mode [S/codex-rs/exec/src/lib.rs].

### 7. Installation and registration

**Idiomatic routes** [build-skills] [dev-plugins]:
- Local skill folders are for "authoring and repo-scoped workflows".
- Plugins (plus a marketplace) are "for reusable distribution". The plugin route also carries hooks
  and MCP.
- MCP is not needed for a CLI.
- A plain `SKILL.md` copy is the lowest-friction, documented and committable option.

**Committable.** Yes: repo `.agents/skills/…`, `.codex/config.toml`, `.codex/rules/`,
`.codex/agents/` and `.codex/hooks.json` are all designed to be checked in. The `.codex/` layer
applies only after the user trusts the project [config-basic].

### 8. Status display

- `tui.status_line` / `/statusline` accept only built-in item IDs, such as model, git-branch,
  context-used, thread-title and task-progress. No custom or external command item exists
  **[src]** [S/codex-rs/tui/src/bottom_pane/status_line_setup.rs] [config-ref].
- `tui.notifications` (OSC 9 / BEL) and `notify` (external program) are turn-level only [config-ref]
  [notifications].
- Hooks can show a transient `statusMessage` and a `systemMessage` warning [hooks].
- **Result:** the §10.5 block must be relayed as text in the agent's message. Command stderr is
  visible to the model in the tool output, but the user sees it only truncated (**inferred**).

### 9. Portability constraints (AC 20)

- No blocking constraint was found:
  - unknown frontmatter keys are ignored;
  - `name` may be omitted but `description` is mandatory;
  - names of 64 characters or fewer, matching the Agent Skills spec;
  - no description length cap, compared with the spec's 1024 **[src]**.
- Codex-only metadata sits in an optional side file (`agents/openai.yaml`). Omitting it keeps the
  bundle byte-identical.
- Hidden subdirectories inside a skill are skipped during discovery **[src]**, so bundles should
  avoid dot-directories.

## Adapter implications (Codex)

**`init --harness codex` (idempotent: write if absent; no-op if byte-identical; report a conflict
if different; never edit `default.rules` or `AGENTS.md`).**

- **Bootstrap skill (required):** copy `skills/dynamic-skill-bootstrap/SKILL.md` byte-for-byte to
  `~/.agents/skills/dynamic-skill-bootstrap/SKILL.md` (personal), or
  `<repo>/.agents/skills/dynamic-skill-bootstrap/SKILL.md` (`--scope project`, committable). Do
  **not** add `agents/openai.yaml`, so implicit invocation stays on by default.
- **Rule (recommended):** `~/.codex/rules/dynamic-skills.rules` (or `<repo>/.codex/rules/…`)
  containing the `prefix_rule` from §6.
  - With `allow`, all commands run unsandboxed without prompts. This is needed for
    `save --scope project` (`.agents/` is protected) and `--scope personal` (`~/.agents` is
    outside the writable roots), and for any read-only `codex exec`.
  - A narrower alternative: allow everything except `save`, and use `decision="prompt"` for
    `["dynamic-skills","save"]` so Codex's own approval doubles as the PRD's persistence consent.
    It fails in exec mode, and whether an approved `prompt` command runs unsandboxed is
    unverified.
  - Tell the user to restart Codex.
- **Custom agent (optional):** `~/.codex/agents/dynamic-skills-context-analyst.toml`, for example:

```toml
name = "dynamic_skills_context_analyst"
description = "Read-only analyst for a Dynamic Skills context packet; returns JSON only."
model_reasoning_effort = "medium"
developer_instructions = """Read only the packet and files it names. Never edit files or run
non-read commands. Output exactly one JSON document valid for the supplied analysis schema."""
[features]
request_permissions_tool = false
apps = false
plugins = false
[[skills.config]]
name = "dynamic-skill-bootstrap"
enabled = false
```

- **Hooks:** none by default, because they need `/hooks` trust and add context to every turn.
  Offer an opt-in `UserPromptSubmit` reminder. Never forge `trusted_hash`.
- **Verify:** check the files exist. Check `dynamic-skills` is on `PATH`. Run
  `codex execpolicy check --rules <file> -- dynamic-skills status` and expect `allow`.

**Other adapter behaviour:**

- **Activation:**
  - Ephemeral: keep the Phase 1 path. The agent reads the `loadOrder` files from the session
    directory. That is Codex's native skill-use mechanism and touches no permanent root (AC 28).
  - Optional native listing: only after `save` (below).
  - Note for the bootstrap: Codex says "do not carry skills across turns unless re-mentioned", so
    tell the agent to keep applying the activated skill for the rest of the task.
- **Delegation:** the bootstrap step 3 already asks for a subagent. With the custom agent
  installed, the adapter hint is `agent_type = "dynamic_skills_context_analyst"`. The root then
  writes the reply to a file and runs `context submit`. It is not truly read-only unless the parent
  sandbox is read-only.
- **Questions:**
  - In Plan mode, map `clarify ask` questions to `request_user_input`: at most 3 per call,
    options extracted into 2–3 `options`, ids mapped (`r1-q1` → `r1_q1`), and "Other" giving free
    text.
  - Otherwise, render the questions as text, end the turn, and pass the next user message to
    `clarify answer`. Never call the tool from a subagent or in exec mode.
- **Status:** text only. The agent quotes the stderr status block in its reply.
- **`save` storage paths:**

| Scope | Destination |
|---|---|
| `--scope project` | `<repo-root>/.agents/skills/<name>/` |
| `--scope personal` | `~/.agents/skills/<name>/` |
| `ephemeral` | no write |
| `discard` | `clean` |

  - Both `project` and `personal` writes need sandbox escape (the rule above).
  - After the write, Codex should list the skill within about 10 s without a restart (**inferred**
    [src]; it should be tested).
  - Skills with the same name are not merged, so `save` must refuse to overwrite an existing
    `<name>` in either root.

## Discrepancies

- **PRD §11.3:**
  - The paths are right but incomplete (see §1).
  - The Phase 1 `scan.ts` covers only `<repo>/.agents/skills` and `~/.agents/skills`. It misses
    nested CWD→root `.agents/skills`, `~/.codex/skills`, `.codex/skills`, `/etc/codex/skills`,
    plugin and system skills.
  - It requires a string `name`, whereas Codex defaults to the directory name.
  - It treats `AGENTS.md`/`CLAUDE.md` only at the repo root. Codex also uses
    `AGENTS.override.md`, nested `AGENTS.md`, `~/.codex/AGENTS.md` and fallback filenames.
- **PRD §14 / §20 ("enable autonomous invocation where supported", "configure explicit
  invocation"):**
  - Both come for free on Codex once the skill sits in a root. Nothing needs configuring.
  - "Configure native skill discovery and activation" amounts to a rules file. No discovery config
    exists.
- **PRD §11.1 / AC 24 vs AC 28, and roadmap "native current-session activation":**
  - On Codex, native activation by *placement* is only possible in permanent roots. There is no
    ephemeral or extra root reachable from the CLI.
  - The PRD intent is met by read-based activation, which is what Codex itself does.
- **Roadmap "native read-only subagent delegation":** Codex cannot give a subagent a stricter
  sandbox than its parent.
- **Bootstrap clarification rule ("put options inside the question `text` (no choices field)"):**
  - It conflicts with `request_user_input`, which *requires* 2–3 options on every question.
  - Phase 2 needs either a structured `choices` field in `clarificationRequest` or adapter-side
    parsing.
- **Roadmap/PRD §20 `npx dynamic-skills init`** vs the bootstrap rule "never fetch it with a
  package runner". A Codex `allow` rule should match only the bare binary (the `not_match` above).
- **PRD §23 link:** it redirects to `learn.chatgpt.com/docs/build-skills`.

## Open questions and risks

1. **Empirical check needed:**
   - Does a skill written into an existing `~/.agents/skills` or `<repo>/.agents/skills` appear
     at the next turn or sampling step without a restart?
   - What about a newly created `.agents/skills`?
   - Run it in the TUI and in `codex exec`.
2. Codex releases daily (`0.171.0-alpha.5` on 2026-11-14). Watcher, catalog-delta and Plan-only
   question behaviour are internal and may change. Pin the tested version in adapter tests.
3. An `allow` rule runs `dynamic-skills` completely unsandboxed. The CLI's own path discipline
   becomes the only boundary, and that should be stated in SECURITY.md.
4. `request_user_input` being Plan-mode-only means most sessions fall back to text questions. The
   SLA pause and resume therefore relies on the agent ending its turn correctly.
5. Is `.agents/skills` repo discovery gated on project trust? The source suggests not; the docs
   are silent.
6. Are project `.codex/agents/*.toml` files loaded only in trusted projects? Probably, as part of
   the config layer, but the docs don't say.
7. The catalog budget (2% of context) may shorten or omit the bootstrap description when users
   have many skills. The description should front-load its triggers.

## Sources (all retrieved 2026-11-15)

**Official documentation:**
- [build-skills] https://learn.chatgpt.com/docs/build-skills (.md); redirect from https://developers.openai.com/codex/skills
- [hooks] https://learn.chatgpt.com/docs/hooks.md
- [subagents] https://learn.chatgpt.com/docs/agent-configuration/subagents.md
- [rules] https://learn.chatgpt.com/docs/agent-configuration/rules.md
- [agents-md] https://learn.chatgpt.com/docs/agent-configuration/agents-md.md
- [approvals] https://learn.chatgpt.com/docs/agent-approvals-security.md
- [sandboxing] https://learn.chatgpt.com/docs/sandboxing.md
- [non-interactive] https://learn.chatgpt.com/docs/non-interactive-mode.md
- [config-basic] https://learn.chatgpt.com/docs/config-file/config-basic.md
- [config-advanced] https://learn.chatgpt.com/docs/config-file/config-advanced.md
- [config-ref] https://learn.chatgpt.com/docs/config-file/config-reference.md
- [cli-commands] https://learn.chatgpt.com/docs/developer-commands.md?surface=cli
- [notifications] https://learn.chatgpt.com/docs/notifications.md
- [plugins] https://learn.chatgpt.com/docs/plugins.md
- [dev-plugins] https://developers.openai.com/plugins/build/plugins.md
- [customization] https://learn.chatgpt.com/docs/customization/overview.md
- [import] https://learn.chatgpt.com/docs/import.md
- [best-practices] https://learn.chatgpt.com/docs/llms-full.txt (Best practices section, "Use Plan mode")
- Index: https://learn.chatgpt.com/llms.txt

**Repository:**
- Repository pointers: https://github.com/openai/codex/tree/main/docs (skills.md, config.md, exec.md, execpolicy.md, sandbox.md, agents_md.md all link to the pages above)
- Releases: https://github.com/openai/codex/releases (rust-v0.169.0, 2026-11-13; rust-v0.171.0-alpha.5, 2026-11-14)

**Source files** (each prefixed with `https://github.com/openai/codex/blob/5cb38e79842a0e0a6dca5bb97874163e8ee50129/`):
- Skills: `codex-rs/skills/src/parser.rs`, `codex-rs/skills/src/metadata.rs`
- Skill extension: `codex-rs/ext/skills/src/host_roots.rs`, `host_service.rs`, `catalog_prompt.rs`,
  `catalog_delta.rs`, `world_state.rs`, `world_state_catalogs.rs`, `loader/mod.rs`, `loader/host.rs`
- Extension API: `codex-rs/ext/extension-api/src/contributors/world_state.rs`
- App server and file watching: `codex-rs/app-server/src/skills_watcher.rs`,
  `codex-rs/app-server/tests/suite/v2/skills_list.rs` (`skills_changed_notification_is_emitted_after_skill_change`),
  `codex-rs/file-watcher/src/lib.rs`
- Features and config: `codex-rs/features/src/lib.rs` (`skill_catalog_deltas`,
  `default_mode_request_user_input`), `codex-rs/tools/src/tool_config.rs`,
  `codex-rs/protocol/src/config_types.rs`, `codex-rs/config/src/hook_config.rs`
- Core tools and policy: `codex-rs/core/src/tools/handlers/request_user_input_spec.rs`,
  `request_user_input.rs`, `multi_agents_spec.rs`, `codex-rs/core/src/exec_policy.rs`
- Clients: `codex-rs/exec/src/lib.rs`, `codex-rs/tui/src/lib.rs`,
  `codex-rs/tui/src/bottom_pane/status_line_setup.rs`
