import type { Result } from "@acme/result";
import { createDb, type Clock, type Db } from "@acme/db";
import type { BusEvent, Publisher } from "@acme/events";
import { ok } from "@acme/result";
import { createOutboxRelay } from "@acme/outbox";
import { setLogSink, type LogRecord } from "@acme/log";

export type FakeClock = Clock & { advance(ms: number): void };

/** A controllable clock; starts at 2026-01-01T00:00:00.000Z unless given a start. */
export function fakeClock(start = "2026-01-01T00:00:00.000Z"): FakeClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
  };
}

/** A fresh in-memory database wired to a fake clock. */
export function createTestDb(): { db: Db; clock: FakeClock } {
  const clock = fakeClock();
  return { db: createDb({ clock }), clock };
}

/** Capture structured log records until `restore()` is called. */
export function captureLogs(): { records: LogRecord[]; restore(): void } {
  const records: LogRecord[] = [];
  const restore = setLogSink((record) => records.push(record));
  return { records, restore };
}

/** Unwrap an ok Result or fail the test. */
export function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  return result.value;
}

/** Assert an err Result of the given kind and return the error for further assertions. */
export function expectErr<T, K extends string>(
  result: Result<T, { kind: string }>,
  kind: K,
): { kind: K; message: string } & Record<string, unknown> {
  if (result.ok) throw new Error(`expected error ${kind}, got ok`);
  if (result.error.kind !== kind)
    throw new Error(`expected error ${kind}, got ${result.error.kind}`);
  return result.error as never;
}

/** Drain the outbox into a recording publisher and return what was delivered. */
export async function drainOutbox(db: Db): Promise<BusEvent[]> {
  const delivered: BusEvent[] = [];
  const publisher: Publisher = {
    async publish(event) {
      delivered.push(event);
      return ok(undefined);
    },
  };
  await createOutboxRelay(db).drain(publisher);
  return delivered;
}
