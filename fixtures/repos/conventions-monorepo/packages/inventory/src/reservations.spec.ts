import { describe, expect, it } from "vitest";
import { err, ok } from "@acme/result";
import { createBus, DeliveryFailed, type BusEvent } from "@acme/events";
import { createOutboxRelay } from "@acme/outbox";
import { captureLogs, createTestDb, drainOutbox, expectErr, expectOk } from "@acme/testkit";
import {
  addStock,
  availableStock,
  releaseStock,
  reserveStock,
  subscribeReservationAudit,
} from "./index";

async function setup(onHand = 10) {
  const { db } = createTestDb();
  const ctx = { db };
  expectOk(await addStock(ctx, "sku-1", onHand));
  await drainOutbox(db);
  return ctx;
}

describe("reserveStock", () => {
  it("reserves, bumps the version and queues exactly one versioned event", async () => {
    const ctx = await setup();
    const item = expectOk(await reserveStock(ctx, { sku: "sku-1", quantity: 3 }));
    expect(item).toMatchObject({ reserved: 3, version: 2 });
    expect(expectOk(await availableStock(ctx, "sku-1"))).toBe(7);
    const events = await drainOutbox(ctx.db);
    expect(events).toEqual([
      {
        topic: "inventory.v1.reserved",
        payload: { sku: "sku-1", quantity: 3, version: 2 },
        idempotencyKey: "stock-reserved:sku-1:2",
      },
    ]);
  });

  it("returns an error Result, queues nothing, and changes nothing when stock is short", async () => {
    const ctx = await setup(2);
    const e = expectErr(
      await reserveStock(ctx, { sku: "sku-1", quantity: 5 }),
      "InsufficientStock",
    );
    expect(e).toMatchObject({ requested: 5, available: 2 });
    expect(await drainOutbox(ctx.db)).toEqual([]);
    expect(expectOk(await availableStock(ctx, "sku-1"))).toBe(2);
  });

  it("returns tagged errors for unknown skus and bad quantities, never throws", async () => {
    const ctx = await setup();
    expectErr(await reserveStock(ctx, { sku: "nope", quantity: 1 }), "UnknownSku");
    expectErr(await reserveStock(ctx, { sku: "sku-1", quantity: 0 }), "InvalidQuantity");
  });

  it("serialises concurrent reservations without losing an update", async () => {
    const ctx = await setup(10);
    const results = await Promise.all([
      reserveStock(ctx, { sku: "sku-1", quantity: 4 }),
      reserveStock(ctx, { sku: "sku-1", quantity: 4 }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(expectOk(await availableStock(ctx, "sku-1"))).toBe(2);
    expect(await drainOutbox(ctx.db)).toHaveLength(2);
  });

  it("logs a structured event", async () => {
    const ctx = await setup();
    const logs = captureLogs();
    await reserveStock(ctx, { sku: "sku-1", quantity: 1 });
    logs.restore();
    expect(logs.records.map((r) => r.event)).toContain("inventory.stock_reserved");
  });
});

describe("releaseStock", () => {
  it("returns reserved units and queues a released event", async () => {
    const ctx = await setup();
    await reserveStock(ctx, { sku: "sku-1", quantity: 3 });
    await drainOutbox(ctx.db);
    expect(expectOk(await releaseStock(ctx, { sku: "sku-1", quantity: 2 })).reserved).toBe(1);
    const events = await drainOutbox(ctx.db);
    expect(events.map((e) => e.topic)).toEqual(["inventory.v1.released"]);
  });
});

describe("subscribeReservationAudit", () => {
  it("audits a redelivered event once", async () => {
    const ctx = await setup();
    const bus = createBus();
    subscribeReservationAudit(bus);
    await reserveStock(ctx, { sku: "sku-1", quantity: 1 });
    const logs = captureLogs();
    let failFirst = true;
    const flaky = {
      async publish(event: BusEvent) {
        const outcome = await bus.publish(event);
        if (failFirst) {
          failFirst = false;
          return err(DeliveryFailed("ack lost", { topic: event.topic }));
        }
        return outcome.ok ? ok(undefined) : outcome;
      },
    };
    const relay = createOutboxRelay(ctx.db);
    await relay.drain(flaky);
    await relay.drain(flaky);
    logs.restore();
    expect(logs.records.filter((r) => r.event === "inventory.reservation_audited")).toHaveLength(1);
  });
});
