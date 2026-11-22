import { ok } from "@acme/result";
import { InvalidOrderError } from "./errors";
import { ORDERS_TABLE, type Order, type OrderItem, type OrdersContext } from "./types";

export async function createOrder(ctx: OrdersContext, input: { items: OrderItem[] }): Promise<Order> {
  if (!input.items || input.items.length === 0) {
    throw new InvalidOrderError("an order needs at least one item");
  }
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new InvalidOrderError("bad quantity for " + item.sku);
    }
  }
  const id = "ord_" + Math.random().toString(36).slice(2, 10);
  const saved = await ctx.db.transaction(async (tx) => {
    const inserted = await tx.insert<Order>(ORDERS_TABLE, {
      id,
      status: "pending",
      items: input.items,
      updatedAt: new Date().toISOString(),
    });
    if (!inserted.ok) throw new Error("could not save order");
    return ok(inserted.value);
  });
  if (!saved.ok) throw new Error("could not save order");
  await ctx.bus.publish({ topic: "order.created", payload: { id }, idempotencyKey: id });
  return saved.value;
}
