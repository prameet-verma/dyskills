import type { Db, DbError, Row } from "@acme/db";
import { defineError, type DomainError } from "@acme/errors";
import type { OutboxError } from "@acme/outbox";

export const STOCK_TABLE = "stock";
export const RESERVATIONS_TABLE = "reservations";

/** One row per SKU; the row id is the SKU itself. */
export type StockItem = Row & { onHand: number; reserved: number; updatedAt: string };

/** One row per reservation; the id comes from newId("res"). */
export type Reservation = Row & {
  sku: string;
  quantity: number;
  status: "held" | "released";
  updatedAt: string;
};

export type InventoryContext = { db: Db };

export const UnknownSku = defineError("UnknownSku");
export const UnknownReservation = defineError("UnknownReservation");
export const InsufficientStock = defineError("InsufficientStock");
export const InvalidQuantity = defineError("InvalidQuantity");
export const AlreadyReleased = defineError("AlreadyReleased");

export type InventoryError =
  | DomainError<"UnknownSku", { sku: string }>
  | DomainError<"UnknownReservation", { id: string }>
  | DomainError<"InsufficientStock", { sku: string; requested: number; available: number }>
  | DomainError<"InvalidQuantity", { quantity: number }>
  | DomainError<"AlreadyReleased", { id: string }>
  | DbError
  | OutboxError;
