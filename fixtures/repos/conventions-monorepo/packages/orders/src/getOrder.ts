import { OrderNotFoundError } from "./errors";
import { ORDERS_TABLE, type Order, type OrdersContext } from "./types";

export async function getOrder(ctx: OrdersContext, id: string): Promise<Order> {
  const order = await ctx.db.get<Order>(ORDERS_TABLE, id);
  if (!order) throw new OrderNotFoundError(id);
  return order;
}
