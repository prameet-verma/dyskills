# Conventions

Every package follows these. `packages/inventory` is the reference implementation.

1. **Result, not exceptions.** Domain code returns `Result<T, E>` from `@acme/result`
   (`ok`, `err`, `isOk`, `map`, `andThen`) and never throws across a package boundary.
   See `adr/0003-no-exceptions.md`.
2. **Tagged errors.** Define errors with `defineError(kind)` from `@acme/errors`:
   plain `{ kind, message, ...details }` objects. No `Error` subclasses.
3. **Transactions.** Anything that changes state runs in `db.transaction(async (tx) => ...)`
   from `@acme/db`. It commits when the callback returns an ok `Result` and rolls back on an
   `err` or a throw. Read and write through `tx`, not `db`, inside the callback.
4. **Optimistic concurrency.** Update a row only with
   `tx.updateWhereVersion(table, id, expectedVersion, patch)`; it returns a `VersionConflict`
   error value when the stored version differs. `tx.update` is last-write-wins and is for tests
   and migrations only.
5. **Events go through the outbox.** Never publish directly. Call
   `outbox.enqueue(tx, { topic, payload, idempotencyKey })` inside the same transaction as the
   state change; the relay (`outboxRelay.drain(bus)`) delivers at least once.
6. **Topic names** are versioned and dotted: `orders.v1.updated`. Subscribing to a name that
   does not match throws.
7. **Idempotency keys** are deterministic and unique per distinct event:
   `<event>:<entity id>:<new version>`. Consumers wrap handlers in `idempotentHandler(store, fn)`.
8. **Ids** come from `newId("ord")` in `@acme/ids` (prefixed: `ord_...`).
9. **Logging** is `log.info(event, fields)` from `@acme/log`, with events named
   `<package>.<snake_case>`. `console.*` is not used.
10. **Tests** live next to the source as `*.spec.ts` (never `*.test.ts`) and use `@acme/testkit`:
    `createTestDb()`, `fakeClock()`, `captureLogs()`, `expectOk` / `expectErr(result, kind)`
    and `drainOutbox(db)`.
