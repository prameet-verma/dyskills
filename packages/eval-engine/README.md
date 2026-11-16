# @dynamic-skills/eval-engine

Deterministic evals that gate a generated skill before activation. No LLM is called. This
package holds the eval types, the structural and context evals, the parallel runner and the
behavioural smoke recorder; it implements PRD §5.5
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
  A tool-permission grant (`allowed-tools`) fails, because hosts disagree on what it does, and so
  does any `metadata` key containing `/` (a host-namespaced key).
- `referencesEval`: every bundle link resolves to an existing file inside the skill directory.
- `concisenessEval` (mandatory): 2,000 tokens passes, up to 5,000 warns, above fails; generic
  filler advice warns.
- `portabilityEval` (mandatory): scans SKILL.md and every other file in the skill directory
  (linked or not; at most 200 entries, six levels deep, 50,000 bytes per file, symlinks never
  followed); fails on harness product names, harness-specific directories and instruction-file
  names, harness tool names, and slash commands. It also fails on syntax a host renders or runs
  before the agent reads it: inline shell execution (a backtick span or fenced block opened with
  an exclamation mark), an arguments placeholder, a host environment placeholder, and a
  positional placeholder (`$1`) in prose, where an inline code span counts as prose. A positional
  placeholder inside a fenced code block only warns. Layout failures: a nested `SKILL.md`, any
  dot-prefixed entry, any other entry beside the bundle in its skills directory, and a bundle too
  large to scan. The exact patterns live next to the code in `src/evals/structural.ts`.
- `securityEval` (mandatory): fails on piping downloads into a shell, destructive deletes, unsafe
  flags, prompt-injection phrases, reading secrets, weakening the sandbox, global installs and
  MCP server installation; warns on force pushes. Every file inside the skill directory (linked
  or not)
  is scanned too (up to 50,000 bytes each; lines over 2,000 characters fail). Cautionary or
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
- `roleEval` (headings count in both `## X` and underlined setext form): five role sections for a new skill; task contract, project context and optional
  additions only, for an augmentation.
- `duplicationEval`: 8-word shingle containment against existing skills and instruction text;
  an augmentation is also checked base-side (0.3 fails, 0.15 warns).
- `behaviouralDefinitionEval` (mandatory): a smoke eval with prohibited behaviour and an
  assertion or rubric item exists.
- `ALL_EVALS`: the 14 generation evals in `EvalId` order (all but `behavioural`); the same set runs
  for new skills and augmentations.
- `runEvaluations(ctx, { evals?, concurrency?, signal? })`: runs evals with at most 6 in flight
  and returns an `EvaluationReport`. A throwing eval becomes `fail` ("eval crashed: ..."); a
  mandatory `not-applicable` becomes `fail` ("mandatory check cannot be skipped"). Overall is
  fail > warning > pass; `activatable` means no `fail`; `limitations` are warning messages and
  `revisionHints` are failure messages prefixed by eval id.
- `recordBehaviouralResult(smoke, output, verdict, notes?)`: async; resolves to the mandatory
  `behavioural` result. `contains` / `not-contains` scan the full output. Regex assertions run in
  one worker thread under a total budget of `ASSERTION_REGEX_BUDGET_MS` (1,000 ms); on timeout the
  worker is terminated and every not-yet-evaluated regex assertion fails ("regex evaluation timed
  out"). A worker crash or early exit is reported the same way, so a failure of the worker fails
  closed rather than passing. Output longer than `MAX_BEHAVIOURAL_OUTPUT_CHARS` (100,000) fails
  regex assertions without evaluating them. As a UX layer only, patterns longer than
  `MAX_ASSERTION_REGEX_CHARS` (200), quantified groups containing a quantifier (including `?`) or
  alternation, and invalid patterns are rejected up front. Values and notes in messages go through
  `sanitiseForMessage`. Failures are reported as failed assertions, never thrown.
- `sanitiseForMessage(value)`: collapses whitespace runs (newlines included) to one space and cuts
  the text to 200 characters with an ellipsis; use it for any untrusted text put in a message.
- `MAX_REPORT_ENTRIES` (50): the most `limitations` and `revisionHints` a report carries.
- Regex budget constants: `ASSERTION_REGEX_BUDGET_MS`, `MAX_ASSERTION_REGEX_CHARS` and
  `MAX_BEHAVIOURAL_OUTPUT_CHARS`.
- `isActivatable(report, behavioural)`: the report is activatable and the behavioural result is
  `pass` or `warning`.

## Example

```ts
import { specEval, securityEval, type EvalContext } from "@dynamic-skills/eval-engine";

declare const ctx: EvalContext;
const { outcome, messages } = await securityEval.run(ctx);
```
