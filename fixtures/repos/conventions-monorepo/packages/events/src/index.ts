import { err, ok, type Result } from "@acme/result";
import { defineError, type DomainError } from "@acme/errors";

/** Versioned, dotted topics: `<domain>.v<major>.<event>`, e.g. `orders.v1.updated`. */
export const TOPIC_PATTERN = /^[a-z]+\.v[0-9]+\.[a-z]+(-[a-z]+)*$/;

export function isValidTopic(topic: string): boolean {
  return TOPIC_PATTERN.test(topic);
}

/** What travels on the bus and through the outbox. */
export type BusEvent = { topic: string; payload: unknown; idempotencyKey: string };

export const DeliveryFailed = defineError("DeliveryFailed");
export type DeliveryFailed = DomainError<"DeliveryFailed", { topic: string }>;

export type Handler = (event: BusEvent) => Promise<Result<void, DomainError<string>>>;

export interface Publisher {
  publish(event: BusEvent): Promise<Result<void, DeliveryFailed>>;
}

export interface Bus extends Publisher {
  subscribe(topic: string, handler: Handler): void;
}

export function createBus(): Bus {
  const handlers = new Map<string, Handler[]>();
  return {
    subscribe(topic, handler) {
      // Wiring mistake, not a domain failure: the one sanctioned throw.
      if (!isValidTopic(topic)) throw new Error(`invalid topic name: ${topic}`);
      handlers.set(topic, [...(handlers.get(topic) ?? []), handler]);
    },
    async publish(event) {
      for (const handler of handlers.get(event.topic) ?? []) {
        let outcome: Result<void, DomainError<string>>;
        try {
          outcome = await handler(event);
        } catch {
          return err(DeliveryFailed("handler threw", { topic: event.topic }));
        }
        if (!outcome.ok) return err(DeliveryFailed(outcome.error.message, { topic: event.topic }));
      }
      return ok(undefined);
    },
  };
}

/** Remembers which idempotency keys a consumer has already handled. */
export interface DedupStore {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
}

export function createDedupStore(): DedupStore {
  const seen = new Set<string>();
  return {
    has: async (key) => seen.has(key),
    add: async (key) => {
      seen.add(key);
    },
  };
}

/**
 * Wrap a consumer so a redelivered event (same idempotencyKey) is skipped.
 * The key is recorded only after the handler succeeds, so a failed handling is retried.
 */
export function idempotentHandler(store: DedupStore, handler: Handler): Handler {
  return async (event) => {
    if (await store.has(event.idempotencyKey)) return ok(undefined);
    const outcome = await handler(event);
    if (outcome.ok) await store.add(event.idempotencyKey);
    return outcome;
  };
}
