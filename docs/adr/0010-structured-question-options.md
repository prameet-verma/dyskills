# 0010. Optional structured question options

## Status

Accepted.

## Context

Native question tools take options (Claude Code `AskUserQuestion`, Codex `request_user_input`,
OpenCode `question`) but are absent in headless runs and, on Codex, outside Plan mode. Their
limits differ: 1-4 questions with 2-4 options, 1-3 questions with 2-3 options, and no documented
cap (synthesis matrix row 4; decision D4; risk 4).

## Decision

- `Question.options` (2-4 items of `{ label, description }`) and `Question.multiSelect` are
  optional. A question without options is always asked as text. `CONTRACT_VERSION` stays `"1"`
  because the change is additive; `schemas/` is regenerated and every Phase 1 document still
  validates.
- Each adapter's `questions()` is pure and returns a `NativeQuestionPlan`: native `calls`, the ids
  to ask as `textOnly` and an `idMap` from native ids back to question ids. A question the tool
  cannot carry (too many options, `multiSelect` on a single-select tool) goes to text; no option
  is dropped or truncated.
- `clarify ask` returns the plan only when the harness is known (`--harness`, or
  `DYNAMIC_SKILLS_HARNESS`); otherwise every question is text.
- Placeholders (D7): in generated skills `$ARGUMENTS` and `${CLAUDE_*}` always fail portability,
  and a positional `$N` fails in prose and only warns inside fenced code blocks. A generated
  skill carrying `allowed-tools` fails the metadata eval.

## Consequences

- Text remains first-class; tests cover the mapping with fixtures, not live tools.
- Free-text answers are always accepted, so an option list never narrows the user.
- Older agents that ignore `options` keep working.
