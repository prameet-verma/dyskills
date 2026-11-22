import { err, ok, type Result } from "@acme/result";
import { defineError, type DomainError } from "@acme/errors";
import type { Db, DuplicateRow, Row, Tx } from "@acme/db";
import { isValidTopic, type BusEvent, type Publisher } from "@acme/events";
import { newId } from "@acme/ids";

export const OUTBOX_TABLE = "outbox";

export type OutboxMessage = Row & {
  topic: string;
  payload: unknown;
  idempotencyKey: string;
  createdAt: string;
  deliveredAt: string | null;
  attempts: number;
};

export const InvalidTopic = defineError("InvalidTopic");
export type InvalidTopic = DomainError<"InvalidTopic", { topic: string }>;
export type OutboxError = InvalidTopic | DuplicateRow;

export const outbox = {
  /**
   * Record an event in the same transaction as the state change it describes, so both commit or
   * neither does. A message with an idempotencyKey already in the outbox is not added twice, so the
   * key must be unique per distinct event (e.g. `<event>:<entity id>:<new version>`).
   */
  async enqueue(tx: Tx, event: BusEvent): Promise<Result<OutboxMessage, OutboxError>> {
    if (!isValidTopic(event.topic)) {
      return err(InvalidTopic(`invalid topic name: ${event.topic}`, { topic: event.topic }));
    }
    const existing = (await tx.list<OutboxMessage>(OUTBOX_TABLE)).find(
      (m) => m.idempotencyKey === event.idempotencyKey,
    );
    if (existing) return ok(existing);
    return tx.insert<OutboxMessage>(OUTBOX_TABLE, {
      id: newId("out"),
      topic: event.topic,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
      createdAt: tx.now().toISOString(),
      deliveredAt: null,
      attempts: 0,
    });
  },
};

export type DrainReport = { delivered: number; failed: number };

/** Delivers pending messages at least once: a message is marked delivered only after publish succeeds. */
export function createOutboxRelay(db: Db) {
  return {
    async drain(publisher: Publisher): Promise<DrainReport> {
      const report: DrainReport = { delivered: 0, failed: 0 };
      const pending = (await db.list<OutboxMessage>(OUTBOX_TABLE)).filter(
        (m) => m.deliveredAt === null,
      );
      for (const message of pending) {
        const sent = await publisher.publish({
          topic: message.topic,
          payload: message.payload,
          idempotencyKey: message.idempotencyKey,
        });
        await db.transaction(async (tx) =>
          tx.update<OutboxMessage>(
            OUTBOX_TABLE,
            message.id,
            sent.ok
              ? { deliveredAt: tx.now().toISOString(), attempts: message.attempts + 1 }
              : { attempts: message.attempts + 1 },
          ),
        );
        if (sent.ok) report.delivered += 1;
        else report.failed += 1;
      }
      return report;
    },
  };
}
