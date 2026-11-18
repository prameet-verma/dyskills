# Dynamic Skills on OpenCode (1.x and 2.x)

One adapter covers both live OpenCode lines (D3, [ADR 0009](../adr/0009-opencode-dual-line.md)):
the variant (`v1` or `v2`) comes from `opencode --version`. Tested against OpenCode `1.19.5` and
`2.3.0`; any other version works but is reported as untested, and a major other than 1 or 2 is
reported as an unsupported line. The adapter internals are in the
[adapter README](../../adapters/opencode/README.md); the design is in the
[architecture](../architecture.md) and [ADR 0007](../adr/0007-harness-adapter-interface.md).

## Install

```sh
npm i -g dynamic-skills
dynamic-skills init --harness opencode                    # personal scope (default)
dynamic-skills init --harness opencode --scope project    # this repository
```

The package is not yet published to npm. Until it is published, build it (`pnpm install && pnpm
build`) and link the bin into a directory on your `PATH`, for example `ln -s
"$PWD/packages/cli/dist/index.js" ~/.local/bin/dynamic-skills`. The adapter writes only the V1
config form (`"permission": {...}`), which V2 migrates; it never writes the V2 `permissions` key,
`plugin` or `plugins`.

### What `init` writes

Personal scope, under the config directory `C` (an absolute `OPENCODE_CONFIG_DIR`, else
`<XDG_CONFIG_HOME or ~/.config>/opencode`):

- `C/skills/dynamic-skill-bootstrap/SKILL.md`
- `C/agents/dynamic-skills-context-analyst.md`
- `C/commands/dynamic-skills.md`
- a JSONC merge into `C/opencode.jsonc` or `C/opencode.json` (whichever exists, else
  `opencode.jsonc`): `permission.bash` (the consent entries below), and `permission.edit` and
  `permission.external_directory` allowing `<session home>/*`.

Project scope, under `<repo>/.opencode/` (committable): the same three files, plus a merge into the
project's OpenCode config holding only `permission.bash`, which carries no machine path. Reading the
session home from OpenCode 1.x still needs the personal-scope `external_directory` allow, so also
run `dynamic-skills init --harness opencode --scope personal`.

A scalar `permission.bash`, `permission.edit` or `permission.external_directory` (for example
`"bash": "ask"`) is promoted to `{ "*": <scalar>, ... }` first, so your blanket rule survives. A
scalar `permission` itself, or an existing `"dynamic-skills *": "deny"`, is a conflict and nothing is
written. Comments and trailing commas in your config are kept.

## Consent rules

`init` appends, in this order (the last match wins):

```jsonc
{ "dynamic-skills *": "allow", "dynamic-skills save *": "ask", "dynamic-skills init *": "ask" }
```

OpenCode asks before a skill is saved or the configuration is changed. `init` simulates the merged
config with OpenCode's own last-match evaluation and adds a note (never a conflict) when another
rule outranks the ask, such as a top-level `permission["*"]: "allow"` placed after `bash` (Ruling
R34). On a project that has its own `opencode.json`, OpenCode 1.x deep-merges it over your personal
config, so a project `"bash": "allow"` can override the personal asks there; run `init --scope
project` in that repository too if it should keep them.

**Known limit (Ruling R35).** OpenCode matches the command text exactly as written. A quoted
subcommand (`dynamic-skills 'save' ...`) or an extra space (`dynamic-skills  save ...`) matches the
broad allow, not the ask. The ask patterns are deliberately not widened (for example to `*save*`),
because that would also prompt on commands such as `assess --task "save ..."`. The consent rule is
therefore a prompt for ordinary calls, not an enforcement boundary. The save itself stays contained
by the CLI's checks.

### Headless runs (`opencode run`)

`opencode run` rejects every pending ask. Either run
`dynamic-skills save --session <id> --scope project --harness opencode` in a terminal, or append a
**distinct, more specific** allow after the ask entries, never the same key again (a duplicate
key makes the next `init` report a conflict):

```jsonc
{ "dynamic-skills save --session *": "allow", "dynamic-skills init --harness *": "allow" }
```

## Using it

**Autonomous.** OpenCode lists skills in `<available_skills>` and the model loads one with the
`skill` tool, so a matching task can trigger `dynamic-skill-bootstrap`. **Explicit.** Run the
installed command `/dynamic-skills <task>`, which tells the agent to use the bootstrap skill. On
2.x you can also write `@dynamic-skill-bootstrap <task>` (live check pending).

Activation is reading the files in `loadOrder`; OpenCode has no native placement (`activate`
returns `native: null`). Status is relayed as text in the reply.

**Questions.** The agent passes `--harness opencode` to `clarify ask`. Every question that has
options goes to the `question` tool in one call (`multiple` set from `multiSelect`); the others are
asked in text. The native payload has no id, so `idMap` keys on a header of at most 30 characters
taken from the id. In `opencode run`, V1 denies the tool and V2 cancels the form: ask in text or
record the question as skipped with an assumption.

**Analyst agent.** `dynamic-skills-context-analyst` is a markdown agent with
`permission: { "*": deny, read, glob, grep, list: allow }`, so it is read-only. **On 2.x, subagents
run in the background** (since 2.3.0): the parent waits for their result, and that wait counts
toward the 60 second budget.

## Saving a skill

`dynamic-skills save --session <id> --scope project|personal --harness opencode` copies the
evaluated bundle byte for byte to `<project>/.opencode/skills/<name>/` (project) or
`C/skills/<name>/` (personal). OpenCode also reads `.claude/skills` and `.agents/skills`, so
`--harness opencode,claude-code` usually writes one copy to `.claude/skills`. OpenCode asks first
(the consent rule).

- **1.x:** a newly saved skill is listed after a **restart**. The ephemeral skill itself needs no
  restart, because it is read from the session home.
- **2.x:** the skill is listed at the next step.

A skill saved in Phase 2 carries no freshness fingerprint, and saving an augmentation is not
supported yet (`SAVE_UNSUPPORTED`).

## Troubleshooting

- **`external_directory` on 1.x.** 1.x defaults `external_directory` to ask, so reading the session
  home (outside the project) prompts and fails headless. Run the personal-scope `init` once; it
  allows `<session home>/*`. 2.x allows it by default, and the rule is harmless there.
- **V1 needs a restart after `save`**, as above. Reading the activated skill does not.
- **V2 background subagents.** If `opencode run` finishes before the analyst reports, or the wait
  pushes active time near 60 seconds, ask for the analysis in the main agent instead. Whether
  `opencode run` waits for background children is not settled; the live smoke records it.
- **Quoted or double-spaced commands bypass the ask** (Ruling R35, above).
- **Config in an unusual shape.** `"permission": "ask"` as a whole, or a `deny` for
  `dynamic-skills *`, is reported as a conflict and nothing is written; edit the file and rerun.
- **V2 `permissions` key.** Do not add it by hand next to the V1 form: V1 hard-fails on a top-level
  V2 `permissions` key, and on 2.x its entries outrank the migrated rules.
- **Verification.** Only 2.x is verified after `init` (`opencode debug paths`); 1.x has no
  equivalent command, so it reports no checks.
