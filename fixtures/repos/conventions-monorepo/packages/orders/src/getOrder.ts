import { err, ok, type Result } from "@acme/result";
import {
  ORDERS_TABLE,
  OrderNotFound,
  type Order,
  type OrderError,
  type OrdersContext,
} from "./types";

export async function getOrder(ctx: OrdersContext, id: string): Promise<Result<Order, OrderError>> {
  const order = await ctx.db.get<Order>(ORDERS_TABLE, id);
  return order ? ok(order) : err(OrderNotFound(`order ${id} not found`, { id }));
}
