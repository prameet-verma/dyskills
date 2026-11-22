import { describe, expect, it } from "vitest";
import { createDb } from "@acme/db";
import { createBus } from "@acme/events";
import { createOrder, getOrder, OrderNotFoundError } from "./index";

describe("getOrder", () => {
  it("finds a created order", async () => {
    const ctx = { db: createDb(), bus: createBus() };
    const created = await createOrder(ctx, { items: [{ sku: "a", quantity: 1 }] });
    expect((await getOrder(ctx, created.id)).id).toBe(created.id);
  });

  it("throws for a missing order", async () => {
    const ctx = { db: createDb(), bus: createBus() };
    await expect(getOrder(ctx, "ord_missing")).rejects.toBeInstanceOf(OrderNotFoundError);
  });
});
