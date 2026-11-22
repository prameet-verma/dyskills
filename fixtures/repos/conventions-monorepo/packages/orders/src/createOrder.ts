import { type Result } from "@acme/result";
import { log } from "@acme/log";
import { newId } from "@acme/ids";
import { outbox } from "@acme/outbox";
import {
  ORDERS_TABLE,
  type Order,
  type OrderError,
  type OrderItem,
  type OrdersContext,
} from "./types";
import { validateItems } from "./validation";

export async function createOrder(
  ctx: OrdersContext,
  input: { items: OrderItem[] },
): Promise<Result<Order, OrderError>> {
  const checked = validateItems(input.items);
  if (!checked.ok) return checked;
  const items = checked.value;
  return ctx.db.transaction<Order, OrderError>(async (tx) => {
    const inserted = await tx.insert<Order>(ORDERS_TABLE, {
      id: newId("ord"),
      status: "pending",
      items,
      updatedAt: tx.now().toISOString(),
    });
    if (!inserted.ok) return inserted;
    const queued = await outbox.enqueue(tx, {
      topic: "orders.v1.created",
      payload: { id: inserted.value.id, version: inserted.value.version },
      idempotencyKey: `order-created:${inserted.value.id}`,
    });
    if (!queued.ok) return queued;
    log.info("orders.order_created", { id: inserted.value.id });
    return inserted;
  });
}
