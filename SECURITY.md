# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Report it privately to the maintainers at
[maintainer contact]. Include what you found, the steps to reproduce it and the version or commit.
We will acknowledge the report, work on a fix and agree a disclosure date with you. The project is
pre-release, so no versions are supported yet.

## Threat model summary

Dynamic Skills reads a repository and the agent's output, and produces text that an agent will
treat as instructions. The design assumes both inputs can be hostile.

- **Repository content is untrusted.** It is data, never instructions. The compilation brief fences
  repository evidence and the base skill as untrusted, and the Context Packet is marked untrusted.
  Reuse and activation are different: `sufficiency submit` (`reused.content`) and `activate`
  (`content`, `base.content`) return skill and instruction text raw on stdout for the agent to
  load.
- **Agent output is untrusted until validated.** Every document the agent submits is parsed with a
  strict schema, and agent claims keep their provenance; a claim is `verified` only when it resolves
  to real, non-secret evidence.
- **Existing skills are read-only.** A base skill is matched by exact scanned path and pinned by
  sha256. Canonical skills are never written, moved or deleted.
- **Secrets are excluded.** Secret files (environment files, keys, certificates and keystores,
  credential files such as `.git-credentials`, `.netrc`, `.pgpass` and `.htpasswd`, Terraform
  variables and state, the `.aws/` and `secrets/` directories, `secrets.*`, `kubeconfig`,
  `.kube/config`, `.docker/config.json` and similar) are never indexed or read by discovery, are
  never part of a packet, and secret-shaped values are redacted from excerpts and evidence.
- **Hostile repository files cannot hang or exhaust the CLI.** Every repository read, including
  the skills scan, uses one non-blocking handle that accepts only a regular file under a size cap;
  a FIFO, a device symlink or an oversized file is skipped with a warning. Instruction files are
  only `stat`-ed by the scan.
- **A generated skill is evaluated before use.** Pattern-based checks flag common unsafe commands,
  prompt-injection phrases, secret reads and sandbox weakening; they are heuristic, not a
  guarantee. The evaluated bundle is pinned by digest, so an edit after evaluation is refused.
- **Agent-written regular expressions are bounded.** They run in a worker thread under a total time
  budget and are terminated on timeout.
- **No automatic installation, no package runner.** Nothing is installed or saved unless you run
  `dynamic-skills init` or `save`, which the harness asks you to approve. The bootstrap skill runs
  the bare `dynamic-skills` command and never a package runner, which could fetch and run an
  unrelated registry package of the same name without a prompt (Ruling R19); when the command is
  missing, the agent stops and asks the user to install it.
- **Where Dynamic Skills writes.** A session writes inside its session directory. Session artifact
  paths are lexically confined to it; agent-written bundle trees and performance reports are walked
  or read without following symlinks; repository reads resolve real paths and re-check the secret
  and excluded rules. Three other writes exist, each planned and reported through the SDK
  (`applyPlan` for `init`, `placeBundle` for `save` and native placement) before it happens,
  idempotent, atomic (a temp file or directory, then `rename`), refusing a symlink at the final path
  and never overwriting a file it did not plan:
  - **`init`** writes the bootstrap skill, an analyst agent and the harness's permission and
    consent rules, only to the paths its plan lists (`--dry-run` writes nothing). It merges into
    your settings and keeps every other key, comment and file mode; it writes nothing for any
    harness when one has a conflict, and `--force` replaces only installer files, never config.
  - **`save`** copies the evaluated bundle to the skill roots its plan lists, only after the
    harness asks you (the consent rules below), and refuses a name already in use, a machine path
    in a committed skill, and a project path that leaves the repository.
  - **Native placement** (Claude Code, opt-in) writes only under `<realpath home>/native/`: the real
    path of the target's parent must lie inside the realpath session home, and a pre-check
    restricts it to `native/`. The placement is swept after 24 hours, when no session references
    it, or when its sessions ended without activating; never within 10 minutes of being placed.

  Ephemeral skills never reach a permanent skill directory. Project files must stay inside the
  realpath of the project root; symlinked parents are followed only for personal files. The
  residual windows (a parent swapped between the executor's last check and the `rename`, by someone
  with write access to that directory) are listed in
  [architecture.md](docs/architecture.md#trust-boundaries). The CLI is still not a privilege
  boundary.

- **Consent rules.** `init` makes the harness ask before `dynamic-skills save` and
  `dynamic-skills init`, even where `dynamic-skills` is otherwise allowed: Claude Code
  `permissions.ask` (ask beats allow), a Codex `prefix_rule` with `decision = "prompt"` (the
  strictest wins) and OpenCode `"ask"` entries (the last match wins; project scope writes only the asks, with no broad
  allow). The CLI
  rejects any option placed before the subcommand so `dynamic-skills -V save` cannot slip past
  them. **Limit:** OpenCode matches the raw command text, so a quoted or extra-spaced subcommand
  (`dynamic-skills 'save' ...`) is not asked; the ask rules are a prompt for ordinary calls, not an
  enforcement boundary. A headless run cannot answer a prompt, so a save there is a terminal run
  of `dynamic-skills save` or a relaxed rule, as each [harness guide](docs/harnesses/claude-code.md)
  describes.
- **The Codex allow rule lets most `dynamic-skills` commands run unsandboxed.** With
  `--codex-allow-rule`, every `dynamic-skills` command except `save` and `init` runs outside the
  Codex sandbox without a prompt, trusting whatever `dynamic-skills` resolves to on `PATH`. `save`
  and `init` keep their prompt rules; an approved prompt runs with the session's current permissions
  (sandboxed unless the session itself is not), so the allow rule gives them no sandbox escape.
  Whether `save` from inside Codex needs an escalation or a terminal run is pending live
  verification (R32). The rule is off by default.
- **The session home is private.** The default home is per user,
  `<os tmpdir>/dynamic-skills-<uid>`. Before writing, the CLI refuses a home (or its `sessions/`)
  that is a symlink (including a trailing-slash spelling), not a directory, or owned by another
  uid (`HOME_UNSAFE`). It creates a missing home 0700 and removes group and other permission bits
  from `sessions/` and below, but never changes the mode of a home that already exists, so a
  `DYNAMIC_SKILLS_HOME` pointing at a directory such as `$HOME` is not tightened; session
  directories are 0700 and files 0600. With `DYNAMIC_SKILLS_HOME=$HOME`, an existing user-owned
  `~/sessions` or `~/reports` is still tightened to 0700, so use a dedicated directory. On a shared temp
  directory another user therefore cannot pre-create, redirect or read the session data.
  `DYNAMIC_SKILLS_HOME` can still point the home at a private directory of your choice.
- **Cleanup is safe and bounded.** A relative or empty `DYNAMIC_SKILLS_HOME` counts as unset (R42).
  The native sweep removes only direct children of each adapter's native layout, and only when the
  marker `<realpath home>/native/.dynamic-skills-native` exists. Without the marker nothing
  is swept. `clean` and `save --scope discard` never fail on unreadable artifacts; `clean` removes a
  session with an unreadable `session.json` with a note, archiving nothing and removing no native
  placement. Both keep a placement within the R39 grace, including the session's own, and the next
  sweep removes it. `save --scope discard` and `--scope ephemeral` accept `--dry-run` and change
  nothing (R45). Internal errors carry a fixed message, never exception text.
- **OpenCode project scope asks, never allows broadly.** Project-scope `init` writes only the
  `save` and `init` ask entries (no broad allow); its consent notes simulate the layered config,
  including agent-level permissions (R44).
- **No network or model calls** are made by any package.
- Terminal output is stripped of control characters, because session ids and options are
  agent-controlled.

## Known limitations

- Session artifact writes (`writeSessionFile`) refuse symlinked components and re-check the
  parent's real path, but a small window remains between that re-check and the `rename`.
  `session.json` is written through the same `writeSessionFile`; the `skills/` and `evals/`
  directories are created without that check. All of these need write access to the 0700 session
  directory, so only the same user can exploit them. See the residual windows in
  [architecture.md](docs/architecture.md#trust-boundaries).
- `applyPlan` (project-scope `init`) opens and renames through the unresolved parent after its
  second containment check, so a parent swapped for a symlink in that window redirects the write.
  It needs write access to the repository's directories. See
  [architecture.md](docs/architecture.md#trust-boundaries).
- Codex prefix rules match plain-word commands only. Codex splits pipes and `&&`, `||` and `;`
  chains of plain words and checks each part, so those are not bypasses. A redirection (including a
  heredoc), `$(...)` or backticks, a `$VAR`, a `VAR=` prefix, a glob, or control flow and subshells
  skip the rules. Such a command is then not matched, so a `prompt` or `forbidden` rule does not
  fire for it. Under `workspace-write` it still runs inside the sandbox; only `danger-full-access`
  leaves it fully exposed. The bootstrap skill tells agents to run `dynamic-skills` commands bare
  (R43).
- Directories under a project or personal skill root are not 0700: `placeBundle` in save mode
  chmods bundle directories to 0755 and creates parents 0755 subject to the umask. Only the session
  home is 0700.
- Owner and permission checks need uids. On a platform without them (Windows) the home is
  checked only for being a real directory; use a private `DYNAMIC_SKILLS_HOME` there.
- Reuse and activation content is returned unfenced, so a hostile existing skill reaches the agent
  as written.
- The security evals are heuristic and check form and grounding, not intent. Review a generated
  skill before relying on it for anything sensitive.
- The CLI is not a privilege boundary: the agent runs as the same user and can do anything that
  user can.
