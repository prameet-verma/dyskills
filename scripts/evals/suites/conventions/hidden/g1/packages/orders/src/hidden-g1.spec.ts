import { describe, expect, it } from "vitest";
import { err, ok } from "@acme/result";
import { DeliveryFailed, type BusEvent, type Publisher } from "@acme/events";
import { createOutboxRelay } from "@acme/outbox";
import { createTestDb } from "@acme/testkit";
import * as orders from "./index";

// Behavioural spec: only the package's public functions and observable state are used. Events
// count the same whether they were published directly or drained from an outbox.

type Db = ReturnType<typeof createTestDb>["db"];
type Call = { ok: true; value: any } | { ok: false }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Classify a call. A refusal is a throw, an `ok: false` / `success: false` result, an
 * error-only object, or null/undefined (the prompts say success returns the order or the list).
 */
async function call(fn: () => Promise<unknown>): Promise<Call> {
  try {
    const r = (await fn()) as Record<string, unknown> | null | undefined;
    if (r === null || r === undefined) return { ok: false };
    if (typeof r === "object" && typeof r.ok === "boolean") {
      return r.ok ? { ok: true, value: r.value } : { ok: false };
    }
    if (typeof r === "object" && typeof r.success === "boolean") {
      return r.success ? { ok: true, value: r.data ?? r.value ?? r } : { ok: false };
    }
    if (typeof r === "object" && !Array.isArray(r) && "error" in r && !("id" in r)) {
      return { ok: false };
    }
    return { ok: true, value: r };
  } catch {
    return { ok: false };
  }
}

function recorder() {
  const events: BusEvent[] = [];
  const state = { mode: "ok" as "ok" | "fail" | "throw" };
  const bus: Publisher = {
    async publish(event) {
      if (state.mode === "throw") throw new Error("publisher down");
      if (state.mode === "fail") return err(DeliveryFailed("publisher down", { topic: event.topic }));
      events.push(event);
      return ok(undefined);
    },
  };
  return { bus, events, state };
}
type Recorder = ReturnType<typeof recorder>;

/** Everything delivered so far matching `topic`: direct publishes plus a drain of any outbox. */
async function delivered(db: Db, rec: Recorder, topic: RegExp): Promise<BusEvent[]> {
  rec.state.mode = "ok";
  await createOutboxRelay(db).drain(rec.bus);
  return rec.events.filter((e) => topic.test(e.topic));
}

const rowOf = (db: Db, id: string) =>
  db.get("orders", id) as Promise<{ status: string; version: number; updatedAt: string; items: unknown[] }>;

async function freshOrder() {
  const { db, clock } = createTestDb();
  const rec = recorder();
  const ctx = { db, bus: rec.bus };
  const created = await call(() => orders.createOrder(ctx, { items: [{ sku: "a", quantity: 1 }] }));
  if (!created.ok) throw new Error("fixture createOrder failed");
  await delivered(db, rec, /./);
  rec.events.length = 0; // forget the creation event
  return { db, clock, rec, ctx, id: created.value.id as string };
}

const fn = (name: string) =>
  (orders as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>)[name];
function need(name: string) {
  const f = fn(name);
  if (typeof f !== "function") throw new Error(`${name} is not exported from the package entry point`);
  return f;
}
const validTime = (iso: unknown) => typeof iso === "string" && !Number.isNaN(Date.parse(iso));

const UPDATED = /updated/i;
const update = (...a: unknown[]) => need("updateOrder")(...a);

/** A db whose nth transaction (1-based) fails before doing anything. */
function failingNthTransaction(db: Db, n: number): Db {
  let count = 0;
  return {
    ...db,
    transaction: ((f: never) => {
      count += 1;
      if (count === n) return Promise.reject(new Error("injected database failure"));
      return db.transaction(f);
    }) as Db["transaction"],
  };
}

/** After a fault: the stored version and the announced events must tell the same story. */
async function expectConsistent(db: Db, rec: Recorder, id: string) {
  const stored = await rowOf(db, id);
  const events = await delivered(db, rec, UPDATED);
  if (stored.version === 1) {
    expect(events).toHaveLength(0); // no change, so no announcement
  } else {
    expect(stored.version).toBe(2);
    expect(events).toHaveLength(1); // a change must be announced, exactly once
    expect((events[0]!.payload as { id: string; version: number }).version).toBe(2);
  }
}

describe("g1: updateOrder under concurrent writers", () => {
  it("applies a patch at the last seen version and returns the updated order", async () => {
    const { db, clock, ctx, id } = await freshOrder();
    clock.advance(5000);
    const res = await call(() => update(ctx, id, { status: "paid" }, 1));
    expect(res.ok).toBe(true);
    const stored = await rowOf(db, id);
    expect(stored.status).toBe("paid");
    expect(stored.version).toBe(2);
    expect(validTime(stored.updatedAt)).toBe(true);
    if (res.ok) expect(res.value).toMatchObject({ id, status: "paid", version: 2 });
  });

  it("refuses a stale version, leaves the order alone and announces nothing more", async () => {
    const { db, rec, ctx, id } = await freshOrder();
    expect((await call(() => update(ctx, id, { status: "paid" }, 1))).ok).toBe(true);
    await delivered(db, rec, UPDATED);
    const before = await rowOf(db, id);
    const stale = await call(() => update(ctx, id, { status: "cancelled" }, 1));
    expect(stale.ok).toBe(false);
    expect(await rowOf(db, id)).toEqual(before);
    expect(await delivered(db, rec, UPDATED)).toHaveLength(1);
  });

  it("lets exactly one of two simultaneous writers win", async () => {
    const { db, ctx, id } = await freshOrder();
    const results = await Promise.all([
      call(() => update(ctx, id, { status: "paid" }, 1)),
      call(() => update(ctx, id, { status: "cancelled" }, 1)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await rowOf(db, id)).version).toBe(2);
  });

  it("announces one event per successful update, each with the id and its own new version", async () => {
    const { db, rec, ctx, id } = await freshOrder();
    await call(() => update(ctx, id, { status: "paid" }, 1));
    await call(() => update(ctx, id, { items: [{ sku: "b", quantity: 3 }] }, 2));
    const events = await delivered(db, rec, UPDATED);
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.payload as { id: string }).id)).toEqual([id, id]);
    expect(events.map((e) => (e.payload as { version: number }).version)).toEqual([2, 3]);
  });

  it("refuses an unknown status, an empty item list and an unknown order, announcing nothing", async () => {
    const { db, rec, ctx, id } = await freshOrder();
    const before = await rowOf(db, id);
    expect((await call(() => update(ctx, id, { status: "bogus" }, 1))).ok).toBe(false);
    expect((await call(() => update(ctx, id, { items: [] }, 1))).ok).toBe(false);
    expect((await call(() => update(ctx, "ord_missing", { status: "paid" }, 1))).ok).toBe(false);
    expect(await rowOf(db, id)).toEqual(before);
    expect(await delivered(db, rec, UPDATED)).toEqual([]);
  });

  describe("fault injection: state and announcements stay consistent", () => {
    it("when the event publisher returns a failure", async () => {
      const { db, rec, ctx, id } = await freshOrder();
      rec.state.mode = "fail";
      await call(() => update(ctx, id, { status: "paid" }, 1));
      await expectConsistent(db, rec, id);
    });

    it("when the event publisher throws", async () => {
      const { db, rec, ctx, id } = await freshOrder();
      rec.state.mode = "throw";
      await call(() => update(ctx, id, { status: "paid" }, 1));
      await expectConsistent(db, rec, id);
    });

    it.each([1, 2])("when database transaction number %i fails", async (n) => {
      const { db, rec, id } = await freshOrder();
      const ctx = { db: failingNthTransaction(db, n), bus: rec.bus };
      await call(() => update(ctx, id, { status: "paid" }, 1));
      await expectConsistent(db, rec, id);
    });
  });
});
