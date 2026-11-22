import { describe, expect, it } from "vitest";
import { createDb } from "@acme/db";
import { createBus } from "@acme/events";
import { createOrder, updateOrder } from "./index";

describe("updateOrder", () => {
  it("applies the patch", async () => {
    const ctx = { db: createDb(), bus: createBus() };
    const created = await createOrder(ctx, { items: [{ sku: "a", quantity: 1 }] });
    const updated = await updateOrder(ctx, created.id, { status: "paid" });
    expect(updated.status).toBe("paid");
  });

  it("throws for a missing order", async () => {
    const ctx = { db: createDb(), bus: createBus() };
    await expect(updateOrder(ctx, "ord_missing", { status: "paid" })).rejects.toThrow("not found");
  });
});
