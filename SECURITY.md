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
- **No automatic installation, no package runner.** Nothing is installed into any agent or skill
  directory. The bootstrap skill runs the bare `dynamic-skills` command and never a package runner,
  which could fetch and run an unrelated registry package of the same name without a prompt
  (Ruling R19); when the command is missing, the agent stops and asks the user to install it.
- **Writes stay in the session directory in Phase 1.** Session artifact paths are lexically
  confined to the session directory; agent-written bundle trees and performance reports are
  walked or read without following symlinks; repository reads resolve real paths and re-check the
  secret and excluded rules.
- **The session home is private.** The default home is per user,
  `<os tmpdir>/dynamic-skills-<uid>`. Before writing, the CLI refuses a home (or its `sessions/`)
  that is a symlink (including a trailing-slash spelling), not a directory, or owned by another
  uid (`HOME_UNSAFE`). It creates a missing home 0700 and removes group and other permission bits
  from `sessions/` and below, but never changes the mode of a home that already exists, so a
  `DYNAMIC_SKILLS_HOME` pointing at a directory such as `$HOME` is not tightened; session
  directories are 0700 and files 0600. On a shared temp
  directory another user therefore cannot pre-create, redirect or read the session data.
  `DYNAMIC_SKILLS_HOME` can still point the home at a private directory of your choice.
- **No network or model calls** are made by any package.
- Terminal output is stripped of control characters, because session ids and options are
  agent-controlled.

## Known limitations

- A symlinked session directory or subdirectory can redirect internal session writes. The CLI
  rejects a symlinked `sessions/<id>` at lookup, but internal artifact writes are not
  symlink-checked.
- Owner and permission checks need uids. On a platform without them (Windows) the home is
  checked only for being a real directory; use a private `DYNAMIC_SKILLS_HOME` there.
- Reuse and activation content is returned unfenced, so a hostile existing skill reaches the agent
  as written.
- The security evals are heuristic and check form and grounding, not intent. Review a generated
  skill before relying on it for anything sensitive.
- The CLI is not a privilege boundary: the agent runs as the same user and can do anything that
  user can.
