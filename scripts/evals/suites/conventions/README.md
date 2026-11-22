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

The prompts never name the house libraries. Three layers score a run:

- `hidden/<task>/`: behavioural specs copied in after the agent finishes. They use only the public
  functions the prompt names and the house libraries' observable state (db rows, delivered outbox
  events), and tolerate any internal naming. They check behaviour, not style.
- `checks.sh <repo-dir> <task>`: deterministic static checks (`name<TAB>pass|fail`).
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

## Why there is no CLAUDE.md

Harnesses auto-load `CLAUDE.md`, `AGENTS.md` and `.cursorrules`. If the fixture shipped one, every
condition would be grounded for free and the suite could not show what Dynamic Skills adds. The
conventions are written down only in `docs/` and in `packages/inventory`, so an agent has to
read the repository to find them.

## Files

`fixture`, `prepare.sh <template-dir>` (installs the workspace), `tasks/`, `rubrics/`, `checks.sh`,
`hidden/`.
