import { describe, expect, it } from "vitest";
import { err, ok } from "@acme/result";
import { DeliveryFailed, type BusEvent } from "@acme/events";
import { createOutboxRelay } from "@acme/outbox";
import { createTestDb, drainOutbox } from "@acme/testkit";
import { createOrder, updateOrder } from "./index";

type Outcome = { ok: true; value: any } | { ok: false };

/** Normalise a call: a returned ok/err value, a plain return, or a throw. Behaviour only. */
async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    const r = (await fn()) as { ok?: unknown; value?: unknown } | undefined;
    if (r && typeof r === "object" && "ok" in r) {
      return r.ok ? { ok: true, value: r.value } : { ok: false };
    }
    return { ok: true, value: r };
  } catch {
    return { ok: false };
  }
}

const update = updateOrder as unknown as (...args: unknown[]) => Promise<unknown>;
const UPDATED = /^orders\.v\d+\.updated$/;

async function setup() {
  const { db, clock } = createTestDb();
  const ctx = { db };
  const created = await outcome(() => createOrder(ctx, { items: [{ sku: "a", quantity: 1 }] }));
  if (!created.ok) throw new Error("fixture createOrder failed");
  await drainOutbox(db); // discard the creation event
  return { db, clock, ctx, id: created.value.id as string };
}

const row = (db: { get: (t: string, id: string) => Promise<unknown> }, id: string) =>
  db.get("orders", id) as Promise<{ status: string; version: number; updatedAt: string; items: unknown[] }>;

describe("g1: updateOrder under concurrent writers", () => {
  it("applies a patch at the expected version, bumps the version and refreshes updatedAt", async () => {
    const { db, clock, ctx, id } = await setup();
    clock.advance(5000);
    const res = await outcome(() => update(ctx, id, { status: "paid" }, 1));
    expect(res.ok).toBe(true);
    const stored = await row(db, id);
    expect(stored.status).toBe("paid");
    expect(stored.version).toBe(2);
    expect(stored.updatedAt).toBe("2026-01-01T00:00:05.000Z");
    if (res.ok) expect(res.value).toMatchObject({ id, status: "paid", version: 2 });
  });

  it("refuses a stale expected version, leaves the order alone and announces nothing", async () => {
    const { db, ctx, id } = await setup();
    expect((await outcome(() => update(ctx, id, { status: "paid" }, 1))).ok).toBe(true);
    await drainOutbox(db);
    const before = await row(db, id);
    const stale = await outcome(() => update(ctx, id, { status: "cancelled" }, 1));
    expect(stale.ok).toBe(false);
    expect(await row(db, id)).toEqual(before);
    expect(await drainOutbox(db)).toEqual([]);
  });

  it("lets exactly one of two simultaneous writers win", async () => {
    const { db, ctx, id } = await setup();
    const results = await Promise.all([
      outcome(() => update(ctx, id, { status: "paid" }, 1)),
      outcome(() => update(ctx, id, { status: "cancelled" }, 1)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await row(db, id)).version).toBe(2);
    const events = (await drainOutbox(db)).filter((e) => UPDATED.test(e.topic));
    expect(events).toHaveLength(1);
  });

  it("announces one versioned event per successful update with a distinct idempotency key", async () => {
    const { db, ctx, id } = await setup();
    await outcome(() => update(ctx, id, { status: "paid" }, 1));
    await outcome(() => update(ctx, id, { items: [{ sku: "b", quantity: 3 }] }, 2));
    const events = (await drainOutbox(db)).filter((e) => UPDATED.test(e.topic));
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.payload as { id: string }).id)).toEqual([id, id]);
    expect(events.map((e) => (e.payload as { version: number }).version)).toEqual([2, 3]);
    const keys = events.map((e) => e.idempotencyKey);
    expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });

  it("redelivers the same event with the same idempotency key after a failed delivery", async () => {
    const { db, ctx, id } = await setup();
    await outcome(() => update(ctx, id, { status: "paid" }, 1));
    const seen: BusEvent[] = [];
    let failNext = true;
    const flaky = {
      async publish(event: BusEvent) {
        seen.push(event);
        if (failNext) {
          failNext = false;
          return err(DeliveryFailed("broker down", { topic: event.topic }));
        }
        return ok(undefined);
      },
    };
    const relay = createOutboxRelay(db);
    await relay.drain(flaky);
    await relay.drain(flaky);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(UPDATED.test(seen[0]!.topic)).toBe(true);
  });

  it("refuses an unknown status, an empty item list and an unknown order, changing nothing", async () => {
    const { db, ctx, id } = await setup();
    const before = await row(db, id);
    expect((await outcome(() => update(ctx, id, { status: "bogus" }, 1))).ok).toBe(false);
    expect((await outcome(() => update(ctx, id, { items: [] }, 1))).ok).toBe(false);
    expect((await outcome(() => update(ctx, "ord_missing", { status: "paid" }, 1))).ok).toBe(false);
    expect(await row(db, id)).toEqual(before);
    expect(await drainOutbox(db)).toEqual([]);
  });
});
