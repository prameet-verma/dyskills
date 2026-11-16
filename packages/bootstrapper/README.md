# @dynamic-skills/bootstrapper

Finds skills that already exist for a project and its user, ranks them as candidate hints for a
task (with invocation-mode gating), and validates the agent's Skill Sufficiency Assessment.

## API

- **`resolveSkillRoots({ repo, home, vars?, etcDir? })`** and **`findProjectRoot(start)`**
  (`roots.ts`, the only bootstrapper file that names harness directories; PRD §11.3): the single
  registry of skill directories. `findProjectRoot` returns the nearest ancestor (at most 32
  levels, inclusive) holding a `.git` entry, else `start`. `vars` replaces `process.env` (path values such as
  `CLAUDE_CONFIG_DIR` count only when absolute); `etcDir` defaults to `/etc`. Roots in dedupe-priority order, merged
  when the directory repeats (`readBy` union, first owner kept):

  | Scope                                                | Directory                                                                                | Owner       | Read by                                                |
  | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
  | project, every level from `repo` to the project root | `.claude/skills`                                                                         | claude-code | claude-code, opencode                                  |
  | same                                                 | `.agents/skills`                                                                         | codex       | codex, opencode                                        |
  | same                                                 | `.opencode/skills`, `.opencode/skill`                                                    | opencode    | opencode                                               |
  | project root only                                    | `.codex/skills`                                                                          | codex       | codex                                                  |
  | personal                                             | `${CLAUDE_CONFIG_DIR ?? ~/.claude}/skills`                                               | claude-code | claude-code (+ opencode when it is `~/.claude/skills`) |
  | personal, only when `CLAUDE_CONFIG_DIR` differs      | `~/.claude/skills`                                                                       | opencode    | opencode                                               |
  | personal                                             | `~/.agents/skills`                                                                       | codex       | codex, opencode                                        |
  | personal                                             | `${CODEX_HOME ?? ~/.codex}/skills`                                                       | codex       | codex                                                  |
  | personal (admin)                                     | `<etcDir>/codex/skills`                                                                  | codex       | codex                                                  |
  | personal                                             | `${OPENCODE_CONFIG_DIR ?? ${XDG_CONFIG_HOME ?? ~/.config}/opencode}/skills`, `.../skill` | opencode    | opencode                                               |

  A non-empty `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` removes opencode from every `.claude/skills`
  root, and a root left with no readers is omitted. The admin root is reported as `personal` so `ExistingSkill.scope` is unchanged.

- **`scanExistingSkills({ repo, home, vars?, etcDir? })`** (`scan.ts`): reads
  `<root>/<entry>/SKILL.md` for every resolved root. Returns
  `{ skills, instructionFiles, warnings }`. `name` is optional and defaults to the directory
  name; a missing or empty `description`, an empty `name`, or broken frontmatter is skipped with
  a warning; a leading BOM is ignored. One file reached through two roots (same `realpath`) is
  listed once, and the same name and body found twice is kept once (first root wins). Each
  `SKILL.md` is read through core's `readSafeFile` with `realBasename: "SKILL.md"`, so a FIFO, a
  device or a symlink to another file (for example `.env`) is skipped with a warning. A bare
  `name:` (null) falls back to the directory name, as Codex does. Known gap: only direct children
  are scanned, but Codex recurses to depth 6 and OpenCode 1.x globs nested `**/SKILL.md`;
  OpenCode 2.x recurses 6 levels and walks project roots up to `/`. Nested skills and roots above
  the git root are therefore invisible to the scan and to save-collision checks. A dotfiles
  `~/.git` makes personal roots report scope `project`, which matches what the harnesses do.
  `instructionFiles` lists `AGENTS.md`, `AGENTS.override.md` and
  `CLAUDE.md` at `repo` when they are regular files; they are only `stat`-ed, never opened.
- **`assessCoverage(task, skills, { explicit, mode })`** (`coverage.ts`): scores each skill by
  the share of task tokens found in its name and description and returns a
  `CoverageAssessment` (`recommendation`, up to 3 `candidates`, `reason`). Candidates are
  hints only; they never decide reuse. `manual` mode without an explicit request gives `none`;
  everything else gives `discover`. The bootstrap skill is never a candidate.
- **`validateSufficiency(assessment, { skills, instructionFiles, mode, explicit })`**
  (`sufficiency.ts`): checks the agent's sufficiency verdict (PRD §5.5) and returns every
  `{ path, message }` issue (empty means valid): base skill must be a scanned skill (name and
  path equal by exact string comparison, no resolving) with a valid Agent Skills name and not the bootstrap skill; base instruction file must be
  scanned (repo-relative); an explicit request allows only `partial` or `insufficient`; manual
  mode requires an explicit request.
- **`matchBaseSkill({ name, path }, skills)`** (`sufficiency.ts`): returns the scanned skill
  whose name and path both equal the verdict's by exact string comparison, or `null`. Callers
  persist the returned skill's `path`, never the verdict's string.
- **`requiresApproval(outcome, mode, explicit)`** (`sufficiency.ts`): true only in `suggest`
  mode without an explicit request for a non-`sufficient` outcome.

The skill that drives all of this from the host is `skills/dynamic-skill-bootstrap/SKILL.md` (repository root). `packages/bootstrapper/test/bootstrap-skill.test.ts` runs the project's own evaluators on it.

## Example

```ts
import { homedir } from "node:os";
import { assessCoverage, scanExistingSkills } from "@dynamic-skills/bootstrapper";

const { skills, warnings } = await scanExistingSkills({ repo, home: homedir(), vars: process.env });
const coverage = assessCoverage(task, skills, { explicit: false, mode: "auto" });
```

## PRD sections implemented

§5.4 (invocation modes), §5.5 (skill sufficiency assessment), §11.3 (skill directories), §12.2 (existing skill checks).
