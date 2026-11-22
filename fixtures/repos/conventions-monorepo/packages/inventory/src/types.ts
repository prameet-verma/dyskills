import type { Db, DbError, Row } from "@acme/db";
import { defineError, type DomainError } from "@acme/errors";
import type { OutboxError } from "@acme/outbox";

export const STOCK_TABLE = "stock";

/** One row per SKU; the row id is the SKU itself. */
export type StockItem = Row & { onHand: number; reserved: number; updatedAt: string };

export type InventoryContext = { db: Db };

export const UnknownSku = defineError("UnknownSku");
export const InsufficientStock = defineError("InsufficientStock");
export const InvalidQuantity = defineError("InvalidQuantity");

export type InventoryError =
  | DomainError<"UnknownSku", { sku: string }>
  | DomainError<"InsufficientStock", { sku: string; requested: number; available: number }>
  | DomainError<"InvalidQuantity", { quantity: number }>
  | DbError
  | OutboxError;
