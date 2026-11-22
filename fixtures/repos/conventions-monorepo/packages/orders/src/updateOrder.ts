import { ok } from "@acme/result";
import { OrderNotFoundError } from "./errors";
import {
  ORDERS_TABLE,
  type Order,
  type OrderItem,
  type OrderStatus,
  type OrdersContext,
} from "./types";

export type OrderPatch = { status?: OrderStatus; items?: OrderItem[] };

// TODO: naive first cut. Concurrent writers can overwrite each other and nobody is told.
export async function updateOrder(ctx: OrdersContext, id: string, patch: OrderPatch): Promise<Order> {
  const found = await ctx.db.get<Order>(ORDERS_TABLE, id);
  if (!found) throw new OrderNotFoundError(id);
  const saved = await ctx.db.transaction(async (tx) => {
    const updated = await tx.update<Order>(ORDERS_TABLE, id, {
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    if (!updated.ok) throw new Error("update failed");
    return ok(updated.value);
  });
  if (!saved.ok) throw new Error("update failed");
  return saved.value;
}
