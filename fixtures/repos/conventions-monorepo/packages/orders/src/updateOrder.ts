import { err, ok, type Result } from "@acme/result";
import {
  ORDERS_TABLE,
  OrderNotFound,
  type Order,
  type OrderError,
  type OrderItem,
  type OrderStatus,
  type OrdersContext,
} from "./types";

export type OrderPatch = { status?: OrderStatus; items?: OrderItem[] };

// TODO: naive first cut. Concurrent writers can overwrite each other and nobody is told.
export async function updateOrder(
  ctx: OrdersContext,
  id: string,
  patch: OrderPatch,
): Promise<Result<Order, OrderError>> {
  const found = await ctx.db.get<Order>(ORDERS_TABLE, id);
  if (!found) return err(OrderNotFound(`order ${id} not found`, { id }));
  return ctx.db.transaction(async (tx) => {
    const updated = await tx.update<Order>(ORDERS_TABLE, id, {
      ...patch,
      updatedAt: tx.now().toISOString(),
    });
    return updated.ok ? ok(updated.value) : updated;
  });
}
