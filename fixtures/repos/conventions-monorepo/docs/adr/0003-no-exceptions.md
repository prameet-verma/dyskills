# ADR 0003: Result values instead of exceptions

Status: accepted

## Context

Exceptions are invisible in signatures. Callers forgot to catch them, one failure mode turned
into several (a thrown `Error` here, a `null` there), and a throw inside a transaction made it hard
to tell what had been committed.

## Decision

Functions that can fail for domain reasons return `Result<T, E>` (`@acme/result`). The error is a
tagged object built with `defineError` (`@acme/errors`), so callers narrow on `error.kind`. Domain
code does not throw across a package boundary. A transaction rolls back when its callback returns
an `err`, so returning the error is the normal way to abort.

Throwing is reserved for programmer mistakes caught at wiring time (for example subscribing to a
malformed topic name).

## Migration

Code written before this decision (`packages/orders` today) still throws `Error` subclasses,
publishes straight to the bus and writes without version checks. It is being migrated package by
package. New and changed code must follow `docs/conventions.md`; do not extend the old style.

## Consequences

Every failure path is visible in the type and covered by a test using `expectErr`. Callers write a
little more code to propagate errors; `map` and `andThen` keep that short.
