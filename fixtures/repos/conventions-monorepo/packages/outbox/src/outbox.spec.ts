import { describe, expect, it } from "vitest";
import { err, ok } from "@acme/result";
import { createDb } from "@acme/db";
import { DeliveryFailed, type BusEvent, type Publisher } from "@acme/events";
import { OUTBOX_TABLE, createOutboxRelay, outbox, type OutboxMessage } from "./index";

const event: BusEvent = { topic: "demo.v1.happened", payload: { n: 1 }, idempotencyKey: "k1" };

describe("outbox", () => {
  it("is written inside the transaction, so a rollback drops it", async () => {
    const db = createDb();
    await db.transaction(async (tx) => {
      await outbox.enqueue(tx, event);
      return err("rolled back");
    });
    expect(await db.list(OUTBOX_TABLE)).toEqual([]);
  });

  it("rejects a bad topic and ignores a repeated key", async () => {
    const db = createDb();
    const bad = await db.transaction(async (tx) => outbox.enqueue(tx, { ...event, topic: "nope" }));
    expect(bad.ok).toBe(false);
    await db.transaction(async (tx) => outbox.enqueue(tx, event));
    await db.transaction(async (tx) => outbox.enqueue(tx, event));
    expect(await db.list(OUTBOX_TABLE)).toHaveLength(1);
  });

  it("delivers at least once, marking delivery only after success", async () => {
    const db = createDb();
    await db.transaction(async (tx) => outbox.enqueue(tx, event));
    const seen: BusEvent[] = [];
    let fail = true;
    const publisher: Publisher = {
      async publish(e) {
        seen.push(e);
        return fail ? err(DeliveryFailed("down", { topic: e.topic })) : ok(undefined);
      },
    };
    const relay = createOutboxRelay(db);
    expect(await relay.drain(publisher)).toEqual({ delivered: 0, failed: 1 });
    fail = false;
    expect(await relay.drain(publisher)).toEqual({ delivered: 1, failed: 0 });
    expect(await relay.drain(publisher)).toEqual({ delivered: 0, failed: 0 });
    expect(seen.map((e) => e.idempotencyKey)).toEqual(["k1", "k1"]);
    const [row] = await db.list<OutboxMessage>(OUTBOX_TABLE);
    expect(row?.deliveredAt).not.toBeNull();
  });
});
