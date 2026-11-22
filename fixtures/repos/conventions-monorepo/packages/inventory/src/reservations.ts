import { andThen, err, ok, type Result } from "@acme/result";
import { log } from "@acme/log";
import { newId } from "@acme/ids";
import { outbox } from "@acme/outbox";
import {
  AlreadyReleased,
  InsufficientStock,
  InvalidQuantity,
  RESERVATIONS_TABLE,
  STOCK_TABLE,
  UnknownReservation,
  UnknownSku,
  type InventoryContext,
  type InventoryError,
  type Reservation,
  type StockItem,
} from "./types";

function validateQuantity(quantity: number): Result<number, InventoryError> {
  return Number.isInteger(quantity) && quantity > 0
    ? ok(quantity)
    : err(InvalidQuantity("quantity must be a positive integer", { quantity }));
}

function validateRequest(sku: string, quantity: number): Result<{ sku: string; quantity: number }, InventoryError> {
  return andThen(validateQuantity(quantity), (q) => ok({ sku, quantity: q }));
}

/**
 * Reserve stock. `expectedStockVersion` is the stock row version the caller last saw; if the row has
 * moved on, the write is refused with a VersionConflict and nothing changes. The stock change, the
 * reservation row and the `inventory.v1.reserved` event commit in ONE transaction.
 */
export async function reserveStock(
  ctx: InventoryContext,
  request: { sku: string; quantity: number },
  expectedStockVersion: number,
): Promise<Result<Reservation, InventoryError>> {
  const checked = validateRequest(request.sku, request.quantity);
  if (!checked.ok) return checked;
  const { sku, quantity } = checked.value;
  return ctx.db.transaction<Reservation, InventoryError>(async (tx) => {
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
    const stock = await tx.updateWhereVersion<StockItem>(STOCK_TABLE, sku, expectedStockVersion, {
      reserved: current.reserved + quantity,
      updatedAt: tx.now().toISOString(),
    });
    if (!stock.ok) return stock;
    const reservation = await tx.insert<Reservation>(RESERVATIONS_TABLE, {
      id: newId("res"),
      sku,
      quantity,
      status: "held",
      updatedAt: tx.now().toISOString(),
    });
    if (!reservation.ok) return reservation;
    const queued = await outbox.enqueue(tx, {
      topic: "inventory.v1.reserved",
      payload: { sku, quantity, reservationId: reservation.value.id, version: stock.value.version },
      idempotencyKey: `stock-reserved:${sku}:${stock.value.version}`,
    });
    if (!queued.ok) return queued;
    log.info("inventory.stock_reserved", { sku, quantity, reservationId: reservation.value.id });
    return reservation;
  });
}

/** Release a held reservation. Same shape as reserveStock: guarded by `expectedStockVersion`, one transaction, one event. */
export async function releaseStock(
  ctx: InventoryContext,
  reservationId: string,
  expectedStockVersion: number,
): Promise<Result<Reservation, InventoryError>> {
  return ctx.db.transaction<Reservation, InventoryError>(async (tx) => {
    const held = await tx.get<Reservation>(RESERVATIONS_TABLE, reservationId);
    if (!held) {
      return err(UnknownReservation(`unknown reservation ${reservationId}`, { id: reservationId }));
    }
    if (held.status === "released") {
      return err(AlreadyReleased(`reservation ${reservationId} already released`, { id: reservationId }));
    }
    const current = await tx.get<StockItem>(STOCK_TABLE, held.sku);
    if (!current) return err(UnknownSku(`unknown sku ${held.sku}`, { sku: held.sku }));
    const stock = await tx.updateWhereVersion<StockItem>(STOCK_TABLE, held.sku, expectedStockVersion, {
      reserved: Math.max(0, current.reserved - held.quantity),
      updatedAt: tx.now().toISOString(),
    });
    if (!stock.ok) return stock;
    const released = await tx.updateWhereVersion<Reservation>(
      RESERVATIONS_TABLE,
      reservationId,
      held.version,
      { status: "released", updatedAt: tx.now().toISOString() },
    );
    if (!released.ok) return released;
    const queued = await outbox.enqueue(tx, {
      topic: "inventory.v1.released",
      payload: { sku: held.sku, quantity: held.quantity, reservationId, version: stock.value.version },
      idempotencyKey: `stock-released:${held.sku}:${stock.value.version}`,
    });
    if (!queued.ok) return queued;
    log.info("inventory.stock_released", { sku: held.sku, reservationId });
    return released;
  });
}
