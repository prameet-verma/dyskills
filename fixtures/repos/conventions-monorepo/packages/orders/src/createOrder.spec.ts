import { describe, expect, it } from "vitest";
import { createTestDb, drainOutbox, expectErr, expectOk } from "@acme/testkit";
import { createOrder } from "./index";

describe("createOrder", () => {
  it("stores a pending order at version 1 and queues a created event", async () => {
    const { db } = createTestDb();
    const order = expectOk(await createOrder({ db }, { items: [{ sku: "a", quantity: 2 }] }));
    expect(order).toMatchObject({ status: "pending", version: 1 });
    expect(order.id.startsWith("ord_")).toBe(true);
    const events = await drainOutbox(db);
    expect(events).toEqual([
      {
        topic: "orders.v1.created",
        payload: { id: order.id, version: 1 },
        idempotencyKey: `order-created:${order.id}`,
      },
    ]);
  });

  it("refuses an empty order with a tagged error and queues nothing", async () => {
    const { db } = createTestDb();
    expectErr(await createOrder({ db }, { items: [] }), "InvalidOrder");
    expect(await drainOutbox(db)).toEqual([]);
  });
});
