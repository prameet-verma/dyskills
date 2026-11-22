import { describe, expect, it } from "vitest";
import { createDb } from "@acme/db";
import { createBus } from "@acme/events";
import { createOrder } from "./index";

describe("createOrder", () => {
  it("stores a pending order", async () => {
    const ctx = { db: createDb(), bus: createBus() };
    const order = await createOrder(ctx, { items: [{ sku: "a", quantity: 2 }] });
    expect(order.status).toBe("pending");
    expect(order.version).toBe(1);
  });

  it("throws on an empty order", async () => {
    const ctx = { db: createDb(), bus: createBus() };
    await expect(createOrder(ctx, { items: [] })).rejects.toThrow("at least one item");
  });
});
