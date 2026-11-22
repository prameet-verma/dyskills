import { err, ok, type Result } from "@acme/result";
import { log } from "@acme/log";
import { outbox } from "@acme/outbox";
import {
  InsufficientStock,
  InvalidQuantity,
  STOCK_TABLE,
  UnknownSku,
  type InventoryContext,
  type InventoryError,
  type StockItem,
} from "./types";

export type Reservation = { sku: string; quantity: number };

function validate(reservation: Reservation): Result<Reservation, InventoryError> {
  return Number.isInteger(reservation.quantity) && reservation.quantity > 0
    ? ok(reservation)
    : err(
        InvalidQuantity("quantity must be a positive integer", { quantity: reservation.quantity }),
      );
}

/**
 * Reserve stock. The stock change and its `inventory.v1.reserved` event commit in one transaction;
 * the write is guarded by the version that was read, so a concurrent change is a VersionConflict.
 */
export async function reserveStock(
  ctx: InventoryContext,
  reservation: Reservation,
): Promise<Result<StockItem, InventoryError>> {
  const checked = validate(reservation);
  if (!checked.ok) return checked;
  const { sku, quantity } = checked.value;
  return ctx.db.transaction<StockItem, InventoryError>(async (tx) => {
    const current = await tx.get<StockItem>(STOCK_TABLE, sku);
    if (!current) return err(UnknownSku(`unknown sku ${sku}`, { sku }));
    const available = current.onHand - current.reserved;
    if (available < quantity) {
      return err(
        InsufficientStock(`only ${available} of ${sku} available`, {
          sku,
          requested: quantity,
          available,
        }),
      );
    }
    const updated = await tx.updateWhereVersion<StockItem>(STOCK_TABLE, sku, current.version, {
      reserved: current.reserved + quantity,
      updatedAt: tx.now().toISOString(),
    });
    if (!updated.ok) return updated;
    const queued = await outbox.enqueue(tx, {
      topic: "inventory.v1.reserved",
      payload: { sku, quantity, version: updated.value.version },
      idempotencyKey: `stock-reserved:${sku}:${updated.value.version}`,
    });
    if (!queued.ok) return queued;
    log.info("inventory.stock_reserved", { sku, quantity });
    return updated;
  });
}

/** The inverse of reserveStock, with the same transaction, version guard and event. */
export async function releaseStock(
  ctx: InventoryContext,
  reservation: Reservation,
): Promise<Result<StockItem, InventoryError>> {
  const checked = validate(reservation);
  if (!checked.ok) return checked;
  const { sku, quantity } = checked.value;
  return ctx.db.transaction<StockItem, InventoryError>(async (tx) => {
    const current = await tx.get<StockItem>(STOCK_TABLE, sku);
    if (!current) return err(UnknownSku(`unknown sku ${sku}`, { sku }));
    const updated = await tx.updateWhereVersion<StockItem>(STOCK_TABLE, sku, current.version, {
      reserved: Math.max(0, current.reserved - quantity),
      updatedAt: tx.now().toISOString(),
    });
    if (!updated.ok) return updated;
    const queued = await outbox.enqueue(tx, {
      topic: "inventory.v1.released",
      payload: { sku, quantity, version: updated.value.version },
      idempotencyKey: `stock-released:${sku}:${updated.value.version}`,
    });
    if (!queued.ok) return queued;
    log.info("inventory.stock_released", { sku, quantity });
    return updated;
  });
}
