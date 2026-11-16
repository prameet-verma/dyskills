# Phase 2 research synthesis: harness integrations

Date: 2026-11-15. Input to `docs/superpowers/plans/2026-11-15-phase-2-harness-integrations.md`.

This document merges the three Phase 2 spikes, applies the human decisions D1–D4 (2026-11-15), and
fixes the adapter design. It changes no code and does not edit `PRD.md`: every PRD or roadmap
change below is a proposed amendment, text only.

**Sources.** Citation keys are prefixed with the spike they come from; the spike's own Sources table
gives each URL (all retrieved 2026-11-15).

| Prefix | Spike report | Example |
|---|---|---|
| `CC-` | `docs/superpowers/research/2026-11-15-spike-claude-code.md` | `CC-S1` = that report's `[S1]` |
| `CX-` | `docs/superpowers/research/2026-11-15-spike-codex.md` | `CX-build-skills`, `CX-src` (a source-only claim) |
| `OC-` | `docs/superpowers/research/2026-11-15-spike-opencode.md` | `OC-D1` (V2 docs), `OC-V1a` (V1 docs), `OC-S1` (V2 source), `OC-T1` (V1 source) |

**Targets and pinned versions.** Four targets, each pinned to the version the spikes read:

| Target | Pinned version | Distribution |
|---|---|---|
| claude-code | 2.1.325 (newest changelog entry, CC-S19) | `claude` CLI |
| codex | rust-v0.169.0 (`codex --version` reports `0.169.0`, CX releases) | `codex` CLI |
| opencode-v1 | v1.19.5 (npm `opencode-ai@latest`, OC-R3, OC-R5) | `opencode` 1.x |
| opencode-v2 | v2.3.0 (npm `@opencode/cli`, OC-R1, OC-R5) | `opencode` 2.x |

## Binding human decisions

- **D1 — distribution.** Publish the CLI as the unscoped npm package `dynamic-skills`, installed
  globally (`npm i -g dynamic-skills`). The installer is the bare `dynamic-skills init`. Everything
  calls the bare `dynamic-skills` binary, never a package runner (Ruling R19). No doc recommends
  `npx dynamic-skills`.
- **D2 — activation.** Reading the files in `loadOrder` into context stays the default on every
  harness. Claude Code gets an optional native mode: when the session was launched with
  `--add-dir <session-home-native-dir>`, `activate` also places the skill under that directory's
  `.claude/skills/`. Nothing ephemeral is ever written to a permanent skill directory (AC 28).
- **D3 — OpenCode.** Support both lines, V1 (1.19.5) and V2 (2.3.0), with one adapter that writes
  V1-style config, which V2 migrates. The compatibility suite has four targets.
- **D4 — question options.** Clarification questions gain optional `options: [{ label,
  description }]` and `multiSelect`. Additive; `CONTRACT_VERSION` stays `"1"`. Adapters map them
  to each native question tool; a text question stays the fallback.

Further binding decisions (2026-11-16), taken after the plan review:

- **D5 — native placement lifetime.** Native placements under `<home>/native/` are swept at every
  `assess` and `activate`. A placement is removed when it is older than 24 h (a TTL constant in
  core), when no session references it, or when every referencing session ended without a
  successful activation (an outcome other than `activated` or `augmented`). An unparsable
  `session.json` counts as referencing every placement (fail safe), so only the TTL removes
  placements while one exists.
- **D6 — consent rules.** `init` writes an ask/prompt rule for `dynamic-skills save` and
  `dynamic-skills init` in every harness:
  - Claude Code: `permissions.ask` (ask beats allow);
  - Codex: a `prefix_rule` with `decision = "prompt"` (strictest wins);
  - OpenCode: `"ask"` entries after the allow (last match wins).

  An allow rule cannot override the consent rule on Claude Code (ask beats allow) or Codex
  (strictest wins). Headless runs that must save or init either run the command themselves in a
  terminal (`dynamic-skills save --session <id> --scope … --harness …`), or remove the consent
  rule (Claude Code, Codex) or append an allow after it (OpenCode); documented per harness.
- **D7 — placeholders.** `$ARGUMENTS` and `${CLAUDE_*}` always fail portability; a positional `$N`
  fails in prose and warns inside fenced code blocks.
- **D8 — augmentations.** Saving an augmentation is deferred to Phase 3 (`SAVE_UNSUPPORTED`). AC 26
  is Phase 3; skills saved in Phase 2 carry no context fingerprint, and Phase 3 treats them as
  needing a relevance check.

## Capability matrix

Legend: ✅ supported and usable by the adapter as is; ⚠️ supported with a limit the design must
handle; ❌ not supported (a fallback is used).

| # | Research question | claude-code 2.1.325 | codex 0.169.0 | opencode-v1 1.19.5 | opencode-v2 2.3.0 |
|---|---|---|---|---|---|
| 1 | **Skill support** (Agent Skills format, discovery paths) | ✅ Agent Skills plus extensions. Personal `${CLAUDE_CONFIG_DIR:-~/.claude}/skills`, project `.claude/skills` from the launch dir up to the repo root, `--add-dir` roots, plugins. Reads no `.agents/skills` (docs silent). Unknown keys ignored; `name` ≠ directory tolerated (CC-S1, CC-S13). | ✅ `.agents/skills` from CWD up to the repo root, `~/.agents/skills`, `/etc/codex/skills` (CX-build-skills); `$CODEX_HOME/skills` (deprecated) and `.codex/skills` (CX-src). `name` optional, defaults to the directory; `description` required (CX-src parser). | ✅ `.opencode/skills`, `.claude/skills`, `.agents/skills`, project and global, walk up to the git worktree (OC-V1a). Keyed by frontmatter `name`: a file without a string `name` is **silently skipped** (OC-T1). | ✅ Same roots plus singular `skill/`, `skills: [...]` config entries; global dir follows `XDG_CONFIG_HOME` / `OPENCODE_CONFIG_DIR` (OC-D1, OC-S1, OC-S13). Keyed by **directory name**; walk to the filesystem root (OC-S7). |
| 2 | **Mid-session activation** without restart | ⚠️ Live watcher on personal, project and `--add-dir` `.claude/skills/` (CC-S1, 2.1.0+). The only non-permanent watched place is an `--add-dir` root chosen at launch; a skills dir created after start needs `/reload-skills` (CC-S1). Reading into context always works. | ⚠️ Codex's own activation **is** reading `SKILL.md` (CX-src `catalog_prompt.rs`), so `loadOrder` reading is native. A watcher lists new skills within ~10 s, but only in permanent roots (CX-src `skills_watcher.rs`); no ephemeral root. | ❌ natively: skills cached per instance, no watcher or reload (OC-T1). Reading into context works. | ✅ Skill roots and config file-watched (100 ms), "New skills are available…" announced at the next step (OC-S1, OC-S4, OC-S5). Only via permanent roots or a config entry visible to every session. |
| 3 | **Autonomous and explicit invocation** | ✅ Descriptions listed every turn; 1 % budget, least-invoked dropped first (CC-S1). Explicit: `/dynamic-skill-bootstrap <task>`. No config needed. | ✅ Catalog ≤ 2 % / 8,000 chars, descriptions shortened first (CX-build-skills). Explicit: `$dynamic-skill-bootstrap` or `/skills`. No config needed. | ✅ `<available_skills>` list, `skill({ name })` (OC-V1a). Explicit: every skill is also `/<name>` (OC-T2); a `.opencode/commands/*.md` file adds a custom command (OC-V1g). | ✅ `skill({ id })`; explicit `@skill-id` (OC-D1); custom commands (OC-D12). Opt-out keys `disable-model-invocation`, `metadata.opencode/autoinvoke` are honoured (OC-D1). |
| 4 | **Native question UI** | ✅ interactive / ⚠️ elsewhere. `AskUserQuestion`: 1–4 questions, 2–4 options `{label, description}`, `multiSelect`, header ≤ 12 chars, free-text "Other" always (CC-S6, CC-S7). Not available to subagents; removed by `--permission-prompts none`; plain `-p` behaviour docs silent. | ⚠️ `request_user_input`: 1–3 questions, 2–3 options, single-select, header ≤ 12, "Other" automatic; **Plan mode only** unless an off-by-default feature is on; refused in `codex exec` and subagents (CX-src). Undocumented. | ⚠️ `question` tool (options, `multiple`, free text); `opencode run` denies it unless `--interactive` (OC-T3, OC-T4). | ✅ interactive / ⚠️ `run`: `question` tool, header ≤ 30, no cap on count (OC-S8); `run` auto-cancels with "make reasonable assumptions" (OC-S9). |
| 5 | **Read-only analysis subagent** (and structured output) | ✅ Markdown agent with `tools: Read, Grep, Glob` is truly read-only (CC-S2). No schema enforcement on the reply (CC-S6). Subagents run in the **background** by default; the wait counts toward the SLA (CC-S2). | ⚠️ Custom agent TOML (`name`, `description`, `developer_instructions`); sandbox and approval are inherited, so **read-only is by instruction only** (CX-subagents). No output schema (CX-src). | ✅ Markdown agent, `permission: {"*": deny, read/glob/grep/list: allow}` (OC-V1b); `task` tool returns the final text (OC-T8). `external_directory` defaults to **ask**, so reading the packet under the session home needs an allow (OC-V1c, OC-T9). | ✅ Same file works (legacy agent keys migrated, OC-S12). Since 2.3.0 subagents **always run in the background** and report via a `<subagent>` message (OC-R1, OC-S10). |
| 6 | **Shell and permissions** | ⚠️ Allow rule `Bash(dynamic-skills *)`. Project rules are **ignored in untrusted `-p`**; user settings and untracked `.claude/settings.local.json` are not trust-gated (CC-S4). An env-prefixed command does not match an allow rule (CC-S4). Sandbox changes `$TMPDIR` and denies writes to `.claude/skills` (CC-S15). Allow rules need both requested and resolved paths to match (`/var` → `/private/var`) (CC-S4). | ⚠️ Starlark `prefix_rule` in `rules/*.rules`; `allow` runs the command **outside the sandbox** (CX-rules, CX-src `exec_policy.rs`). `.agents` and `.codex` are read-only inside workspace-write (CX-approvals). Only plain `&&`/`;`/`|` scripts are split per segment; `VAR=…`, `$(…)`, redirects match as one script (CX-src). Rules load at startup. | ✅ `"permission": {"bash": {"dynamic-skills *": "allow"}}`, last match wins (OC-V1c). **A V2 `permissions` key makes V1 throw** (OC-T6). Compound commands checked per node (OC-T5). | ✅ Migrates V1 `permission` and puts it before native rules (OC-S11); per-subcommand scanner (OC-D3); `external_directory` defaults to allow and canonicalises paths (OC-D3). |
| 7 | **Installation and registration** | ✅ Plain files: skill, agent, strict-JSON settings merge (CC-S9, CC-S13). Optional plugin `bin/` on `PATH` (CC-S11), at the cost of a namespaced skill name. New `agents/` dir needs a restart (CC-S2). | ✅ Plain files: skill, agent TOML, optional rules file. `.codex/` only applies in trusted projects (CX-config-basic); restart after a rule (CX-rules). | ✅ Plain files: skill, agent md, command md, `opencode.json(c)` merge. V1 plugins do not run on V2 (OC-D8). | ✅ Same files; JSONC merge; `opencode debug paths` for verification (OC-D10). |
| 8 | **Status display** (PRD §10.5) | ⚠️ Text relay in the reply. `statusLine` is one user-owned slot (CC-S8); mods draw nothing in `-p` (CC-S17). | ⚠️ Text only; the status line accepts built-in items only (CX-src `status_line_setup.rs`). | ⚠️ Text; transient toast via a plugin (OC-V1f). | ⚠️ Text; a TUI plugin could fill a footer slot (OC-D7). |
| 9 | **Portability constraints** (AC 20) | ⚠️ On invocation, `` !`cmd` `` and ```` ```! ```` blocks run as shell commands; `$ARGUMENTS`, `$N`, `${CLAUDE_*}` are substituted; `allowed-tools` **grants** permissions (CC-S1, CC-S4). | ✅ Unknown keys ignored, no description cap, `agents/openai.yaml` optional; hidden subdirectories skipped (CX-src). | ⚠️ `name` must be present and equal the directory (keyed by name); `**/SKILL.md` glob picks up nested `SKILL.md` (OC-T1). | ⚠️ Honours `disable-model-invocation` and `metadata.opencode/autoinvoke`; a root-level `*.md` in a skills dir is a skill; dot-dirs skipped; stops descending below a `SKILL.md` (OC-D1, OC-S2). |

### What the matrix decides

1. **Reading into context is the only activation that works on all four targets without touching a
   permanent directory.** It is Codex's own mechanism, OpenCode V1's only one, and survives
   everywhere. D2 keeps it as the default; Claude Code's add-dir placement is an optional extra.
2. **One canonical bundle is possible**, but only with stricter generation rules than Phase 1
   enforces: no shell-render syntax, no argument placeholders (D7: a positional `$N` only warns
   inside fenced code), no `allowed-tools`, no host-namespaced metadata, `name` present and equal to the directory, no nested `SKILL.md`, no dot-entries, no
   stray top-level `.md` (row 9).
3. **Native question tools are unavailable in every headless mode** (`-p`, `exec`, `run`) and in
   Codex's default mode (row 4). Questions must work as text, and the automated suites must test
   the mapping with fixtures, not with live tools.
4. **Read-only delegation is enforceable on three targets, not on Codex** (row 5). The CLI's schema
   validation stays the only real gate on analysis output.
5. **Status is text everywhere** (row 8). No adapter writes a status line or plugin UI.

## Chosen adapter design

### Shape

- **`packages/adapter-sdk`** — harness-neutral. Defines `HarnessAdapter`, the `HostEnv` /
  `HostProbe` injection points, and the executors every adapter shares:
  - idempotent install-plan application (file create / unchanged / conflict, strict-JSON and JSONC
    merges that keep user keys and comments, scalar promotion for OpenCode's `"bash": "ask"`);
  - realpath resolution of every path written into a config;
  - byte-identical bundle placement with a sha256 manifest, atomic rename and conflict detection;
  - a minimal save-target planner that uses the compatibility paths so one copy serves several
    harnesses;
  - a compatibility **testkit** that every adapter runs against its own fixture home.
- **`adapters/claude-code`, `adapters/codex`, `adapters/opencode`** — each a pure planner: detection
  through an injected probe, the install plan (files and config patches), its save roots, the roots
  it reads (from the bootstrapper's single root registry), the native question mapping, and the
  analyst agent template. OpenCode is one adapter with a `line: 1 | 2` variant from
  `opencode --version`.
- **The CLI is the composition root.** `dynamic-skills init` and `dynamic-skills save` call the
  adapters; `activate` and `clarify ask` consult the adapter of the current harness when it is
  known. Adapters never change the core contracts (roadmap architecture decision).

### Why this design

- **Plain files over plugins, hooks and MCP.** Plain files are documented, committable and identical
  in effect on both OpenCode lines (OC-§7); Claude Code plugins namespace the skill and cannot carry
  allow rules (CC-§7); Codex plugins need a new session (CX-plugins); OpenCode V1 plugin code does
  not run on V2 (OC-D8); hooks need per-hook trust on Codex (CX-hooks) and add context every turn;
  none of the three needs MCP for a CLI.
- **Pure planners plus one executor.** Idempotency, dry-run, conflict handling and realpath
  discipline are written and tested once (in the SDK) and proven per target by the shared testkit.
  Adapter tasks then touch only their own package, so the three can be built in parallel.
- **Read-first activation (D2).** It satisfies AC 24 (no restart) and AC 28 (no permanent writes) on
  all four targets. Claude Code's optional native mode gives compaction survival (CC-S1) where the
  user opts in by launching with `--add-dir`.
- **V1-style OpenCode config (D3).** V1 throws on V2 keys (OC-T6); V2 migrates V1 keys (OC-S11). One
  adapter, two compat targets.
- **Harness identity by configuration, never by the skill text.** The bootstrap skill must stay
  harness-neutral (PRD §6.9 #7; the portability eval fails on harness names). The CLI learns the
  harness from `--harness` or from `DYNAMIC_SKILLS_HARNESS`, which `init` sets where the host
  supports an environment block (Claude Code settings `env`, CC-S13). The bootstrap tells the
  agent to pass `--harness <host id>` to `clarify ask` when it knows its host, so native question
  plans reach Codex and OpenCode too. Without either, every feature still works through the text
  and read-into-context paths.
- **Machine-specific values stay out of committed files.** Session-home paths go into Claude Code's
  untracked `settings.local.json` or user settings (CC-S4) and OpenCode's user config (OC-§7).
- **Codex's allow rule is opt-in.** `allow` runs `dynamic-skills` unsandboxed (CX-rules), which is
  a trust decision; `init` writes it only with `--codex-allow-rule` and says why `save` needs it.
- **Consent before persistence and installation (D6).** Every harness gets an ask/prompt rule for
  `dynamic-skills save` and `dynamic-skills init`, using each harness's precedence (CC-S4 ask beats
  allow; CX-rules strictest decision wins; OC-V1c last match wins). The harness's own approval
  prompt becomes the PRD §11.2 consent for saving.
- **Native placements expire (D5).** Claude Code add-dir placements are swept at every `assess` and
  `activate`: unreferenced placements, placements whose sessions all ended without a successful
  activation, and anything older than 24 h. A crash therefore cannot leave a skill listed natively
  for long.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Write ephemeral skills into `.claude/skills`, `.agents/skills` or `.opencode/skills` for native pickup | Violates AC 28; write-denied under Claude Code's sandbox (CC-S15) and inside Codex workspace-write (CX-approvals) |
| OpenCode V2 `skills` config entry pointing at the session home | Live, but visible to every session (OC-§Adapter implications, inferred); V1 has no equivalent |
| OpenCode V2 server plugin registering the skill per session | Session-scoped and compaction-safe (OC-D6, OC-R2), but V2-only plugin code to maintain; deferred to Phase 5 (extension API) |
| Claude Code plugin with `bin/` on `PATH` | Solves `PATH` for Claude Code users only, namespaces the skill, cannot carry permission rules (CC-§7); D1 solves `PATH` for everyone |
| Nested `codex exec --sandbox read-only --output-schema` analyst | Real read-only sandbox and enforced JSON, but a nested model process, network approval from workspace-write, and OpenAI strict-schema rules our schemas may not meet (CX-§5) |
| `UserPromptSubmit` / `SessionStart` reminder hooks | Autonomous invocation already works from the description listing on all targets (row 3); hooks cost per-turn context and trust prompts (CX-hooks, CC-S3) |
| Status line or TUI footer | Single user-owned slot on Claude Code (CC-S8), built-ins only on Codex (CX-src), V2-only on OpenCode (OC-D7) |

## Discrepancies with the PRD and roadmap, with proposed amendments

Text only; `PRD.md` and the roadmap are not edited by Phase 2.

### PRD §11.3 Harness-Specific Storage — paths incomplete

The table is right for the primary paths but omits roots every harness reads (CC-S1, CC-S13;
CX-build-skills, CX-src; OC-D1, OC-V1a, OC-S13). Scanning and save-collision checks need them.

> **Proposed §11.3 replacement.**
>
> | Harness | Project scope (save target; also read) | Personal scope (save target; also read) |
> |---|---|---|
> | Claude Code | `.claude/skills/` at the repository root; also read from the launch directory up to the root and from `--add-dir` directories | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/` |
> | Codex | `.agents/skills/` at the repository root; also read from the working directory up to the root, and `.codex/skills/` | `~/.agents/skills/`; also read `${CODEX_HOME:-~/.codex}/skills/` (deprecated) and `/etc/codex/skills/` (admin) |
> | OpenCode (1.x and 2.x) | `.opencode/skills/`; also read `.opencode/skill/`, `.claude/skills/`, `.agents/skills/` | `${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/opencode}/skills/`; also read `~/.claude/skills/`, `~/.agents/skills/` |
>
> Because harnesses read each other's directories, a skill saved for several harnesses is written
> once to a directory they all read where possible, and a save is refused when a different skill
> with the same name is visible to any selected harness. Codex treats `name` as optional;
> Dynamic Skills always writes it.

### PRD §11.1, FR-27, AC 24 vs AC 28 — what "activation" means

Native registration without restart requires writing into a watched directory; the only
non-permanent one is Claude Code's launch-time `--add-dir` root (CC-S1, CC-S4). Codex's own
activation is reading the file (CX-src). OpenCode V1 has no live reload (OC-T1).

> **Proposed §11.1 addition.** "Activation loads the evaluated skill into the current session
> without a restart. Reading the skill files into the agent's context is a valid activation on
> every harness and is the default. Where a harness watches a non-permanent location chosen by the
> user (for example a directory added at launch), the adapter may additionally register the skill
> natively. Ephemeral skills are never written to a permanent skill location (AC 28)."
>
> **Proposed AC 24 wording.** "Skills activate without restarting the host session, by loading them
> into context, or natively where the harness supports a non-permanent location."

### PRD §14 and AC 20 — identical bytes are not identical behaviour

Claude Code renders shell blocks and placeholders and treats `allowed-tools` as a grant (CC-S1,
CC-S4); OpenCode V2 acts on `disable-model-invocation` and `metadata.opencode/autoinvoke` (OC-D1);
OpenCode V1 keys skills by `name` and skips unnamed skills (OC-T1); placement rules differ (OC-S2).

> **Proposed §14 portability requirements addition.**
> - "Generated skills contain no host-executed or host-substituted syntax (inline shell
>   execution, argument placeholders, host environment placeholders; a positional placeholder is
>   tolerated, with a warning, only inside fenced code), no permission-granting frontmatter
>   (`allowed-tools`), and no host-namespaced metadata keys."
> - "A bundle's `name` is present and equals its directory name; `description` is present; a
>   bundle contains no nested `SKILL.md`, no dot-prefixed entries, and adds no top-level files to a
>   skills directory."

### PRD §20 Installation — `npx dynamic-skills init`

Contradicts Ruling R19 and D1, and an allow rule must match the bare binary (CC-S4, CX-rules,
OC-V1c).

> **Proposed §20 replacement.**
> ```bash
> npm install -g dynamic-skills
> dynamic-skills init
> dynamic-skills init --harness claude-code,codex,opencode --scope project
> ```
> "Agents and scripts always call the installed `dynamic-skills` command; package runners are not
> used." Steps 3–5 become: "3. Explicit invocation uses each harness's native skill invocation (an
> extra command file where the harness supports one). 4. Autonomous invocation needs no
> configuration on the supported harnesses: the skill description is listed natively. 5. Grant the
> `dynamic-skills` command and the session home the permissions each harness needs, and install the
> read-only context-analyst agent."

### PRD §10.4 principle 5 and §10.5 — native interaction and persistent status

Native question tools are unavailable headless on all targets and outside Plan mode on Codex
(row 4); no harness offers a portable persistent status surface (row 8).

> **Proposed §10.4 #5.** "Use the root agent's native question mechanism where it is available;
> otherwise ask in plain text in the conversation. Structured options are optional, and free-text
> answers are always accepted."
>
> **Proposed §10.5 addition.** "The status block is shown as text in the agent's reply. Harness
> status lines and UI panels are optional and must not replace a user's own configuration."

### PRD §13.1 — read-only delegation

Codex subagents inherit the parent sandbox; read-only is by instruction only (CX-subagents).

> **Proposed §13.1 addition.** "Where a harness cannot enforce read-only tools for a subagent, the
> subagent is instructed to stay read-only, and the core's schema validation of its output remains
> the authority."

### PRD §14 and §18 Phase 2 — "three harnesses"

OpenCode ships two incompatible lines (OC-§Critical context).

> **Proposed §14 / §18 wording.** "Initial support: Claude Code, Codex, and OpenCode 1.x and 2.x.
> Adapter compatibility tests run against four targets. Each adapter records the harness versions
> it was tested against."

### PRD §20 step 4 and AC 3 — autonomous invocation is best-effort

Both Claude Code and Codex drop or shorten descriptions when the listing budget overflows (CC-S1,
CX-build-skills).

> **Proposed AC 3 note.** "Autonomous invocation depends on the harness listing the bootstrap
> description; when it does not, explicit invocation works (PRD §14)."

### PRD §11.2 — persistence consent and sandboxes

On Codex, `save --scope project|personal` writes into directories the sandbox protects, so it needs
an `allow` rule that runs the CLI unsandboxed (CX-approvals, CX-rules).

> **Proposed §11.2 addition.** "Where a harness sandbox blocks writes to its skill directories, the
> installer may add a rule that lets the Dynamic Skills command run outside the sandbox, only with
> the user's explicit opt-in; otherwise saving reports the denial and how to grant it. The
> installer also makes each harness ask for approval before Dynamic Skills saves a skill or
> changes the installation (D6); a non-interactive run does either by running the command outside
> the agent, or by relaxing that rule where the harness allows it."

### PRD §23 — link

`developers.openai.com/codex/skills` redirects to `learn.chatgpt.com/docs/build-skills`
(CX-build-skills). Proposed: update the link.

### Roadmap

| Roadmap text | Problem | Proposed amendment |
|---|---|---|
| Documentation rules: "alongside `npx dynamic-skills init`"; Phase 2: "`npx dynamic-skills init [--harness …]`" | R19 and D1 | "alongside `dynamic-skills init` (installed with `npm i -g dynamic-skills`)" and "`dynamic-skills init [--harness claude-code,codex,opencode] [--scope project\|personal]`" |
| Phase 2: "native current-session activation" | Native placement only on Claude Code add-dir and OpenCode V2 permanent roots | "current-session activation (read into context everywhere; optional native registration on Claude Code via an add-dir root)" |
| Phase 2: "adapter compatibility test suite run identically against all three adapters" | OpenCode has two lines (D3) | "…against four targets: claude-code, codex, opencode-v1, opencode-v2" |
| Phase 2: "native subagent delegation for context analysis" | Read-only is instruction-only on Codex | "a read-only context-analyst agent installed per harness (enforced on Claude Code and OpenCode, instructed on Codex)" |
| Phase 2 exit gate: "all three adapters" | D3 | "all three adapters (four targets)" |
| Phase 3: persisting an augmentation | Phase 2 must decide the interim | D8: Phase 2 `save` refuses augmentations (`SAVE_UNSUPPORTED`); Phase 3 adds them together with the base-hash freshness check (see plan Task 12a) |
| Phase 3 exit gate (AC 26, freshness checks before reuse) | Phase 2 saves skills before fingerprints exist | D8: "Skills saved before Phase 3 carry no context fingerprint; the freshness validator treats them as needing a relevance check." |
| Cross-phase risk "A harness cannot activate a new skill mid-session" | Now confirmed for OpenCode V1 and Codex (non-ephemeral only) | Mitigation stands: read-into-context is the default (D2) |

## Open risks

| # | Risk | Evidence | Mitigation in the plan |
|---|---|---|---|
| 1 | macOS `/var` → `/private/var` breaks allow rules and `--add-dir` containment | CC-S4 (allow needs both paths), OC-§Q2 (V1 unverified) | Every path written into a config is a `realpath`; tested with a symlinked home in the testkit; checked by the Claude Code live smoke |
| 2 | Claude Code sandbox gives sandboxed commands a different `$TMPDIR`, splitting the session home | CC-S15 | `init` pins `DYNAMIC_SKILLS_HOME` through the settings `env` block (an inline prefix would not match the allow rule, CC-S4) |
| 3 | Background subagents (Claude Code default; OpenCode V2 always) add waiting time inside the 60 s budget | CC-S2, OC-R1 | The live smoke records `agenticMs` from `reports/discovery.json` per harness; the gate records the numbers |
| 4 | Native question tools are absent headless and outside Codex Plan mode | CC-S5, CX-src, OC-T3, OC-S9 | Text questions remain first-class; structured options are optional; e2e and compat suites test the mapping with fixtures; headless runs map a cancelled question to `skipped` plus an assumption |
| 5 | Codex `allow` rule runs `dynamic-skills` unsandboxed; the CLI's own path discipline is the only boundary | CX-rules, CX-§Q3 | Opt-in flag; SECURITY.md states the trust decision; every write outside the session home is planned, listed, atomic, and refuses symlinked targets |
| 6 | OpenCode V1/V2 divergence (walk-up limit, keying by name vs directory, background subagents) and V1's support horizon is unknown | OC-S7, OC-T1, OC-§Q1 | Portability rules make name = directory; both lines in the compat suite; adapter warns on untested versions |
| 7 | Source-derived behaviour (Codex watcher, OpenCode V2 watcher, V1 cache, legacy-agent migration) is undocumented and may change | CX-§Q2, OC-§Q7 | Pinned tested versions in each adapter; detection warns on others; live smoke per target at the gate |
| 8 | Bootstrap description dropped when the skill listing overflows | CC-S1, CX-build-skills | Description front-loads its triggers; explicit invocation documented per harness and checked at the gate |
| 9 | A saved skill shadows or duplicates a same-named skill through compatibility paths | OC-§Q6, CX-§1 ("not merged") | `save` checks every root any selected harness reads and refuses a different same-named skill |
| 10 | Whether Claude Code applies the "new top-level skills dir needs `/reload-skills`" rule to add-dir roots is docs silent | CC-§Open questions | `init --native` pre-creates `<home>/native/claude-code/.claude/skills/` |
| 11 | Plain `claude -p` behaviour with `AskUserQuestion` is docs silent | CC-S5 | Treated as unavailable: the bootstrap asks in text or records an assumption |
| 12 | Is `.agents/skills` repo discovery gated on project trust in Codex? Are project `.codex/agents` loaded untrusted? | CX-§Q5, CX-§Q6 | Docs say so; Codex live smoke uses `--scope project` in a fresh repo and records whether the bootstrap was listed |
| 13 | Publishing needs a license; none is chosen (Ruling R6) | Phase 1 rulings | Publishing is a human gate step that starts with the license choice |
| 14 | A crashed or abandoned session leaves a native placement listed by every Claude Code session launched with the add-dir | CC-S1 (live watcher) | D5: sweep at every `assess` and `activate`, 24 h TTL, fail safe on unparsable sessions |
| 15 | Consent rules block saving in headless runs (`-p`, `exec`, `run` cannot approve) | CC-S5, CX-src, OC-S9 | D6: documented per harness; a headless save runs `dynamic-skills save` in a terminal, or the consent rule is removed (Claude Code, Codex) or followed by an allow (OpenCode) |
