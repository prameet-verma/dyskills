import { ok } from "@acme/result";
import { createDedupStore, idempotentHandler, type Bus, type DedupStore } from "@acme/events";
import { log } from "@acme/log";

/**
 * Example consumer: audits reservations. Delivery is at least once, so the handler is wrapped in
 * idempotentHandler and a redelivered event (same idempotencyKey) is processed once.
 */
export function subscribeReservationAudit(bus: Bus, store: DedupStore = createDedupStore()): void {
  bus.subscribe(
    "inventory.v1.reserved",
    idempotentHandler(store, async (event) => {
      log.info("inventory.reservation_audited", { key: event.idempotencyKey });
      return ok(undefined);
    }),
  );
}
