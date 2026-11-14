# @dynamic-skills/eval-engine

Deterministic evals that gate a generated skill before activation. No LLM is called. This
package holds the eval types, the structural evals and the context evals; it implements PRD §5.5
(augmentation consistency), §6.6 (evidence classification), §9.1 (generation evals) and §9.5
(security rules).

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
- `portabilityEval` (mandatory): scans SKILL.md and referenced files; fails on harness product
  names, harness-specific directories and instruction-file names, harness tool names, and slash
  commands. The exact patterns live next to the code in `src/evals/structural.ts`.
- `securityEval` (mandatory): fails on piping downloads into a shell, destructive deletes, unsafe
  flags, prompt-injection phrases, reading secrets, weakening the sandbox, global installs and
  MCP server installation; warns on force pushes. Referenced files inside the skill directory
  are scanned too (up to 50,000 bytes each; lines over 2,000 characters fail). Cautionary or
  negated mentions fail on purpose, because negation is easy to evade: restrictions must be
  phrased without quoting the command.
- `groundingEval` (mandatory): every `[evidence:]`/`[inferred:]` key exists and is not conflicting,
  every `[assumption:]` id is a recorded assumption, every bullet of every `## Project context`
  section is cited, and malformed citations fail. A citation names exactly one key
  (`[evidence: key]`: no commas or whitespace in the key, at most 8 spaces of padding, key up to
  200 characters); the grammar is shared with `@dynamic-skills/skill-compiler`.
- `evidenceClassificationEval` (mandatory): `[evidence:]` on an inferred or assumed key fails;
  `[inferred:]` on a verified key warns.
- `assumptionsEval`: a version in the body must equal or be a dotted prefix of a version in
  non-conflicting evidence or an assumption; known frameworks need exact `framework.<name>`
  evidence (warning).
- `completenessEval`: each answerable gap category is cited (warning); user evidence must be
  cited (fail).
- `scopeEval`: the description shares a content word with the task.
- `roleEval`: five role sections for a new skill; task contract, project context and optional
  additions only, for an augmentation.
- `duplicationEval`: 8-word shingle containment against existing skills and instruction text;
  an augmentation is also checked base-side (0.3 fails, 0.15 warns).
- `behaviouralDefinitionEval` (mandatory): a smoke eval with prohibited behaviour and an
  assertion or rubric item exists.

## Example

```ts
import { specEval, securityEval, type EvalContext } from "@dynamic-skills/eval-engine";

declare const ctx: EvalContext;
const { outcome, messages } = await securityEval.run(ctx);
```
