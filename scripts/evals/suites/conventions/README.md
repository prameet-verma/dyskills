# conventions suite

Does repository grounding help a coding agent? The target is `fixtures/repos/conventions-monorepo`,
a small pnpm/TypeScript monorepo with house conventions a strong model cannot guess from general
knowledge but can learn by reading the code and `docs/`. An earlier eval on a two-function stub
repository found no gain because there was nothing project-specific to learn
(`docs/superpowers/research/2026-11-21-bootstrap-effectiveness-eval.md`).

## What it measures

Three plain-language product requests against `packages/orders`, run with and without grounding:

| Task | Request                                                                               | Kind       |
| ---- | ------------------------------------------------------------------------------------- | ---------- |
| `g1` | make `updateOrder` safe under concurrent writers and publish an update event reliably | specialist |
| `g2` | add `cancelOrder` (pending only, publishes an event)                                  | mid        |
| `g3` | add `listOrdersByStatus`                                                              | routine    |

`packages/orders` is deliberately legacy code written before ADR 0003: it throws `Error`
subclasses, publishes events directly, has no logging, uses `*.test.ts` and writes without version
checks. `docs/conventions.md` says new or changed code must follow the conventions and that `orders`
is being migrated; `packages/inventory` is the one complete reference. So the test is whether the
agent follows the documented conventions or copies the local legacy style. A solution that works
but ignores the conventions passes the hidden specs and fails the checks.

The prompts never name the house libraries. Three layers score a run:

- `hidden/<task>/`: behavioural specs copied in after the agent finishes. They use only the public
  functions the prompt names and observable state (db rows, events seen on the context's publisher
  or drained from the outbox, counted the same either way), and tolerate any internal naming. g1
  also injects faults (publisher failure or throw, a failing database transaction) and requires
  state and announcements to stay consistent. They check behaviour, not style.
- `checks.sh <repo-dir> <task>`: deterministic static checks (`name<TAB>pass|fail`). They grade only
  the files the agent changed or added (`git diff --name-only HEAD` plus untracked files; the run
  repo needs a baseline commit) and fail everything if the task function was not written, so doing
  nothing scores 0.
- `rubrics/<task>.txt`: the task text plus true/false items for a blind grader.

## The conventions

1. Result values (`@acme/result`), no throwing across package boundaries.
2. Tagged errors from `defineError` (`@acme/errors`), never classes.
3. State changes in `db.transaction` (`@acme/db`); an `err` or a throw rolls back.
4. Optimistic concurrency only via `tx.updateWhereVersion`.
5. Events via `outbox.enqueue(tx, ...)` in the same transaction; relay delivers at least once.
6. Versioned dotted topics, for example `orders.v1.updated`.
7. Deterministic idempotency keys unique per event (`<event>:<id>:<version>`) and
   `idempotentHandler` for consumers.
8. Ids from `newId("ord")` (`@acme/ids`).
9. `log.info(event, fields)` (`@acme/log`), never `console.*`.
10. `*.spec.ts` next to the source, using `@acme/testkit`.
11. Time from `tx.now()`, never `new Date()` (listed with the others in `docs/conventions.md`).

## Why there is no CLAUDE.md

Harnesses auto-load `CLAUDE.md`, `AGENTS.md` and `.cursorrules`. If the fixture shipped one, every
condition would be grounded for free and the suite could not show what Dynamic Skills adds. The
conventions are written down only in `docs/` and in `packages/inventory`, so an agent has to
read the repository to find them.

## Files

`fixture`, `prepare.sh <template-dir>` (frozen-lockfile install of the workspace), `tasks/`, `rubrics/`, `checks.sh`,
`hidden/`.
