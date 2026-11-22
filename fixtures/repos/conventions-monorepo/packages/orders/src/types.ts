import type { Db, Row } from "@acme/db";
import type { Publisher } from "@acme/events";

export const ORDERS_TABLE = "orders";

export type OrderStatus = "pending" | "paid" | "cancelled";
export type OrderItem = { sku: string; quantity: number };

export type Order = Row & {
  status: OrderStatus;
  items: OrderItem[];
  updatedAt: string;
};

/** What every orders operation takes first: the database and the event bus. */
export type OrdersContext = { db: Db; bus: Publisher };
