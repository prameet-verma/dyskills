import { err, ok, type Result } from "@acme/result";
import { InvalidOrder, type OrderError, type OrderItem } from "./types";

export function validateItems(items: OrderItem[]): Result<OrderItem[], OrderError> {
  if (items.length === 0)
    return err(InvalidOrder("an order needs at least one item", { reason: "no items" }));
  const bad = items.find((i) => !Number.isInteger(i.quantity) || i.quantity <= 0);
  return bad ? err(InvalidOrder(`bad quantity for ${bad.sku}`, { reason: "quantity" })) : ok(items);
}
