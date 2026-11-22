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
  const { db, clock } = createTestDb();
  const ctx = { db };
  const stock = expectOk(await addStock(ctx, "sku-1", onHand));
  return { ctx, clock, version: stock.version };
}

describe("reserveStock", () => {
  it("reserves against the version the caller saw and queues one versioned event", async () => {
    const { ctx, clock, version } = await setup();
    clock.advance(5000);
    const reservation = expectOk(await reserveStock(ctx, { sku: "sku-1", quantity: 3 }, version));
    expect(reservation).toMatchObject({ sku: "sku-1", quantity: 3, status: "held" });
    expect(reservation.id.startsWith("res_")).toBe(true);
    expect(reservation.updatedAt).toBe("2026-01-01T00:00:05.000Z");
    expect(expectOk(await availableStock(ctx, "sku-1"))).toBe(7);
    expect(await drainOutbox(ctx.db)).toEqual([
      {
        topic: "inventory.v1.reserved",
        payload: { sku: "sku-1", quantity: 3, reservationId: reservation.id, version: version + 1 },
        idempotencyKey: `stock-reserved:sku-1:${version + 1}`,
      },
    ]);
  });

  it("refuses a stale version with VersionConflict, changing and queueing nothing", async () => {
    const { ctx, version } = await setup();
    expectOk(await reserveStock(ctx, { sku: "sku-1", quantity: 1 }, version));
    await drainOutbox(ctx.db);
    const conflict = expectErr(
      await reserveStock(ctx, { sku: "sku-1", quantity: 1 }, version),
      "VersionConflict",
    );
    expect(conflict).toMatchObject({ expected: version, actual: version + 1 });
    expect(expectOk(await availableStock(ctx, "sku-1"))).toBe(9);
    expect(await drainOutbox(ctx.db)).toEqual([]);
  });

  it("returns tagged errors, never throws, and queues nothing", async () => {
    const { ctx, version } = await setup(2);
    expectErr(await reserveStock(ctx, { sku: "sku-1", quantity: 5 }, version), "InsufficientStock");
    expectErr(await reserveStock(ctx, { sku: "nope", quantity: 1 }, 1), "UnknownSku");
    expectErr(await reserveStock(ctx, { sku: "sku-1", quantity: 0 }, version), "InvalidQuantity");
    expect(await drainOutbox(ctx.db)).toEqual([]);
  });

  it("lets exactly one of two writers with the same version win", async () => {
    const { ctx, version } = await setup();
    const results = await Promise.all([
      reserveStock(ctx, { sku: "sku-1", quantity: 4 }, version),
      reserveStock(ctx, { sku: "sku-1", quantity: 4 }, version),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await drainOutbox(ctx.db)).toHaveLength(1);
  });

  it("logs a structured event", async () => {
    const { ctx, version } = await setup();
    const logs = captureLogs();
    await reserveStock(ctx, { sku: "sku-1", quantity: 1 }, version);
    logs.restore();
    expect(logs.records.map((r) => r.event)).toContain("inventory.stock_reserved");
  });
});

describe("releaseStock", () => {
  it("frees the units and queues a released event", async () => {
    const { ctx, version } = await setup();
    const held = expectOk(await reserveStock(ctx, { sku: "sku-1", quantity: 3 }, version));
    await drainOutbox(ctx.db);
    const released = expectOk(await releaseStock(ctx, held.id, version + 1));
    expect(released.status).toBe("released");
    expect(expectOk(await availableStock(ctx, "sku-1"))).toBe(10);
    expect((await drainOutbox(ctx.db)).map((e) => e.topic)).toEqual(["inventory.v1.released"]);
    expectErr(await releaseStock(ctx, held.id, version + 2), "AlreadyReleased");
  });
});

describe("subscribeReservationAudit", () => {
  it("audits a redelivered event once", async () => {
    const { ctx, version } = await setup();
    const bus = createBus();
    subscribeReservationAudit(bus);
    await reserveStock(ctx, { sku: "sku-1", quantity: 1 }, version);
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
