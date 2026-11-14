# @dynamic-skills/bootstrapper

Finds skills that already exist for a project and its user, and decides whether a task is
already covered by one of them or needs a new skill.

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
  `CoverageAssessment` (`recommendation`, up to 3 `candidates`, `reason`). Rules in order:
  explicit request gives `synthesize`; `manual` mode gives `none`; a top score of 0.5 or more
  gives `reuse`; `suggest` mode gives `suggest-synthesis`; otherwise `synthesize`. The
  bootstrap skill is never a candidate.

## Example

```ts
import { assessCoverage, scanExistingSkills } from "@dynamic-skills/bootstrapper";

const { skills, warnings } = await scanExistingSkills({ repo });
const coverage = assessCoverage(task, skills, { explicit: false, mode: "auto" });
```

## PRD sections implemented

§5.2 (existing skill coverage), §11.3 (skill directories), §12.2 (existing skill checks).
