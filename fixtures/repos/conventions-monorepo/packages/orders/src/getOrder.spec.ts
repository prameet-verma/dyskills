import { describe, it } from "vitest";
import { createTestDb, expectErr, expectOk } from "@acme/testkit";
import { createOrder, getOrder } from "./index";

describe("getOrder", () => {
  it("finds a created order and reports a missing one as an error value", async () => {
    const { db } = createTestDb();
    const ctx = { db };
    const created = expectOk(await createOrder(ctx, { items: [{ sku: "a", quantity: 1 }] }));
    expectOk(await getOrder(ctx, created.id));
    expectErr(await getOrder(ctx, "ord_missing"), "OrderNotFound");
  });
});
