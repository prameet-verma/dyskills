# @dynamic-skills/eval-engine

Deterministic evals that gate a generated skill before activation. No LLM is called. This
package currently holds the eval types and the structural evals; it implements PRD §5.5
(augmentation consistency), §9.1 (generation evals) and §9.5 (security rules).

## API

- `EvalContext`: everything an eval may read (task, generated skill, evidence, assumptions, gaps,
  existing skills, instruction texts, smoke eval, and `augmentation`, which is non-null exactly for
  a `partial` session).
- `GenerationEval`: `{ id, mandatory, run(ctx) }` returning `{ outcome, messages }`.
- `specEval` (mandatory): name and description limits, name equals its directory, non-empty body.
- `metadataEval` (mandatory): allowed frontmatter keys, `compatibility` length, string-only
  `metadata`, and augmentation consistency (the base name and sha256 match the assessed base, the
  base is unchanged, the augmentation is named `<base>-augment`; a new skill carries none of it).
- `referencesEval`: every bundle link resolves to an existing file inside the skill directory.
- `concisenessEval` (mandatory): 2,000 tokens passes, up to 5,000 warns, above fails; generic
  filler advice warns.
- `portabilityEval` (mandatory): scans SKILL.md and referenced files; fails on harness product names, harness-specific directories and
  instruction-file names, harness tool names, and slash commands. The exact patterns live next to
  the code in `src/evals/structural.ts`.
- `securityEval` (mandatory): fails on piping downloads into a shell, destructive deletes, unsafe
  flags, prompt-injection phrases, reading secrets, weakening the sandbox, global installs and
  MCP server installation; warns on force pushes. Referenced files inside the skill directory
  are scanned too (up to 400,000 bytes each). Cautionary or negated mentions fail on purpose,
  because negation is easy to evade: restrictions must be phrased without quoting the command.

## Example

```ts
import { specEval, securityEval, type EvalContext } from "@dynamic-skills/eval-engine";

declare const ctx: EvalContext;
const { outcome, messages } = await securityEval.run(ctx);
```
