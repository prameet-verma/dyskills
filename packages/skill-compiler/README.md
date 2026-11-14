# @dynamic-skills/skill-compiler

Expertise Compiler support: builds the brief that asks the agent to write a skill (or an
augmentation of a partially sufficient base skill) and parses what the agent wrote. No LLM is
called here. Implements PRD §5.5 (augmentation), §7 (untrusted evidence fence) and §8-8.2
(compiler input and generated bundle).

## API

- `buildCompilationBrief(input)`: returns the brief text. Repository- and agent-derived strings
  are sanitised and rendered inside one `<repository-evidence trust="untrusted">` fence. Only
  `verified` evidence is an observed fact; `inferred` evidence is listed as inference. Augmentation
  mode (`augmentation` non-null, verdict `partial`) adds a read-only `<base-skill>` block and
  requires `metadata.augments` / `metadata.augments-sha256`. Throws `invalid base skill name:
<name>` for a non-kebab-case base name.
- `augmentationName(baseName)`: `<base>-augment`, shortened to stay within 64 characters.
- `parseSkillBundle(skillsRoot)`: parses the single skill directory into a `GeneratedSkill`
  (references, token estimate, `augments`); throws `BundleError` otherwise.
- `loadSmokeEval(path)`: validated `SmokeEval`, `null` if the file is absent.
- Constants `REQUIRED_SECTIONS`, `PROJECT_CONTEXT_SECTION`, `AUGMENTATION_*`, `MAX_BASE_SKILL_CHARS`
  and the citation patterns `CITATION_PATTERN`, `INFERENCE_PATTERN`, `ASSUMPTION_PATTERN`.

## Example

```ts
import { buildCompilationBrief, parseSkillBundle } from "@dynamic-skills/skill-compiler";

const brief = buildCompilationBrief({
  state,
  evidence,
  gaps,
  assumptions,
  analysis,
  existingSkills,
  augmentation: null,
  sessionDir,
  remainingMs,
});
const skill = await parseSkillBundle(`${sessionDir}/skills`);
```
