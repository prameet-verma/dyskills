import type { Db, DbError, Row } from "@acme/db";
import { defineError, type DomainError } from "@acme/errors";
import type { OutboxError } from "@acme/outbox";

export const ORDERS_TABLE = "orders";

export type OrderStatus = "pending" | "paid" | "cancelled";
export type OrderItem = { sku: string; quantity: number };

export type Order = Row & {
  status: OrderStatus;
  items: OrderItem[];
  updatedAt: string;
};

export type OrdersContext = { db: Db };

export const OrderNotFound = defineError("OrderNotFound");
export const InvalidOrder = defineError("InvalidOrder");

export type OrderError =
  | DomainError<"OrderNotFound", { id: string }>
  | DomainError<"InvalidOrder", { reason: string }>
  | DbError
  | OutboxError;
