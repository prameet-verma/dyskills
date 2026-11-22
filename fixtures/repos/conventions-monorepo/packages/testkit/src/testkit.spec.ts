import { describe, expect, it } from "vitest";
import { err, ok } from "@acme/result";
import { log } from "@acme/log";
import { outbox } from "@acme/outbox";
import { captureLogs, createTestDb, drainOutbox, expectErr, expectOk, fakeClock } from "./index";

describe("testkit", () => {
  it("unwraps results", () => {
    expect(expectOk(ok(1))).toBe(1);
    expect(expectErr(err({ kind: "Nope", message: "m" }), "Nope").message).toBe("m");
    expect(() => expectOk(err({ kind: "Nope" }))).toThrow();
  });

  it("controls time, logs and the outbox", async () => {
    const clock = fakeClock();
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.000Z");
    const logs = captureLogs();
    log.info("demo.seen");
    logs.restore();
    expect(logs.records).toHaveLength(1);
    const { db } = createTestDb();
    await db.transaction(async (tx) =>
      outbox.enqueue(tx, { topic: "demo.v1.happened", payload: {}, idempotencyKey: "k" }),
    );
    expect(await drainOutbox(db)).toHaveLength(1);
    expect(await drainOutbox(db)).toHaveLength(0);
  });
});
