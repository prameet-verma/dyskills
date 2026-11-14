# @dynamic-skills/bootstrapper

Finds skills that already exist for a project and its user, and decides whether a task is
a task has candidate skills, and validates the agent's Skill Sufficiency Assessment.

## API

- **`scanExistingSkills({ repo, home? })`** (`scan.ts`): reads `<dir>/<name>/SKILL.md` from the
  the three project-level and three personal skill directories from the PRD §11.3 table (see
  `ROOTS` in `src/scan.ts`). Returns
  `{ skills, instructionFiles, warnings }`. Skills whose frontmatter is missing, broken or
  lacks a string `name` and `description` are skipped with a warning; the same name and body
  found twice is kept once (project before personal). `instructionFiles` lists `AGENTS.md`
  and `CLAUDE.md` at the repo root when present. `home` defaults to `os.homedir()`.
- **`assessCoverage(task, skills, { explicit, mode })`** (`coverage.ts`): scores each skill by
  the share of task tokens found in its name and description and returns a
  `CoverageAssessment` (`recommendation`, up to 3 `candidates`, `reason`). Candidates are
  hints only; they never decide reuse. `manual` mode without an explicit request gives `none`;
  everything else gives `discover`. The bootstrap skill is never a candidate.
- **`validateSufficiency(assessment, { skills, instructionFiles, mode, explicit })`**
  (`sufficiency.ts`): checks the agent's sufficiency verdict (PRD §5.5) and returns every
  `{ path, message }` issue (empty means valid): base skill must be a scanned skill (name and
  path) with a valid Agent Skills name and not the bootstrap skill; base instruction file must be
  scanned (repo-relative); an explicit request allows only `partial` or `insufficient`; manual
  mode requires an explicit request.
- **`requiresApproval(outcome, mode, explicit)`** (`sufficiency.ts`): true only in `suggest`
  mode without an explicit request for a non-`sufficient` outcome.

## Example

```ts
import { assessCoverage, scanExistingSkills } from "@dynamic-skills/bootstrapper";

const { skills, warnings } = await scanExistingSkills({ repo });
const coverage = assessCoverage(task, skills, { explicit: false, mode: "auto" });
```

## PRD sections implemented

§5.4 (invocation modes), §5.5 (skill sufficiency assessment), §11.3 (skill directories), §12.2 (existing skill checks).
