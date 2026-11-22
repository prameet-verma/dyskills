import { err, map, ok, type Result } from "@acme/result";
import { log } from "@acme/log";
import {
  InvalidQuantity,
  STOCK_TABLE,
  UnknownSku,
  type InventoryContext,
  type InventoryError,
  type StockItem,
} from "./types";

function validateQuantity(quantity: number): Result<number, InventoryError> {
  return Number.isInteger(quantity) && quantity > 0
    ? ok(quantity)
    : err(InvalidQuantity("quantity must be a positive integer", { quantity }));
}

export async function addStock(
  ctx: InventoryContext,
  sku: string,
  quantity: number,
): Promise<Result<StockItem, InventoryError>> {
  const checked = validateQuantity(quantity);
  if (!checked.ok) return checked;
  return ctx.db.transaction<StockItem, InventoryError>(async (tx) => {
    const current = await tx.get<StockItem>(STOCK_TABLE, sku);
    if (current) {
      return tx.updateWhereVersion<StockItem>(STOCK_TABLE, sku, current.version, {
        onHand: current.onHand + quantity,
        updatedAt: tx.now().toISOString(),
      });
    }
    return tx.insert<StockItem>(STOCK_TABLE, {
      id: sku,
      onHand: quantity,
      reserved: 0,
      updatedAt: tx.now().toISOString(),
    });
  });
}

export async function getStock(
  ctx: InventoryContext,
  sku: string,
): Promise<Result<StockItem, InventoryError>> {
  const item = await ctx.db.get<StockItem>(STOCK_TABLE, sku);
  log.info("inventory.stock_read", { sku, found: item !== undefined });
  return item ? ok(item) : err(UnknownSku(`unknown sku ${sku}`, { sku }));
}

/** Units that can still be reserved. */
export async function availableStock(
  ctx: InventoryContext,
  sku: string,
): Promise<Result<number, InventoryError>> {
  return map(await getStock(ctx, sku), (item) => item.onHand - item.reserved);
}
