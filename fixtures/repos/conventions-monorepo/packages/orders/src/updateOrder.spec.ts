import { describe, expect, it } from "vitest";
import { createTestDb, expectErr, expectOk } from "@acme/testkit";
import { createOrder, updateOrder } from "./index";

describe("updateOrder", () => {
  it("applies the patch", async () => {
    const { db } = createTestDb();
    const ctx = { db };
    const created = expectOk(await createOrder(ctx, { items: [{ sku: "a", quantity: 1 }] }));
    const updated = expectOk(await updateOrder(ctx, created.id, { status: "paid" }));
    expect(updated.status).toBe("paid");
  });

  it("reports a missing order", async () => {
    const { db } = createTestDb();
    expectErr(await updateOrder({ db }, "ord_missing", { status: "paid" }), "OrderNotFound");
  });
});
