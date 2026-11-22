import { describe, expect, it } from "vitest";
import { ok } from "@acme/result";
import { createBus, createDedupStore, idempotentHandler, isValidTopic } from "./index";

describe("topics", () => {
  it("accepts versioned dotted names only", () => {
    expect(isValidTopic("orders.v1.updated")).toBe(true);
    expect(isValidTopic("orders.updated")).toBe(false);
    expect(isValidTopic("OrdersUpdated")).toBe(false);
  });

  it("throws on a bad name at subscribe time", () => {
    expect(() => createBus().subscribe("orders-updated", async () => ok(undefined))).toThrow();
  });
});

describe("idempotentHandler", () => {
  it("handles a redelivered key once", async () => {
    let calls = 0;
    const handler = idempotentHandler(createDedupStore(), async () => {
      calls += 1;
      return ok(undefined);
    });
    const event = { topic: "demo.v1.happened", payload: {}, idempotencyKey: "k1" };
    await handler(event);
    await handler(event);
    expect(calls).toBe(1);
  });
});
